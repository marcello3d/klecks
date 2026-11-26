/**
 * `.klr`: Klecks input recording, the binary coder. Pure (no DOM, only type imports), so
 * `node --test scripts/test-klr-unit.mjs` runs it as is. Built on Lascaux's .lsa v3 primitives
 * (klr-bytes.ts: LEB128 varints, zigzag deltas). Design: worker/KLECKS-RECORDING-PLAN.md in
 * 2draw.net; docs/2draw-klr.md here.
 *
 *   magic  89 4B 4C 52                       ("\x89KLR")
 *   chunk* u8 type | varint length | payload
 *
 *   HEAD (1)  varint format version, varint engineV, string build, varint width, height,
 *             u8 start kind (0 blank: value-coded layer list; 1 reference: string URL),
 *             varint layer count, u32 FNV-1a per layer at the start
 *   OPS  (2)  varint start ms (since the recording started), then ops until the payload ends:
 *             u8 opcode | varint dt ms | arguments. Self-contained: the clock starts at 0, the
 *             coordinate deltas start at 0, the first stroke of each brush restates all its
 *             settings and the first stroke restates the layer. A sealed chunk ends with HASH.
 *
 * Coordinates are 1/32 px (zigzag varint deltas from the previous point of the chunk),
 * pressure is u8. Other arguments use a small tagged value coding (writeValue). There is no
 * blob chunk: the recording never holds an image from outside Klecks (the catch-all TILES op
 * holds tiles Klecks drew itself, and counts as a bug).
 */
import { ByteReader, ByteWriter, concatBytes } from './klr-bytes.ts';

export const KLR_MAGIC = Uint8Array.of(0x89, 0x4b, 0x4c, 0x52);
export const KLR_FORMAT_VERSION = 1;
// What the replaying engine must do the same way. Bump with a change that would make old
// recordings replay differently, and keep the old behaviour behind `engineV` checks.
export const KLR_ENGINE_V = 1;

export const CHUNK_HEAD = 1;
export const CHUNK_OPS = 2;

export const COORD_SCALE = 32;

// Opcodes. Append only.
export const OP = {
    DOWN: 0x01,
    MOVE: 0x02,
    UP: 0x03,
    LINE: 0x04,
    TRANSFER: 0x05, // the easel's per-frame transferToCanvas
    BRUSH: 0x10, // brush id + changed settings
    LAYER: 0x11, // the layer strokes go to
    CANVAS: 0x20, // 0x20 + index into CANVAS_METHODS
    FILTER: 0x40,
    UNDO: 0x41,
    REDO: 0x42,
    ACTIVE: 0x43, // active layer pushed to the history (layer list click)
    SAMPLE: 0x44, // selection sample taken for a transform
    XFORM: 0x45, // select tool free transform applied
    FFD: 0x46, // select tool warp applied
    COPY: 0x47, // in-app copy into the in-memory clipboard
    PASTE: 0x48, // in-app paste as a new layer
    TILES: 0x7e, // catch-all: a history entry with no opcode, as tiles (a bug to fix)
    HASH: 0x7f, // FNV-1a 32 per layer
} as const;

// KlCanvas methods recorded with their arguments. Append only (the index is the opcode).
export const CANVAS_METHODS = [
    'reset',
    'resize',
    'cropExtend',
    'addLayer',
    'duplicateLayer',
    'removeLayer',
    'renameLayer',
    'setOpacity',
    'setLayerIsVisible',
    'setLayerHasClipping',
    'moveLayer',
    'mergeLayer',
    'mergeAll',
    'rotate',
    'flip',
    'layerFill',
    'floodFill',
    'drawShape',
    'drawGradient',
    'text',
    'eraseLayer',
    'setMixMode',
    'setSelection',
] as const;
export type TKlrCanvasMethod = (typeof CANVAS_METHODS)[number];

// Brushes by u8 index. Append only.
export const BRUSH_IDS = [
    'penBrush',
    'blendBrush',
    'sketchyBrush',
    'pixelBrush',
    'chemyBrush',
    'smudgeBrush',
    'eraserBrush',
] as const;
export type TKlrBrushId = (typeof BRUSH_IDS)[number];

// ---------------------------------------------------------------- values

export type TKlrValue =
    | undefined
    | null
    | boolean
    | number
    | string
    | Uint8Array
    | TKlrValue[]
    | { [key: string]: TKlrValue };

const V_UNDEF = 0;
const V_NULL = 1;
const V_FALSE = 2;
const V_TRUE = 3;
const V_INT = 4;
const V_F32 = 5;
const V_F64 = 6;
const V_STR = 7;
const V_ARR = 8;
const V_OBJ = 9;
const V_BYTES = 10;

export class KlrUnencodable extends Error {}

function isHostObject(v: object): boolean {
    const g = globalThis as any;
    for (const name of [
        'Node',
        'ImageData',
        'ImageBitmap',
        'CanvasRenderingContext2D',
        'OffscreenCanvas',
        'Path2D',
        'CanvasPattern',
        'CanvasGradient',
        'Blob',
    ]) {
        if (typeof g[name] === 'function' && v instanceof g[name]) {
            return true;
        }
    }
    return false;
}

/** Tagged value: plain data only. Throws KlrUnencodable for functions, canvases, images... */
export function writeValue(w: ByteWriter, v: unknown, depth = 0): void {
    if (depth > 32) {
        throw new KlrUnencodable('too deep');
    }
    if (v === undefined) {
        w.u8(V_UNDEF);
    } else if (v === null) {
        w.u8(V_NULL);
    } else if (v === false) {
        w.u8(V_FALSE);
    } else if (v === true) {
        w.u8(V_TRUE);
    } else if (typeof v === 'number') {
        if (Number.isSafeInteger(v) && !Object.is(v, -0)) {
            w.u8(V_INT);
            w.svarint(v);
        } else if (Math.fround(v) === v || Object.is(v, -0)) {
            w.u8(V_F32);
            w.f32(v);
        } else {
            w.u8(V_F64);
            w.f64(v);
        }
    } else if (typeof v === 'string') {
        w.u8(V_STR);
        w.string(v);
    } else if (v instanceof Uint8Array) {
        w.u8(V_BYTES);
        w.blob(v);
    } else if (Array.isArray(v)) {
        w.u8(V_ARR);
        w.varint(v.length);
        for (const item of v) {
            writeValue(w, item, depth + 1);
        }
    } else if (typeof v === 'object') {
        if (ArrayBuffer.isView(v) || isHostObject(v)) {
            throw new KlrUnencodable('not plain data');
        }
        const keys = Object.keys(v);
        w.u8(V_OBJ);
        w.varint(keys.length);
        for (const key of keys) {
            w.string(key);
            writeValue(w, (v as Record<string, unknown>)[key], depth + 1);
        }
    } else {
        throw new KlrUnencodable('not plain data: ' + typeof v);
    }
}

export function readValue(r: ByteReader): TKlrValue {
    const tag = r.u8();
    switch (tag) {
        case V_UNDEF:
            return undefined;
        case V_NULL:
            return null;
        case V_FALSE:
            return false;
        case V_TRUE:
            return true;
        case V_INT:
            return r.svarint();
        case V_F32:
            return r.f32();
        case V_F64:
            return r.f64();
        case V_STR:
            return r.string();
        case V_BYTES:
            return r.blob().slice();
        case V_ARR: {
            const n = r.varint();
            const out: TKlrValue[] = [];
            for (let i = 0; i < n; i++) {
                out.push(readValue(r));
            }
            return out;
        }
        case V_OBJ: {
            const n = r.varint();
            const out: Record<string, TKlrValue> = {};
            for (let i = 0; i < n; i++) {
                const key = r.string();
                out[key] = readValue(r);
            }
            return out;
        }
    }
    throw new Error('klr: bad value tag ' + tag);
}

/** Encodes to bytes on its own, so a caller can find out first whether it encodes. */
export function encodeValue(v: unknown): Uint8Array {
    const w = new ByteWriter(64);
    writeValue(w, v);
    return w.toBytes();
}

// ---------------------------------------------------------------- hashing

export function fnv1a(data: ArrayLike<number>, h = 0x811c9dc5): number {
    for (let i = 0; i < data.length; i++) {
        h ^= data[i];
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

// ---------------------------------------------------------------- quantization

export const quantizeCoord = (v: number): number => Math.round(v * COORD_SCALE) / COORD_SCALE;
export const quantizePressure = (v: number): number =>
    Math.round(Math.max(0, Math.min(1, v)) * 255) / 255;

// ---------------------------------------------------------------- ops

export type TKlrTile = undefined | { fill: string } | { w: number; h: number; data: Uint8Array };
export type TKlrTilesLayer = {
    // index in the layer list before the entry, -1: a new layer
    src: number;
    props: Record<string, TKlrValue>; // name, opacity, isVisible, mixModeStr, hasClipping, index
    tiles?: TKlrTile[];
};
export type TKlrTiles = {
    size?: { width: number; height: number };
    selection?: { value?: TKlrValue };
    // >= 0: layer at that index before the entry; < 0: -(k + 1), the k-th new layer in `layers`
    activeLayer?: number;
    layers?: TKlrTilesLayer[];
};

export type TKlrOp =
    | { op: 'down'; t: number; x: number; y: number; p: number; seed: number }
    | { op: 'move'; t: number; x: number; y: number; p: number }
    | { op: 'up'; t: number }
    | {
          op: 'line';
          t: number;
          x0: number;
          y0: number;
          x1: number;
          y1: number;
          p0: number;
          p1: number;
          seed: number;
      }
    | { op: 'transfer'; t: number }
    | { op: 'brush'; t: number; brush: TKlrBrushId; settings: Record<string, TKlrValue> }
    | { op: 'layer'; t: number; index: number }
    | { op: 'canvas'; t: number; method: TKlrCanvasMethod; args: TKlrValue[] }
    | { op: 'filter'; t: number; name: string; layer: number; seed: number; input: TKlrValue }
    | { op: 'undo'; t: number }
    | { op: 'redo'; t: number }
    | { op: 'active'; t: number; index: number }
    | { op: 'sample'; t: number; id: number; layer: number }
    | { op: 'xform'; t: number; sample: number; params: TKlrValue }
    | { op: 'ffd'; t: number; sample: number; params: TKlrValue }
    | { op: 'copy'; t: number; id: number; mask: boolean }
    | { op: 'paste'; t: number; id: number; params: TKlrValue }
    | { op: 'tiles'; t: number; tiles: TKlrTiles }
    | { op: 'hash'; t: number; hashes: number[] };

// An op as the recorder hands it over: the writer adds the time.
export type TKlrOpInput = TKlrOp extends infer O
    ? O extends { t: number }
        ? Omit<O, 't'>
        : never
    : never;

function writeTile(w: ByteWriter, tile: TKlrTile): void {
    if (!tile) {
        w.u8(0);
    } else if ('fill' in tile) {
        w.u8(1);
        w.string(tile.fill);
    } else {
        w.u8(2);
        w.varint(tile.w);
        w.varint(tile.h);
        w.bytes(tile.data);
    }
}

function readTile(r: ByteReader): TKlrTile {
    const kind = r.u8();
    if (kind === 0) {
        return undefined;
    }
    if (kind === 1) {
        return { fill: r.string() };
    }
    const w = r.varint();
    const h = r.varint();
    return { w, h, data: r.bytes(w * h * 4).slice() };
}

function writeTiles(w: ByteWriter, t: TKlrTiles): void {
    w.u8((t.size ? 1 : 0) | (t.selection ? 2 : 0) | (t.activeLayer !== undefined ? 4 : 0) | (t.layers ? 8 : 0));
    if (t.size) {
        w.varint(t.size.width);
        w.varint(t.size.height);
    }
    if (t.selection) {
        writeValue(w, t.selection.value);
    }
    if (t.activeLayer !== undefined) {
        w.svarint(t.activeLayer);
    }
    if (t.layers) {
        w.varint(t.layers.length);
        for (const layer of t.layers) {
            w.svarint(layer.src);
            writeValue(w, layer.props);
            if (layer.tiles) {
                w.varint(layer.tiles.length + 1);
                layer.tiles.forEach((tile) => writeTile(w, tile));
            } else {
                w.varint(0);
            }
        }
    }
}

function readTiles(r: ByteReader): TKlrTiles {
    const flags = r.u8();
    const out: TKlrTiles = {};
    if (flags & 1) {
        out.size = { width: r.varint(), height: r.varint() };
    }
    if (flags & 2) {
        out.selection = { value: readValue(r) };
    }
    if (flags & 4) {
        out.activeLayer = r.svarint();
    }
    if (flags & 8) {
        const n = r.varint();
        out.layers = [];
        for (let i = 0; i < n; i++) {
            const src = r.svarint();
            const props = readValue(r) as Record<string, TKlrValue>;
            const nTiles = r.varint();
            const layer: TKlrTilesLayer = { src, props };
            if (nTiles > 0) {
                layer.tiles = [];
                for (let k = 0; k < nTiles - 1; k++) {
                    layer.tiles.push(readTile(r));
                }
            }
            out.layers.push(layer);
        }
    }
    return out;
}

/** Writes one OPS chunk's payload. A new writer per chunk: deltas and clock start over. */
export class KlrOpsWriter {
    private readonly w = new ByteWriter(4096);
    private lastT = 0;
    private lastX = 0; // 1/32 px
    private lastY = 0;
    opCount = 0;

    constructor(startMs: number) {
        this.w.varint(Math.max(0, Math.round(startMs)));
    }

    get length(): number {
        return this.w.length;
    }

    private point(x: number, y: number): void {
        const qx = Math.round(x * COORD_SCALE);
        const qy = Math.round(y * COORD_SCALE);
        this.w.svarint(qx - this.lastX);
        this.w.svarint(qy - this.lastY);
        this.lastX = qx;
        this.lastY = qy;
    }

    private pressure(p: number): void {
        this.w.u8(Math.round(Math.max(0, Math.min(1, p)) * 255));
    }

    /** t: ms since the chunk started; never goes back. */
    write(op: TKlrOpInput, t: number): void {
        const w = this.w;
        t = Math.max(this.lastT, Math.round(t));
        const dt = t - this.lastT;
        this.lastT = t;
        this.opCount++;
        const head = (code: number) => {
            w.u8(code);
            w.varint(dt);
        };
        switch (op.op) {
            case 'down':
                head(OP.DOWN);
                this.point(op.x, op.y);
                this.pressure(op.p);
                w.varint(op.seed);
                return;
            case 'move':
                head(OP.MOVE);
                this.point(op.x, op.y);
                this.pressure(op.p);
                return;
            case 'up':
                head(OP.UP);
                return;
            case 'line':
                head(OP.LINE);
                this.point(op.x0, op.y0);
                this.point(op.x1, op.y1);
                this.pressure(op.p0);
                this.pressure(op.p1);
                w.varint(op.seed);
                return;
            case 'transfer':
                head(OP.TRANSFER);
                return;
            case 'brush':
                head(OP.BRUSH);
                w.u8(BRUSH_IDS.indexOf(op.brush));
                writeValue(w, op.settings);
                return;
            case 'layer':
                head(OP.LAYER);
                w.varint(op.index);
                return;
            case 'canvas': {
                const i = CANVAS_METHODS.indexOf(op.method);
                if (i < 0) {
                    throw new Error('klr: unknown canvas method ' + op.method);
                }
                head(OP.CANVAS + i);
                writeValue(w, op.args);
                return;
            }
            case 'filter':
                head(OP.FILTER);
                w.string(op.name);
                w.varint(op.layer);
                w.varint(op.seed);
                writeValue(w, op.input);
                return;
            case 'undo':
                head(OP.UNDO);
                return;
            case 'redo':
                head(OP.REDO);
                return;
            case 'active':
                head(OP.ACTIVE);
                w.varint(op.index);
                return;
            case 'sample':
                head(OP.SAMPLE);
                w.varint(op.id);
                w.varint(op.layer);
                return;
            case 'xform':
            case 'ffd':
                head(op.op === 'xform' ? OP.XFORM : OP.FFD);
                w.varint(op.sample);
                writeValue(w, op.params);
                return;
            case 'copy':
                head(OP.COPY);
                w.varint(op.id);
                w.u8(op.mask ? 1 : 0);
                return;
            case 'paste':
                head(OP.PASTE);
                w.varint(op.id);
                writeValue(w, op.params);
                return;
            case 'tiles':
                head(OP.TILES);
                writeTiles(w, op.tiles);
                return;
            case 'hash':
                head(OP.HASH);
                w.varint(op.hashes.length);
                op.hashes.forEach((h) => w.u32(h));
                return;
        }
    }

    /** The payload so far (a copy). */
    bytes(): Uint8Array {
        return this.w.toBytes();
    }
}

export type TKlrOpsChunk = { startMs: number; ops: TKlrOp[] };

export function decodeOps(payload: Uint8Array): TKlrOpsChunk {
    const r = new ByteReader(payload);
    const startMs = r.varint();
    const ops: TKlrOp[] = [];
    let t = 0;
    let x = 0;
    let y = 0;
    const point = (): [number, number] => {
        x += r.svarint();
        y += r.svarint();
        return [x / COORD_SCALE, y / COORD_SCALE];
    };
    const pressure = () => r.u8() / 255;
    while (r.remaining > 0) {
        const code = r.u8();
        t += r.varint();
        if (code >= OP.CANVAS && code < OP.CANVAS + CANVAS_METHODS.length) {
            ops.push({
                op: 'canvas',
                t,
                method: CANVAS_METHODS[code - OP.CANVAS],
                args: readValue(r) as TKlrValue[],
            });
            continue;
        }
        switch (code) {
            case OP.DOWN: {
                const [px, py] = point();
                ops.push({ op: 'down', t, x: px, y: py, p: pressure(), seed: r.varint() });
                break;
            }
            case OP.MOVE: {
                const [px, py] = point();
                ops.push({ op: 'move', t, x: px, y: py, p: pressure() });
                break;
            }
            case OP.UP:
                ops.push({ op: 'up', t });
                break;
            case OP.LINE: {
                const [x0, y0] = point();
                const [x1, y1] = point();
                const p0 = pressure();
                const p1 = pressure();
                ops.push({ op: 'line', t, x0, y0, x1, y1, p0, p1, seed: r.varint() });
                break;
            }
            case OP.TRANSFER:
                ops.push({ op: 'transfer', t });
                break;
            case OP.BRUSH: {
                const brush = BRUSH_IDS[r.u8()];
                if (!brush) {
                    throw new Error('klr: unknown brush');
                }
                ops.push({
                    op: 'brush',
                    t,
                    brush,
                    settings: readValue(r) as Record<string, TKlrValue>,
                });
                break;
            }
            case OP.LAYER:
                ops.push({ op: 'layer', t, index: r.varint() });
                break;
            case OP.FILTER: {
                const name = r.string();
                const layer = r.varint();
                const seed = r.varint();
                ops.push({ op: 'filter', t, name, layer, seed, input: readValue(r) });
                break;
            }
            case OP.UNDO:
                ops.push({ op: 'undo', t });
                break;
            case OP.REDO:
                ops.push({ op: 'redo', t });
                break;
            case OP.ACTIVE:
                ops.push({ op: 'active', t, index: r.varint() });
                break;
            case OP.SAMPLE: {
                const id = r.varint();
                ops.push({ op: 'sample', t, id, layer: r.varint() });
                break;
            }
            case OP.XFORM:
            case OP.FFD: {
                const sample = r.varint();
                ops.push({
                    op: code === OP.XFORM ? 'xform' : 'ffd',
                    t,
                    sample,
                    params: readValue(r),
                });
                break;
            }
            case OP.COPY: {
                const id = r.varint();
                ops.push({ op: 'copy', t, id, mask: r.u8() === 1 });
                break;
            }
            case OP.PASTE: {
                const id = r.varint();
                ops.push({ op: 'paste', t, id, params: readValue(r) });
                break;
            }
            case OP.TILES:
                ops.push({ op: 'tiles', t, tiles: readTiles(r) });
                break;
            case OP.HASH: {
                const n = r.varint();
                const hashes: number[] = [];
                for (let i = 0; i < n; i++) {
                    hashes.push(r.u32());
                }
                ops.push({ op: 'hash', t, hashes });
                break;
            }
            default:
                // An opcode this build doesn't know: the rest of the chunk can't be read.
                throw new Error('klr: unknown opcode 0x' + code.toString(16));
        }
    }
    return { startMs, ops };
}

// ---------------------------------------------------------------- head + container

export type TKlrStartLayer = {
    name: string;
    opacity: number;
    isVisible: boolean;
    mixModeStr: string;
    hasClipping: boolean;
    fill: string; // CSS color of the whole layer
};

export type TKlrStart = { kind: 'blank'; layers: TKlrStartLayer[] } | { kind: 'reference'; url: string };

export type TKlrHead = {
    formatVersion: number;
    engineV: number;
    build: string;
    width: number;
    height: number;
    start: TKlrStart;
    startHashes: number[]; // FNV-1a per layer of the start picture
};

export function encodeHead(h: TKlrHead): Uint8Array {
    const w = new ByteWriter(256);
    w.varint(h.formatVersion);
    w.varint(h.engineV);
    w.string(h.build);
    w.varint(h.width);
    w.varint(h.height);
    if (h.start.kind === 'blank') {
        w.u8(0);
        writeValue(w, h.start.layers);
    } else {
        w.u8(1);
        w.string(h.start.url);
    }
    w.varint(h.startHashes.length);
    h.startHashes.forEach((v) => w.u32(v));
    return w.toBytes();
}

export function decodeHead(payload: Uint8Array): TKlrHead {
    const r = new ByteReader(payload);
    const formatVersion = r.varint();
    const engineV = r.varint();
    const build = r.string();
    const width = r.varint();
    const height = r.varint();
    const kind = r.u8();
    const start: TKlrStart =
        kind === 0
            ? { kind: 'blank', layers: readValue(r) as TKlrStartLayer[] }
            : { kind: 'reference', url: r.string() };
    const n = r.varint();
    const startHashes: number[] = [];
    for (let i = 0; i < n; i++) {
        startHashes.push(r.u32());
    }
    return { formatVersion, engineV, build, width, height, start, startHashes };
}

export function encodeChunk(type: number, payload: Uint8Array): Uint8Array {
    const w = new ByteWriter(payload.length + 8);
    w.u8(type);
    w.blob(payload);
    return w.toBytes();
}

/** magic + HEAD chunk + the given (already framed) chunks */
export function joinKlr(head: Uint8Array, chunks: Uint8Array[]): Uint8Array {
    return concatBytes([KLR_MAGIC, encodeChunk(CHUNK_HEAD, head), ...chunks]);
}

export type TKlrFile = { head: TKlrHead; chunks: TKlrOpsChunk[] };

export function parseKlr(bytes: Uint8Array): TKlrFile {
    for (let i = 0; i < KLR_MAGIC.length; i++) {
        if (bytes[i] !== KLR_MAGIC[i]) {
            throw new Error('klr: not a .klr file');
        }
    }
    const r = new ByteReader(bytes.subarray(KLR_MAGIC.length));
    let head: TKlrHead | undefined;
    const chunks: TKlrOpsChunk[] = [];
    while (r.remaining > 0) {
        const type = r.u8();
        const payload = r.blob();
        if (type === CHUNK_HEAD) {
            head = decodeHead(payload);
            if (head.formatVersion > KLR_FORMAT_VERSION) {
                throw new Error('klr: format version ' + head.formatVersion + ' is newer');
            }
        } else if (type === CHUNK_OPS) {
            chunks.push(decodeOps(payload));
        } // unknown chunk types are skipped
    }
    if (!head) {
        throw new Error('klr: no HEAD');
    }
    return { head, chunks };
}
