/**
 * Layer hashes for the .klr (klr-format.ts): FNV-1a 32 over the FNV-1a 32 of each 256 px tile,
 * read from the layer canvases. A tile's hash is kept while the history's tile object for it
 * stays the same (tiles are immutable: a change is a new object), so a seal reads back only
 * the tiles that changed since the last one.
 */
import { KlCanvas } from '../klecks/canvas/kl-canvas';
import { HISTORY_TILE_SIZE, KlHistory } from '../klecks/history/kl-history';
import { fnv1a } from './klr-format';

export class KlrHasher {
    // tile object → (tile index → hash); a fill tile object may be shared between positions
    private cache = new WeakMap<object, Map<number, number>>();
    tilesRead = 0;

    hash(klCanvas: KlCanvas, klHistory: KlHistory, useCache = true): number[] {
        const composed = klHistory.getComposed();
        const w = klCanvas.getWidth();
        const h = klCanvas.getHeight();
        const cols = Math.ceil(w / HISTORY_TILE_SIZE);
        const rows = Math.ceil(h / HISTORY_TILE_SIZE);
        const bytes = new Uint8Array(4);
        return klCanvas.getLayersReference().map((layer) => {
            const tiles = composed.layerMap[layer.id]?.tiles;
            let out = 0x811c9dc5;
            for (let i = 0; i < cols * rows; i++) {
                const tile = tiles?.[i] as object | undefined;
                let th = useCache && tile ? this.cache.get(tile)?.get(i) : undefined;
                if (th === undefined) {
                    const x = (i % cols) * HISTORY_TILE_SIZE;
                    const y = Math.floor(i / cols) * HISTORY_TILE_SIZE;
                    const tw = Math.min(HISTORY_TILE_SIZE, w - x);
                    const tht = Math.min(HISTORY_TILE_SIZE, h - y);
                    th = fnv1a(layer.context.getImageData(x, y, tw, tht).data);
                    this.tilesRead++;
                    if (tile) {
                        let m = this.cache.get(tile);
                        if (!m) {
                            this.cache.set(tile, (m = new Map()));
                        }
                        m.set(i, th);
                    }
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
}
