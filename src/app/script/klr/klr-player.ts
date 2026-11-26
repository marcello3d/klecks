/**
 * Replays a .klr recording headless: a KlHistory, a KlCanvas, the brushes and filters, no UI.
 * The same calls the live app made, in the same order, with the same seeds, so in the browser
 * that drew it the result is the same pixels. Each sealed chunk ends with a HASH of every
 * layer; the player compares and counts mismatches (drift, or a bug).
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
import { parseKlr, TKlrFile, TKlrHead, TKlrOp, TKlrBrushId, TKlrTiles } from './klr-format';
import {
    applyBrushSettings,
    bindBrushLayer,
    brushDown,
    brushMove,
    brushUp,
    createBrush,
    TKlrBrush,
} from './klr-brushes';
import { pasteAsLayer, TKlrPasteParams } from './klr-paste';
import { KlrHasher } from './klr-hash';
import { sortLayerMap } from '../klecks/history/sort-layer-map';
import { softwareCanvases } from '../klecks/canvas/layer-context';

export type TKlrPlayerResult = {
    ops: number;
    strokes: number;
    ms: number;
    hashChecks: number;
    hashMismatches: { chunk: number; layers: number[] }[];
    startMismatch: boolean;
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
    private readonly result: TKlrPlayerResult = {
        ops: 0,
        strokes: 0,
        ms: 0,
        hashChecks: 0,
        hashMismatches: [],
        startMismatch: false,
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
            case 'down':
                klRandomSeed(op.seed);
                brushDown(this.brushId, this.bindBrush(), op.x, op.y, op.p);
                this.result.strokes++;
                return;
            case 'move':
                brushMove(this.brushId, this.brush(), op.x, op.y, op.p);
                return;
            case 'up':
                brushUp(this.brushId, this.brush());
                return;
            case 'line':
                klRandomSeed(op.seed);
                this.bindBrush().drawLineSegment(op.x0, op.y0, op.x1, op.y1);
                this.result.strokes++;
                return;
            case 'transfer':
                this.brush().transferToCanvas?.();
                return;
            case 'canvas':
                (kc as any)[op.method](...op.args);
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
                if (op.op === 'xform') {
                    klCanvasTransform({ ...(op.params as any), klCanvas: kc, selectionSample });
                } else {
                    this.ffdRenderer ??= new FfdRenderer();
                    klCanvasFfd({
                        ...(op.params as any),
                        klCanvas: kc,
                        selectionSample,
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
                pasteAsLayer(kc, clip, op.params as TKlrPasteParams);
                return;
            }
            case 'tiles':
                this.applyTiles(op.tiles);
                return;
            case 'restore':
            case 'hash': {
                this.result.hashChecks++;
                const now = this.getLayerHashes();
                const differ = now
                    .map((h, i) => (h === op.hashes[i] ? -1 : i))
                    .filter((i) => i >= 0);
                if (differ.length || now.length !== op.hashes.length) {
                    this.result.hashMismatches.push({ chunk: this.chunkIndex, layers: differ });
                }
                if (op.op === 'restore') {
                    this.restart();
                }
                return;
            }
        }
    }

    // RESTORE: the page reloaded and opened its draft, with a fresh history, fresh brushes, an
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
            const ops = this.file.chunks[this.chunkIndex].ops;
            if (this.opIndex < ops.length) {
                this.exec(ops[this.opIndex++]);
                this.result.ops++;
                return true;
            }
            this.chunkIndex++;
            this.opIndex = 0;
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
