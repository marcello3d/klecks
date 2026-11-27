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
 * Seeking (2draw's KlecksPlayer): checkpoint() between two steps keeps the player's whole state,
 * the history with its undo entries included, and new KlrPlayer(checkpoint) carries on from there,
 * the same pixels as a replay that never stopped. A checkpoint copies no pixels: the history's
 * entries and tiles never change once made, so it shares them (KlrCheckpointBytes counts what
 * the ones kept hold that the replay would have let go).
 */
import { KlCanvas } from '../klecks/canvas/kl-canvas';
import { HISTORY_TILE_SIZE, KlHistory, TKlHistoryState } from '../klecks/history/kl-history';
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
import { klRandomGetState, klRandomSeed, klRandomSetState } from '../klecks/utils/kl-random';
import { TKlProject, TMixMode } from '../klecks/kl-types';
import { randomUuid } from '../bb/base/base';
import {
    BRUSH_FIELDS,
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
    readBrushSettings,
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

/** A player's state between two steps (KlrPlayer.checkpoint). Opaque; shares the history's tiles,
 * the selection samples and the clipboard images (never changed once made) with the player. */
export type TKlrCheckpoint = {
    readonly file: TKlrFile;
    readonly history: TKlHistoryState;
    // each brush made so far: its own plain fields (the settings, and what carries from one stroke
    // or line to the next: sketchy's seed, a line tool's last dot)
    readonly brushes: readonly [TKlrBrushId, Record<string, unknown>, Record<string, HTMLCanvasElement> | undefined][];
    readonly brushId: TKlrBrushId;
    readonly brushLayer: number;
    readonly samples: ReadonlyMap<number, TSelectionSample | undefined>;
    readonly clips: ReadonlyMap<number, HTMLCanvasElement>;
    readonly chunkIndex: number;
    readonly opIndex: number;
    readonly chunkStarted: boolean;
    readonly result: TKlrPlayerResult;
    readonly hasher: KlrHasher;
    readonly penTipsUsed: boolean;
    readonly tainted: boolean;
    readonly ffdRenderer: FfdRenderer | undefined;
    // the layers' pixels as the canvases hold them (see TKlrLayerCapture)
    readonly layers: readonly TKlrLayerCapture[];
};

/**
 * A layer's pixels at a checkpoint, tile by tile (HISTORY_TILE_SIZE), as its canvas holds them.
 * Not the history's tiles: a canvas does not always read back what putImageData of its readback
 * would make it (pixels a WebGL filter drew, at low alpha: one level apart), so a canvas rebuilt
 * from the history's tiles, as an undo does, can differ from the one the replay drew. So each
 * tile is a copy of the canvas's own (drawImage, exact), or a fill the canvas is exactly. A tile
 * whose history tile is the same object as at the last checkpoint is the same copy (nothing
 * drew on it since: every stroke pushes the tiles it touched); after any op but a stroke, a line
 * or an undo/redo every tile is copied again. Only once a WebGL filter or warp has drawn
 * (`tainted`): until then the 2D canvas's pixels are always what putImageData of the history's
 * tiles makes (the test checks it at every op), so nothing is copied ({ tile } alone).
 */
export type TKlrTileCapture = { readonly tile: object | undefined; readonly bmp?: HTMLCanvasElement };
export type TKlrLayerCapture = {
    readonly id: string;
    readonly canvas: HTMLCanvasElement;
    readonly w: number;
    readonly h: number;
    readonly tiles: readonly TKlrTileCapture[];
};

// ops that draw only into the tiles they push (or put back the history's)
const TILE_TRACKED_OPS = new Set(['brush', 'layer', 'stroke', 'line', 'undo', 'redo', 'active', 'sample', 'copy', 'ext']);
const PIXEL_FREE_METHODS = new Set(['setOpacity', 'setLayerIsVisible', 'setLayerHasClipping', 'renameLayer', 'setMixMode', 'moveLayer', 'setSelection']);

const fillRgba = new Map<string, number>();
function fillPixel(fill: string): number {
    let v = fillRgba.get(fill);
    if (v === undefined) {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        const g = c.getContext('2d')!;
        g.fillStyle = fill;
        g.fillRect(0, 0, 1, 1);
        v = new Uint32Array(g.getImageData(0, 0, 1, 1).data.buffer)[0];
        fillRgba.set(fill, v);
    }
    return v;
}

// a copy of plain data (numbers, strings, booleans, plain objects and arrays of them), or
// NOT_PLAIN: a brush's contexts, canvases, history and class instances are not its state
const NOT_PLAIN = Symbol('not plain');
function copyPlain(v: unknown, depth = 0): unknown {
    if (v === null || v === undefined || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
        return v;
    }
    if (typeof v !== 'object' || depth > 8) {
        return NOT_PLAIN;
    }
    if (Array.isArray(v)) {
        const out: unknown[] = [];
        for (const x of v) {
            const c = copyPlain(x, depth + 1);
            if (c === NOT_PLAIN) {
                return NOT_PLAIN;
            }
            out.push(c);
        }
        return out;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
        return NOT_PLAIN;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v)) {
        const c = copyPlain((v as Record<string, unknown>)[key], depth + 1);
        if (c === NOT_PLAIN) {
            return NOT_PLAIN;
        }
        out[key] = c;
    }
    return out;
}

// Pen's image tips (alphaCanvas128/64/32, drawn by setColor/setAlpha). In Chrome a tip draws
// a little differently once it has been drawn from (a stroke) than the first time after it was
// redrawn, though it reads back the same, so a tip made afresh from the settings is right only if
// the replay had not drawn with it yet. So the player gives the pen new tip canvases before it
// redraws them (a brush op), never redrawing one in place, and a checkpoint keeps the tips
// themselves once a stroke has drawn with them (shared: nothing draws into them again).
const PEN_TIPS: [string, number][] = [
    ['alphaCanvas128', 128],
    ['alphaCanvas64', 64],
    ['alphaCanvas32', 32],
];
const PEN_TIP_IDS = new Set([1, 2]); // not ALPHA_CIRCLE 0 or ALPHA_SQUARE 3 (pen-brush.ts)
function newPenTips(brush: TKlrBrush): void {
    for (const [key, size] of PEN_TIPS) {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        brush[key] = c;
    }
}

function brushState(id: TKlrBrushId, brush: TKlrBrush): Record<string, unknown> {
    // the settings as the recorder reads them (colours are class instances), then the rest
    const out: Record<string, unknown> = readBrushSettings(id, brush);
    const fields = BRUSH_FIELDS[id];
    for (const key of Object.keys(brush)) {
        if (fields.includes(key)) {
            continue;
        }
        const c = copyPlain(brush[key]);
        if (c !== NOT_PLAIN) {
            out[key] = c;
        }
    }
    return out;
}

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
    private hasher = new KlrHasher();
    private readonly brushes = new Map<TKlrBrushId, TKlrBrush>();
    private brushId: TKlrBrushId = 'penBrush';
    private brushLayer = 0;
    private readonly samples = new Map<number, TSelectionSample | undefined>();
    private readonly clips = new Map<number, HTMLCanvasElement>();
    private ffdRenderer: FfdRenderer | undefined;
    private chunkIndex = 0;
    private opIndex = 0;
    private chunkStarted = false;
    private result: TKlrPlayerResult = {
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

    // the canvases' tiles at the last checkpoint, by layer id; every tile to be copied again
    private captures = new Map<string, TKlrLayerCapture>();
    // a WebGL filter or warp has drawn since the canvases were last made from the history's tiles:
    // only then can a canvas hold pixels putImageData would not make (TKlrLayerCapture)
    private tainted = false;
    // a stroke has drawn with pen's tips since they were last drawn (PEN_TIPS)
    private penTipsUsed = false;
    private allDirty = true;

    private notePenTips(): void {
        if (this.brushId === 'penBrush' && PEN_TIP_IDS.has(this.brush().settingAlphaId)) {
            this.penTipsUsed = true;
        }
    }

    private captureTile(ctx: CanvasRenderingContext2D, tile: object | undefined, i: number, cols: number, w: number, h: number): TKlrTileCapture {
        const x = (i % cols) * HISTORY_TILE_SIZE;
        const y = Math.floor(i / cols) * HISTORY_TILE_SIZE;
        const tw = Math.min(HISTORY_TILE_SIZE, w - x);
        const th = Math.min(HISTORY_TILE_SIZE, h - y);
        const fill = (tile as { fill?: string } | undefined)?.fill;
        if (fill !== undefined) {
            // a fill (an empty layer, mostly): kept as the fill if the canvas is exactly that
            const px = new Uint32Array(ctx.getImageData(x, y, tw, th).data.buffer);
            const want = fillPixel(fill);
            let same = true;
            for (let k = 0; k < px.length; k++) {
                if (px[k] !== want) {
                    same = false;
                    break;
                }
            }
            if (same) {
                return { tile };
            }
        }
        const bmp = document.createElement('canvas');
        bmp.width = tw;
        bmp.height = th;
        bmp.getContext('2d')!.drawImage(ctx.canvas, x, y, tw, th, 0, 0, tw, th);
        return { tile, bmp };
    }

    private captureLayers(): TKlrLayerCapture[] {
        const kc = this.klCanvas;
        const composed = this.klHistory.getComposed();
        const w = kc.getWidth();
        const h = kc.getHeight();
        const cols = Math.ceil(w / HISTORY_TILE_SIZE);
        const n = cols * Math.ceil(h / HISTORY_TILE_SIZE);
        const out: TKlrLayerCapture[] = [];
        const next = new Map<string, TKlrLayerCapture>();
        for (const layer of kc.getLayersReference()) {
            const tiles = (composed.layerMap[layer.id]?.tiles ?? []) as (object | undefined)[];
            const prev = this.captures.get(layer.id);
            const same = !this.allDirty && prev && prev.canvas === layer.canvas && prev.w === w && prev.h === h;
            const caps: TKlrTileCapture[] = [];
            for (let i = 0; i < n; i++) {
                const t = tiles[i];
                // (untainted: the history's tile makes the canvas's exactly, nothing to copy)
                caps.push(!this.tainted ? { tile: t } : same && t && prev!.tiles[i].tile === t ? prev!.tiles[i] : this.captureTile(layer.context, t, i, cols, w, h));
            }
            const cap: TKlrLayerCapture = { id: layer.id, canvas: layer.canvas, w, h, tiles: caps };
            next.set(layer.id, cap);
            out.push(cap);
        }
        this.captures = next;
        this.allDirty = false;
        return out;
    }

    // a restored player's canvases: the checkpoint's copies over what the history's tiles made
    private restoreLayers(layers: readonly TKlrLayerCapture[]): void {
        const kc = this.klCanvas;
        const byId = new Map(kc.getLayersReference().map((l) => [l.id, l]));
        const cols = Math.ceil(kc.getWidth() / HISTORY_TILE_SIZE);
        for (const cap of layers) {
            const layer = byId.get(cap.id);
            if (!layer || cap.w !== kc.getWidth() || cap.h !== kc.getHeight()) {
                this.allDirty = true;
                continue;
            }
            const ctx = layer.context;
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
            cap.tiles.forEach((t, i) => {
                if (t.bmp) {
                    const x = (i % cols) * HISTORY_TILE_SIZE;
                    const y = Math.floor(i / cols) * HISTORY_TILE_SIZE;
                    ctx.clearRect(x, y, t.bmp.width, t.bmp.height);
                    ctx.drawImage(t.bmp, x, y);
                }
            });
            ctx.restore();
            this.captures.set(cap.id, { ...cap, canvas: layer.canvas });
        }
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

    // what the brush UIs and the easel did with the stroke, one sample at a time; begun, fed and
    // ended separately, so a stroke can be drawn over several frames (strokeTo) with the same calls
    private pending: {
        op: Extract<TKlrOp, { op: 'stroke' }>;
        brush: TKlrBrush;
        id: TKlrBrushId;
        next: number; // samples given
        k: number; // transfers made
        rng: number; // klRandom's state, between two parts
    } | null = null;

    private strokeTransfers(): void {
        const p = this.pending!;
        while (p.k < p.op.transfers.length && p.op.transfers[p.k] <= p.next) {
            p.brush.transferToCanvas?.();
            p.k++;
        }
    }

    private strokeBegin(op: Extract<TKlrOp, { op: 'stroke' }>): void {
        klRandomSeed(op.seed);
        const brush = this.bindBrush();
        const s0 = op.samples[0];
        brushDown(this.brushId, brush, s0[1] / COORD_SCALE, s0[2] / COORD_SCALE, s0[3] / 255);
        this.pending = { op, brush, id: this.brushId, next: 1, k: 0, rng: 0 };
        this.strokeTransfers();
        this.pending.rng = klRandomGetState();
    }

    // the samples up to time t (the chunk's clock, as op.t)
    private strokeFeed(t: number): void {
        const p = this.pending!;
        const samples = p.op.samples;
        if (p.next >= samples.length || samples[p.next][0] > t) {
            return;
        }
        klRandomSetState(p.rng);
        while (p.next < samples.length && samples[p.next][0] <= t) {
            const s = samples[p.next];
            brushMove(p.id, p.brush, s[1] / COORD_SCALE, s[2] / COORD_SCALE, s[3] / 255);
            p.next++;
            this.strokeTransfers();
        }
        p.rng = klRandomGetState();
    }

    private strokeEnd(): void {
        const p = this.pending!;
        this.strokeFeed(Infinity);
        klRandomSetState(p.rng);
        while (p.k < p.op.transfers.length) {
            p.brush.transferToCanvas?.();
            p.k++;
        }
        brushUp(p.id, p.brush);
        this.pending = null;
        this.result.strokes++;
    }

    private strokeOp(op: Extract<TKlrOp, { op: 'stroke' }>): void {
        if (this.pending?.op !== op) {
            this.strokeBegin(op);
        }
        this.strokeEnd();
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
        if (!TILE_TRACKED_OPS.has(op.op) && !(op.op === 'canvas' && PIXEL_FREE_METHODS.has(op.method))) {
            this.allDirty = true;
        }
        if (op.op === 'filter' || op.op === 'ffd') {
            this.tainted = true;
        }
        switch (op.op) {
            case 'brush': {
                this.brushId = op.brush;
                const brush = this.brush();
                if (op.brush === 'penBrush' && ('settingColor' in op.settings || 'settingAlphaId' in op.settings)) {
                    newPenTips(brush);
                    this.penTipsUsed = false;
                }
                applyBrushSettings(op.brush, brush, op.settings);
                return;
            }
            case 'layer':
                this.brushLayer = op.index;
                return;
            case 'stroke':
                this.notePenTips();
                this.strokeOp(op);
                return;
            case 'line':
                this.notePenTips();
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
        this.penTipsUsed = false;
        this.tainted = false; // (fresh canvases from the history's tiles)
        this.allDirty = true;
        this.samples.clear();
        this.clips.clear();
        this.ffdRenderer = undefined;
        this.brushId = 'penBrush';
        this.brushLayer = 0;
    }

    // ----------------------------------- public -----------------------------------

    /** From a .klr's bytes (at its start: blank, or `project`), or from a checkpoint of a player of
     * the same file (it carries on from there). */
    constructor(from: Uint8Array | TKlrCheckpoint, p: { project?: TKlProject } = {}) {
        // software canvases, as the recording app had (layer-context.ts)
        softwareCanvases();
        if (!(from instanceof Uint8Array)) {
            const cp = from;
            this.file = cp.file;
            this.klHistory = KlHistory.fromState(cp.history);
            this.klCanvas = new KlCanvas(this.klHistory, -1);
            for (const [id, state, canvases] of cp.brushes) {
                const brush = createBrush(id, this.klHistory);
                // the settings through their setters (derived state: pen's alpha), then the rest
                if (id === 'penBrush') {
                    newPenTips(brush);
                }
                applyBrushSettings(id, brush, state as Record<string, TKlrValue>);
                const fields = BRUSH_FIELDS[id];
                for (const key of Object.keys(state)) {
                    if (!fields.includes(key)) {
                        brush[key] = copyPlain(state[key]);
                    }
                }
                if (canvases) {
                    Object.assign(brush, canvases);
                }
                this.brushes.set(id, brush);
            }
            this.penTipsUsed = cp.penTipsUsed;
            this.tainted = cp.tainted;
            this.brushId = cp.brushId;
            this.brushLayer = cp.brushLayer;
            cp.samples.forEach((v, k) => this.samples.set(k, v));
            cp.clips.forEach((v, k) => this.clips.set(k, v));
            this.chunkIndex = cp.chunkIndex;
            this.opIndex = cp.opIndex;
            this.chunkStarted = cp.chunkStarted;
            this.result = { ...cp.result, hashMismatches: cp.result.hashMismatches.slice() };
            this.hasher = cp.hasher;
            this.ffdRenderer = cp.ffdRenderer;
            this.allDirty = false;
            this.restoreLayers(cp.layers);
            return;
        }
        this.file = parseKlr(from);
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

    /** The player's state now (between two steps), for new KlrPlayer(checkpoint). */
    checkpoint(): TKlrCheckpoint {
        if (this.pending) {
            throw new Error('klr: no checkpoint in the middle of a stroke');
        }
        return {
            file: this.file,
            history: this.klHistory.getState(),
            brushes: [...this.brushes].map(([id, brush]) => [
                id,
                brushState(id, brush),
                id === 'penBrush' && this.penTipsUsed ? Object.fromEntries(PEN_TIPS.map(([k]) => [k, brush[k]])) : undefined,
            ]),
            penTipsUsed: this.penTipsUsed,
            tainted: this.tainted,
            brushId: this.brushId,
            brushLayer: this.brushLayer,
            samples: new Map(this.samples),
            clips: new Map(this.clips),
            chunkIndex: this.chunkIndex,
            opIndex: this.opIndex,
            chunkStarted: this.chunkStarted,
            result: this.getResult(),
            hasher: this.hasher,
            ffdRenderer: this.ffdRenderer,
            layers: this.captureLayers(),
        };
    }

    /** How many ops have run (as step() counts them). */
    getOpCount(): number {
        return this.result.ops;
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

    private enterChunk(): void {
        const chunk = this.file.chunks[this.chunkIndex];
        if (this.opIndex === 0 && !this.chunkStarted) {
            this.chunkStarted = true;
            this.result.skipped += chunk.skipped;
            if (chunk.restore) {
                this.checkHashes(chunk.restore, 'restore');
                this.restart();
            }
        }
    }

    /** If the next op is a stroke: gives the brush its samples up to time `t` (the chunk's clock,
     * as the op's t), so it draws along its path; the next step() gives it the rest and ends it.
     * The same calls as step() alone, spread out. False (and nothing done) for any other op. */
    strokeTo(t: number): boolean {
        if (this.chunkIndex >= this.file.chunks.length) {
            return false;
        }
        this.enterChunk();
        const chunk = this.file.chunks[this.chunkIndex];
        const op = chunk.ops[this.opIndex];
        if (!op || op.op !== 'stroke') {
            return false;
        }
        if (this.pending?.op !== op) {
            this.notePenTips();
            this.strokeBegin(op);
        }
        this.strokeFeed(t);
        return true;
    }

    /** The op the next step() runs, if any (at a chunk's end: undefined until step() moves on). */
    nextOp(): TKlrOp | undefined {
        return this.file.chunks[this.chunkIndex]?.ops[this.opIndex];
    }

    /** A stroke begun by strokeTo and not ended yet. */
    isMidStroke(): boolean {
        return !!this.pending;
    }

    /** Runs the next op (ends a stroke under way). False at the end. */
    step(): boolean {
        while (this.chunkIndex < this.file.chunks.length) {
            const chunk = this.file.chunks[this.chunkIndex];
            this.enterChunk();
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
