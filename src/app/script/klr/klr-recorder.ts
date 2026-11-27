/**
 * Records a Klecks session as .klr (klr-format.ts) while the artist draws: the chain-out draw
 * events (quantized before the brush sees them), the easel's per-frame transfers, every
 * recorded KlCanvas call, filter, undo, redo, layer pick, select-tool transform and in-app
 * copy/paste (klr-hooks.ts), and a per-stroke seed for the brushes' PRNG.
 *
 * Catch-all: a history push that no op claimed is stored as tiles (TILES op), counted in
 * getInfo().catchAll and logged as a bug. It keeps the recording whole; each use wants an
 * opcode.
 *
 * Chunks: the open chunk's ops are kept in memory (checked and copied as they come) and coded
 * only when it is sealed, in a quiet gap once it is big or old enough, at every draft
 * checkpoint (getDraftState) and by getBytes(). A stroke is held from DOWN to UP and becomes one
 * op at its UP. Nothing here reads pixels except the seal's hashes.
 */
import { KlCanvas } from '../klecks/canvas/kl-canvas';
import { KlHistory } from '../klecks/history/kl-history';
import { THistoryEntryData, THistoryEntryLayerTile } from '../klecks/history/history.types';
import { klRandomSeed } from '../klecks/utils/kl-random';
import type { TDrawEvent } from '../klecks/kl-types';
import {
    CANVAS_METHODS,
    canvasFields,
    COORD_SCALE,
    encodeHeadChunk,
    encodeOpsChunk,
    KlrUnencodable,
    PenGrid,
    prepareOp,
    quantizeCoord,
    quantizePressure,
    TKlrBrushId,
    TKlrOp,
    TKlrOpInput,
    TKlrSample,
    TKlrStart,
    TKlrTile,
    TKlrTiles,
    TKlrValue,
    toKlrValue,
} from './klr-format';
import { diffBrushSettings, readBrushSettings } from './klr-brushes';
import { klrHooks, TKlrHookTarget } from './klr-hooks';
import { KlrHasher } from './klr-hash';

export type TKlrAppApi = {
    klCanvas: KlCanvas;
    klHistory: KlHistory;
    getBrushId: () => string;
    getBrush: () => any;
    getLayerIndex: () => number;
    isDrawing: () => boolean;
    // where a stroke's pointer lattice may be (the view's zoom, the device's pixel ratio), or
    // null when the strokes are smoothed (not on any lattice)
    getGrid?: () => { scale: number; dpr: number } | null;
};

export type TKlrChunks = {
    head: Uint8Array; // magic + HEAD chunk
    sealed: Uint8Array[]; // OPS chunks (each with its TILES chunk, if any)
};

// What a draft keeps of the recording (embed-draft.ts) to continue it after a reload: sealed
// chunks only (getDraftState seals first)
export type TKlrDraftState = {
    head: Uint8Array; // magic + HEAD chunk
    sealed: Uint8Array[]; // OPS chunks, framed
    elapsedMs: number; // since the recording started
    seed: number;
    id: number;
};

export type TKlrInfo = {
    chunks: number; // sealed
    ops: number;
    strokes: number;
    samples: number;
    bytes: number; // head + sealed
    openOps: number; // ops not sealed yet (not coded)
    catchAll: number; // history entries stored as tiles: bugs
    unencodable: number; // ops whose arguments didn't encode (their entries went to the catch-all)
    hashTilesRead: number; // tiles read back for hashes (only changed ones are)
    sealMs: number; // main-thread time of the last seal (hashing and coding), and the longest
    sealMaxMs: number;
};

// seal the open chunk in a quiet gap once one of these is reached (drafts seal it at every
// checkpoint anyway)
const SEAL_SAMPLES = 100_000;
const SEAL_OPS = 20000;
const SEAL_AGE_MS = 60_000;
const QUIET_MS = 1500;

export function getBuildId(): string {
    return process.env.KLECKS_BUILD || 'dev';
}

function tileToKlr(tile: THistoryEntryLayerTile | undefined): TKlrTile {
    if (!tile) {
        return undefined;
    }
    if ('fill' in tile) {
        return { fill: tile.fill };
    }
    const d = tile.data;
    return { w: d.width, h: d.height, data: new Uint8Array(d.data.buffer.slice(0)) };
}

type TOpenChunk = {
    startMs: number; // since the recording began
    ops: TKlrOp[]; // t (and a stroke's sample times, upT): ms since the recording began
    samples: number;
    restore?: number[];
};

type TPendingStroke = {
    t: number;
    seed: number;
    samples: TKlrSample[]; // times since the recording began
    transfers: number[];
    grid: PenGrid | null;
    brush: TKlrBrushId;
    settings: Record<string, TKlrValue>; // at DOWN
    layer: number;
};

export class KlrRecorder implements TKlrHookTarget {
    private readonly api: TKlrAppApi;
    private readonly head: Uint8Array; // magic + HEAD chunk
    private readonly sealed: Uint8Array[] = [];
    private readonly t0: number;
    private readonly hasher = new KlrHasher();
    private pendingRestore: number[] | undefined;
    private restoreTimer: ReturnType<typeof setTimeout> | undefined;
    private open!: TOpenChunk;
    private stroke: TPendingStroke | undefined;
    private lastOpAt = 0;
    private depth = 0;
    private seed = 1;
    private id = 1;
    private ops = 0;
    private strokes = 0;
    private samples = 0;
    private catchAll = 0;
    private unencodable = 0;
    private sealMs = 0;
    private sealMaxMs = 0;
    // per chunk: what the decoder knows
    private brushCache = new Map<string, Record<string, TKlrValue>>();
    private lastBrushId: string | undefined;
    private lastLayer: number | undefined;
    // layer ids before the next history push (for the catch-all's layer indices)
    private ids: string[] = [];
    private readonly restore: (() => void)[] = [];
    private readonly timer: ReturnType<typeof setInterval>;

    /** ms since the recording began */
    private now(): number {
        return performance.now() - this.t0;
    }

    private newChunk(startMs: number): void {
        this.open = { startMs: Math.max(0, Math.round(startMs)), ops: [], samples: 0 };
        this.brushCache.clear();
        this.lastBrushId = undefined;
        this.lastLayer = undefined;
    }

    private flushRestore(): void {
        if (!this.pendingRestore) {
            return;
        }
        const early = this.pendingRestore;
        this.pendingRestore = undefined;
        clearTimeout(this.restoreTimer);
        const hashes = this.hashLayers(false);
        if (early.join() !== hashes.join()) {
            console.warn('klr: the restored picture changed after the app started', early, hashes);
        }
        this.open.restore = hashes;
    }

    /** Checks and copies the op (throws KlrUnencodable, keeping nothing), then keeps it. */
    private emit(op: TKlrOpInput, t = this.now()): void {
        this.flushRestore();
        this.push({ ...prepareOp(op), t } as TKlrOp);
    }

    private push(op: TKlrOp): void {
        this.open.ops.push(op);
        this.ops++;
        this.lastOpAt = performance.now();
    }

    hashLayers(useCache = true): number[] {
        return this.hasher.hash(this.api.klCanvas, this.api.klHistory, useCache);
    }

    private snapshotIds(): void {
        this.ids = this.api.klCanvas.getLayersReference().map((layer) => layer.id);
    }

    private brushNow(): { brush: TKlrBrushId; settings: Record<string, TKlrValue>; layer: number } {
        const brush = this.api.getBrushId() as TKlrBrushId;
        return { brush, settings: readBrushSettings(brush, this.api.getBrush()), layer: this.api.getLayerIndex() };
    }

    // BRUSH and LAYER before a stroke, for what changed since this chunk last said
    private emitBrushState(s: { brush: TKlrBrushId; settings: Record<string, TKlrValue>; layer: number }, t: number): void {
        const diff = diffBrushSettings(this.brushCache.get(s.brush), s.settings);
        if (s.brush !== this.lastBrushId || Object.keys(diff).length > 0) {
            this.emit({ op: 'brush', brush: s.brush, settings: diff }, t);
            this.brushCache.set(s.brush, s.settings);
            this.lastBrushId = s.brush;
        }
        if (s.layer !== this.lastLayer) {
            this.emit({ op: 'layer', index: s.layer }, t);
            this.lastLayer = s.layer;
        }
    }

    private grid(): PenGrid | null {
        const g = this.api.getGrid?.();
        return g ? { scale: g.scale, dpr: g.dpr, U: COORD_SCALE, key: String(g.scale) } : null;
    }

    private run<T>(fn: () => T): T {
        this.depth++;
        try {
            return fn();
        } finally {
            this.depth--;
            if (this.depth === 0) {
                this.snapshotIds();
            }
        }
    }

    // a history push: claimed by the op running, or the catch-all
    private onPush(entry: THistoryEntryData, replaceTop: boolean): void {
        if (this.depth > 0) {
            return;
        }
        this.catchAll++;
        console.warn('klr: a history entry with no opcode, stored as tiles (catch-all)', entry);
        try {
            const tiles: TKlrTiles = {};
            if (replaceTop) {
                tiles.replaceTop = true;
            }
            if (entry.size) {
                tiles.size = { ...entry.size };
            }
            if (entry.selection) {
                tiles.selection = { value: toKlrValue(entry.selection.value) };
            }
            const newIds: string[] = [];
            if (entry.layerMap) {
                tiles.layers = Object.entries(entry.layerMap).map(([layerId, layer]) => {
                    const src = this.ids.indexOf(layerId);
                    if (src < 0) {
                        newIds.push(layerId);
                    }
                    const { tiles: layerTiles, ...props } = layer;
                    return {
                        src,
                        props: toKlrValue(props) as Record<string, TKlrValue>,
                        ...(layerTiles ? { tiles: layerTiles.map(tileToKlr) } : {}),
                    };
                });
            }
            if (entry.activeLayerId !== undefined) {
                const src = this.ids.indexOf(entry.activeLayerId);
                tiles.activeLayer = src >= 0 ? src : -(newIds.indexOf(entry.activeLayerId) + 1);
            }
            this.emit({ op: 'tiles', tiles });
        } catch (e) {
            if (!(e instanceof KlrUnencodable)) {
                throw e;
            }
            this.unencodable++;
            console.warn('klr: a catch-all entry did not encode', e);
        }
        this.snapshotIds();
    }

    private canSeal(): boolean {
        return this.depth === 0 && !this.stroke && !this.api.isDrawing();
    }

    private tick(): void {
        if (this.open.ops.length === 0 || !this.canSeal()) {
            return;
        }
        const due =
            this.open.samples >= SEAL_SAMPLES ||
            this.open.ops.length >= SEAL_OPS ||
            this.now() - this.open.startMs >= SEAL_AGE_MS;
        if (due && performance.now() - this.lastOpAt >= QUIET_MS) {
            this.seal();
        }
    }

    // the open chunk coded: its ops' times from its start
    private encodeOpen(endHashes: number[]): Uint8Array {
        const start = this.open.startMs;
        const rel = (t: number) => Math.max(0, t - start);
        const ops = this.open.ops.map((op): TKlrOp => {
            if (op.op === 'stroke') {
                return {
                    ...op,
                    t: rel(op.t),
                    upT: rel(op.upT),
                    samples: op.samples.map((s): TKlrSample => [rel(s[0]), s[1], s[2], s[3]]),
                };
            }
            return { ...op, t: rel(op.t) };
        });
        return encodeOpsChunk({ startMs: start, ops, restore: this.open.restore, endHashes });
    }

    // ----------------------------------- public -----------------------------------

    /**
     * start: a new recording. restored: the recording a draft kept (embed-draft.ts), continued:
     * its chunks stay as they are and the next chunk starts on a restore (its header holds the
     * restored picture's hashes), as the page starts over from the draft's tiles with a fresh
     * history.
     */
    constructor(p: { api: TKlrAppApi; start: TKlrStart; build?: string; restored?: TKlrDraftState }) {
        this.api = p.api;
        const klCanvas = p.api.klCanvas;
        if (p.restored) {
            this.head = p.restored.head;
            this.sealed.push(...p.restored.sealed);
            this.t0 = performance.now() - p.restored.elapsedMs;
            this.seed = p.restored.seed;
            this.id = p.restored.id;
        } else {
            this.t0 = performance.now();
            this.head = encodeHeadChunk({
                build: p.build ?? getBuildId(),
                width: klCanvas.getWidth(),
                height: klCanvas.getHeight(),
                start: p.start,
                startHashes: this.hasher.hash(klCanvas, p.api.klHistory),
            });
        }
        this.newChunk(this.now());
        this.snapshotIds();
        if (p.restored) {
            // the restored picture's hashes, as the page shows it once it settled: just after
            // construction it can still differ (seen in Chrome), so they are taken before the
            // first op, the first draft save or seal, or after a moment, whichever is first
            this.pendingRestore = this.hashLayers(false);
            this.restoreTimer = setTimeout(() => this.flushRestore(), 300);
        }

        // every KlCanvas method that changes the picture, with its arguments as named fields
        for (const method of CANVAS_METHODS) {
            const orig = (klCanvas as any)[method];
            if (typeof orig !== 'function') {
                continue;
            }
            (klCanvas as any)[method] = (...args: unknown[]) =>
                this.op(
                    () => ({ op: 'canvas', method, fields: canvasFields(method, args) }),
                    () => orig.apply(klCanvas, args),
                );
            this.restore.push(() => delete (klCanvas as any)[method]);
        }
        p.api.klHistory.setPushObserver((entry, replaceTop) => this.onPush(entry, replaceTop));
        this.restore.push(() => p.api.klHistory.setPushObserver(undefined));
        klrHooks.rec = this;
        this.timer = setInterval(() => this.tick(), 1000);
    }

    op<T>(build: () => TKlrOpInput, fn: () => T): T {
        if (this.depth > 0) {
            return fn();
        }
        try {
            this.emit(build());
        } catch (e) {
            if (!(e instanceof KlrUnencodable)) {
                throw e;
            }
            // runs unclaimed: what it pushes goes to the catch-all
            this.unencodable++;
            console.warn('klr: op arguments not encodable', e);
            return fn();
        }
        return this.run(fn);
    }

    chainOut(e: TDrawEvent, fn: (e: TDrawEvent) => void): void {
        if (this.depth > 0) {
            fn(e);
            return;
        }
        this.flushRestore(); // before the canvas changes
        let q: TDrawEvent;
        if (e.type === 'down' || e.type === 'move') {
            q = { ...e, x: quantizeCoord(e.x), y: quantizeCoord(e.y), pressure: quantizePressure(e.pressure) };
        } else if (e.type === 'line') {
            q = {
                ...e,
                x0: e.x0 === null ? null : quantizeCoord(e.x0),
                y0: e.y0 === null ? null : quantizeCoord(e.y0),
                x1: quantizeCoord(e.x1),
                y1: quantizeCoord(e.y1),
            };
        } else {
            q = e;
        }
        const sample = (x: number, y: number, p: number): TKlrSample => [
            this.now(),
            Math.round(x * COORD_SCALE),
            Math.round(y * COORD_SCALE),
            Math.round(p * 255),
        ];
        if (q.type === 'down') {
            if (this.stroke) {
                this.endStroke(); // a DOWN without an UP: the last one ends here
            }
            const seed = this.nextSeed();
            klRandomSeed(seed);
            const t = this.now();
            this.stroke = {
                t,
                seed,
                samples: [sample(q.x, q.y, q.pressure)],
                transfers: [],
                grid: this.grid(),
                ...this.brushNow(),
            };
            this.strokes++;
        } else if (q.type === 'line') {
            try {
                this.emitBrushState(this.brushNow(), this.now());
            } catch (e) {
                if (!(e instanceof KlrUnencodable)) {
                    throw e;
                }
                this.unencodable++;
            }
            const seed = this.nextSeed();
            klRandomSeed(seed);
            const fromLast = q.x0 === null || q.y0 === null;
            try {
                this.emit({ op: 'line', x0: fromLast ? null : q.x0, y0: fromLast ? null : q.y0, x1: q.x1, y1: q.y1, seed });
            } catch (e) {
                if (!(e instanceof KlrUnencodable)) {
                    throw e;
                }
                this.unencodable++;
                console.warn('klr: a line not encodable', e);
            }
            this.strokes++;
        } else if (q.type === 'move') {
            this.stroke?.samples.push(sample(q.x, q.y, q.pressure));
        } else if (this.stroke) {
            this.endStroke();
        }
        this.run(() => fn(q));
    }

    // the held stroke becomes an op, after the brush and layer it was drawn with
    private endStroke(): void {
        const s = this.stroke!;
        this.stroke = undefined;
        try {
            this.emitBrushState(s, s.t);
        } catch (e) {
            if (!(e instanceof KlrUnencodable)) {
                throw e;
            }
            this.unencodable++;
            console.warn('klr: brush settings not encodable', e);
        }
        const upT = this.now();
        this.push({ op: 'stroke', t: s.t, seed: s.seed, samples: s.samples, transfers: s.transfers, upT, grid: s.grid });
        this.open.samples += s.samples.length;
        this.samples += s.samples.length;
    }

    transfer(fn: () => void): void {
        if (
            this.depth === 0 &&
            this.stroke &&
            typeof this.api.getBrush()?.transferToCanvas === 'function'
        ) {
            this.stroke.transfers.push(this.stroke.samples.length);
            this.run(fn);
        } else {
            fn();
        }
    }

    nextSeed(): number {
        return this.seed++;
    }

    nextId(): number {
        return this.id++;
    }

    /**
     * Codes the open chunk and starts the next. Not inside an op. During a stroke (a draft
     * checkpoint can come while the pen is down) it seals the ops before the stroke, without
     * end hashes (the canvas holds half a stroke); the stroke goes to the next chunk.
     */
    seal(): boolean {
        this.flushRestore();
        if (this.open.ops.length === 0 || this.depth > 0) {
            return false;
        }
        const t0 = performance.now();
        const hashes = this.stroke || this.api.isDrawing() ? [] : this.hashLayers();
        this.sealed.push(this.encodeOpen(hashes));
        const now = this.now();
        this.newChunk(this.stroke ? Math.min(now, this.stroke.t) : now);
        this.sealMs = performance.now() - t0;
        this.sealMaxMs = Math.max(this.sealMaxMs, this.sealMs);
        return true;
    }

    /**
     * Before a seal, in slices: reads back up to `max` of the layer tiles the seal's hashes
     * need (those changed since the last), so the seal itself is short. Returns how many are
     * left (0: the seal reads back nothing). Only while nothing is being drawn.
     */
    warmHashes(max: number): number {
        if (this.stroke || this.depth > 0 || this.api.isDrawing() || this.open.ops.length === 0) {
            return 0;
        }
        return this.hasher.warm(this.api.klCanvas, this.api.klHistory, max);
    }

    getChunks(): TKlrChunks {
        return { head: this.head, sealed: this.sealed.slice() };
    }

    /** The whole recording, the open chunk sealed first (a stroke still going on isn't in it). */
    getBytes(): Uint8Array {
        this.seal();
        const parts = [this.head, ...this.sealed];
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) {
            out.set(p, o);
            o += p.length;
        }
        return out;
    }

    /** For a draft: seals, then everything sealed, and how to continue. */
    getDraftState(): TKlrDraftState {
        this.seal();
        return {
            head: this.head,
            sealed: this.sealed.slice(),
            elapsedMs: this.now(),
            seed: this.seed,
            id: this.id,
        };
    }

    getInfo(): TKlrInfo {
        return {
            chunks: this.sealed.length,
            ops: this.ops,
            strokes: this.strokes,
            samples: this.samples,
            bytes: this.head.length + this.sealed.reduce((n, b) => n + b.length, 0),
            openOps: this.open.ops.length,
            catchAll: this.catchAll,
            unencodable: this.unencodable,
            hashTilesRead: this.hasher.tilesRead,
            sealMs: this.sealMs,
            sealMaxMs: this.sealMaxMs,
        };
    }

    destroy(): void {
        clearInterval(this.timer);
        clearTimeout(this.restoreTimer);
        this.restore.forEach((fn) => fn());
        if (klrHooks.rec === this) {
            klrHooks.rec = undefined;
        }
    }
}
