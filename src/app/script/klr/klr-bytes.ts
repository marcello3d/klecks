/**
 * Growable byte writer and cursor for the .klr recording (klr-format.ts).
 * Copied from Lascaux's animation format (web/src/anim/bytes.ts, .lsa v3), unchanged apart from
 * indentation and an f32; no dependency across repositories.
 */

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
