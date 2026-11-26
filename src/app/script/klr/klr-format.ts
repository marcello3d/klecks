/**
 * `.klr`: Klecks input recording, the binary coder. Pure (no DOM, only type imports), so
 * `node --test scripts/test-klr-unit.mjs` runs it as is. Built on Lascaux's .lsa v3 primitives
 * (LEB128 varints, zigzag deltas; the byte writer below is theirs). Design: worker/KLECKS-RECORDING-PLAN.md in
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

// ---------------------------------------------------------------- bytes
// ByteWriter / ByteReader / concatBytes: copied from Lascaux's animation format
// (web/src/anim/bytes.ts, .lsa v3), plus f32; no dependency across repositories.

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

export class ByteWriter {
    private buf: Uint8Array;
    length = 0;

    constructor(initial = 1024) {
        this.buf = new Uint8Array(initial);
    }

    private ensure(n: number): void {
        if (this.length + n <= this.buf.length) {
            return;
        }
        let size = this.buf.length * 2;
        while (size < this.length + n) {
            size *= 2;
        }
        const next = new Uint8Array(size);
        next.set(this.buf.subarray(0, this.length));
        this.buf = next;
    }

    u8(v: number): void {
        this.ensure(1);
        this.buf[this.length++] = v & 0xff;
    }

    u32(v: number): void {
        this.ensure(4);
        const b = this.buf;
        let o = this.length;
        b[o++] = v >>> 24;
        b[o++] = v >>> 16;
        b[o++] = v >>> 8;
        b[o++] = v;
        this.length = o;
    }

    /** Unsigned LEB128 (any non-negative integer up to 2^53). */
    varint(v: number): void {
        if (!(v >= 0) || !Number.isSafeInteger(v)) {
            throw new Error(`varint out of range: ${v}`);
        }
        while (v >= 0x80) {
            this.u8((v & 0x7f) | 0x80);
            v = Math.floor(v / 128);
        }
        this.u8(v);
    }

    /** Zigzag signed LEB128. */
    svarint(v: number): void {
        this.varint(v < 0 ? -2 * v - 1 : 2 * v);
    }

    f32(v: number): void {
        this.ensure(4);
        new DataView(this.buf.buffer, this.buf.byteOffset + this.length, 4).setFloat32(0, v);
        this.length += 4;
    }

    f64(v: number): void {
        this.ensure(8);
        new DataView(this.buf.buffer, this.buf.byteOffset + this.length, 8).setFloat64(0, v);
        this.length += 8;
    }

    bytes(b: Uint8Array): void {
        this.ensure(b.length);
        this.buf.set(b, this.length);
        this.length += b.length;
    }

    /** Length-prefixed byte string. */
    blob(b: Uint8Array): void {
        this.varint(b.length);
        this.bytes(b);
    }

    /** Length-prefixed UTF-8 string. */
    string(s: string): void {
        this.blob(utf8Encoder.encode(s));
    }

    /** Big-endian ARGB pixels. */
    pixels(p: Int32Array | ArrayLike<number>): void {
        const n = p.length;
        this.ensure(n * 4);
        const b = this.buf;
        let o = this.length;
        for (let i = 0; i < n; i++) {
            const c = p[i];
            b[o++] = c >>> 24;
            b[o++] = c >>> 16;
            b[o++] = c >>> 8;
            b[o++] = c;
        }
        this.length = o;
    }

    /** A view of the bytes written so far (invalidated by further writes). */
    view(): Uint8Array {
        return this.buf.subarray(0, this.length);
    }

    toBytes(): Uint8Array {
        return this.buf.slice(0, this.length);
    }
}

export class ByteReader {
    pos = 0;

    private readonly b: Uint8Array;

    constructor(b: Uint8Array) {
        this.b = b;
    }

    get remaining(): number {
        return this.b.length - this.pos;
    }

    private need(n: number): void {
        if (this.pos + n > this.b.length) {
            throw new Error('truncated data');
        }
    }

    u8(): number {
        this.need(1);
        return this.b[this.pos++];
    }

    u32(): number {
        this.need(4);
        const b = this.b;
        const o = this.pos;
        this.pos += 4;
        return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    }

    varint(): number {
        let v = 0;
        let scale = 1;
        for (let i = 0; i < 8; i++) {
            const byte = this.u8();
            v += (byte & 0x7f) * scale;
            if (!(byte & 0x80)) {
                return v;
            }
            scale *= 128;
        }
        throw new Error('varint too long');
    }

    svarint(): number {
        const v = this.varint();
        return v % 2 === 1 ? -(v + 1) / 2 : v / 2;
    }

    f32(): number {
        this.need(4);
        const v = new DataView(this.b.buffer, this.b.byteOffset + this.pos, 4).getFloat32(0);
        this.pos += 4;
        return v;
    }

    f64(): number {
        this.need(8);
        const v = new DataView(this.b.buffer, this.b.byteOffset + this.pos, 8).getFloat64(0);
        this.pos += 8;
        return v;
    }

    bytes(n: number): Uint8Array {
        this.need(n);
        const out = this.b.subarray(this.pos, this.pos + n);
        this.pos += n;
        return out;
    }

    blob(): Uint8Array {
        return this.bytes(this.varint());
    }

    string(): string {
        return utf8Decoder.decode(this.blob());
    }

    pixels(n: number): Int32Array {
        this.need(n * 4);
        const out = new Int32Array(n);
        const b = this.b;
        let o = this.pos;
        for (let i = 0; i < n; i++, o += 4) {
            out[i] = (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
        }
        this.pos = o;
        return out;
    }
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

// ---------------------------------------------------------------- format

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
    replaceTop?: boolean; // pushed replacing the history's top entry
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
    // shift+click line; x0/y0 null: from where the brush last was
    | { op: 'line'; t: number; x0: number | null; y0: number | null; x1: number; y1: number; seed: number }
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
    w.u8(
        (t.size ? 1 : 0) |
            (t.selection ? 2 : 0) |
            (t.activeLayer !== undefined ? 4 : 0) |
            (t.layers ? 8 : 0) |
            (t.replaceTop ? 16 : 0),
    );
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
    if (flags & 16) {
        out.replaceTop = true;
    }
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

    /** t: ms since the chunk started; never goes back. Writes nothing if it throws. */
    write(op: TKlrOpInput, t: number): void {
        const saved = [this.w.length, this.lastT, this.lastX, this.lastY, this.opCount];
        try {
            this.writeOp(op, t);
        } catch (e) {
            [this.w.length, this.lastT, this.lastX, this.lastY, this.opCount] = saved;
            throw e;
        }
    }

    private writeOp(op: TKlrOpInput, t: number): void {
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
                w.u8(op.x0 === null || op.y0 === null ? 1 : 0);
                if (op.x0 !== null && op.y0 !== null) {
                    this.point(op.x0, op.y0);
                }
                this.point(op.x1, op.y1);
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
                const fromLast = r.u8() === 1;
                const [x0, y0] = fromLast ? [null, null] : point();
                const [x1, y1] = point();
                ops.push({ op: 'line', t, x0, y0, x1, y1, seed: r.varint() });
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
