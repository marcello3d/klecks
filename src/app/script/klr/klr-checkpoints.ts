/**
 * What a set of KlrPlayer checkpoints (klr-player.ts) holds in memory. A checkpoint copies no
 * pixels: it keeps the history's entries and tiles, the selection samples and the clipboard images
 * as they were, shared with the player and with the other checkpoints. So what it costs is the
 * pixels nothing else would still hold: tiles the history has since let go (undone and replaced,
 * or trimmed from the oldest end), samples and clips of chunks gone by. Each pixel buffer (a tile's
 * ImageData, a canvas) is counted once however many checkpoints share it, the copies of the
 * layers' tiles (TKlrLayerCapture) included.
 *
 *   const bytes = new KlrCheckpointBytes();
 *   bytes.add(cp); bytes.remove(cp);
 *   bytes.total();          // every buffer the kept checkpoints hold
 *   bytes.beyond(cp);       // the ones `cp` itself does not hold
 */
import { THistoryEntry } from '../klecks/history/history.types';
import { TKlrCheckpoint } from './klr-player';

type TBuffers = Map<object, number>; // buffer → bytes

function addTiles(out: TBuffers, tiles: readonly unknown[] | undefined): void {
    if (!tiles) {
        return;
    }
    for (const tile of tiles) {
        const data = (tile as { data?: ImageData } | undefined)?.data;
        if (data && !out.has(data)) {
            out.set(data, data.data.byteLength);
        }
    }
}

function addCanvas(out: TBuffers, c: HTMLCanvasElement | undefined): void {
    if (c && !out.has(c)) {
        out.set(c, c.width * c.height * 4);
    }
}

export class KlrCheckpointBytes {
    private readonly refs = new Map<object, { bytes: number; n: number }>();
    private sum = 0;
    // an entry's buffers (entries never change once made), and a checkpoint's
    private readonly entryBuffers = new WeakMap<THistoryEntry, TBuffers>();
    private readonly cpBuffers = new WeakMap<TKlrCheckpoint, TBuffers>();

    private ofEntry(entry: THistoryEntry): TBuffers {
        let out = this.entryBuffers.get(entry);
        if (!out) {
            out = new Map();
            for (const layer of Object.values(entry.data.layerMap ?? {})) {
                addTiles(out, layer.tiles);
            }
            this.entryBuffers.set(entry, out);
        }
        return out;
    }

    /** The buffers `cp` holds, each once. */
    buffers(cp: TKlrCheckpoint): TBuffers {
        let out = this.cpBuffers.get(cp);
        if (!out) {
            out = new Map();
            for (const entry of cp.history.entries) {
                for (const [b, n] of this.ofEntry(entry)) {
                    out.set(b, n);
                }
            }
            for (const layer of Object.values(cp.history.composed.layerMap)) {
                addTiles(out, layer.tiles);
            }
            cp.samples.forEach((s) => addCanvas(out!, s?.image));
            cp.clips.forEach((c) => addCanvas(out!, c));
            for (const layer of cp.layers) {
                for (const t of layer.tiles) {
                    addCanvas(out, t.bmp);
                }
            }
            this.cpBuffers.set(cp, out);
        }
        return out;
    }

    /** The bytes of `cp`'s own buffers. */
    bytesOf(cp: TKlrCheckpoint): number {
        let n = 0;
        for (const b of this.buffers(cp).values()) {
            n += b;
        }
        return n;
    }

    add(cp: TKlrCheckpoint): void {
        for (const [b, bytes] of this.buffers(cp)) {
            const r = this.refs.get(b);
            if (r) {
                r.n++;
            } else {
                this.refs.set(b, { bytes, n: 1 });
                this.sum += bytes;
            }
        }
    }

    remove(cp: TKlrCheckpoint): void {
        for (const b of this.buffers(cp).keys()) {
            const r = this.refs.get(b);
            if (!r) {
                continue;
            }
            if (--r.n === 0) {
                this.refs.delete(b);
                this.sum -= r.bytes;
            }
        }
    }

    /** Every buffer the added checkpoints hold, each once. */
    total(): number {
        return this.sum;
    }

    /** What the added checkpoints hold beyond `cp`'s own buffers (`cp` added or not). */
    beyond(cp: TKlrCheckpoint): number {
        let own = 0;
        for (const b of this.buffers(cp).keys()) {
            own += this.refs.get(b)?.bytes ?? 0;
        }
        return this.sum - own;
    }
}
