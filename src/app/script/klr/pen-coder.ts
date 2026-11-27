// The pen coder: an adaptive binary range coder and the modelling of pen
// samples (time, x, y and any other channels, coded as deltas or second
// differences, optionally on the pointer's lattice), shared by every 2draw
// tool that records strokes. Lascaux Pocket's .lsp format 2 (FORMAT.md) is
// built on it; Klecks's .klr will be. What it is, why, and how a tool adopts
// it: PEN-CODER.md, next to this file.
//
// THIS FILE IS VENDORED. A byte-identical copy lives in the Klecks fork
// (marcello3d/klecks, src/app/script/klr/pen-coder.ts), which can't import
// from 2draw. This one (2draw.net worker/src/pocket/pen-coder.ts) is the
// source of truth: change it here, then copy it over whole; each side has a
// test that the copies match (PEN-CODER.md, "Vendoring"). So: no imports, no
// 2draw or Klecks specifics, and nothing a tool's linter would reformat.
//
// FOREVER READABLE. Drawings coded with it sit on S3 for good. A coding is
// named by its coder number (CODER_RANGE ...) and its flag bits (PEN_XY2
// ...), both stored with what was coded. Never change what an existing
// coder or flag writes or reads: a new coding is a new coder number or a new
// flag bit (PEN_RESERVED), and this file keeps reading the old ones.

// ---------- bytes ----------

/** A growing byte buffer (the coders' output). */
export class PenBytes {
  declare b: Uint8Array<ArrayBuffer>;
  declare n: number;
  constructor() { this.b = new Uint8Array(1024); this.n = 0; }
  room(k: number) { if (this.n + k > this.b.length) { const nb = new Uint8Array(Math.max(this.b.length * 2, this.n + k)); nb.set(this.b.subarray(0, this.n)); this.b = nb; } }
  u8(v: number) { this.room(1); this.b[this.n++] = v; }
  /** LEB128 */
  uv(v: number) { this.room(10); while (v >= 128) { this.b[this.n++] = (v % 128) | 128; v = Math.floor(v / 128); } this.b[this.n++] = v; }
  /** zigzag LEB128 */
  sv(v: number) { this.uv(v < 0 ? -2 * v - 1 : 2 * v); }
  bytes(a: ArrayLike<number>) { this.room(a.length); this.b.set(a, this.n); this.n += a.length; }
  out(): Uint8Array<ArrayBuffer> { return this.b.slice(0, this.n); }
}
/** Reads PenBytes' varints from b[i, end). */
export class PenBytesReader {
  declare b: Uint8Array;
  declare i: number;
  declare end: number;
  constructor(b: Uint8Array, i = 0, end = b.length) { this.b = b; this.i = i; this.end = end; }
  more() { return this.i < this.end; }
  // `!`: in range up to `end`; an `end` past the buffer reads undefined, as it always has
  u8() { if (this.i >= this.end) throw new Error("pen-coder: truncated"); return this.b[this.i++]!; }
  uv() { let v = 0, m = 1, x: number; do { x = this.u8(); v += (x & 127) * m; m *= 128; } while (x & 128); return v; }
  sv() { const v = this.uv(); return v % 2 ? -(v + 1) / 2 : v / 2; }
}

// ---------- range coder ----------
// LZMA's binary range coder (32-bit range, carry propagation through a
// cached byte; numbers stay below 2^40, exact in doubles), with 15-bit
// probabilities that adapt fast while a bit is new (the step is 1/(n+1.5)
// for its first ADAPT_FAST uses) and then settle to 1/2^MOVE. Blocks are
// short (~30 s of drawing), so how quickly the statistics are learned
// matters more than their final precision.

const PROB_BITS = 15, PROB_ONE = 1 << PROB_BITS, MOVE = 5, ADAPT_FAST = 24, TOP = 2 ** 24;
const P_MIN = 31, P_MAX = PROB_ONE - 31;
/** zero bytes a range decoder reads past its end before it calls the stream truncated */
const OVERREAD = 8;
const STEP = Float64Array.from({ length: ADAPT_FAST }, (_, n) => 1 / (n + 1.5));
/** A set of adaptive bits: probability of a 0, and how often each was used. */
interface Bins {
  p: Uint16Array;
  n: Uint8Array;
}
const bins = (len: number): Bins => ({ p: new Uint16Array(len).fill(PROB_ONE / 2), n: new Uint8Array(len) });
// The range coder's hot path. Its `!`s read typed arrays at indexes in range
// by construction: a bit's index is within the Bins its IntModel sized for
// its channel's contexts, STEP is read only below ADAPT_FAST, and m[ch.id]
// has one model per channel.
function adapt(B: Bins, i: number, b: number) {
  const p = B.p[i]!, n = B.n[i]!, target = b ? 0 : PROB_ONE;
  let q = n < ADAPT_FAST ? p + Math.trunc((target - p) * STEP[n]!) : p + ((target - p) >> MOVE);
  if (n < ADAPT_FAST) B.n[i] = n + 1;
  B.p[i] = q < P_MIN ? P_MIN : q > P_MAX ? P_MAX : q;
}
class RangeEncoder {
  declare low: number;
  declare range: number;
  declare cache: number;
  declare cacheSize: number;
  declare w: PenBytes;
  constructor() { this.low = 0; this.range = 0xffffffff; this.cache = 0; this.cacheSize = 1; this.w = new PenBytes(); }
  bit(B: Bins, i: number, b: number) {
    const bound = (this.range >>> PROB_BITS) * B.p[i]!;
    if (b) { this.low += bound; this.range -= bound; } else this.range = bound;
    adapt(B, i, b);
    while (this.range < TOP) { this.range = (this.range * 256) >>> 0; this.shiftLow(); }
  }
  shiftLow() {
    if (this.low < 0xff000000 || this.low >= 2 ** 32) {
      const carry = this.low >= 2 ** 32 ? 1 : 0;
      let temp = this.cache;
      do { this.w.u8((temp + carry) & 0xff); temp = 0xff; } while (--this.cacheSize !== 0);
      this.cache = Math.floor(this.low / TOP) & 0xff;
    }
    this.cacheSize++;
    this.low = (this.low % TOP) * 256;
  }
  finish() { for (let i = 0; i < 5; i++) this.shiftLow(); return this.w.out(); }
}
class RangeDecoder {
  declare b: Uint8Array;
  declare i: number;
  declare end: number;
  declare range: number;
  declare code: number;
  declare over: number;
  constructor(b: Uint8Array, i: number, end: number) {
    this.b = b; this.i = i; this.end = end; this.range = 0xffffffff; this.code = 0; this.over = 0;
    // every finished stream has at least its 5 flushed bytes
    if (Math.min(end, b.length) - i < 5) throw new Error("pen-coder: truncated");
    for (let k = 0; k < 5; k++) this.code = (this.code * 256 + this.byte()) % 2 ** 32;
  }
  // Past the end it reads zeros, as LZMA's decoder does; a stream the
  // encoder finished never needs any (finish flushes enough), so a reader
  // that keeps going is reading a truncated or corrupt stream: it stops
  // after OVERREAD zeros instead of decoding garbage for ever.
  byte() { if (this.i < this.end && this.i < this.b.length) return this.b[this.i++]!; if (++this.over > OVERREAD) throw new Error("pen-coder: truncated"); return 0; }
  bit(B: Bins, i: number) {
    const bound = (this.range >>> PROB_BITS) * B.p[i]!;
    let b: number;
    if (this.code < bound) { this.range = bound; b = 0; } else { this.code -= bound; this.range -= bound; b = 1; }
    adapt(B, i, b);
    while (this.range < TOP) { this.range = (this.range * 256) >>> 0; this.code = (this.code * 256 + this.byte()) >>> 0; }
    return b;
  }
}

// An integer model: for each context, adaptive bits for "is zero", the
// sign (in the context of the previous value's sign), the Elias-gamma
// exponent (unary), and the mantissa (a small tree per exponent for its
// top bits, then one bit per position). Values up to 2^52.
const MAXK = 53, TREE = 3;
class IntModel {
  declare nctx: number;
  declare zero: Bins;
  declare sign: Bins;
  declare exp: Bins;
  declare tree: Bins;
  declare low: Bins;
  declare lastSign: number;
  constructor(nctx: number) {
    this.nctx = nctx;
    this.zero = bins(nctx);
    this.sign = bins(nctx * 3);
    this.exp = bins(nctx * MAXK);
    this.tree = bins(nctx * MAXK * (1 << TREE));
    this.low = bins(nctx * MAXK);
    this.lastSign = 0;
  }
}
// n >= 1, as exponent k (2^k <= n < 2^(k+1)) and the k bits below its top one
function encGamma(rc: RangeEncoder, m: IntModel, c: number, n: number) {
  let k = 0;
  while (2 ** (k + 1) <= n) k++;
  for (let i = 0; i < k; i++) rc.bit(m.exp, c * MAXK + i, 1);
  if (k < MAXK - 1) rc.bit(m.exp, c * MAXK + k, 0);
  let node = 1;
  for (let j = k - 1; j >= 0; j--) {
    const b = Math.floor(n / 2 ** j) % 2, pos = k - 1 - j;
    if (pos < TREE) { rc.bit(m.tree, (c * MAXK + k) * (1 << TREE) + node, b); node = node * 2 + b; }
    else rc.bit(m.low, c * MAXK + pos, b);
  }
}
function decGamma(rc: RangeDecoder, m: IntModel, c: number) {
  let k = 0;
  while (k < MAXK - 1 && rc.bit(m.exp, c * MAXK + k)) k++;
  let n = 1, node = 1;
  for (let pos = 0; pos < k; pos++) {
    const b = pos < TREE ? rc.bit(m.tree, (c * MAXK + k) * (1 << TREE) + node) : rc.bit(m.low, c * MAXK + pos);
    if (pos < TREE) node = node * 2 + b;
    n = n * 2 + b;
  }
  return n;
}

// ---------- channels, sinks and sources ----------
// A tool codes (channel, integer, context) symbols into a sink; a source
// reads them back in the order they were written. Each channel has its own
// statistics (in the range coder), split by a small context the tool picks
// from what is already coded (how fast the pen was moving, say), so the
// coder learns each channel's distribution as the block goes.

/** A channel: its id (its place in the tool's channel list) and how many
 * contexts it has (contexts only matter to the range coder). */
export interface Channel {
  id: number;
  nctx: number;
}
/** A tool's channels by name, and in id order (what sinks and sources take). */
export interface ChannelTable<N extends string> {
  ch: Record<N, Channel>;
  list: Channel[];
}
/** The channel table for a list of [name, contexts]: ids in list order. A
 * tool's list is part of its format: append only (a channel's id is its
 * column in CODER_COLUMNS; the range coder's bytes depend only on the order
 * symbols are coded in and their channels' context counts). */
export function channelTable<N extends string>(spec: readonly (readonly [N, number])[]): ChannelTable<N> {
  const ch = {} as Record<N, Channel>, list: Channel[] = [];
  spec.forEach(([name, nctx], id) => { if (name in ch) throw new Error("pen-coder: channel twice: " + name); ch[name] = { id, nctx }; list.push(ch[name]); });
  return { ch, list };
}

/** Where a tool's symbols go: a signed or unsigned integer on a channel, in
 * a context (0 to the channel's nctx - 1). */
export interface Sink {
  s(ch: Channel, v: number, c?: number): void;
  u(ch: Channel, v: number, c?: number): void;
  finish(): Uint8Array<ArrayBuffer>;
}
/** The symbols read back, in the order they were written. */
export interface Source {
  s(ch: Channel, c?: number): number;
  u(ch: Channel, c?: number): number;
}

/** The adaptive range coder: a fresh model per channel. */
export class RangeSink implements Sink {
  declare rc: RangeEncoder;
  declare m: IntModel[];
  constructor(channels: readonly Channel[]) { this.rc = new RangeEncoder(); this.m = channels.map((c) => new IntModel(c.nctx)); }
  s(ch: Channel, v: number, c = 0) {
    const m = this.m[ch.id]!, rc = this.rc;
    rc.bit(m.zero, c, v === 0 ? 0 : 1);
    if (v === 0) { m.lastSign = 0; return; }
    rc.bit(m.sign, c * 3 + m.lastSign, v < 0 ? 1 : 0);
    m.lastSign = v < 0 ? 2 : 1;
    encGamma(rc, m, c, Math.abs(v));
  }
  u(ch: Channel, v: number, c = 0) { encGamma(this.rc, this.m[ch.id]!, c, v + 1); }
  finish() { return this.rc.finish(); }
}
export class RangeSource implements Source {
  declare rc: RangeDecoder;
  declare m: IntModel[];
  constructor(channels: readonly Channel[], b: Uint8Array, i: number, end: number) { this.rc = new RangeDecoder(b, i, end); this.m = channels.map((c) => new IntModel(c.nctx)); }
  s(ch: Channel, c = 0) {
    const m = this.m[ch.id]!, rc = this.rc;
    if (!rc.bit(m.zero, c)) { m.lastSign = 0; return 0; }
    const neg = rc.bit(m.sign, c * 3 + m.lastSign);
    m.lastSign = neg ? 2 : 1;
    const n = decGamma(rc, m, c);
    return neg ? -n : n;
  }
  u(ch: Channel, c = 0) { return decGamma(this.rc, this.m[ch.id]!, c) - 1; }
}
/** The same symbols as (zigzag) LEB128 varints, interleaved: for debugging
 * and size comparisons (they compress under gzip, but need it). */
export class VarintSink implements Sink {
  declare w: PenBytes;
  constructor(_channels?: readonly Channel[]) { this.w = new PenBytes(); }
  s(_ch: Channel, v: number) { this.w.sv(v); }
  u(_ch: Channel, v: number) { this.w.uv(v); }
  finish() { return this.w.out(); }
}
export class VarintSource implements Source {
  declare r: PenBytesReader;
  constructor(_channels: readonly Channel[], b: Uint8Array, i: number, end: number) { this.r = new PenBytesReader(b, i, end); }
  s() { return this.r.sv(); }
  u() { return this.r.uv(); }
}
/** The same varints, one column per channel: u count, then [u channel id]
 * [u length][bytes] for each channel used. */
export class ColumnSink implements Sink {
  declare w: PenBytes[];
  constructor(channels: readonly Channel[]) { this.w = channels.map(() => new PenBytes()); }
  col(ch: Channel) { const w = this.w[ch.id]; if (!w) throw new Error("pen-coder: unknown channel"); return w; }
  s(ch: Channel, v: number) { this.col(ch).sv(v); }
  u(ch: Channel, v: number) { this.col(ch).uv(v); }
  finish() {
    const o = new PenBytes(), used = this.w.map((w, id): [number, PenBytes] => [id, w]).filter(([, w]) => w.n);
    o.uv(used.length);
    for (const [id, w] of used) { o.uv(id); o.uv(w.n); o.bytes(w.b.subarray(0, w.n)); }
    return o.out();
  }
}
export class ColumnSource implements Source {
  declare r: PenBytesReader[];
  constructor(_channels: readonly Channel[], b: Uint8Array, i: number, end: number) {
    const r = new PenBytesReader(b, i, end), n = r.uv();
    this.r = [];
    for (let k = 0; k < n; k++) { const id = r.uv(), len = r.uv(); this.r[id] = new PenBytesReader(b, r.i, r.i + len); r.i += len; }
  }
  col(ch: Channel) { const r = this.r[ch.id]; if (!r) throw new Error("pen-coder: missing column"); return r; }
  s(ch: Channel) { return this.col(ch).sv(); }
  u(ch: Channel) { return this.col(ch).uv(); }
}

/** The coders, by the number a tool stores with what it coded. */
export const CODER_RANGE = 0, CODER_VARINT = 1, CODER_COLUMNS = 2;
const SINKS: (new (channels: readonly Channel[]) => Sink)[] = [RangeSink, VarintSink, ColumnSink];
const SOURCES: (new (channels: readonly Channel[], b: Uint8Array, i: number, end: number) => Source)[] = [RangeSource, VarintSource, ColumnSource];
/** A new sink of coder `coder` over the tool's channels (throws on an unknown coder). */
export function newSink(coder: number, channels: readonly Channel[]): Sink {
  const S = SINKS[coder];
  if (!S) throw new Error(`pen-coder: unknown coder ${coder}`);
  return new S(channels);
}
/** A source reading b[i, end) as coder `coder`, or null for a coder this
 * file doesn't know (a later one: the tool skips what it holds). */
export function newSource(coder: number, channels: readonly Channel[], b: Uint8Array, i: number, end: number): Source | null {
  const S = SOURCES[coder];
  return S ? new S(channels, b, i, end) : null;
}

// ---------- modelling helpers ----------

/** A context from a value's size: 0, 1-2, 3-6, 7-14, 15-30, 31+ (0 to 5). */
export const bucket = (v: number) => { v = Math.abs(v); return v === 0 ? 0 : v < 3 ? 1 : v < 7 ? 2 : v < 15 ? 3 : v < 31 ? 4 : 5; };

// ---------- the pointer lattice ----------
// A finger's or mouse's clientX/Y lie on a grid of 1/dpr (or 1) CSS px, so
// at view scale s its positions in 1/U px fall on a lattice of step
// L = U/(s*dpr). fitLattice looks for that lattice (the step to 2^-20 and an
// offset to 1/OFFQ unit, per axis); if LATTICE_FIT of the stroke's points
// lie on it, the stroke can be coded as lattice indexes plus a correction
// per point (almost always 0): x = round(o + n*L) + c, exactly.

/** The lattice step's precision (1/LQ) and the offsets' (1/OFFQ unit). */
export const LQ = 2 ** 20, OFFQ = 32;
const LATTICE_FIT = 0.9;
/** A stroke's lattice: step Lq / LQ, offsets ox, oy (1/OFFQ unit). */
export interface LatticeFit {
  Lq: number;
  ox: number;
  oy: number;
  cx?: number[];
  cy?: number[];
}
function onLattice(vals: number[], L: number, o: number, step: number) {
  let f = 0;
  for (let i = 0; i < vals.length; i += step) { const v = vals[i]!; if (v === Math.round(o + Math.round((v - o) / L) * L)) f++; } // `!`: i < vals.length
  return f;
}
function bestOffset(vals: number[], L: number, step: number): [number, number] {
  let best = -1, ob = 0;
  const v0 = vals[0];
  if (v0 === undefined) return [0, 0]; // no points: none on any lattice (fitLattice wants 8)
  for (let k = 0; k < OFFQ; k++) { const f = onLattice(vals, L, v0 - 0.5 + k / OFFQ, step); if (f > best) { best = f; ob = k; } }
  return [best, ob];
}
/** The lattice a stroke's points lie on, or null. xs/ys: the points in
 * 1/U px; s: the view scale in force; dpr: the device's pixel ratio;
 * prevL: the last stroke's step (0: none), tried first. An encoder's
 * search: what it finds is stored, so a better search never changes what
 * reads back. */
export function fitLattice(xs: number[], ys: number[], s: number, dpr: number, prevL: number, U = 16): LatticeFit | null {
  const n = xs.length;
  if (n < 8 || !(s > 0)) return null;
  const step = Math.max(1, Math.ceil(n / 48)), m = Math.ceil(n / step);
  const score = (L: number) => bestOffset(xs, L, step)[0] + bestOffset(ys, L, step)[0];
  const good = (f: number) => f >= LATTICE_FIT * 2 * m;
  // most strokes are drawn at the same view as the one before
  let best = prevL ? { f: score(prevL), L: prevL } : null;
  if (!best || best.f < 2 * m) {
    // the recording's dpr first; a drawing carried on on another device, or
    // a recording loaded from a file (whose dpr is this device's), has others
    for (const L0 of new Set([U / (s * dpr), U / (s * 3), U / (s * 2), U / s])) {
      if (!(L0 >= 1.25 && L0 < 1e4)) continue;
      // the view scale may be rounded (Pocket's to 1e-4), so the step is
      // searched around it: coarsely, then finely around the best, finely
      // enough to stay on the grid across the stroke
      const span = Math.max(1, (Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys)) / L0);
      const range = L0 * Math.max(1e-4, 6e-5 / s), fine = Math.min(range, 0.02 / span);
      let c = { f: -1, L: L0 };
      const K = Math.min(24, Math.ceil(range / fine));
      for (let j = -K; j <= K; j++) { const L = L0 + (j * range) / K, f = score(L); if (f > c.f) c = { f, L }; }
      const coarse = range / K, k = Math.min(24, Math.ceil(coarse / fine));
      for (let j = -k; j <= k; j++) { const L = c.L + (j * coarse) / k, f = score(L); if (f > c.f) c = { f, L }; }
      if (!best || c.f > best.f) best = c;
      if (best.f === 2 * m) break;
    }
  }
  if (!best || !good(best.f)) return null;
  const Lq = Math.round(best.L * LQ), L = Lq / LQ;
  const [fx, ox] = bestOffset(xs, L, 1), [fy, oy] = bestOffset(ys, L, 1);
  if (fx + fy < LATTICE_FIT * 2 * n) return null;
  return { Lq, ox, oy };
}
/** A lattice's index of each point, and its correction. */
export function toLattice(vals: number[], L: number, o: number): { idx: number[]; corr: number[] } {
  const idx: number[] = [], corr: number[] = [];
  for (const v of vals) { const k = Math.round((v - o) / L); idx.push(k); corr.push(v - Math.round(o + k * L)); }
  return { idx, corr };
}

// ---------- stroke samples ----------
// A stroke is a list of samples, each [t, x, y, e0, e1, ...] in integers of
// the tool's units (Pocket: t in 0.1 ms, x/y in 1/16 or 1/256 px, pressure
// in 1/4096, altitude and azimuth in 1/1000 rad; Klecks: ms, 1/32 px, u8).
// The extra channels e0, e1, ... are the tool's; mask bit k says extra k
// varies within the stroke (the tool stores each extra's first value).
//
// PenEncoder.samples codes everything after the first sample: the lattice
// (PEN_LATTICE), then per sample dt, dx, dy (or their second differences,
// PEN_T2, PEN_XY2), the lattice corrections, and each varying extra's delta.
// The tool codes the stroke's head (its start, sample count, mask, first
// sample) its own way, or with encodeStroke/decodeStroke below.

/** x/y as second differences (the delta of the delta). */
export const PEN_XY2 = 1;
/** sample times as second differences */
export const PEN_T2 = 2;
/** strokes may be coded on their pointer's lattice */
export const PEN_LATTICE = 8;
/** The flags a new tool should use. (The bit values are Pocket's F_XY2,
 * F_T2 and F_LATTICE, so its block flags pass straight through.) */
export const PEN_FLAGS = PEN_XY2 | PEN_T2 | PEN_LATTICE;
/** Bits of the flags byte that are Pocket's forever (F_VIEW2 4, F_FINE 16):
 * this file ignores them and never gives them a meaning. */
export const PEN_POCKET_BITS = 4 | 16;
/** Bits kept for this file's later codings (32, 64, 128). A coder or
 * decoder refuses flags with any of them, or above a byte: they would mean a
 * coding it doesn't have. A tool's own flags never go here: they go in a
 * field of its own (.klr's klrFlags). */
export const PEN_RESERVED = 32 | 64 | 128;
const checkFlags = (flags: number) => { if (!Number.isInteger(flags) || flags < 0 || flags > 255 || flags & PEN_RESERVED) throw new Error("pen-coder: flags this file doesn't know: " + flags); return flags; };
/** The most samples a stroke may have when read (a longer count is a corrupt
 * stream: 2^22, over nine hours at 120 Hz). */
export const PEN_MAX_SAMPLES = 2 ** 22;

/** The channels the sample coder writes, from the tool's table. */
export interface PenChannels {
  /** dt (or its second difference): 27 contexts */
  DT: Channel;
  /** dx, dy (or theirs), off a lattice: 36 contexts each */
  DX: Channel;
  DY: Channel;
  /** dx, dy of lattice indexes: 36 contexts each */
  DXL: Channel;
  DYL: Channel;
  /** a lattice point's corrections: 4 contexts */
  CORR: Channel;
  /** the lattice's presence, step and offsets: 2 contexts */
  LAT: Channel;
  /** each extra's deltas: 6 contexts each */
  extra: readonly Channel[];
}
/** The context counts PenChannels' channels need, for a tool's table. */
export const PEN_NCTX = { DT: 27, DX: 36, DY: 36, DXL: 36, DYL: 36, CORR: 4, LAT: 2, EXTRA: 6 } as const;

/** Where a stroke's lattice may be: the view scale in force, the device's
 * pixel ratio, the x/y unit (U per px), and a key for the encoder's
 * shortcut (a pointer that missed the lattice 3 times in a row with the
 * same key isn't searched again; Pocket: pointer type and view scale). */
export interface PenGrid {
  scale: number;
  dpr: number;
  U: number;
  key: string;
}

/** Codes the samples of a block's strokes, one stroke after another (the
 * statistics and the last stroke's dt and lattice carry over: one per block,
 * on the block's sink). */
export class PenEncoder {
  declare sink: Sink;
  declare ch: PenChannels;
  declare flags: number;
  /** the last stroke's last dt, and lattice step (0: none) */
  declare lastDt: number;
  declare lastLq: number;
  declare hintLq: number;
  declare misses: Map<string, number>;
  constructor(sink: Sink, ch: PenChannels, flags: number) {
    this.sink = sink; this.ch = ch; this.flags = checkFlags(flags);
    this.lastDt = 0; this.lastLq = 0; this.hintLq = 0; this.misses = new Map();
  }
  /** Everything after S[0] (S: [t, x, y, ...extras], integers; S[0] is
   * the tool's to code). grid: where a lattice may be (null: none is
   * searched; with PEN_LATTICE its "no lattice" bit is still coded).
   * Returns how many samples sit on a lattice with no correction (0
   * without one). */
  samples(S: readonly (readonly number[])[], mask: number, grid: PenGrid | null): number {
    const { sink, ch, flags } = this, S0 = S[0];
    if (!S0) throw new Error("pen-coder: a stroke has a sample");
    let PX = S.map((s) => s[1]!), PY = S.map((s) => s[2]!), lat: LatticeFit | null = null, exact = 0;
    // the lattice's corrections (lat.cx, lat.cy), once it is kept
    let CX: number[] = [], CY: number[] = [];
    if (flags & PEN_LATTICE) {
      if (grid) {
        const missed = this.misses.get(grid.key) || 0;
        lat = missed >= 3 ? null : fitLattice(PX, PY, grid.scale, grid.dpr, this.hintLq / LQ, grid.U);
        if (lat) this.misses.delete(grid.key); else if (S.length >= 8) this.misses.set(grid.key, missed + 1);
        if (lat) {
          const L = lat.Lq / LQ, X = toLattice(PX, L, S0[1]! - 0.5 + lat.ox / OFFQ), Y = toLattice(PY, L, S0[2]! - 0.5 + lat.oy / OFFQ);
          if (X.idx[0] || Y.idx[0] || X.corr[0] || Y.corr[0]) lat = null;
          else { PX = X.idx; PY = Y.idx; CX = lat.cx = X.corr; CY = lat.cy = Y.corr; }
        }
        if (lat) exact = S.length - CX.filter((c, i) => c || CY[i]).length;
      }
      sink.u(ch.LAT, lat ? 1 : 0, this.lastLq ? 1 : 0);
      if (lat) { sink.s(ch.LAT, lat.Lq - this.lastLq, 1); sink.u(ch.LAT, lat.ox, 0); sink.u(ch.LAT, lat.oy, 0); this.lastLq = this.hintLq = lat.Lq; }
    }
    const DX = lat ? ch.DXL : ch.DX, DY = lat ? ch.DYL : ch.DY, ne = ch.extra.length;
    const prevE = new Array<number>(ne).fill(0);
    let pdt = this.lastDt, run = 0, lastR = 0, pdx = 0, pdy = 0, rx = 0, kx = 0, ky = 0;
    // the per-sample loop: `!` reads S, PX, PY (and CX, CY, on a lattice:
    // toLattice's, one per point) at i < S.length, each as long as S
    let q = S0, qx = PX[0]!, qy = PY[0]!;
    for (let i = 1; i < S.length; i++) {
      const s = S[i]!, sx = PX[i]!, sy = PY[i]!;
      const dt = s[0]! - q[0]!, dx = sx - qx, dy = sy - qy;
      if (flags & PEN_T2) { const r = dt - pdt; sink.s(ch.DT, r, Math.min(run, 8) * 3 + lastR); run = r === 0 ? run + 1 : 0; if (r) lastR = r > 0 ? 1 : 2; }
      else sink.s(ch.DT, dt, bucket(pdt));
      pdt = dt;
      if (flags & PEN_XY2) {
        const ex = dx - pdx, ey = dy - pdy;
        sink.s(DX, ex, bucket(pdx) * 6 + bucket(rx));
        sink.s(DY, ey, bucket(pdy) * 6 + bucket(ex));
        rx = ex;
      } else {
        sink.s(DX, dx, bucket(pdx));
        sink.s(DY, dy, bucket(pdy) * 6 + bucket(dx));
      }
      pdx = dx; pdy = dy;
      if (lat) { const cx = CX[i]!, cy = CY[i]!; sink.s(ch.CORR, cx, kx); sink.s(ch.CORR, cy, 2 + ky); kx = cx ? 1 : 0; ky = cy ? 1 : 0; }
      for (let k = 0; k < ne; k++) if (mask & (1 << k)) { const d = s[3 + k]! - q[3 + k]!; sink.s(ch.extra[k]!, d, bucket(prevE[k]!)); prevE[k] = d; }
      q = s; qx = sx; qy = sy;
    }
    this.lastDt = pdt;
    return exact;
  }
}

/** Reads what PenEncoder wrote, with the same channels and flags. */
export class PenDecoder {
  declare src: Source;
  declare ch: PenChannels;
  declare flags: number;
  declare lastDt: number;
  declare lastLq: number;
  constructor(src: Source, ch: PenChannels, flags: number) { this.src = src; this.ch = ch; this.flags = checkFlags(flags); this.lastDt = 0; this.lastLq = 0; }
  /** The n - 1 samples after s (the first sample, as the tool read it:
   * [t, x, y, ...extras]): s is updated in place to each in turn and passed
   * to emit (copy it to keep it). Leaves s at the last sample. */
  samples(s: number[], n: number, mask: number, emit: (s: number[]) => void): void {
    if (!(n >= 1 && n <= PEN_MAX_SAMPLES)) throw new Error("pen-coder: a stroke of " + n + " samples");
    const { src, ch, flags } = this;
    let lat: { L: number; ox: number; oy: number } | null = null;
    if (flags & PEN_LATTICE && src.u(ch.LAT, this.lastLq ? 1 : 0)) {
      const Lq = this.lastLq + src.s(ch.LAT, 1);
      lat = { L: Lq / LQ, ox: s[1]! - 0.5 + src.u(ch.LAT, 0) / OFFQ, oy: s[2]! - 0.5 + src.u(ch.LAT, 0) / OFFQ };
      this.lastLq = Lq;
    }
    const DX = lat ? ch.DXL : ch.DX, DY = lat ? ch.DYL : ch.DY, ne = ch.extra.length;
    const prevE = new Array<number>(ne).fill(0);
    let px = lat ? 0 : s[1]!, py = lat ? 0 : s[2]!, kx = 0, ky = 0;
    let pdt = this.lastDt, run = 0, lastR = 0, pdx = 0, pdy = 0, rx = 0;
    for (let i = 1; i < n; i++) {
      let dt: number, dx: number, dy: number;
      if (flags & PEN_T2) { const r = src.s(ch.DT, Math.min(run, 8) * 3 + lastR); run = r === 0 ? run + 1 : 0; if (r) lastR = r > 0 ? 1 : 2; dt = pdt + r; }
      else dt = src.s(ch.DT, bucket(pdt));
      pdt = dt;
      if (flags & PEN_XY2) {
        const ex = src.s(DX, bucket(pdx) * 6 + bucket(rx));
        const ey = src.s(DY, bucket(pdy) * 6 + bucket(ex));
        dx = pdx + ex; dy = pdy + ey; rx = ex;
      } else {
        dx = src.s(DX, bucket(pdx));
        dy = src.s(DY, bucket(pdy) * 6 + bucket(dx));
      }
      pdx = dx; pdy = dy;
      px += dx; py += dy;
      s[0] = s[0]! + dt;
      if (lat) {
        const cx = src.s(ch.CORR, kx), cy = src.s(ch.CORR, 2 + ky);
        kx = cx ? 1 : 0; ky = cy ? 1 : 0;
        s[1] = Math.round(lat.ox + px * lat.L) + cx; s[2] = Math.round(lat.oy + py * lat.L) + cy;
      } else { s[1] = px; s[2] = py; }
      for (let k = 0; k < ne; k++) if (mask & (1 << k)) { const d = src.s(ch.extra[k]!, bucket(prevE[k]!)); prevE[k] = d; s[3 + k] = s[3 + k]! + d; }
      emit(s);
    }
    this.lastDt = pdt;
  }
}

// ---------- whole strokes (for a new tool) ----------
// A stroke's head as well, for a tool with no head of its own to keep:
//   N      the sample count - 1
//   MASK   which extras vary (bit k: extra k)
//   X0, Y0 the first point, from the last stroke's last point in the block
//   FIRST  each extra's first value (context 2k + varies)
//   then PenEncoder.samples.
// The stroke's start time is the tool's to code (its clock, its events);
// sample times are coded from the first sample's. Pocket codes its own head
// (FORMAT.md) and uses PenEncoder directly.

/** The [name, contexts] entries encodeStroke's channels need, for a tool to
 * put in its channel table (any order, any place; names as given), with
 * one delta channel per extra, named by the tool (e.g. ["P"]). */
export function penChannelSpec<E extends string>(extras: readonly E[]): [string, number][] {
  return [["N", 1], ["MASK", 1], ["X0", 1], ["Y0", 1], ["FIRST", Math.max(1, 2 * extras.length)], ["DT", PEN_NCTX.DT], ["DX", PEN_NCTX.DX], ["DY", PEN_NCTX.DY], ["DXL", PEN_NCTX.DXL], ["DYL", PEN_NCTX.DYL], ["CORR", PEN_NCTX.CORR], ["LAT", PEN_NCTX.LAT], ...extras.map((e): [string, number] => [e, PEN_NCTX.EXTRA])];
}
/** PenChannels and the head's channels, from a table made with penChannelSpec. */
export interface PenStrokeChannels extends PenChannels {
  N: Channel;
  MASK: Channel;
  X0: Channel;
  Y0: Channel;
  FIRST: Channel;
}
export function penStrokeChannels(ch: Record<string, Channel>, extras: readonly string[]): PenStrokeChannels {
  const get = (n: string) => { const c = ch[n]; if (!c) throw new Error("pen-coder: no channel " + n); return c; };
  return { N: get("N"), MASK: get("MASK"), X0: get("X0"), Y0: get("Y0"), FIRST: get("FIRST"), DT: get("DT"), DX: get("DX"), DY: get("DY"), DXL: get("DXL"), DYL: get("DYL"), CORR: get("CORR"), LAT: get("LAT"), extra: extras.map(get) };
}

/** A block's strokes, head and samples (one per block, on the block's sink). */
export class PenStrokeEncoder extends PenEncoder {
  declare sc: PenStrokeChannels;
  declare lastX: number;
  declare lastY: number;
  constructor(sink: Sink, ch: PenStrokeChannels, flags: number) { super(sink, ch, flags); this.sc = ch; this.lastX = 0; this.lastY = 0; }
  /** One stroke: S as for samples() (at least one sample); returns what
   * samples() does. The extras' first values are signed integers. */
  stroke(S: readonly (readonly number[])[], grid: PenGrid | null = null): number {
    const { sink, sc } = this, S0 = S[0], end = S[S.length - 1];
    if (!S0 || !end) throw new Error("pen-coder: a stroke has a sample");
    let mask = 0;
    for (let k = 0; k < sc.extra.length; k++) if (S.some((s) => s[3 + k] !== S0[3 + k])) mask |= 1 << k;
    sink.u(sc.N, S.length - 1);
    sink.u(sc.MASK, mask);
    sink.s(sc.X0, S0[1]! - this.lastX); sink.s(sc.Y0, S0[2]! - this.lastY);
    for (let k = 0; k < sc.extra.length; k++) sink.s(sc.FIRST, S0[3 + k]!, 2 * k + (mask >> k & 1));
    const exact = this.samples(S, mask, grid);
    this.lastX = end[1]!; this.lastY = end[2]!;
    return exact;
  }
}
/** Reads PenStrokeEncoder's strokes. */
export class PenStrokeDecoder extends PenDecoder {
  declare sc: PenStrokeChannels;
  declare lastX: number;
  declare lastY: number;
  constructor(src: Source, ch: PenStrokeChannels, flags: number) { super(src, ch, flags); this.sc = ch; this.lastX = 0; this.lastY = 0; }
  /** One stroke, its first sample at time t0: the samples, [t, x, y, ...extras]. */
  stroke(t0 = 0): number[][] {
    const { src, sc } = this, ne = sc.extra.length;
    const n = src.u(sc.N) + 1, mask = src.u(sc.MASK);
    if (n > PEN_MAX_SAMPLES) throw new Error("pen-coder: a stroke of " + n + " samples");
    const s = [t0, this.lastX + src.s(sc.X0), this.lastY + src.s(sc.Y0)];
    for (let k = 0; k < ne; k++) s.push(src.s(sc.FIRST, 2 * k + (mask >> k & 1)));
    const out = [s.slice()];
    this.samples(s, n, mask, (q) => out.push(q.slice()));
    this.lastX = s[1]!; this.lastY = s[2]!;
    return out;
  }
}
