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
 * Chunks: the open OPS chunk is sealed (with a HASH of every layer) in a quiet gap once it is
 * big or old enough, or by seal(). Nothing here reads pixels except the seal.
 */
import { KlCanvas } from '../klecks/canvas/kl-canvas';
import { KlHistory } from '../klecks/history/kl-history';
import { THistoryEntryData, THistoryEntryLayerTile } from '../klecks/history/history.types';
import { klRandomSeed } from '../klecks/utils/kl-random';
import type { TDrawEvent } from '../klecks/kl-types';
import {
    CANVAS_METHODS,
    CHUNK_OPS,
    concatBytes,
    encodeChunk,
    encodeHead,
    fnv1a,
    KLR_ENGINE_V,
    KLR_FORMAT_VERSION,
    KLR_MAGIC,
    KlrOpsWriter,
    KlrUnencodable,
    quantizeCoord,
    quantizePressure,
    TKlrBrushId,
    TKlrOpInput,
    TKlrStart,
    TKlrTile,
    TKlrTiles,
    TKlrValue,
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
};

export type TKlrChunks = {
    head: Uint8Array; // magic + HEAD chunk
    sealed: Uint8Array[]; // OPS chunks, each ending with HASH
    open: Uint8Array | null; // the OPS chunk being written, no HASH yet
};

// What a draft keeps of the recording (embed-draft.ts) to continue it after a reload
export type TKlrDraftState = {
    head: Uint8Array; // magic + HEAD chunk
    sealed: Uint8Array[]; // OPS chunks, framed
    open: Uint8Array | null; // the open chunk up to its last op between strokes, framed
    elapsedMs: number; // since the recording started
    seed: number;
    id: number;
};

export type TKlrInfo = {
    chunks: number; // sealed
    ops: number;
    strokes: number;
    bytes: number; // head + sealed + open
    catchAll: number; // history entries stored as tiles: bugs
    unencodable: number; // ops whose arguments didn't encode (their entries went to the catch-all)
    hashTilesRead: number; // tiles read back for hashes (only changed ones are)
};

// seal the open chunk in a quiet gap once one of these is reached
// (the open chunk rides in a draft's tail, base64 in JSON, under 2draw's 512 kB tailMax)
const SEAL_BYTES = 64 * 1024;
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

export class KlrRecorder implements TKlrHookTarget {
    private readonly api: TKlrAppApi;
    private readonly head: Uint8Array; // magic + HEAD chunk
    private readonly sealed: Uint8Array[] = [];
    private readonly t0: number;
    private readonly hasher = new KlrHasher();
    // the open chunk up to its last op outside a stroke and outside an op: what a draft keeps
    private stableLength = 0;
    private stableOps = 0;
    private pendingRestore: number[] | undefined;
    private restoreTimer: ReturnType<typeof setTimeout> | undefined;
    private writer!: KlrOpsWriter;
    private chunkT0 = 0;
    private lastOpAt = 0;
    private depth = 0;
    private strokeActive = false;
    private seed = 1;
    private id = 1;
    private ops = 0;
    private strokes = 0;
    private catchAll = 0;
    private unencodable = 0;
    // per chunk: what the decoder knows
    private brushCache = new Map<string, Record<string, TKlrValue>>();
    private lastBrushId: string | undefined;
    private lastLayer: number | undefined;
    // layer ids before the next history push (for the catch-all's layer indices)
    private ids: string[] = [];
    private readonly restore: (() => void)[] = [];
    private readonly timer: ReturnType<typeof setInterval>;

    private now(): number {
        return performance.now() - this.chunkT0;
    }

    private newChunk(): void {
        this.chunkT0 = performance.now();
        this.writer = new KlrOpsWriter(this.chunkT0 - this.t0);
        this.brushCache.clear();
        this.lastBrushId = undefined;
        this.lastLayer = undefined;
        this.stableLength = this.writer.length;
        this.stableOps = 0;
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
        this.emit({ op: 'restore', hashes });
    }

    private emit(op: TKlrOpInput): void {
        if (this.pendingRestore) {
            this.flushRestore();
        }
        this.writer.write(op, this.now());
        this.ops++;
        this.lastOpAt = performance.now();
        this.markStable();
    }

    private markStable(): void {
        if (this.depth === 0 && !this.strokeActive) {
            this.stableLength = this.writer.length;
            this.stableOps = this.writer.opCount;
        }
    }

    hashLayers(useCache = true): number[] {
        return this.hasher.hash(this.api.klCanvas, this.api.klHistory, useCache);
    }

    private snapshotIds(): void {
        this.ids = this.api.klCanvas.getLayersReference().map((layer) => layer.id);
    }

    private emitBrushState(): void {
        const id = this.api.getBrushId() as TKlrBrushId;
        const settings = readBrushSettings(id, this.api.getBrush());
        const diff = diffBrushSettings(this.brushCache.get(id), settings);
        if (id !== this.lastBrushId || Object.keys(diff).length > 0) {
            this.emit({ op: 'brush', brush: id, settings: diff });
            this.brushCache.set(id, settings);
            this.lastBrushId = id;
        }
        const layer = this.api.getLayerIndex();
        if (layer !== this.lastLayer) {
            this.emit({ op: 'layer', index: layer });
            this.lastLayer = layer;
        }
    }

    private run<T>(fn: () => T): T {
        this.depth++;
        try {
            return fn();
        } finally {
            this.depth--;
            if (this.depth === 0) {
                this.snapshotIds();
                this.markStable();
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
        const tiles: TKlrTiles = {};
        if (replaceTop) {
            tiles.replaceTop = true;
        }
        if (entry.size) {
            tiles.size = { ...entry.size };
        }
        if (entry.selection) {
            tiles.selection = { value: entry.selection.value as TKlrValue };
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
                    props: props as Record<string, TKlrValue>,
                    ...(layerTiles ? { tiles: layerTiles.map(tileToKlr) } : {}),
                };
            });
        }
        if (entry.activeLayerId !== undefined) {
            const src = this.ids.indexOf(entry.activeLayerId);
            tiles.activeLayer = src >= 0 ? src : -(newIds.indexOf(entry.activeLayerId) + 1);
        }
        this.emit({ op: 'tiles', tiles });
        this.snapshotIds();
    }

    private canSeal(): boolean {
        return this.depth === 0 && !this.strokeActive && !this.api.isDrawing();
    }

    private tick(): void {
        if (this.writer.opCount === 0 || !this.canSeal()) {
            return;
        }
        const due =
            this.writer.length >= SEAL_BYTES ||
            this.writer.opCount >= SEAL_OPS ||
            this.now() >= SEAL_AGE_MS;
        if (due && performance.now() - this.lastOpAt >= QUIET_MS) {
            this.seal();
        }
    }

    // ----------------------------------- public -----------------------------------

    /**
     * start: a new recording. restored: the recording a draft kept (embed-draft.ts), continued:
     * its chunks stay as they are (the open one closes without a HASH) and the new chunk starts
     * with RESTORE, as the page starts over from the draft's tiles with a fresh history.
     */
    constructor(p: { api: TKlrAppApi; start: TKlrStart; build?: string; restored?: TKlrDraftState }) {
        this.api = p.api;
        const klCanvas = p.api.klCanvas;
        if (p.restored) {
            this.head = p.restored.head;
            this.sealed.push(...p.restored.sealed, ...(p.restored.open ? [p.restored.open] : []));
            this.t0 = performance.now() - p.restored.elapsedMs;
            this.seed = p.restored.seed;
            this.id = p.restored.id;
        } else {
            this.t0 = performance.now();
            this.head = concatBytes([
                KLR_MAGIC,
                encodeChunk(
                    1,
                    encodeHead({
                        formatVersion: KLR_FORMAT_VERSION,
                        engineV: KLR_ENGINE_V,
                        build: p.build ?? getBuildId(),
                        width: klCanvas.getWidth(),
                        height: klCanvas.getHeight(),
                        start: p.start,
                        startHashes: this.hasher.hash(klCanvas, p.api.klHistory),
                    }),
                ),
            ]);
        }
        this.newChunk();
        this.snapshotIds();
        if (p.restored) {
            // RESTORE goes first, with the picture as the page shows it once it settled: just
            // after construction it can still differ (seen in Chrome), so it is written before
            // the first op, the first draft save or seal, or after a moment, whichever is first
            this.pendingRestore = this.hashLayers(false);
            this.restoreTimer = setTimeout(() => this.flushRestore(), 300);
        }

        // every KlCanvas method that changes the picture, with its arguments
        for (const method of CANVAS_METHODS) {
            const orig = (klCanvas as any)[method];
            if (typeof orig !== 'function') {
                continue;
            }
            (klCanvas as any)[method] = (...args: unknown[]) =>
                this.op(
                    () => ({ op: 'canvas', method, args: args as TKlrValue[] }),
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
        if (q.type === 'down' || q.type === 'line') {
            this.emitBrushState();
            const seed = this.nextSeed();
            klRandomSeed(seed);
            if (q.type === 'down') {
                this.strokeActive = true; // first: a draft never keeps half a stroke
                this.emit({ op: 'down', x: q.x, y: q.y, p: q.pressure, seed });
            } else {
                const fromLast = q.x0 === null || q.y0 === null;
                this.emit({ op: 'line', x0: fromLast ? null : q.x0, y0: fromLast ? null : q.y0, x1: q.x1, y1: q.y1, seed });
            }
            this.strokes++;
        } else if (q.type === 'move') {
            this.emit({ op: 'move', x: q.x, y: q.y, p: q.pressure });
        } else {
            this.emit({ op: 'up' });
            this.strokeActive = false; // stable once the brush has pushed (run, below)
        }
        this.run(() => fn(q));
    }

    transfer(fn: () => void): void {
        if (
            this.depth === 0 &&
            this.strokeActive &&
            typeof this.api.getBrush()?.transferToCanvas === 'function'
        ) {
            this.emit({ op: 'transfer' });
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

    /** Ends the open chunk with a HASH of every layer. Not while a stroke is going on. */
    seal(): boolean {
        this.flushRestore();
        if (this.writer.opCount === 0 || !this.canSeal()) {
            return false;
        }
        this.emit({ op: 'hash', hashes: this.hashLayers() });
        this.sealed.push(encodeChunk(CHUNK_OPS, this.writer.bytes()));
        this.newChunk();
        return true;
    }

    getChunks(): TKlrChunks {
        return {
            head: this.head,
            sealed: this.sealed.slice(),
            open: this.writer.opCount ? encodeChunk(CHUNK_OPS, this.writer.bytes()) : null,
        };
    }

    /** The whole recording; seals the open chunk first when it can. */
    getBytes(): Uint8Array {
        this.seal();
        const c = this.getChunks();
        return concatBytes([c.head, ...c.sealed, ...(c.open ? [c.open] : [])]);
    }

    /** For a draft: everything up to the last op between strokes, and how to continue. */
    getDraftState(): TKlrDraftState {
        this.flushRestore();
        return {
            head: this.head,
            sealed: this.sealed.slice(),
            open: this.stableOps
                ? encodeChunk(CHUNK_OPS, this.writer.bytes().slice(0, this.stableLength))
                : null,
            elapsedMs: performance.now() - this.t0,
            seed: this.seed,
            id: this.id,
        };
    }

    getInfo(): TKlrInfo {
        const c = this.getChunks();
        return {
            chunks: c.sealed.length,
            ops: this.ops,
            strokes: this.strokes,
            bytes: c.head.length + c.sealed.reduce((n, b) => n + b.length, 0) + (c.open?.length ?? 0),
            catchAll: this.catchAll,
            unencodable: this.unencodable,
            hashTilesRead: this.hasher.tilesRead,
        };
    }

    destroy(): void {
        clearInterval(this.timer);
        this.restore.forEach((fn) => fn());
        if (klrHooks.rec === this) {
            klrHooks.rec = undefined;
        }
    }
}
