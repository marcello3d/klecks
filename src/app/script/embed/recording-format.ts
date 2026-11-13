/**
 * The pure parts of the timelapse recording (embed-recording.ts): sizes, the thinning schedule,
 * the draft's video pieces and the diff of two history states. No DOM and only type imports, so
 * `node --test` runs them as they are (scripts/test-recording-unit.mjs).
 * Design: docs/2draw-recording.md.
 */
import type {
    THistoryEntryDataComposed,
    THistoryEntryLayerComposed,
} from '../klecks/history/history.types';

export const RECORDING_FPS = 30;
export const KEY_EVERY = 300; // frames between keyframes
export const VIDEO_CAP = 1920; // long side
export const VIDEO_CAP_FALLBACK = 1280; // if no encoder takes 1920
export const BITRATE = 1_000_000;
export const MAX_CLIPS = 8;
const MIB = 1024 * 1024;
export const BYTES_CAP = 16 * MIB; // per upload, all clips together (2draw checks the same)
export const BYTES_STOP = 15.5 * MIB; // no more frames between submits past this
export const BYTES_MUX_CAP = BYTES_CAP - 64 * 1024; // chunk bytes a submit muxes at most
export const CODECS = ['avc1.640033', 'avc1.4d0033', 'avc1.42e033']; // High, Main, Constrained Baseline
const TILE_SIZE = 256; // HISTORY_TILE_SIZE (kl-history.ts), tied to the tile data

export type TVideoChunk = { bytes: Uint8Array; key: boolean };

// TTail.video in the draft (embed-draft.ts)
export type TVideoTail = {
    v: 1;
    clips: TVideoTailClip[];
};
export type TVideoTailClip = {
    codec: string;
    description: string; // base64
    width: number;
    height: number;
    fps: number;
    frames: number;
    pieces: number[]; // piece indices, in order
};

// The video's size for a canvas: the long side at most `cap`, both sides even.
export function videoSize(width: number, height: number, cap: number): [number, number] {
    const f = Math.min(1, cap / Math.max(width, height));
    const even = (v: number) => Math.max(2, Math.round((v * f) / 2) * 2);
    return [even(width), even(height)];
}

/**
 * Every how many steps a frame is made, by the bytes recorded so far: every step, then every
 * 2nd past 8 MiB, every 4th past 12 MiB, every 8th past 14 MiB. 0: none (past BYTES_STOP).
 */
export function thinStride(bytes: number): number {
    if (bytes >= BYTES_STOP) {
        return 0;
    }
    if (bytes >= 14 * MIB) {
        return 8;
    }
    if (bytes >= 12 * MIB) {
        return 4;
    }
    if (bytes >= 8 * MIB) {
        return 2;
    }
    return 1;
}

// A video piece: records of u32 length (little endian), u8 flags (bit 0: keyframe), the bytes.
export function packChunks(chunks: TVideoChunk[]): Uint8Array {
    let size = 0;
    chunks.forEach((c) => (size += 5 + c.bytes.length));
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    let pos = 0;
    for (const c of chunks) {
        view.setUint32(pos, c.bytes.length, true);
        out[pos + 4] = c.key ? 1 : 0;
        out.set(c.bytes, pos + 5);
        pos += 5 + c.bytes.length;
    }
    return out;
}

export function unpackChunks(piece: Uint8Array): TVideoChunk[] {
    const view = new DataView(piece.buffer, piece.byteOffset, piece.byteLength);
    const out: TVideoChunk[] = [];
    let pos = 0;
    while (pos < piece.length) {
        if (pos + 5 > piece.length) {
            throw new Error('Video piece truncated');
        }
        const length = view.getUint32(pos, true);
        const end = pos + 5 + length;
        if (end > piece.length) {
            throw new Error('Video piece truncated');
        }
        out.push({ key: (piece[pos + 4] & 1) === 1, bytes: piece.slice(pos + 5, end) });
        pos = end;
    }
    return out;
}

// Splits chunks into pieces of at most `max` bytes each (a larger chunk gets one of its own).
export function chunksToPieces(chunks: TVideoChunk[], max: number): Uint8Array[] {
    const pieces: Uint8Array[] = [];
    let run: TVideoChunk[] = [];
    let size = 0;
    for (const c of chunks) {
        if (run.length && size + 5 + c.bytes.length > max) {
            pieces.push(packChunks(run));
            run = [];
            size = 0;
        }
        run.push(c);
        size += 5 + c.bytes.length;
    }
    if (run.length) {
        pieces.push(packChunks(run));
    }
    return pieces;
}

export function bytesToBase64(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
}

export function base64ToBytes(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
    }
    return out;
}

export function sameBytes(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined) {
    if (!a || !b || a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

// Checks a tail's video field. Throws on anything malformed.
export function checkVideoTail(video: unknown, pieceCount: number): TVideoTail {
    const v = video as TVideoTail;
    if (!v || v.v !== 1 || !Array.isArray(v.clips)) {
        throw new Error('Unsupported recording');
    }
    for (const c of v.clips) {
        const ok =
            typeof c.codec === 'string' &&
            typeof c.description === 'string' &&
            c.width > 0 &&
            c.height > 0 &&
            c.frames >= 0 &&
            Array.isArray(c.pieces) &&
            c.pieces.every((p) => Number.isInteger(p) && p >= 0 && p < pieceCount);
        if (!ok) {
            throw new Error('Malformed recording clip');
        }
    }
    return v;
}

export type TPictureDiff =
    | { kind: 'none' }
    | { kind: 'resize' }
    | { kind: 'full' }
    | { kind: 'rect'; x0: number; y0: number; x1: number; y1: number }; // canvas pixels

function sortedLayers(composed: THistoryEntryDataComposed): THistoryEntryLayerComposed[] {
    return Object.values(composed.layerMap).sort((a, b) => a.index - b.index);
}

/**
 * What changed on the picture between two history states. Tiles are immutable, so a changed
 * tile is a changed reference. Selection and active layer don't count.
 */
export function diffComposed(
    prev: THistoryEntryDataComposed,
    next: THistoryEntryDataComposed,
): TPictureDiff {
    const { width, height } = next.size;
    if (prev.size.width !== width || prev.size.height !== height) {
        return { kind: 'resize' };
    }
    const a = sortedLayers(prev);
    const b = sortedLayers(next);
    if (a.length !== b.length) {
        return { kind: 'full' };
    }
    const cols = Math.ceil(width / TILE_SIZE);
    let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
    for (let i = 0; i < a.length; i++) {
        const la = a[i];
        const lb = b[i];
        if (
            la.opacity !== lb.opacity ||
            la.isVisible !== lb.isVisible ||
            la.mixModeStr !== lb.mixModeStr ||
            la.hasClipping !== lb.hasClipping ||
            la.tiles.length !== lb.tiles.length
        ) {
            return { kind: 'full' };
        }
        for (let t = 0; t < lb.tiles.length; t++) {
            if (la.tiles[t] !== lb.tiles[t]) {
                const tx = (t % cols) * TILE_SIZE;
                const ty = Math.floor(t / cols) * TILE_SIZE;
                x0 = Math.min(x0, tx);
                y0 = Math.min(y0, ty);
                x1 = Math.max(x1, Math.min(width, tx + TILE_SIZE));
                y1 = Math.max(y1, Math.min(height, ty + TILE_SIZE));
            }
        }
    }
    if (x1 < x0) {
        return { kind: 'none' };
    }
    return { kind: 'rect', x0, y0, x1, y1 };
}

// Where the canvas goes in a video frame: scaled to fill it, or (a canvas whose size differs
// from the clip's, past MAX_CLIPS) fitted and centred.
export type TPlacement = { sx: number; sy: number; ox: number; oy: number; w: number; h: number };
export function placement(
    canvasW: number,
    canvasH: number,
    videoW: number,
    videoH: number,
    fill: boolean,
): TPlacement {
    if (fill) {
        return { sx: videoW / canvasW, sy: videoH / canvasH, ox: 0, oy: 0, w: videoW, h: videoH };
    }
    const s = Math.min(videoW / canvasW, videoH / canvasH);
    const w = Math.max(1, Math.round(canvasW * s));
    const h = Math.max(1, Math.round(canvasH * s));
    return {
        sx: w / canvasW,
        sy: h / canvasH,
        ox: Math.floor((videoW - w) / 2),
        oy: Math.floor((videoH - h) / 2),
        w,
        h,
    };
}

// A canvas rectangle in video pixels, with a pixel of margin for the scaling filter.
export function videoRect(
    p: TPlacement,
    videoW: number,
    videoH: number,
    r: { x0: number; y0: number; x1: number; y1: number },
): { x: number; y: number; w: number; h: number } | null {
    const x0 = Math.max(0, Math.floor(p.ox + r.x0 * p.sx) - 1);
    const y0 = Math.max(0, Math.floor(p.oy + r.y0 * p.sy) - 1);
    const x1 = Math.min(videoW, Math.ceil(p.ox + r.x1 * p.sx) + 1);
    const y1 = Math.min(videoH, Math.ceil(p.oy + r.y1 * p.sy) + 1);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
