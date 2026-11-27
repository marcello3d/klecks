/**
 * Layer hashes for the .klr (klr-format.ts): FNV-1a 32 over the FNV-1a 32 of each 256 px tile,
 * read from the layer canvases. A tile's hash is kept while the history's tile object for it
 * stays the same (tiles are immutable: a change is a new object), so a seal reads back only
 * the tiles that changed since the last one.
 */
import { KlCanvas, TKlCanvasLayer } from '../klecks/canvas/kl-canvas';
import { HISTORY_TILE_SIZE, KlHistory } from '../klecks/history/kl-history';
import { fnv1a } from './klr-format';

export class KlrHasher {
    // tile object → (tile index → hash); a fill tile object may be shared between positions
    private cache = new WeakMap<object, Map<number, number>>();
    tilesRead = 0;

    private tileHash(klCanvas: KlCanvas, layer: TKlCanvasLayer, tile: object | undefined, i: number, cols: number): number {
        const w = klCanvas.getWidth();
        const h = klCanvas.getHeight();
        const x = (i % cols) * HISTORY_TILE_SIZE;
        const y = Math.floor(i / cols) * HISTORY_TILE_SIZE;
        const tw = Math.min(HISTORY_TILE_SIZE, w - x);
        const tht = Math.min(HISTORY_TILE_SIZE, h - y);
        const th = fnv1a(layer.context.getImageData(x, y, tw, tht).data);
        this.tilesRead++;
        if (tile) {
            let m = this.cache.get(tile);
            if (!m) {
                this.cache.set(tile, (m = new Map()));
            }
            m.set(i, th);
        }
        return th;
    }

    private grid(klCanvas: KlCanvas): { cols: number; n: number } {
        const cols = Math.ceil(klCanvas.getWidth() / HISTORY_TILE_SIZE);
        return { cols, n: cols * Math.ceil(klCanvas.getHeight() / HISTORY_TILE_SIZE) };
    }

    hash(klCanvas: KlCanvas, klHistory: KlHistory, useCache = true): number[] {
        const composed = klHistory.getComposed();
        const { cols, n } = this.grid(klCanvas);
        const bytes = new Uint8Array(4);
        return klCanvas.getLayersReference().map((layer) => {
            const tiles = composed.layerMap[layer.id]?.tiles;
            let out = 0x811c9dc5;
            for (let i = 0; i < n; i++) {
                const tile = tiles?.[i] as object | undefined;
                let th = useCache && tile ? this.cache.get(tile)?.get(i) : undefined;
                if (th === undefined) {
                    th = this.tileHash(klCanvas, layer, tile, i, cols);
                }
                bytes[0] = th >>> 24;
                bytes[1] = th >>> 16;
                bytes[2] = th >>> 8;
                bytes[3] = th;
                out = fnv1a(bytes, out);
            }
            return out;
        });
    }

    /** Reads back up to `max` of the tiles the next hash() would (the changed ones), so it can
     * be done in slices while the pen rests. Returns how many are left. */
    warm(klCanvas: KlCanvas, klHistory: KlHistory, max: number): number {
        const composed = klHistory.getComposed();
        const { cols, n } = this.grid(klCanvas);
        let left = 0;
        for (const layer of klCanvas.getLayersReference()) {
            const tiles = composed.layerMap[layer.id]?.tiles;
            for (let i = 0; i < n; i++) {
                const tile = tiles?.[i] as object | undefined;
                if (tile && this.cache.get(tile)?.get(i) !== undefined) {
                    continue;
                }
                if (max > 0 && tile) {
                    this.tileHash(klCanvas, layer, tile, i, cols);
                    max--;
                } else {
                    left++;
                }
            }
        }
        return left;
    }
}
