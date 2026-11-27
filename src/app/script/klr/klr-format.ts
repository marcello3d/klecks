/**
 * `.klr` v0: Klecks input recording, the coder. Pure (no DOM, no runtime imports but the
 * vendored pen coder), so `node --test scripts/test-klr-unit.mjs` runs it as is.
 *
 * The spec is 2draw.net's worker/src/pocket/PEN-CODER.md, section 8 ("`.klr` v0 on the pen
 * coder"); docs/2draw-klr.md here says how it is built and where it deviates. In short:
 *
 *   magic  89 4B 4C 52                       ("\x89KLR")
 *   chunk* u8 type | varint length | payload  unknown types are skipped
 *
 *   HEAD  (1)  plain: headV 0, build, width, height, hashTile 256, start (blank: its layers;
 *              reference: the previous version's PSD, which 2draw hands the player), start hashes
 *   OPS   (2)  a plain header (opsV 0, engineV, coder 0, pen flags, klrFlags 0, startMs,
 *              durationMs, opCount, restore + its hashes, the hashes at the seal), then one
 *              range-coded op stream (pen-coder.ts) over CHANNELS, ending with END
 *   TILES (3)  plain: the pixels of the catch-all TILES ops of the OPS chunk before it
 *
 * Each OPS chunk decodes on its own. Strokes are one op (DOWN to UP) whose samples go through
 * the shared pen coder (KlrSampleCoder, the one seam for them). Hot ops have typed fields;
 * the rest carry named, self-describing values (writeValue) that the player maps to calls.
 */
import {
    channelTable,
    CODER_RANGE,
    newSink,
    newSource,
    PEN_FLAGS,
    penChannelSpec,
    penStrokeChannels,
    PenStrokeDecoder,
    PenStrokeEncoder,
    VarintSink,
} from './pen-coder.ts';
import type { Channel, PenGrid, Sink, Source } from './pen-coder.ts';

export type { PenGrid } from './pen-coder.ts';

// ---------------------------------------------------------------- bytes (the plain parts)

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

    /** big-endian */
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

    /** Unsigned LEB128 (any non-negative safe integer). */
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

    /** big-endian IEEE double */
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
            throw new Error('klr: truncated');
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
        throw new Error('klr: varint too long');
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

// ---------------------------------------------------------------- versions and tables

export const KLR_MAGIC = Uint8Array.of(0x89, 0x4b, 0x4c, 0x52);
/** HEAD's version. v0 is provisional (beta only, may be deleted); v1 is frozen. */
export const KLR_HEAD_V = 0;
/** OPS chunks' version: the opcodes, channels and value coding below. */
export const KLR_OPS_V = 0;
// What the replaying engine must do the same way. Bump with a change that would make old
// recordings replay differently, and keep the old behaviour behind `engineV` checks.
export const KLR_ENGINE_V = 1;
/** The only coder .klr accepts (the pen coder's range coder). */
export const KLR_CODER = CODER_RANGE;
export const KLR_PEN_FLAGS = PEN_FLAGS;
/** .klr's own per-chunk flags: none yet. A reader refuses bits it doesn't know. */
export const KLR_FLAGS_KNOWN = 0;
/** The tile size of every layer hash. */
export const KLR_HASH_TILE = 256;

export const CHUNK_HEAD = 1;
export const CHUNK_OPS = 2;
export const CHUNK_TILES = 3;

export const COORD_SCALE = 32;

/** Opcodes. Flat and append only; a changed field list is a new opcode. */
export const OPC = {
    END: 0,
    STROKE: 1,
    LINE: 2,
    BRUSH: 3,
    LAYER: 4,
    ACTIVE: 5,
    UNDO: 6,
    REDO: 7,
    COPY: 8,
    PASTE: 9,
    SAMPLE: 10,
    XFORM: 11,
    FFD: 12,
    FILTER: 13,
    TILES: 14,
    EXT: 15,
} as const;

/** KlCanvas methods with typed fields, opcodes 16-24. */
export const SCALAR_METHODS = [
    'setOpacity',
    'setLayerIsVisible',
    'setLayerHasClipping',
    'moveLayer',
    'mergeLayer',
    'removeLayer',
    'duplicateLayer',
    'renameLayer',
    'setMixMode',
] as const;
/** KlCanvas methods with named fields, opcodes 25-38. */
export const NAMED_METHODS = [
    'addLayer',
    'reset',
    'resize',
    'cropExtend',
    'mergeAll',
    'rotate',
    'flip',
    'layerFill',
    'floodFill',
    'drawShape',
    'drawGradient',
    'text',
    'eraseLayer',
    'setSelection',
] as const;
export const OPC_SCALAR = 16;
export const OPC_NAMED = 25;
/** Every recorded KlCanvas method (the recorder wraps them). */
export const CANVAS_METHODS = [...SCALAR_METHODS, ...NAMED_METHODS] as const;
export type TKlrCanvasMethod = (typeof CANVAS_METHODS)[number];

/** Each method's parameters by their names in KlCanvas's signature, in order: the named fields. */
export const CANVAS_PARAMS: Record<TKlrCanvasMethod, readonly string[]> = {
    setOpacity: ['layerIndex', 'opacity'],
    setLayerIsVisible: ['layerIndex', 'isVisible'],
    setLayerHasClipping: ['layerIndex', 'hasClipping'],
    moveLayer: ['index', 'delta'],
    mergeLayer: ['layerIndex', 'mixModeStr'],
    removeLayer: ['index'],
    duplicateLayer: ['srcIndex'],
    renameLayer: ['index', 'name'],
    setMixMode: ['layerIndex', 'mixModeStr'],
    addLayer: ['selectedIndex', 'data'],
    reset: ['p'],
    resize: ['w', 'h', 'algorithm'],
    cropExtend: ['p'],
    mergeAll: [],
    rotate: ['deg'],
    flip: ['isHorizontal', 'isVertical', 'layerIndex'],
    layerFill: ['layerIndex', 'colorObj', 'compositeOperation', 'doClipSelection'],
    floodFill: [
        'layerIndex',
        'x',
        'y',
        'rgb',
        'opacity',
        'tolerance',
        'sampleStr',
        'grow',
        'isContiguous',
    ],
    drawShape: ['layerIndex', 'shapeObj'],
    drawGradient: ['layerIndex', 'gradientObj'],
    text: ['layerIndex', 'p'],
    eraseLayer: ['p'],
    setSelection: ['selection'],
};

/** A call's arguments as named fields (undefined ones left out). */
export function canvasFields(
    method: TKlrCanvasMethod,
    args: readonly unknown[],
): Record<string, TKlrValue> {
    const names = CANVAS_PARAMS[method];
    if (args.length > names.length && args.slice(names.length).some((a) => a !== undefined)) {
        throw new KlrUnencodable(method + ': more arguments than its signature has');
    }
    const out: Record<string, TKlrValue> = {};
    names.forEach((name, i) => {
        if (args[i] !== undefined) {
            out[name] = args[i] as TKlrValue;
        }
    });
    return out;
}

// Brushes by index. Append only.
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

/** Each brush's recorded fields as of opsV 0 (BRUSH's mask bit k is field k). A new field is
 * a new opcode. klr-brushes.ts reads and restores them. */
export const BRUSH_FIELDS: Record<TKlrBrushId, readonly string[]> = {
    penBrush: [
        'settingSize',
        'settingSpacing',
        'settingOpacity',
        'settingScatter',
        'settingColor',
        'settingAlphaId',
        'settingLockLayerAlpha',
        'settingHasSizePressure',
        'settingHasOpacityPressure',
        'settingHasScatterPressure',
    ],
    blendBrush: [
        'size',
        'opacity',
        'blending',
        'color',
        'settingLockLayerAlpha',
        'settingSizePressure',
        'settingOpacityPressure',
    ],
    // sketchySeed advances with every segment and lives across strokes
    sketchyBrush: [
        'settingSize',
        'settingOpacity',
        'settingBlending',
        'settingScale',
        'settingColor',
        'sketchySeed',
    ],
    pixelBrush: [
        'settingSize',
        'settingSpacing',
        'settingOpacity',
        'settingColor',
        'settingLockLayerAlpha',
        'settingIsEraser',
        'settingHasSizePressure',
        'settingPattern',
        'settingTip',
    ],
    chemyBrush: [
        'settingSize',
        'settingOpacity',
        'settingColor',
        'settingLockLayerAlpha',
        'settingIsEraser',
        'settingMode',
        'settingDistort',
        'settingXSymmetry',
        'settingYSymmetry',
        'settingGradient',
    ],
    smudgeBrush: [
        'settingSize',
        'settingSpacing',
        'settingOpacity',
        'settingColor',
        'settingLockLayerAlpha',
        'settingHasSizePressure',
        'settingHasOpacityPressure',
    ],
    eraserBrush: [
        'size',
        'spacing',
        'opacity',
        'useSizePressure',
        'useOpacityPressure',
        'isTransparentBG',
    ],
};

/** Klecks's TMixMode order. Append only. */
export const MIX_MODES = [
    'source-over',
    'darken',
    'multiply',
    'color-burn',
    'lighten',
    'screen',
    'color-dodge',
    'overlay',
    'soft-light',
    'hard-light',
    'difference',
    'exclusion',
    'hue',
    'saturation',
    'color',
    'luminosity',
] as const;

/** The OPS stream's channels, in id order. Append only. */
const TABLE = channelTable<string>([
    ['OP', 64],
    ['ODT', 64],
    ...penChannelSpec(['P']),
    ['SEED', 1],
    ['XFER', 2],
    ['UPDT', 1],
    ['LXY', 2],
    ['LAYER', 2],
    ['ID', 2],
    ['BRUSHID', 1],
    ['BMASK', 8],
    ['MISC', 4],
    ['VTAG', 4],
    ['VINT', 4],
    ['F64', 2],
    ['VLEN', 2],
    ['BYTES', 1],
    ['COLOR', 3],
    ['EXTC', 1],
]);
export const KLR_CHANNELS: readonly Channel[] = TABLE.list;
const C = TABLE.ch as Record<
    | 'OP'
    | 'ODT'
    | 'SEED'
    | 'XFER'
    | 'UPDT'
    | 'LXY'
    | 'LAYER'
    | 'ID'
    | 'BRUSHID'
    | 'BMASK'
    | 'MISC'
    | 'VTAG'
    | 'VINT'
    | 'F64'
    | 'VLEN'
    | 'BYTES'
    | 'COLOR'
    | 'EXTC',
    Channel
>;
const PEN = penStrokeChannels(TABLE.ch, ['P']);

// ---------------------------------------------------------------- values

export type TKlrValue =
    | undefined
    | null
    | boolean
    | number
    | string
    | TKlrValue[]
    | { [key: string]: TKlrValue };

const V_UNDEF = 0;
const V_NULL = 1;
const V_FALSE = 2;
const V_TRUE = 3;
const V_INT = 4;
const V_F64 = 5;
const V_STR = 6;
const V_ARR = 7;
const V_OBJ = 8;
const V_RGB = 9;
const MAX_DEPTH = 32;
const MAX_LEN = 1 << 26; // a longer length is a damaged stream

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
        'Map',
        'Set',
        'Date',
        'Promise',
    ]) {
        if (typeof g[name] === 'function' && v instanceof g[name]) {
            return true;
        }
    }
    return false;
}

/** A plain copy of v as a value holds it. Throws KlrUnencodable for what a value can't hold
 * (functions, canvases, images, typed arrays...). */
export function toKlrValue(v: unknown, depth = 0): TKlrValue {
    if (depth > MAX_DEPTH) {
        throw new KlrUnencodable('too deep');
    }
    if (v === undefined || v === null || typeof v === 'boolean' || typeof v === 'number') {
        return v;
    }
    if (typeof v === 'string') {
        return v;
    }
    if (Array.isArray(v)) {
        return v.map((item) => toKlrValue(item, depth + 1));
    }
    if (typeof v === 'object') {
        if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer || isHostObject(v)) {
            throw new KlrUnencodable('not plain data');
        }
        const out: Record<string, TKlrValue> = {};
        for (const key of Object.keys(v)) {
            out[key] = toKlrValue((v as Record<string, unknown>)[key], depth + 1);
        }
        return out;
    }
    throw new KlrUnencodable('not plain data: ' + typeof v);
}

const f64View = new DataView(new ArrayBuffer(8));

function isRgb(v: object): v is { r: number; g: number; b: number } {
    const keys = Object.keys(v);
    if (keys.length !== 3 || keys[0] !== 'r' || keys[1] !== 'g' || keys[2] !== 'b') {
        return false;
    }
    const o = v as Record<string, unknown>;
    return [o.r, o.g, o.b].every((c) => Number.isInteger(c) && (c as number) >= 0 && (c as number) <= 255);
}

function writeString(s: Sink, str: string): void {
    const b = utf8Encoder.encode(str);
    s.u(C.VLEN, b.length, 1);
    for (let i = 0; i < b.length; i++) {
        s.u(C.BYTES, b[i]);
    }
}

function readBytes(src: Source, n: number): Uint8Array {
    if (n > MAX_LEN) {
        throw new Error('klr: a length of ' + n);
    }
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        b[i] = src.u(C.BYTES);
    }
    return b;
}

function readString(src: Source): string {
    return utf8Decoder.decode(readBytes(src, src.u(C.VLEN, 1)));
}

/** A self-describing value (PEN-CODER.md 8.3, "Values"). */
export function writeValue(s: Sink, v: unknown, depth = 0): void {
    if (depth > MAX_DEPTH) {
        throw new KlrUnencodable('too deep');
    }
    const d = Math.min(depth, 3);
    if (v === undefined) {
        s.u(C.VTAG, V_UNDEF, d);
    } else if (v === null) {
        s.u(C.VTAG, V_NULL, d);
    } else if (v === false) {
        s.u(C.VTAG, V_FALSE, d);
    } else if (v === true) {
        s.u(C.VTAG, V_TRUE, d);
    } else if (typeof v === 'number') {
        // integers the pen coder's model holds (2^52), not -0; the rest exactly as f64
        if (Number.isInteger(v) && Math.abs(v) <= 2 ** 52 && !Object.is(v, -0)) {
            s.u(C.VTAG, V_INT, d);
            s.s(C.VINT, v, d);
        } else {
            s.u(C.VTAG, V_F64, d);
            f64View.setFloat64(0, v);
            s.u(C.F64, f64View.getUint32(0), 0);
            s.u(C.F64, f64View.getUint32(4), 1);
        }
    } else if (typeof v === 'string') {
        s.u(C.VTAG, V_STR, d);
        writeString(s, v);
    } else if (Array.isArray(v)) {
        s.u(C.VTAG, V_ARR, d);
        s.u(C.VLEN, v.length, 0);
        for (const item of v) {
            writeValue(s, item, depth + 1);
        }
    } else if (typeof v === 'object') {
        if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer || isHostObject(v)) {
            throw new KlrUnencodable('not plain data');
        }
        if (isRgb(v)) {
            s.u(C.VTAG, V_RGB, d);
            s.u(C.COLOR, v.r, 0);
            s.u(C.COLOR, v.g, 1);
            s.u(C.COLOR, v.b, 2);
            return;
        }
        const keys = Object.keys(v);
        s.u(C.VTAG, V_OBJ, d);
        s.u(C.VLEN, keys.length, 0);
        for (const key of keys) {
            writeString(s, key);
            writeValue(s, (v as Record<string, unknown>)[key], depth + 1);
        }
    } else {
        throw new KlrUnencodable('not plain data: ' + typeof v);
    }
}

export function readValue(src: Source, depth = 0): TKlrValue {
    if (depth > MAX_DEPTH) {
        throw new Error('klr: a value too deep');
    }
    const d = Math.min(depth, 3);
    const tag = src.u(C.VTAG, d);
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
            return src.s(C.VINT, d);
        case V_F64:
            f64View.setUint32(0, src.u(C.F64, 0));
            f64View.setUint32(4, src.u(C.F64, 1));
            return f64View.getFloat64(0);
        case V_STR:
            return readString(src);
        case V_ARR: {
            const n = src.u(C.VLEN, 0);
            if (n > MAX_LEN) {
                throw new Error('klr: a length of ' + n);
            }
            const out: TKlrValue[] = [];
            for (let i = 0; i < n; i++) {
                out.push(readValue(src, depth + 1));
            }
            return out;
        }
        case V_OBJ: {
            const n = src.u(C.VLEN, 0);
            if (n > MAX_LEN) {
                throw new Error('klr: a length of ' + n);
            }
            const out: Record<string, TKlrValue> = {};
            for (let i = 0; i < n; i++) {
                const key = readString(src);
                out[key] = readValue(src, depth + 1);
            }
            return out;
        }
        case V_RGB:
            return { r: src.u(C.COLOR, 0), g: src.u(C.COLOR, 1), b: src.u(C.COLOR, 2) };
    }
    throw new Error('klr: bad value tag ' + tag);
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

/** A stroke sample: [t ms (in the chunk), x, y (1/32 px), pressure (0-255)], integers. */
export type TKlrSample = [number, number, number, number];

export type TKlrOp =
    // DOWN to UP: the samples (the first at the op's time t), the easel's transfers (each the
    // number of samples the brush had been given when it ran), the UP's time.
    // grid: where the encoder looks for the pointer's lattice (not stored).
    | {
          op: 'stroke';
          t: number;
          seed: number;
          samples: TKlrSample[];
          transfers: number[];
          upT: number;
          grid?: PenGrid | null;
      }
    // shift+click line, px (quantized to 1/32); x0/y0 null: from where the brush last was
    | { op: 'line'; t: number; x0: number | null; y0: number | null; x1: number; y1: number; seed: number }
    | { op: 'brush'; t: number; brush: TKlrBrushId; settings: Record<string, TKlrValue> }
    | { op: 'layer'; t: number; index: number }
    | { op: 'active'; t: number; index: number }
    | { op: 'undo'; t: number }
    | { op: 'redo'; t: number }
    | { op: 'copy'; t: number; id: number; mask: boolean }
    | { op: 'paste'; t: number; id: number; params: Record<string, TKlrValue> }
    | { op: 'sample'; t: number; id: number; layer: number }
    | { op: 'xform'; t: number; sample: number; params: Record<string, TKlrValue> }
    | { op: 'ffd'; t: number; sample: number; params: Record<string, TKlrValue> }
    | { op: 'filter'; t: number; name: string; layer: number; seed: number; input: TKlrValue }
    | { op: 'canvas'; t: number; method: TKlrCanvasMethod; fields: Record<string, TKlrValue> }
    | { op: 'tiles'; t: number; tiles: TKlrTiles }
    // skippable: a reader skips a code it doesn't know (no codes yet)
    | { op: 'ext'; t: number; code: number; bytes: Uint8Array };

// An op as the recorder hands it over: the time is added.
export type TKlrOpInput = TKlrOp extends infer O
    ? O extends { t: number }
        ? Omit<O, 't'>
        : never
    : never;

const uint = (v: unknown, what: string): number => {
    if (!Number.isSafeInteger(v) || (v as number) < 0) {
        throw new KlrUnencodable(what + ': not an index: ' + String(v));
    }
    return v as number;
};
const int = (v: unknown, what: string): number => {
    if (!Number.isSafeInteger(v)) {
        throw new KlrUnencodable(what + ': not an integer: ' + String(v));
    }
    return v as number;
};
const bool = (v: unknown, what: string): number => {
    if (typeof v !== 'boolean') {
        throw new KlrUnencodable(what + ': not a boolean: ' + String(v));
    }
    return v ? 1 : 0;
};
const mixIndex = (v: unknown, what: string): number => {
    const i = MIX_MODES.indexOf(v as (typeof MIX_MODES)[number]);
    if (i < 0) {
        throw new KlrUnencodable(what + ': not a mix mode: ' + String(v));
    }
    return i;
};
const coord = (v: number): number => int(Math.round(v * COORD_SCALE), 'a coordinate');

/** Writes ops into one sink: one per chunk (the clock, the pen coder and every "last" start
 * over). Also the dry run that tells whether an op encodes (onto a throwaway sink). */
class OpsEncoder {
    private readonly s: Sink;
    private readonly pen: PenStrokeEncoder;
    private prev = 0; // the previous opcode
    clock = 0; // ms from the chunk's start
    readonly tiles: TKlrTile[] = [];

    constructor(s: Sink, penFlags: number) {
        this.s = s;
        this.pen = new PenStrokeEncoder(s, PEN, penFlags);
    }

    private head(code: number, t: number): void {
        t = Math.max(this.clock, Math.round(t));
        this.s.u(C.OP, code, Math.min(this.prev, 63));
        this.s.u(C.ODT, t - this.clock, Math.min(code, 63));
        this.clock = t;
        this.prev = code;
    }

    end(): void {
        this.s.u(C.OP, OPC.END, Math.min(this.prev, 63));
    }

    op(op: TKlrOp): void {
        const s = this.s;
        switch (op.op) {
            case 'stroke': {
                if (!op.samples.length) {
                    throw new KlrUnencodable('a stroke without samples');
                }
                this.head(OPC.STROKE, op.t);
                s.u(C.SEED, uint(op.seed, 'seed'));
                // times monotonic from the op's; integers, pressure a byte
                let last = this.clock;
                const S = op.samples.map((p, i) => {
                    const t = i === 0 ? this.clock : Math.max(last, Math.round(p[0]));
                    last = t;
                    return [t, int(p[1], 'x'), int(p[2], 'y'), Math.max(0, Math.min(255, Math.round(p[3])))];
                });
                KlrSampleCoder.encode(this.pen, S, op.grid ?? null);
                s.u(C.XFER, op.transfers.length, 0);
                let place = 0;
                for (const x of op.transfers) {
                    const at = Math.max(place, uint(x, 'transfer'));
                    s.u(C.XFER, at - place, 1);
                    place = at;
                }
                const upT = Math.max(last, Math.round(op.upT));
                s.u(C.UPDT, upT - last);
                this.clock = upT;
                return;
            }
            case 'line': {
                this.head(OPC.LINE, op.t);
                s.u(C.SEED, uint(op.seed, 'seed'));
                const fromLast = op.x0 === null || op.y0 === null;
                s.u(C.MISC, fromLast ? 1 : 0, 0);
                if (!fromLast) {
                    s.s(C.LXY, coord(op.x0!), 0);
                    s.s(C.LXY, coord(op.y0!), 1);
                }
                s.s(C.LXY, coord(op.x1), 0);
                s.s(C.LXY, coord(op.y1), 1);
                return;
            }
            case 'brush': {
                const id = BRUSH_IDS.indexOf(op.brush);
                if (id < 0) {
                    throw new KlrUnencodable('unknown brush ' + op.brush);
                }
                const fields = BRUSH_FIELDS[op.brush];
                const extra = Object.keys(op.settings).filter((k) => !fields.includes(k));
                if (extra.length) {
                    throw new KlrUnencodable(op.brush + ': fields not in BRUSH_FIELDS: ' + extra);
                }
                let mask = 0;
                fields.forEach((f, k) => {
                    if (f in op.settings) {
                        mask += 2 ** k;
                    }
                });
                this.head(OPC.BRUSH, op.t);
                s.u(C.BRUSHID, id);
                s.u(C.BMASK, mask, Math.min(id, 7));
                fields.forEach((f) => {
                    if (f in op.settings) {
                        writeValue(s, op.settings[f]);
                    }
                });
                return;
            }
            case 'layer':
            case 'active':
                this.head(op.op === 'layer' ? OPC.LAYER : OPC.ACTIVE, op.t);
                s.u(C.LAYER, uint(op.index, op.op), 0);
                return;
            case 'undo':
                this.head(OPC.UNDO, op.t);
                return;
            case 'redo':
                this.head(OPC.REDO, op.t);
                return;
            case 'copy':
                this.head(OPC.COPY, op.t);
                s.u(C.ID, uint(op.id, 'id'), 0);
                s.u(C.MISC, bool(op.mask, 'mask'), 0);
                return;
            case 'paste':
                this.head(OPC.PASTE, op.t);
                s.u(C.ID, uint(op.id, 'id'), 0);
                writeValue(s, op.params);
                return;
            case 'sample':
                this.head(OPC.SAMPLE, op.t);
                s.u(C.ID, uint(op.id, 'id'), 1);
                s.u(C.LAYER, uint(op.layer, 'layer'), 1);
                return;
            case 'xform':
            case 'ffd':
                this.head(op.op === 'xform' ? OPC.XFORM : OPC.FFD, op.t);
                s.u(C.ID, uint(op.sample, 'sample'), 1);
                writeValue(s, op.params);
                return;
            case 'filter':
                this.head(OPC.FILTER, op.t);
                writeValue(s, { name: op.name, layer: op.layer, seed: op.seed, input: op.input });
                return;
            case 'tiles': {
                this.head(OPC.TILES, op.t);
                const t = op.tiles;
                const v: Record<string, TKlrValue> = {};
                if (t.replaceTop) {
                    v.replaceTop = true;
                }
                if (t.size) {
                    v.size = { width: t.size.width, height: t.size.height };
                }
                if (t.selection) {
                    v.selection = { value: t.selection.value };
                }
                if (t.activeLayer !== undefined) {
                    v.activeLayer = t.activeLayer;
                }
                if (t.layers) {
                    v.layers = t.layers.map((layer) => {
                        const out: Record<string, TKlrValue> = { src: layer.src, props: layer.props };
                        if (layer.tiles) {
                            out.tiles = layer.tiles.map((tile) => {
                                if (!tile) {
                                    return -1;
                                }
                                this.tiles.push(tile);
                                return this.tiles.length - 1;
                            });
                        }
                        return out;
                    });
                }
                writeValue(s, v);
                return;
            }
            case 'ext':
                this.head(OPC.EXT, op.t);
                s.u(C.EXTC, uint(op.code, 'code'));
                s.u(C.VLEN, op.bytes.length, 1);
                for (let i = 0; i < op.bytes.length; i++) {
                    s.u(C.BYTES, op.bytes[i]);
                }
                return;
            case 'canvas':
                this.canvas(op);
                return;
        }
        throw new KlrUnencodable('unknown op ' + (op as { op: string }).op);
    }

    private canvas(op: Extract<TKlrOp, { op: 'canvas' }>): void {
        const s = this.s;
        const f = op.fields;
        const scalar = (SCALAR_METHODS as readonly string[]).indexOf(op.method);
        if (scalar < 0) {
            const named = (NAMED_METHODS as readonly string[]).indexOf(op.method);
            if (named < 0) {
                throw new KlrUnencodable('unknown canvas method ' + op.method);
            }
            this.head(OPC_NAMED + named, op.t);
            writeValue(s, f);
            return;
        }
        // check before writing anything: the range coder can't take half an op back
        const m = op.method;
        const layer = uint(f[CANVAS_PARAMS[m][0]], m);
        const more = (): void => {
            switch (m) {
                case 'setOpacity':
                    if (typeof f.opacity !== 'number') {
                        throw new KlrUnencodable('setOpacity: not a number');
                    }
                    writeValue(s, f.opacity);
                    return;
                case 'setLayerIsVisible':
                    s.u(C.MISC, bool(f.isVisible, m), 0);
                    return;
                case 'setLayerHasClipping':
                    s.u(C.MISC, bool(f.hasClipping, m), 0);
                    return;
                case 'moveLayer':
                    s.s(C.MISC, int(f.delta, m), 2);
                    return;
                case 'mergeLayer':
                    s.u(C.MISC, f.mixModeStr === undefined ? 0 : mixIndex(f.mixModeStr, m) + 1, 1);
                    return;
                case 'renameLayer':
                    if (typeof f.name !== 'string') {
                        throw new KlrUnencodable('renameLayer: not a string');
                    }
                    writeValue(s, f.name);
                    return;
                case 'setMixMode':
                    s.u(C.MISC, mixIndex(f.mixModeStr, m), 1);
                    return;
            }
        };
        if (m === 'mergeLayer' && f.mixModeStr !== undefined) {
            mixIndex(f.mixModeStr, m);
        } else if (m === 'setMixMode') {
            mixIndex(f.mixModeStr, m);
        } else if (m === 'setLayerIsVisible' || m === 'setLayerHasClipping') {
            bool(m === 'setLayerIsVisible' ? f.isVisible : f.hasClipping, m);
        } else if (m === 'moveLayer') {
            int(f.delta, m);
        } else if (m === 'setOpacity' && typeof f.opacity !== 'number') {
            throw new KlrUnencodable('setOpacity: not a number');
        } else if (m === 'renameLayer' && typeof f.name !== 'string') {
            throw new KlrUnencodable('renameLayer: not a string');
        }
        this.head(OPC_SCALAR + scalar, op.t);
        s.u(C.LAYER, layer, 1);
        more();
    }
}

/**
 * The seam for stroke samples: every stroke's samples go through here, onto the shared pen
 * coder (pen-coder.ts, vendored from 2draw: PenStrokeEncoder / PenStrokeDecoder, one of each
 * per chunk), and nothing else knows how they are coded.
 */
export const KlrSampleCoder = {
    encode(enc: PenStrokeEncoder, S: number[][], grid: PenGrid | null): void {
        enc.stroke(S, grid);
    },
    decode(dec: PenStrokeDecoder, t0: number): TKlrSample[] {
        return dec.stroke(t0) as TKlrSample[];
    },
};

/**
 * The op, checked and copied as it will be coded: its values made plain copies (the app may
 * change the objects it passed later), then coded on a throwaway sink, so an op that can't be
 * coded is known before any of it is (throws KlrUnencodable). Strokes are made by the recorder
 * from numbers and aren't checked.
 */
export function prepareOp<O extends TKlrOpInput>(op: O): O {
    let out: TKlrOpInput;
    switch (op.op) {
        case 'brush':
            out = { ...op, settings: toKlrValue(op.settings) as Record<string, TKlrValue> };
            break;
        case 'paste':
        case 'xform':
        case 'ffd':
            out = { ...op, params: toKlrValue(op.params) as Record<string, TKlrValue> };
            break;
        case 'filter':
            out = { ...op, input: toKlrValue(op.input) };
            break;
        case 'canvas':
            out = { ...op, fields: toKlrValue(op.fields) as Record<string, TKlrValue> };
            break;
        case 'tiles':
            out = op; // the recorder's own copies
            break;
        default:
            out = op;
    }
    if (out.op !== 'stroke') {
        new OpsEncoder(new VarintSink(), KLR_PEN_FLAGS).op({ ...out, t: 0 } as TKlrOp);
    }
    return out as O;
}

export type TKlrOpsChunk = {
    opsV: number;
    engineV: number;
    coder: number;
    penFlags: number;
    klrFlags: number;
    startMs: number; // since the recording began
    durationMs: number; // the clock at the chunk's end: its last op's time (a stroke's: its UP)
    opCount: number;
    restore?: number[]; // the chunk starts on a draft restore: the restored picture's hashes
    endHashes: number[]; // at the seal; empty: not taken (sealed during a stroke)
    ops: TKlrOp[]; // t: ms from startMs
    skipped: number; // EXT ops a reader skipped
};

export type TKlrChunkInput = {
    startMs: number;
    ops: TKlrOp[]; // t: ms from startMs
    restore?: number[];
    endHashes: number[];
    engineV?: number;
};

function writeHashes(w: ByteWriter, hashes: readonly number[]): void {
    w.varint(hashes.length);
    hashes.forEach((h) => w.u32(h));
}

function readHashes(r: ByteReader): number[] {
    const n = r.varint();
    if (n > 4096) {
        throw new Error('klr: ' + n + ' layer hashes');
    }
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
        out.push(r.u32());
    }
    return out;
}

/** An OPS chunk and, when its TILES ops hold pixels, the TILES chunk after it: framed. */
export function encodeOpsChunk(c: TKlrChunkInput): Uint8Array {
    const sink = newSink(KLR_CODER, KLR_CHANNELS);
    const enc = new OpsEncoder(sink, KLR_PEN_FLAGS);
    for (const op of c.ops) {
        enc.op(op);
    }
    enc.end();
    const stream = sink.finish();
    const w = new ByteWriter(64 + stream.length);
    w.varint(KLR_OPS_V);
    w.varint(c.engineV ?? KLR_ENGINE_V);
    w.u8(KLR_CODER);
    w.u8(KLR_PEN_FLAGS);
    w.varint(0); // klrFlags
    w.varint(Math.max(0, Math.round(c.startMs)));
    w.varint(enc.clock);
    w.varint(c.ops.length);
    w.u8(c.restore ? 1 : 0);
    if (c.restore) {
        writeHashes(w, c.restore);
    }
    writeHashes(w, c.endHashes);
    w.bytes(stream);
    const out = [encodeChunk(CHUNK_OPS, w.toBytes())];
    if (enc.tiles.length) {
        out.push(encodeChunk(CHUNK_TILES, encodeTiles(enc.tiles)));
    }
    return concatBytes(out);
}

function encodeTiles(tiles: TKlrTile[]): Uint8Array {
    const w = new ByteWriter(1024);
    w.varint(tiles.length);
    for (const tile of tiles) {
        if (!tile) {
            w.u8(0);
        } else if ('fill' in tile) {
            w.u8(1);
            w.string(tile.fill);
        } else {
            w.u8(2);
            w.varint(tile.w);
            w.varint(tile.h);
            if (tile.data.length !== tile.w * tile.h * 4) {
                throw new Error('klr: a tile of the wrong size');
            }
            w.bytes(tile.data);
        }
    }
    return w.toBytes();
}

function decodeTiles(payload: Uint8Array): TKlrTile[] {
    const r = new ByteReader(payload);
    const n = r.varint();
    const out: TKlrTile[] = [];
    for (let i = 0; i < n; i++) {
        const kind = r.u8();
        if (kind === 0) {
            out.push(undefined);
        } else if (kind === 1) {
            out.push({ fill: r.string() });
        } else if (kind === 2) {
            const w = r.varint();
            const h = r.varint();
            out.push({ w, h, data: r.bytes(w * h * 4).slice() });
        } else {
            throw new Error('klr: tile kind ' + kind);
        }
    }
    return out;
}

/** Reads an OPS chunk's payload (and the TILES chunk's after it, if there is one). Throws
 * on anything it can't read: the replay ends at this chunk. */
export function decodeOpsChunk(payload: Uint8Array, tilesPayload?: Uint8Array): TKlrOpsChunk {
    const r = new ByteReader(payload);
    const opsV = r.varint();
    if (opsV !== KLR_OPS_V) {
        throw new Error('klr: opsV ' + opsV);
    }
    const engineV = r.varint();
    const coder = r.u8();
    if (coder !== KLR_CODER) {
        throw new Error('klr: coder ' + coder);
    }
    const penFlags = r.u8();
    const klrFlags = r.varint();
    if (klrFlags & ~KLR_FLAGS_KNOWN) {
        throw new Error('klr: klrFlags ' + klrFlags);
    }
    const startMs = r.varint();
    const durationMs = r.varint();
    const opCount = r.varint();
    const restoreFlag = r.u8();
    const restore = restoreFlag ? readHashes(r) : undefined;
    const endHashes = readHashes(r);
    const src = newSource(coder, KLR_CHANNELS, payload, r.pos, payload.length)!;
    const pen = new PenStrokeDecoder(src, PEN, penFlags); // throws on flags it doesn't know
    const tiles = tilesPayload ? decodeTiles(tilesPayload) : [];
    const tile = (i: TKlrValue): TKlrTile => {
        if (i === -1) {
            return undefined;
        }
        if (typeof i !== 'number' || !(i >= 0 && i < tiles.length)) {
            throw new Error('klr: no tile ' + i);
        }
        return tiles[i];
    };

    const ops: TKlrOp[] = [];
    let count = 0;
    let skipped = 0;
    let prev = 0;
    let clock = 0;
    for (;;) {
        const code = src.u(C.OP, Math.min(prev, 63));
        if (code === OPC.END) {
            break;
        }
        if (++count > opCount) {
            throw new Error('klr: more ops than the header says');
        }
        clock += src.u(C.ODT, Math.min(code, 63));
        prev = code;
        const t = clock;
        if (code >= OPC_SCALAR && code < OPC_SCALAR + SCALAR_METHODS.length) {
            const method = SCALAR_METHODS[code - OPC_SCALAR];
            const names = CANVAS_PARAMS[method];
            const fields: Record<string, TKlrValue> = { [names[0]]: src.u(C.LAYER, 1) };
            switch (method) {
                case 'setOpacity': {
                    const v = readValue(src);
                    if (typeof v !== 'number') {
                        throw new Error('klr: setOpacity without a number');
                    }
                    fields.opacity = v;
                    break;
                }
                case 'setLayerIsVisible':
                    fields.isVisible = src.u(C.MISC, 0) === 1;
                    break;
                case 'setLayerHasClipping':
                    fields.hasClipping = src.u(C.MISC, 0) === 1;
                    break;
                case 'moveLayer':
                    fields.delta = src.s(C.MISC, 2);
                    break;
                case 'mergeLayer': {
                    const m = src.u(C.MISC, 1);
                    if (m > 0) {
                        fields.mixModeStr = mixMode(m - 1);
                    }
                    break;
                }
                case 'renameLayer': {
                    const v = readValue(src);
                    if (typeof v !== 'string') {
                        throw new Error('klr: renameLayer without a string');
                    }
                    fields.name = v;
                    break;
                }
                case 'setMixMode':
                    fields.mixModeStr = mixMode(src.u(C.MISC, 1));
                    break;
            }
            ops.push({ op: 'canvas', t, method, fields });
            continue;
        }
        if (code >= OPC_NAMED && code < OPC_NAMED + NAMED_METHODS.length) {
            const fields = readValue(src);
            if (!isObject(fields)) {
                throw new Error('klr: named fields are not an object');
            }
            ops.push({ op: 'canvas', t, method: NAMED_METHODS[code - OPC_NAMED], fields });
            continue;
        }
        switch (code) {
            case OPC.STROKE: {
                const seed = src.u(C.SEED);
                const samples = KlrSampleCoder.decode(pen, t);
                const n = src.u(C.XFER, 0);
                if (n > MAX_LEN) {
                    throw new Error('klr: ' + n + ' transfers');
                }
                const transfers: number[] = [];
                let place = 0;
                for (let i = 0; i < n; i++) {
                    place += src.u(C.XFER, 1);
                    transfers.push(place);
                }
                const upT = samples[samples.length - 1][0] + src.u(C.UPDT);
                clock = upT;
                ops.push({ op: 'stroke', t, seed, samples, transfers, upT });
                break;
            }
            case OPC.LINE: {
                const seed = src.u(C.SEED);
                const fromLast = src.u(C.MISC, 0) === 1;
                let x0: number | null = null;
                let y0: number | null = null;
                if (!fromLast) {
                    x0 = src.s(C.LXY, 0) / COORD_SCALE;
                    y0 = src.s(C.LXY, 1) / COORD_SCALE;
                }
                const x1 = src.s(C.LXY, 0) / COORD_SCALE;
                const y1 = src.s(C.LXY, 1) / COORD_SCALE;
                ops.push({ op: 'line', t, x0, y0, x1, y1, seed });
                break;
            }
            case OPC.BRUSH: {
                const id = src.u(C.BRUSHID);
                const brush = BRUSH_IDS[id];
                if (!brush) {
                    throw new Error('klr: unknown brush ' + id);
                }
                const mask = src.u(C.BMASK, Math.min(id, 7));
                const fields = BRUSH_FIELDS[brush];
                if (mask >= 2 ** fields.length) {
                    throw new Error('klr: brush mask ' + mask);
                }
                const settings: Record<string, TKlrValue> = {};
                fields.forEach((f, k) => {
                    if (Math.floor(mask / 2 ** k) % 2) {
                        settings[f] = readValue(src);
                    }
                });
                ops.push({ op: 'brush', t, brush, settings });
                break;
            }
            case OPC.LAYER:
            case OPC.ACTIVE:
                ops.push({ op: code === OPC.LAYER ? 'layer' : 'active', t, index: src.u(C.LAYER, 0) });
                break;
            case OPC.UNDO:
                ops.push({ op: 'undo', t });
                break;
            case OPC.REDO:
                ops.push({ op: 'redo', t });
                break;
            case OPC.COPY: {
                const id = src.u(C.ID, 0);
                ops.push({ op: 'copy', t, id, mask: src.u(C.MISC, 0) === 1 });
                break;
            }
            case OPC.PASTE: {
                const id = src.u(C.ID, 0);
                ops.push({ op: 'paste', t, id, params: objectValue(src) });
                break;
            }
            case OPC.SAMPLE: {
                const id = src.u(C.ID, 1);
                ops.push({ op: 'sample', t, id, layer: src.u(C.LAYER, 1) });
                break;
            }
            case OPC.XFORM:
            case OPC.FFD: {
                const sample = src.u(C.ID, 1);
                ops.push({ op: code === OPC.XFORM ? 'xform' : 'ffd', t, sample, params: objectValue(src) });
                break;
            }
            case OPC.FILTER: {
                const f = objectValue(src);
                if (typeof f.name !== 'string' || typeof f.layer !== 'number' || typeof f.seed !== 'number') {
                    throw new Error('klr: FILTER fields');
                }
                ops.push({ op: 'filter', t, name: f.name, layer: f.layer, seed: f.seed, input: f.input });
                break;
            }
            case OPC.TILES: {
                const v = objectValue(src);
                const out: TKlrTiles = {};
                if (v.replaceTop === true) {
                    out.replaceTop = true;
                }
                if (isObject(v.size)) {
                    out.size = { width: v.size.width as number, height: v.size.height as number };
                }
                if (isObject(v.selection)) {
                    out.selection = { value: v.selection.value };
                }
                if (typeof v.activeLayer === 'number') {
                    out.activeLayer = v.activeLayer;
                }
                if (Array.isArray(v.layers)) {
                    out.layers = v.layers.map((layer) => {
                        if (!isObject(layer) || typeof layer.src !== 'number' || !isObject(layer.props)) {
                            throw new Error('klr: TILES layer');
                        }
                        const l: TKlrTilesLayer = { src: layer.src, props: layer.props };
                        if (Array.isArray(layer.tiles)) {
                            l.tiles = layer.tiles.map(tile);
                        }
                        return l;
                    });
                }
                ops.push({ op: 'tiles', t, tiles: out });
                break;
            }
            case OPC.EXT: {
                src.u(C.EXTC); // no codes yet: every one is skipped
                readBytes(src, src.u(C.VLEN, 1));
                skipped++;
                break;
            }
            default:
                // an opcode this build doesn't know: the rest of the chunk can't be read
                throw new Error('klr: unknown opcode ' + code);
        }
    }
    if (count !== opCount || clock !== durationMs) {
        throw new Error(`klr: damaged chunk (${count}/${opCount} ops, ${clock}/${durationMs} ms)`);
    }
    return { opsV, engineV, coder, penFlags, klrFlags, startMs, durationMs, opCount, restore, endHashes, ops, skipped };
}

function isObject(v: TKlrValue): v is Record<string, TKlrValue> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function objectValue(src: Source): Record<string, TKlrValue> {
    const v = readValue(src);
    if (!isObject(v)) {
        throw new Error('klr: named fields are not an object');
    }
    return v;
}

function mixMode(i: number): (typeof MIX_MODES)[number] {
    const m = MIX_MODES[i];
    if (!m) {
        throw new Error('klr: mix mode ' + i);
    }
    return m;
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

// reference: the previous version's PSD, which 2draw gives the player (no URL in the file)
export type TKlrStart = { kind: 'blank'; layers: TKlrStartLayer[] } | { kind: 'reference' };

export type TKlrHead = {
    headV: number;
    build: string;
    width: number;
    height: number;
    hashTile: number;
    start: TKlrStart;
    startHashes: number[]; // per layer of the start picture
};

export function encodeHead(h: Omit<TKlrHead, 'headV' | 'hashTile'>): Uint8Array {
    const w = new ByteWriter(256);
    w.varint(KLR_HEAD_V);
    w.string(h.build);
    w.varint(h.width);
    w.varint(h.height);
    w.varint(KLR_HASH_TILE);
    if (h.start.kind === 'blank') {
        w.u8(0);
        w.varint(h.start.layers.length);
        for (const layer of h.start.layers) {
            w.string(layer.name);
            w.f64(layer.opacity);
            w.u8((layer.isVisible ? 1 : 0) | (layer.hasClipping ? 2 : 0));
            w.varint(Math.max(0, MIX_MODES.indexOf(layer.mixModeStr as (typeof MIX_MODES)[number])));
            w.string(layer.fill);
        }
    } else {
        w.u8(1);
    }
    writeHashes(w, h.startHashes);
    return w.toBytes();
}

export function decodeHead(payload: Uint8Array): TKlrHead {
    const r = new ByteReader(payload);
    const headV = r.varint();
    if (headV !== KLR_HEAD_V) {
        throw new Error('klr: headV ' + headV);
    }
    const build = r.string();
    const width = r.varint();
    const height = r.varint();
    const hashTile = r.varint();
    const kind = r.u8();
    let start: TKlrStart;
    if (kind === 0) {
        const n = r.varint();
        const layers: TKlrStartLayer[] = [];
        for (let i = 0; i < n; i++) {
            const name = r.string();
            const opacity = r.f64();
            const bits = r.u8();
            const mixModeStr = mixMode(r.varint());
            layers.push({ name, opacity, isVisible: !!(bits & 1), mixModeStr, hasClipping: !!(bits & 2), fill: r.string() });
        }
        start = { kind: 'blank', layers };
    } else if (kind === 1) {
        start = { kind: 'reference' };
    } else {
        throw new Error('klr: start ' + kind);
    }
    const startHashes = readHashes(r);
    return { headV, build, width, height, hashTile, start, startHashes };
}

export function encodeChunk(type: number, payload: Uint8Array): Uint8Array {
    const w = new ByteWriter(payload.length + 8);
    w.u8(type);
    w.blob(payload);
    return w.toBytes();
}

/** magic + HEAD chunk */
export function encodeHeadChunk(h: Omit<TKlrHead, 'headV' | 'hashTile'>): Uint8Array {
    return concatBytes([KLR_MAGIC, encodeChunk(CHUNK_HEAD, encodeHead(h))]);
}

export type TKlrFile = {
    head: TKlrHead;
    chunks: TKlrOpsChunk[];
    // why reading stopped early (a damaged or unknown chunk): the replay ends before it
    error?: string;
};

/** Reads a .klr. Throws only when it isn't one (no magic, no HEAD); a chunk it can't read
 * ends it there, with `error` saying why. */
export function parseKlr(bytes: Uint8Array): TKlrFile {
    for (let i = 0; i < KLR_MAGIC.length; i++) {
        if (bytes[i] !== KLR_MAGIC[i]) {
            throw new Error('klr: not a .klr file');
        }
    }
    const r = new ByteReader(bytes.subarray(KLR_MAGIC.length));
    const raw: { type: number; payload: Uint8Array }[] = [];
    let error: string | undefined;
    while (r.remaining > 0) {
        try {
            const type = r.u8();
            raw.push({ type, payload: r.blob() });
        } catch (e) {
            error = 'chunk ' + raw.length + ': ' + (e as Error).message;
            break;
        }
    }
    if (raw[0]?.type !== CHUNK_HEAD) {
        throw new Error('klr: no HEAD');
    }
    const head = decodeHead(raw[0].payload);
    const chunks: TKlrOpsChunk[] = [];
    for (let i = 1; i < raw.length; i++) {
        if (raw[i].type !== CHUNK_OPS) {
            continue; // TILES are read with their OPS chunk; unknown types are skipped
        }
        const tiles = raw[i + 1]?.type === CHUNK_TILES ? raw[i + 1].payload : undefined;
        try {
            chunks.push(decodeOpsChunk(raw[i].payload, tiles));
        } catch (e) {
            error = 'chunk ' + i + ': ' + (e as Error).message;
            break;
        }
    }
    return { head, chunks, ...(error ? { error } : {}) };
}
