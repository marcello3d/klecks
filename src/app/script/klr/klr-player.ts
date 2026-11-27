/**
 * Replays a .klr recording headless: a KlHistory, a KlCanvas, the brushes and filters, no UI.
 * The same calls the live app made, in the same order, with the same seeds, so in the browser
 * that drew it the result is the same pixels. Each chunk's header holds the layer hashes at its
 * seal (and, on a draft restore, the restored picture's); the player compares and counts
 * mismatches (drift, or a bug). Named fields are mapped to the Klecks calls here, by name.
 *
 *   const player = new KlrPlayer(bytes);       // a blank start; or { project } for a reference
 *   player.runAll();
 *   player.getKlCanvas().getCanvas();
 *
 * Later: the base of 2draw's KlecksPlayer (seeking, pacing).
 */
import { KlCanvas } from '../klecks/canvas/kl-canvas';
import { KlHistory } from '../klecks/history/kl-history';
import { projectToComposed } from '../klecks/history/push-helpers/project-to-composed';
import { isHistoryEntryActiveLayerChange } from '../klecks/history/push-helpers/is-history-entry-active-layer-change';
import { THistoryEntryData, THistoryEntryLayer } from '../klecks/history/history.types';
import { createImageDataTile } from '../klecks/history/image-data-tile';
import { getNextLayerId } from '../klecks/history/get-next-layer-id';
import { FILTER_LIB } from '../klecks/filters/filters';
import { importFilters } from '../klecks/filters/filters-lazy';
import { createSelectionSample, TSelectionSample } from '../klecks/transform/selection-sample';
import { klCanvasTransform } from '../klecks/canvas/kl-canvas-transform';
import { klCanvasFfd } from '../klecks/canvas/kl-canvas-ffd';
import { FfdRenderer } from '../klecks/transform/ffd-renderer';
import { klRandomSeed } from '../klecks/utils/kl-random';
import { TKlProject, TMixMode } from '../klecks/kl-types';
import { randomUuid } from '../bb/base/base';
import {
    COORD_SCALE,
    KLR_HASH_TILE,
    parseKlr,
    TKlrBrushId,
    TKlrFile,
    TKlrHead,
    TKlrOp,
    TKlrTiles,
    TKlrValue,
} from './klr-format';
import {
    applyBrushSettings,
    bindBrushLayer,
    brushDown,
    brushMove,
    brushUp,
    createBrush,
    TKlrBrush,
} from './klr-brushes';
import { pasteAsLayer } from './klr-paste';
import { KlrHasher } from './klr-hash';
import { sortLayerMap } from '../klecks/history/sort-layer-map';
import { softwareCanvases } from '../klecks/canvas/layer-context';

export type TKlrPlayerResult = {
    ops: number;
    strokes: number;
    ms: number;
    hashChecks: number;
    hashMismatches: { chunk: number; at: 'restore' | 'end'; layers: number[] }[];
    startMismatch: boolean;
    skipped: number; // EXT ops skipped
    error?: string; // why the file stopped being read early: the replay ends there
};

export function blankStartProject(head: TKlrHead): TKlProject {
    if (head.start.kind !== 'blank') {
        throw new Error('klr: the start is a reference, pass its project');
    }
    return {
        projectId: randomUuid(),
        width: head.width,
        height: head.height,
        layers: head.start.layers.map((layer) => ({
            name: layer.name,
            opacity: layer.opacity,
            isVisible: layer.isVisible,
            mixModeStr: layer.mixModeStr as TMixMode,
            hasClipping: layer.hasClipping,
            image: { fill: layer.fill },
        })),
    };
}

export class KlrPlayer {
    private readonly file: TKlrFile;
    private klHistory: KlHistory;
    private klCanvas: KlCanvas;
    private readonly hasher = new KlrHasher();
    private readonly brushes = new Map<TKlrBrushId, TKlrBrush>();
    private brushId: TKlrBrushId = 'penBrush';
    private brushLayer = 0;
    private readonly samples = new Map<number, TSelectionSample | undefined>();
    private readonly clips = new Map<number, HTMLCanvasElement>();
    private ffdRenderer: FfdRenderer | undefined;
    private chunkIndex = 0;
    private opIndex = 0;
    private chunkStarted = false;
    private readonly result: TKlrPlayerResult = {
        ops: 0,
        strokes: 0,
        ms: 0,
        hashChecks: 0,
        hashMismatches: [],
        startMismatch: false,
        skipped: 0,
    };

    private brush(): TKlrBrush {
        let brush = this.brushes.get(this.brushId);
        if (!brush) {
            brush = createBrush(this.brushId, this.klHistory);
            this.brushes.set(this.brushId, brush);
        }
        return brush;
    }

    private bindBrush(): TKlrBrush {
        const brush = this.brush();
        bindBrushLayer(this.brushId, brush, this.klCanvas.getLayer(this.brushLayer));
        return brush;
    }

    private undoRedo(isUndo: boolean): void {
        const before = this.klHistory.getComposed();
        if (isUndo) {
            this.klHistory.decreaseIndex();
        } else {
            this.klHistory.increaseIndex();
        }
        this.klCanvas.updateViaComposed(before, this.klHistory.getComposed());
    }

    private applyTiles(t: TKlrTiles): void {
        const layers = this.klCanvas.getLayersReference();
        const entry: THistoryEntryData = {};
        const newIds: string[] = [];
        if (t.size) {
            entry.size = { ...t.size };
        }
        if (t.selection) {
            entry.selection = { value: t.selection.value as any };
        }
        if (t.layers) {
            entry.layerMap = {};
            for (const layer of t.layers) {
                let id: string;
                if (layer.src >= 0) {
                    id = layers[layer.src].id;
                } else {
                    id = getNextLayerId();
                    newIds.push(id);
                }
                const out: THistoryEntryLayer = { ...(layer.props as any) };
                if (layer.tiles) {
                    out.tiles = layer.tiles.map((tile) => {
                        if (!tile) {
                            return undefined;
                        }
                        if ('fill' in tile) {
                            return { fill: tile.fill };
                        }
                        const data = new ImageData(tile.w, tile.h);
                        data.data.set(tile.data);
                        return createImageDataTile(data);
                    });
                }
                entry.layerMap[id] = out;
            }
        }
        if (t.activeLayer !== undefined) {
            entry.activeLayerId =
                t.activeLayer >= 0 ? layers[t.activeLayer].id : newIds[-t.activeLayer - 1];
        }
        const before = this.klHistory.getComposed();
        this.klHistory.push(entry, t.replaceTop);
        this.klCanvas.updateViaComposed(before, this.klHistory.getComposed());
    }

    private checkHashes(hashes: number[], at: 'restore' | 'end'): void {
        if (!hashes.length || this.file.head.hashTile !== KLR_HASH_TILE) {
            return; // not taken (sealed during a stroke), or on tiles this build doesn't hash
        }
        this.result.hashChecks++;
        const now = this.getLayerHashes();
        const differ = now.map((h, i) => (h === hashes[i] ? -1 : i)).filter((i) => i >= 0);
        if (differ.length || now.length !== hashes.length) {
            this.result.hashMismatches.push({ chunk: this.chunkIndex, at, layers: differ });
        }
    }

    // what the brush UIs and the easel did with the stroke, one sample at a time
    private strokeOp(op: Extract<TKlrOp, { op: 'stroke' }>): void {
        const id = this.brushId;
        const xy = (v: number) => v / COORD_SCALE;
        klRandomSeed(op.seed);
        const brush = this.bindBrush();
        let k = 0;
        const transfers = () => {
            while (k < op.transfers.length && op.transfers[k] <= given) {
                brush.transferToCanvas?.();
                k++;
            }
        };
        const [s0, ...rest] = op.samples;
        brushDown(id, brush, xy(s0[1]), xy(s0[2]), s0[3] / 255);
        let given = 1;
        transfers();
        for (const s of rest) {
            brushMove(id, brush, xy(s[1]), xy(s[2]), s[3] / 255);
            given++;
            transfers();
        }
        while (k < op.transfers.length) {
            brush.transferToCanvas?.();
            k++;
        }
        brushUp(id, brush);
        this.result.strokes++;
    }

    // a KlCanvas call from its named fields
    private canvasOp(method: string, f: Record<string, TKlrValue>): void {
        const kc = this.klCanvas as any;
        const a = f as Record<string, any>;
        switch (method) {
            case 'setOpacity':
                return kc.setOpacity(a.layerIndex, a.opacity);
            case 'setLayerIsVisible':
                return kc.setLayerIsVisible(a.layerIndex, a.isVisible);
            case 'setLayerHasClipping':
                return kc.setLayerHasClipping(a.layerIndex, a.hasClipping);
            case 'moveLayer':
                return kc.moveLayer(a.index, a.delta);
            case 'mergeLayer':
                return kc.mergeLayer(a.layerIndex, a.mixModeStr);
            case 'removeLayer':
                return kc.removeLayer(a.index);
            case 'duplicateLayer':
                return kc.duplicateLayer(a.srcIndex);
            case 'renameLayer':
                return kc.renameLayer(a.index, a.name);
            case 'setMixMode':
                return kc.setMixMode(a.layerIndex, a.mixModeStr);
            case 'addLayer':
                return kc.addLayer(a.selectedIndex, a.data);
            case 'reset':
                return kc.reset(a.p);
            case 'resize':
                return kc.resize(a.w, a.h, a.algorithm);
            case 'cropExtend':
                return kc.cropExtend(a.p);
            case 'mergeAll':
                return kc.mergeAll();
            case 'rotate':
                return kc.rotate(a.deg);
            case 'flip':
                return kc.flip(a.isHorizontal, a.isVertical, a.layerIndex);
            case 'layerFill':
                return kc.layerFill(a.layerIndex, a.colorObj, a.compositeOperation, a.doClipSelection);
            case 'floodFill':
                return kc.floodFill(a.layerIndex, a.x, a.y, a.rgb, a.opacity, a.tolerance, a.sampleStr, a.grow, a.isContiguous);
            case 'drawShape':
                return kc.drawShape(a.layerIndex, a.shapeObj);
            case 'drawGradient':
                return kc.drawGradient(a.layerIndex, a.gradientObj);
            case 'text':
                return kc.text(a.layerIndex, a.p);
            case 'eraseLayer':
                return kc.eraseLayer(a.p);
            case 'setSelection':
                return kc.setSelection(a.selection);
        }
        throw new Error('klr: no player mapping for ' + method);
    }

    private exec(op: TKlrOp): void {
        const kc = this.klCanvas;
        switch (op.op) {
            case 'brush':
                this.brushId = op.brush;
                applyBrushSettings(op.brush, this.brush(), op.settings);
                return;
            case 'layer':
                this.brushLayer = op.index;
                return;
            case 'stroke':
                this.strokeOp(op);
                return;
            case 'line':
                klRandomSeed(op.seed);
                this.bindBrush().drawLineSegment(op.x0, op.y0, op.x1, op.y1);
                this.result.strokes++;
                return;
            case 'canvas':
                this.canvasOp(op.method, op.fields);
                return;
            case 'filter': {
                importFilters();
                klRandomSeed(op.seed);
                const filter = FILTER_LIB[op.name];
                if (!filter?.apply) {
                    throw new Error('klr: unknown filter ' + op.name);
                }
                filter.apply({
                    layer: kc.getLayer(op.layer),
                    klCanvas: kc,
                    input: op.input,
                    klHistory: this.klHistory,
                });
                return;
            }
            case 'undo':
            case 'redo':
                this.undoRedo(op.op === 'undo');
                return;
            case 'active': {
                const top = this.klHistory.getEntries().at(-1)!.data;
                this.klHistory.push(
                    { activeLayerId: kc.getLayer(op.index).id },
                    isHistoryEntryActiveLayerChange(top),
                );
                return;
            }
            case 'sample':
                this.samples.set(op.id, createSelectionSample(op.layer, kc));
                return;
            case 'xform':
            case 'ffd': {
                const selectionSample = this.samples.get(op.sample);
                if (!selectionSample) {
                    throw new Error('klr: no selection sample ' + op.sample);
                }
                const f = op.params as Record<string, any>;
                if (op.op === 'xform') {
                    klCanvasTransform({
                        klCanvas: kc,
                        selectionSample,
                        selection: f.selection,
                        freeTransform: f.freeTransform,
                        eraseLayerIndex: f.eraseLayerIndex,
                        targetLayerIndex: f.targetLayerIndex,
                        algorithm: f.algorithm,
                        backgroundIsTransparent: f.backgroundIsTransparent,
                    });
                } else {
                    this.ffdRenderer ??= new FfdRenderer();
                    klCanvasFfd({
                        klCanvas: kc,
                        selectionSample,
                        selection: f.selection,
                        ffd: f.ffd,
                        eraseLayerIndex: f.eraseLayerIndex,
                        targetLayerIndex: f.targetLayerIndex,
                        algorithm: f.algorithm,
                        backgroundIsTransparent: f.backgroundIsTransparent,
                        ffdRenderer: this.ffdRenderer,
                    });
                }
                return;
            }
            case 'copy':
                this.clips.set(op.id, kc.getCanvas(1, op.mask));
                return;
            case 'paste': {
                const clip = this.clips.get(op.id);
                if (!clip) {
                    throw new Error('klr: no clipboard image ' + op.id);
                }
                const f = op.params as Record<string, any>;
                pasteAsLayer(kc, clip, { name: f.name, transform: f.transform, isPixelated: f.isPixelated });
                return;
            }
            case 'tiles':
                this.applyTiles(op.tiles);
                return;
            case 'ext':
                return; // no codes yet
        }
    }

    // a chunk that starts on a restore: the page reloaded and opened its draft, with a fresh history, fresh brushes, an
    // empty clipboard, from the picture as it was
    private restart(): void {
        // as the draft holds it: the history's tiles and layer attributes (embed-draft.ts)
        const composed = this.klHistory.getComposed();
        const project: TKlProject = {
            projectId: composed.projectId.value,
            width: composed.size.width,
            height: composed.size.height,
            layers: Object.values(composed.layerMap)
                .sort(sortLayerMap)
                .map((layer) => ({
                    name: layer.name,
                    opacity: layer.opacity,
                    isVisible: layer.isVisible,
                    mixModeStr: layer.mixModeStr,
                    hasClipping: layer.hasClipping,
                    image: layer.tiles.slice(),
                })),
        };
        const klHistory = new KlHistory({ oldest: projectToComposed(project) });
        const klCanvas = new KlCanvas(klHistory, -1);
        this.klCanvas.destroy();
        this.klHistory = klHistory;
        this.klCanvas = klCanvas;
        this.brushes.clear();
        this.samples.clear();
        this.clips.clear();
        this.ffdRenderer = undefined;
        this.brushId = 'penBrush';
        this.brushLayer = 0;
    }

    // ----------------------------------- public -----------------------------------

    constructor(bytes: Uint8Array, p: { project?: TKlProject } = {}) {
        // software canvases, as the recording app had (layer-context.ts)
        softwareCanvases();
        this.file = parseKlr(bytes);
        if (this.file.error) {
            this.result.error = this.file.error;
        }
        const project = p.project ?? blankStartProject(this.file.head);
        this.klHistory = new KlHistory({ oldest: projectToComposed(project) });
        this.klCanvas = new KlCanvas(this.klHistory, -1);
        const start = this.getLayerHashes();
        this.result.startMismatch =
            start.length !== this.file.head.startHashes.length ||
            start.some((h, i) => h !== this.file.head.startHashes[i]);
    }

    getHead(): TKlrHead {
        return this.file.head;
    }

    getKlCanvas(): KlCanvas {
        return this.klCanvas;
    }

    getKlHistory(): KlHistory {
        return this.klHistory;
    }

    /** Runs the next op. False at the end. */
    step(): boolean {
        while (this.chunkIndex < this.file.chunks.length) {
            const chunk = this.file.chunks[this.chunkIndex];
            if (this.opIndex === 0 && !this.chunkStarted) {
                this.chunkStarted = true;
                this.result.skipped += chunk.skipped;
                if (chunk.restore) {
                    this.checkHashes(chunk.restore, 'restore');
                    this.restart();
                }
            }
            if (this.opIndex < chunk.ops.length) {
                this.exec(chunk.ops[this.opIndex++]);
                this.result.ops++;
                return true;
            }
            this.checkHashes(chunk.endHashes, 'end');
            this.chunkIndex++;
            this.opIndex = 0;
            this.chunkStarted = false;
        }
        return false;
    }

    runAll(): TKlrPlayerResult {
        const t0 = performance.now();
        while (this.step()) {
            // all of it
        }
        this.result.ms += performance.now() - t0;
        return this.getResult();
    }

    getResult(): TKlrPlayerResult {
        return { ...this.result, hashMismatches: this.result.hashMismatches.slice() };
    }

    getLayerHashes(useCache = true): number[] {
        return this.hasher.hash(this.klCanvas, this.klHistory, useCache);
    }
}
