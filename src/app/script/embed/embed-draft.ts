import { KlApp } from '../app/kl-app';
import { isLayerFill, TKlProject, TMixMode } from '../klecks/kl-types';
import {
    THistoryEntryDataComposed,
    THistoryEntryLayerComposed,
    TImageDataTile,
} from '../klecks/history/history.types';
import { sortLayerMap } from '../klecks/history/sort-layer-map';
import { deserializeRecovery, TRecoveryBundle } from '../klecks/storage/kl-recovery-serialization';
import { drawProject } from '../klecks/canvas/draw-project';
import { canvasToBlob } from '../bb/base/canvas';
import { randomUuid } from '../bb/base/base';
import { BB } from '../bb/bb';
import { EmbedInput, getEmbedInput } from './embed-input';
import type { EmbedRecording, TRecordingClip, TRecordingRestored } from './embed-recording';
import type { KlrRecorder, TKlrDraftState } from '../klr/klr-recorder';
import {
    base64ToBytes,
    bytesToBase64,
    checkVideoTail,
    chunksToPieces,
    RECORDING_FPS,
    TVideoChunk,
    TVideoTail,
    unpackChunks,
} from './recording-format';

/**
 * Drafts (opt-in): Klecks saves the drawing in progress through the embedder's store, so a reload
 * or a crash doesn't lose it. The store keeps the bytes as they are.
 *
 * Format 'klecks-tiles-1', the history's 256px tiles:
 * - head: TILES_HEAD.
 * - pieces: append-only. One or more tiles each, back to back: RGBA as in the tile's ImageData,
 *   deflated ('deflate-raw').
 * - tail: JSON (TTail). Per tile a fill color, or where it is: TTileRef.
 * - With a recording (embed-recording.ts), video pieces too: the encoded frames, runs of
 *   u32 length, u8 flags (bit 0: keyframe), bytes (recording-format.ts). TTail.video lists
 *   them per clip; a reader that doesn't know it ignores it.
 *
 * A save appends the tiles that weren't saved yet and replaces the tail. When most saved tiles
 * aren't used anymore, the next save starts over (fresh) with the live ones.
 *
 * Format 'klecks-tiles-2' (written since the .klr recording; tiles-1 is still read, forever):
 * tiles-1 plus, with recording: 'klr' (klr/klr-recorder.ts), TTail.klr: the recording's HEAD and
 * its sealed chunks as pieces of their own (one each, an OPS chunk with its TILES chunk if any).
 * Saves are checkpoints: in a quiet gap, every CHECKPOINT_MS or CHECKPOINT_CHANGES picture
 * changes, whichever comes first, and on flush. Every checkpoint seals the recording's open
 * chunk, so a draft holds no open chunk. The tiles and the recording in a save are taken at the
 * same moment, so a restored draft and its recording agree: the picture opens from the tiles
 * (never by replay) with a fresh undo history, and the recording goes on with a chunk that
 * starts on a restore (its header holds the restored picture's hashes).
 * A tiles-1 draft's video pieces are dropped under recording: 'klr' (no timelapse).
 */

export type TEmbedDraftSaved = {
    format: string;
    pieces: Uint8Array[]; // in order, without the head
    tail: Uint8Array;
};

export type TEmbedDraftSave = {
    format: string;
    head?: Uint8Array; // with fresh
    append: Uint8Array[]; // pieces, after those saved before
    tail: Uint8Array; // replaces the previous tail
    fresh?: boolean; // replaces everything saved before
    thumb?: Blob; // JPEG, at most 256px
};

export type TEmbedDraftStore = {
    save: (save: TEmbedDraftSave) => Promise<void>; // not called again until it settled
    changed: () => void; // the picture changed and isn't saved yet
    onFlush: (flush: () => Promise<void>) => void; // flush() saves right away, e.g. on page hide
    unreadable: (error: unknown) => void; // draft.saved couldn't be opened
};

export type TEmbedDraft = {
    saved: TEmbedDraftSaved | null;
    store: TEmbedDraftStore;
};

export const TILES_FORMAT = 'klecks-tiles-2';
const TILES_FORMATS_READ = ['klecks-tiles-1', 'klecks-tiles-2'];
const TILES_HEAD = 'klecks draft: tiles, klecks-tiles-2\n';
// checkpoints: whichever comes first, in a quiet gap
export const CHECKPOINT_MS = 30_000;
export const CHECKPOINT_CHANGES = 50; // picture changes (strokes, fills, ...) since the last one
const ENC_RAW = 0;
const ENC_DEFLATE = 1;
const QUIET_MS = 500; // the pen rests this long before a save (not between fast strokes)
const BATCH = 8; // tiles per worker task. Input is checked in between.
const HASH_BATCH = 8; // .klr hash tiles read back per slice before a checkpoint's seal
const PIECE_MAX = 1024 * 1024;
const COMPACT_MIN_BYTES = 4 * 1024 * 1024;
const COMPACT_PIECES = 4096;
const THUMB_PX = 256;
const THUMB_EVERY_MS = 5000;

// piece index (0 = first after the head), offset, length, width, height, encoding
type TTileRef = [number, number, number, number, number, number];

type TTail = {
    format: string;
    v: 1;
    width: number;
    height: number;
    projectId: string;
    layers: {
        name: string;
        opacity: number;
        visible: boolean;
        blend: TMixMode;
        clip: boolean;
        tiles: (TTileRef | string)[];
    }[];
    video?: TVideoTail;
    klr?: TKlrTail; // tiles-2
};

// v 2: .klr v0, sealed chunks only (v 1 carried an open chunk of the interim coding: dropped)
type TKlrTail = {
    v: 2;
    head: string; // base64: magic + HEAD chunk
    pieces: number[]; // the sealed chunks, one piece each, in order
    elapsedMs: number;
    seed: number;
    id: number;
};

export type TDraftRestored = {
    format: string;
    project: TKlProject;
    refs: Map<string, TTileRef>;
    pieceSizes: number[];
    video?: TRecordingRestored;
    klr?: TKlrDraftState;
    klrPieces?: number[]; // where klr.sealed is
};

// Deflates or inflates. Self-contained, as it also runs in the worker.
async function deflate(bytes: ArrayBufferView, inflate: boolean): Promise<Uint8Array> {
    const stream = inflate
        ? new DecompressionStream('deflate-raw')
        : new CompressionStream('deflate-raw');
    const blob = new Blob([bytes as BlobPart]);
    return new Uint8Array(await new Response(blob.stream().pipeThrough(stream)).arrayBuffer());
}

const canDeflate = typeof CompressionStream !== 'undefined';
let worker: Worker | null | undefined; // null: none (e.g. a CSP blocks it), the main thread does it
let lastJobId = 0;
const jobs = new Map<number, (result?: { out?: Uint8Array; error?: string }) => void>();

function deflateInWorker(bytes: ArrayBufferView, inflate: boolean): Promise<Uint8Array> {
    if (worker === undefined) {
        const src = `const deflate = ${deflate};
onmessage = async ({ data: { id, bytes, inflate } }) => {
    try {
        const out = await deflate(bytes, inflate);
        postMessage({ id, out }, [out.buffer]);
    } catch (e) {
        postMessage({ id, error: String(e) });
    }
};`;
        try {
            worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
            worker.onmessage = (e) => {
                jobs.get(e.data.id)?.(e.data);
                jobs.delete(e.data.id);
            };
            worker.onerror = (e) => {
                e.preventDefault();
                worker = null;
                jobs.forEach((done) => done());
                jobs.clear();
            };
        } catch (e) {
            worker = null;
        }
    }
    if (!worker) {
        return deflate(bytes, inflate);
    }
    const id = ++lastJobId;
    worker.postMessage({ id, bytes, inflate });
    return new Promise((resolve, reject) => {
        jobs.set(id, (result) => {
            if (!result) {
                deflate(bytes, inflate).then(resolve, reject);
            } else if (result.error) {
                reject(new Error(result.error));
            } else {
                resolve(result.out!);
            }
        });
    });
}

function getLayers(composed: THistoryEntryDataComposed): THistoryEntryLayerComposed[] {
    return Object.values(composed.layerMap).sort(sortLayerMap);
}

// What a save holds. Selection and active layer don't count. Tiles are immutable.
function getPictureKey(composed: THistoryEntryDataComposed): unknown[] {
    const key: unknown[] = [composed.size.width, composed.size.height];
    for (const l of getLayers(composed)) {
        key.push(l.name, l.opacity, l.isVisible, l.mixModeStr, l.hasClipping, ...l.tiles);
    }
    return key;
}

function concatBytes(parts: Uint8Array[], size: number): Uint8Array {
    const result = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

export async function restoreDraft(saved: TEmbedDraftSaved): Promise<TDraftRestored> {
    const tail = JSON.parse(new TextDecoder().decode(saved.tail)) as TTail;
    if (
        !TILES_FORMATS_READ.includes(saved.format) ||
        tail.format !== saved.format ||
        tail.v !== 1
    ) {
        throw new Error('Unsupported draft format: ' + saved.format);
    }
    // Every saved tile gets an id, so the next save only appends new tiles.
    const refs = new Map<string, TTileRef>();
    const idByRef = new Map<string, string>(); // a tile can be in more than one layer
    const layers = tail.layers.map((layer) => ({
        name: layer.name,
        opacity: layer.opacity,
        isVisible: layer.visible,
        mixModeStr: layer.blend,
        hasClipping: layer.clip,
        image: layer.tiles.map((tile) => {
            if (typeof tile === 'string') {
                return { fill: tile };
            }
            const key = tile[0] + ':' + tile[1];
            let id = idByRef.get(key);
            if (!id) {
                id = randomUuid();
                idByRef.set(key, id);
                refs.set(id, tile);
            }
            return { id, sizeBytes: tile[3] * tile[4] * 4 };
        }),
    }));

    const imageDataById: TRecoveryBundle['imageDataById'] = new Map();
    const entries = [...refs];
    for (let i = 0; i < entries.length; i += BATCH) {
        const batch = entries.slice(i, i + BATCH);
        await Promise.all(
            batch.map(async ([id, [piece, offset, length, width, height, enc]]) => {
                let bytes: Uint8Array = saved.pieces[piece].slice(offset, offset + length);
                if (enc === ENC_DEFLATE) {
                    bytes = await deflateInWorker(bytes, true);
                }
                const data = new Uint8ClampedArray(bytes.buffer as ArrayBuffer);
                imageDataById.set(id, new ImageData(data, width, height));
            }),
        );
    }
    const { project } = await deserializeRecovery({
        recovery: {
            projectId: tail.projectId,
            width: tail.width,
            height: tail.height,
            timestamp: 0,
            thumbnail: '',
            layers,
            memoryEstimateBytes: 0,
        },
        imageDataById,
    });
    return {
        format: saved.format,
        project,
        refs,
        pieceSizes: saved.pieces.map((piece) => piece.length),
        video: tail.video ? restoreVideo(tail.video, saved.pieces) : undefined,
        klr: tail.klr ? restoreKlr(tail.klr, saved.pieces) : undefined,
        klrPieces: tail.klr?.pieces.slice(),
    };
}

// The .klr in a draft. One that can't be read is dropped: the drawing opens, the recording
// starts over (from this picture, as a reference).
function restoreKlr(klr: TKlrTail, pieces: Uint8Array[]): TKlrDraftState | undefined {
    try {
        if (klr.v !== 2 || !klr.pieces.every((i) => i >= 0 && i < pieces.length)) {
            throw new Error('bad klr tail');
        }
        return {
            head: base64ToBytes(klr.head),
            sealed: klr.pieces.map((i) => pieces[i].slice()),
            elapsedMs: klr.elapsedMs,
            seed: klr.seed,
            id: klr.id,
        };
    } catch (e) {
        console.error('Draft recording (.klr) unreadable, dropped', e);
        return undefined;
    }
}

// The recording in a draft. One that can't be read is dropped: the drawing opens without it.
function restoreVideo(video: unknown, pieces: Uint8Array[]): TRecordingRestored | undefined {
    try {
        const tail = checkVideoTail(video, pieces.length);
        const clips: TRecordingClip[] = tail.clips.map((c) => {
            const chunks: TVideoChunk[] = [];
            c.pieces.forEach((i) => chunks.push(...unpackChunks(pieces[i])));
            if (chunks.length !== c.frames || (chunks.length && !chunks[0].key)) {
                throw new Error('Recording clip incomplete');
            }
            return {
                codec: c.codec,
                description: base64ToBytes(c.description),
                width: c.width,
                height: c.height,
                chunks,
                savedChunks: chunks.length,
                pieces: c.pieces.slice(),
            };
        });
        return { clips: clips.filter((c) => c.chunks.length > 0) };
    } catch (e) {
        console.error('Draft recording unreadable, dropped', e);
        return undefined;
    }
}

const ABORTED = new Error('aborted');

export type TEmbedDraftParams = {
    klApp: KlApp;
    store: TEmbedDraftStore;
    restored?: TDraftRestored;
    recording?: EmbedRecording; // saved with the tiles
    klr?: KlrRecorder; // saved with the tiles (tiles-2)
};

export type TDraftInfo = {
    format: string;
    checkpoints: number;
    // main-thread time of a checkpoint (deflating is in a worker; the store's own write isn't
    // counted), the last and the longest
    lastMs: number;
    maxMs: number;
    sliceMaxMs: number; // the longest stretch of a checkpoint's main-thread time without a break

    savedBytes: number; // pieces, as stored
    tailBytes: number;
    klrPieces: number;
};

/**
 * Saves into the embedder's store once the picture changed and the pen rested. One save at a
 * time. Tiles are deflated in a worker, a few per task, and the save stops if the artist starts
 * drawing (the tiles encoded so far are kept for the next one).
 */
export class EmbedDraft {
    private readonly klApp: KlApp;
    private readonly store: TEmbedDraftStore;
    private readonly input: EmbedInput;
    private readonly recording: EmbedRecording | undefined;
    private readonly klr: KlrRecorder | undefined;
    private klrPieces: number[] = []; // pieces holding the sealed chunks saved so far
    private lastCheckpointMs = performance.now();
    private busyMs = 0; // main-thread time of the save running
    private busyFrom = 0;
    private readonly info: TDraftInfo = {
        format: TILES_FORMAT,
        checkpoints: 0,
        lastMs: 0,
        maxMs: 0,
        sliceMaxMs: 0,
        savedBytes: 0,
        tailBytes: 0,
        klrPieces: 0,
    };
    private pictureKey: unknown[];
    private changeSeq: number = 0;
    private savedSeq: number = 0;
    private failedSeq: number = -1; // not retried until the next change
    private saving: Promise<void> | undefined;
    private timeout: ReturnType<typeof setTimeout> | undefined;
    private isUrgent: boolean = false; // flushing: no waiting
    private lastThumbMs: number = -Infinity;

    // what the store holds
    private hasCopy: boolean = false;
    private refs = new Map<string, TTileRef>(); // every tile saved, by id
    private pieceSizes: number[] = [];
    private compactWanted: boolean = false;
    private readonly encoded = new Map<string, { bytes: Uint8Array; enc: number }>();

    private isBusy(): boolean {
        return this.klApp.isDrawing() || this.input.waitMs(QUIET_MS) > 0;
    }

    private onHistoryChange(): void {
        const key = getPictureKey(this.klApp.getKlHistory().getComposed());
        if (
            key.length === this.pictureKey.length &&
            key.every((v, i) => v === this.pictureKey[i])
        ) {
            return;
        }
        this.pictureKey = key;
        this.changeSeq++;
        this.store.changed();
        if (this.changeSeq - this.savedSeq >= CHECKPOINT_CHANGES && this.timeout !== undefined) {
            // waiting for the clock: now it's the count
            clearTimeout(this.timeout);
            this.timeout = undefined;
        }
        this.schedule();
    }

    // ms until a checkpoint is due (0 or less: due)
    private dueInMs(): number {
        if (this.changeSeq - this.savedSeq >= CHECKPOINT_CHANGES) {
            return 0;
        }
        return this.lastCheckpointMs + CHECKPOINT_MS - performance.now();
    }

    // awaits p without counting the wait as the save's main-thread time
    private async w<T>(p: Promise<T>): Promise<T> {
        const slice = performance.now() - this.busyFrom;
        this.busyMs += slice;
        this.info.sliceMaxMs = Math.max(this.info.sliceMaxMs, slice);
        try {
            return await p;
        } finally {
            this.busyFrom = performance.now();
        }
    }

    private schedule(): void {
        if (
            this.timeout !== undefined ||
            this.saving ||
            this.isUrgent ||
            this.changeSeq === this.savedSeq ||
            this.changeSeq === this.failedSeq
        ) {
            return;
        }
        const quietMs = this.klApp.isDrawing() ? QUIET_MS : this.input.waitMs(QUIET_MS);
        const waitMs = Math.max(quietMs, this.dueInMs());
        this.timeout = setTimeout(
            () => {
                this.timeout = undefined;
                if (this.isBusy() || this.dueInMs() > 0) {
                    this.schedule();
                } else {
                    void this.startSave();
                }
            },
            Math.max(0, waitMs),
        );
    }

    private startSave(): Promise<void> {
        this.saving = this.save().finally(() => {
            this.saving = undefined;
            this.schedule();
        });
        return this.saving;
    }

    // lets input through. Throws ABORTED if the artist started drawing.
    private async giveWay(): Promise<void> {
        if (this.isUrgent) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve));
        if (!this.isUrgent && this.isBusy()) {
            throw ABORTED;
        }
    }

    private async makeThumb(): Promise<Blob> {
        const project = this.klApp.getProject();
        const factor = Math.min(1, THUMB_PX / Math.max(project.width, project.height));
        const canvas = drawProject(project, factor);
        const ctx = BB.ctx(canvas);
        ctx.globalCompositeOperation = 'destination-over'; // JPEG: white instead of transparent
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        try {
            return await canvasToBlob(canvas, 'image/jpeg');
        } finally {
            BB.freeCanvas(canvas);
        }
    }

    private async save(): Promise<void> {
        this.busyMs = 0;
        this.busyFrom = performance.now();
        // the recording's seal hashes the changed layer tiles: read them back a few at a time
        // first, giving way to input (drawing aborts the save; what was read is kept)
        try {
            while (this.klr && !this.isUrgent && this.klr.warmHashes(HASH_BATCH) > 0) {
                await this.w(this.giveWay());
            }
        } catch (e) {
            if (e === ABORTED) {
                return;
            }
            throw e;
        }
        const seq = this.changeSeq;
        const composed = this.klApp.getKlHistory().getComposed();
        // the recording at the same moment as the picture (sealed: no open chunk in a draft)
        const klrState = this.klr?.getDraftState();
        const layers = getLayers(composed);
        const fresh = !this.hasCopy || this.compactWanted;
        const known = fresh ? new Map<string, TTileRef>() : this.refs;
        const tiles = new Map<string, TImageDataTile>(); // to save, in order
        for (const layer of layers) {
            for (const tile of layer.tiles) {
                if (!isLayerFill(tile) && !known.has(tile.id)) {
                    tiles.set(tile.id, tile);
                }
            }
        }
        for (const id of this.encoded.keys()) {
            if (!tiles.has(id)) {
                this.encoded.delete(id);
            }
        }

        try {
            const todo = [...tiles.values()].filter((tile) => !this.encoded.has(tile.id));
            for (let i = 0; i < todo.length; i += BATCH) {
                await this.w(this.giveWay());
                // flushing: stored raw, no worker round trip
                const enc = this.isUrgent || !canDeflate ? ENC_RAW : ENC_DEFLATE;
                await this.w(Promise.all(
                    todo.slice(i, i + BATCH).map(async (tile) => {
                        const d = tile.data.data;
                        const bytes =
                            enc === ENC_RAW
                                ? new Uint8Array(d.buffer, d.byteOffset, d.length)
                                : await deflateInWorker(d, false);
                        this.encoded.set(tile.id, { bytes, enc });
                    }),
                ));
            }

            const firstPiece = fresh ? 0 : this.pieceSizes.length;
            const append: Uint8Array[] = [];
            const newRefs = new Map<string, TTileRef>();
            let parts: Uint8Array[] = [];
            let size = 0;
            const closePiece = () => {
                if (parts.length) {
                    append.push(concatBytes(parts, size));
                    parts = [];
                    size = 0;
                }
            };
            for (const tile of tiles.values()) {
                const { bytes, enc } = this.encoded.get(tile.id)!;
                if (size + bytes.length > PIECE_MAX) {
                    closePiece();
                    await this.w(this.giveWay());
                }
                const { width, height } = tile.data;
                newRefs.set(tile.id, [
                    firstPiece + append.length,
                    size,
                    bytes.length,
                    width,
                    height,
                    enc,
                ]);
                parts.push(bytes);
                size += bytes.length;
            }
            closePiece();

            // the recording: its new frames (all of them when fresh), in pieces of their own
            let video: TVideoTail | undefined;
            const videoCommit: { clip: TRecordingClip; to: number; pieces: number[] }[] = [];
            if (this.recording) {
                const parts = await this.w(this.recording.prepareSave(this.isUrgent, fresh));
                if (parts.length) {
                    video = { v: 1, clips: [] };
                    for (const { clip, from, to } of parts) {
                        const indices = fresh ? [] : clip.pieces.slice();
                        for (const piece of chunksToPieces(clip.chunks.slice(from, to), PIECE_MAX)) {
                            indices.push(firstPiece + append.length);
                            append.push(piece);
                        }
                        videoCommit.push({ clip, to, pieces: indices });
                        video.clips.push({
                            codec: clip.codec,
                            description: bytesToBase64(clip.description),
                            width: clip.width,
                            height: clip.height,
                            fps: RECORDING_FPS,
                            frames: to,
                            pieces: indices,
                        });
                    }
                }
            }

            // the recording: sealed chunks not saved yet (all of them when fresh), a piece each
            let klr: TKlrTail | undefined;
            const klrPieces = fresh ? [] : this.klrPieces.slice();
            if (klrState) {
                for (const chunk of klrState.sealed.slice(klrPieces.length)) {
                    klrPieces.push(firstPiece + append.length);
                    append.push(chunk);
                }
                klr = {
                    v: 2,
                    head: bytesToBase64(klrState.head),
                    pieces: klrPieces,
                    elapsedMs: Math.round(klrState.elapsedMs),
                    seed: klrState.seed,
                    id: klrState.id,
                };
            }

            const tail: TTail = {
                format: TILES_FORMAT,
                v: 1,
                width: composed.size.width,
                height: composed.size.height,
                projectId: composed.projectId.value,
                layers: layers.map((layer) => ({
                    name: layer.name,
                    opacity: layer.opacity,
                    visible: layer.isVisible,
                    blend: layer.mixModeStr,
                    clip: layer.hasClipping,
                    tiles: layer.tiles.map((tile) =>
                        isLayerFill(tile)
                            ? tile.fill
                            : (newRefs.get(tile.id) ?? known.get(tile.id)!),
                    ),
                })),
                ...(video ? { video } : {}),
                ...(klr ? { klr } : {}),
            };
            const tailBytes = new TextEncoder().encode(JSON.stringify(tail));
            const withThumb =
                this.isUrgent || performance.now() - this.lastThumbMs > THUMB_EVERY_MS;
            const thumb = withThumb ? await this.w(this.makeThumb()) : undefined;
            await this.w(this.giveWay());
            await this.w(this.store.save({
                format: TILES_FORMAT,
                ...(fresh ? { head: new TextEncoder().encode(TILES_HEAD), fresh: true } : {}),
                append,
                tail: tailBytes,
                ...(thumb ? { thumb } : {}),
            }));

            if (thumb) {
                this.lastThumbMs = performance.now();
            }
            if (fresh) {
                this.refs = new Map();
                this.pieceSizes = [];
            }
            newRefs.forEach((ref, id) => {
                this.refs.set(id, ref);
                this.encoded.delete(id);
            });
            this.pieceSizes.push(...append.map((piece) => piece.length));
            this.recording?.committed(videoCommit);
            this.klrPieces = klrPieces;
            this.hasCopy = true;
            this.savedSeq = seq;
            this.lastCheckpointMs = performance.now();
            this.compactWanted = this.shouldCompact(layers);
            const slice = performance.now() - this.busyFrom;
            this.busyMs += slice;
            this.info.sliceMaxMs = Math.max(this.info.sliceMaxMs, slice);
            this.info.checkpoints++;
            this.info.lastMs = this.busyMs;
            this.info.maxMs = Math.max(this.info.maxMs, this.busyMs);
            this.info.savedBytes = this.pieceSizes.reduce((n, size) => n + size, 0);
            this.info.tailBytes = tailBytes.length;
            this.info.klrPieces = klrPieces.length;
        } catch (e) {
            if (e !== ABORTED) {
                this.failedSeq = seq;
                console.error('Draft save failed', e);
            }
        }
    }

    // when most saved bytes are tiles that aren't used anymore
    private shouldCompact(layers: THistoryEntryLayerComposed[]): boolean {
        const live = new Set<TTileRef>();
        for (const layer of layers) {
            for (const tile of layer.tiles) {
                if (!isLayerFill(tile)) {
                    live.add(this.refs.get(tile.id)!);
                }
            }
        }
        let liveBytes = 0;
        live.forEach((ref) => (liveBytes += ref[2]));
        // the recordings' pieces are all live
        this.klrPieces.forEach((i) => (liveBytes += this.pieceSizes[i] ?? 0));
        this.recording?.clips.forEach((clip) =>
            clip.pieces.forEach((i) => (liveBytes += this.pieceSizes[i] ?? 0)),
        );
        const savedBytes = this.pieceSizes.reduce((a, b) => a + b, 0);
        return (
            savedBytes > 2 * liveBytes + COMPACT_MIN_BYTES ||
            this.pieceSizes.length > COMPACT_PIECES
        );
    }

    // ----------------------------------- public -----------------------------------
    constructor(p: TEmbedDraftParams) {
        this.klApp = p.klApp;
        this.store = p.store;
        this.input = getEmbedInput();
        this.recording = p.recording;
        this.klr = p.klr;
        const composed = this.klApp.getKlHistory().getComposed();
        this.pictureKey = getPictureKey(composed);
        if (p.restored) {
            this.hasCopy = true;
            this.refs = p.restored.refs;
            this.pieceSizes = p.restored.pieceSizes;
            if (p.restored.klr && this.klr) {
                // the recorder continues what the draft holds: its sealed chunks are saved
                this.klrPieces = p.restored.klrPieces ?? [];
            }
            // an older format: start over in this one
            this.compactWanted =
                p.restored.format !== TILES_FORMAT || this.shouldCompact(getLayers(composed));
        }
        this.klApp.getKlHistory().addListener(() => this.onHistoryChange());
        this.store.onFlush(() => this.flush());
    }

    getInfo(): TDraftInfo {
        return { ...this.info };
    }

    // saves now if the picture changed since the last save
    async flush(): Promise<void> {
        clearTimeout(this.timeout);
        this.timeout = undefined;
        this.isUrgent = true;
        try {
            // a stroke that just ended is in the history a moment later
            const endMs = performance.now() + 500;
            while (this.klApp.isDrawing() && performance.now() < endMs) {
                await new Promise((resolve) => setTimeout(resolve));
            }
            this.onHistoryChange(); // history listeners run in a timeout
            while (this.saving) {
                await this.saving;
            }
            if (this.changeSeq !== this.savedSeq) {
                await this.startSave();
            }
        } finally {
            this.isUrgent = false;
            this.schedule();
        }
    }
}
