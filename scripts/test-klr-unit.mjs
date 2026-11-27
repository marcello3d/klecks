// Unit tests of the .klr v0 coder (src/app/script/klr/klr-format.ts; spec: 2draw.net's
// worker/src/pocket/PEN-CODER.md, section 8):
//   node --test scripts/test-klr-unit.mjs
// Node runs the .ts files as they are (type stripping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BRUSH_FIELDS,
    BRUSH_IDS,
    CANVAS_METHODS,
    CANVAS_PARAMS,
    canvasFields,
    CHUNK_OPS,
    concatBytes,
    decodeOpsChunk,
    encodeChunk,
    encodeHeadChunk,
    encodeOpsChunk,
    fnv1a,
    KLR_CHANNELS,
    KLR_ENGINE_V,
    KlrUnencodable,
    NAMED_METHODS,
    OPC,
    OPC_NAMED,
    OPC_SCALAR,
    parseKlr,
    prepareOp,
    quantizeCoord,
    quantizePressure,
    readValue,
    SCALAR_METHODS,
    writeValue,
} from '../src/app/script/klr/klr-format.ts';
import { newSink, newSource, CODER_RANGE, CODER_VARINT } from '../src/app/script/klr/pen-coder.ts';

const head = {
    build: 'abc12345',
    width: 1200,
    height: 900,
    start: {
        kind: 'blank',
        layers: [
            { name: 'Background', opacity: 1, isVisible: true, mixModeStr: 'source-over', hasClipping: false, fill: '#fff' },
            { name: 'Layer 1', opacity: 0.73, isVisible: false, mixModeStr: 'multiply', hasClipping: true, fill: 'transparent' },
        ],
    },
    startHashes: [0x12345678, 0xffffffff],
};

const roundTripValue = (v, coder = CODER_RANGE) => {
    const sink = newSink(coder, KLR_CHANNELS);
    writeValue(sink, v);
    const b = sink.finish();
    return readValue(newSource(coder, KLR_CHANNELS, b, 0, b.length));
};

test('values round-trip exactly', () => {
    const v = {
        a: 1,
        b: -7,
        c: 0.5,
        d: 0.1, // f64, exact
        e: 'text ✓',
        f: [true, false, null, undefined, [1, [2, [3]]]],
        g: { r: 10, g: 20, b: 30 }, // the rgb tag
        g2: { r: 10.5, g: 20, b: 30 }, // not integers: an object
        g3: { g: 20, r: 10, b: 30 }, // other order: an object
        i: 2 ** 40,
        i2: 2 ** 53 - 1,
        j: NaN,
        k: -Infinity,
        l: 0.73,
    };
    for (const coder of [CODER_RANGE, CODER_VARINT]) assert.deepEqual(roundTripValue(v, coder), v);
    assert.ok(Object.is(roundTripValue(-0), -0));
    assert.deepEqual(Object.keys(roundTripValue(v.g3)), ['g', 'r', 'b']);
    const poly = [[[[0, 0], [10.25, 0], [10.25, 3.3333333333], [0, 0]]]];
    assert.deepEqual(roundTripValue(poly), poly);
});

test('values refuse functions, typed arrays and host objects', () => {
    assert.throws(() => prepareOp({ op: 'canvas', method: 'drawShape', fields: { layerIndex: 0, shapeObj: { f: () => 1 } } }), KlrUnencodable);
    assert.throws(() => prepareOp({ op: 'canvas', method: 'drawShape', fields: { layerIndex: 0, shapeObj: new Float32Array(2) } }), KlrUnencodable);
    assert.throws(() => prepareOp({ op: 'canvas', method: 'drawShape', fields: { layerIndex: 0, shapeObj: Uint8Array.of(1) } }), KlrUnencodable);
    // typed fields are checked too, before any of the op is coded
    assert.throws(() => prepareOp({ op: 'canvas', method: 'setMixMode', fields: { layerIndex: 0, mixModeStr: 'nope' } }), KlrUnencodable);
    assert.throws(() => prepareOp({ op: 'canvas', method: 'setLayerIsVisible', fields: { layerIndex: 0, isVisible: 1 } }), KlrUnencodable);
    assert.throws(() => prepareOp({ op: 'canvas', method: 'setOpacity', fields: { layerIndex: -1, opacity: 1 } }), KlrUnencodable);
    assert.throws(() => prepareOp({ op: 'brush', brush: 'penBrush', settings: { notAField: 1 } }), KlrUnencodable);
});

test('prepareOp copies the values (the app may change its objects later)', () => {
    const shape = { type: 'rect', x1: 1, fillRgb: { r: 1, g: 2, b: 3 } };
    const op = prepareOp({ op: 'canvas', method: 'drawShape', fields: canvasFields('drawShape', [2, shape]) });
    shape.x1 = 99;
    shape.fillRgb.r = 99;
    assert.deepEqual(op.fields, { layerIndex: 2, shapeObj: { type: 'rect', x1: 1, fillRgb: { r: 1, g: 2, b: 3 } } });
});

test('named fields from a call', () => {
    assert.deepEqual(canvasFields('resize', [10, 20]), { w: 10, h: 20 });
    assert.deepEqual(canvasFields('drawShape', [1, { a: 1 }]), { layerIndex: 1, shapeObj: { a: 1 } });
    assert.deepEqual(canvasFields('mergeAll', []), {});
    assert.throws(() => canvasFields('rotate', [90, 1]), KlrUnencodable);
    for (const m of CANVAS_METHODS) assert.ok(Array.isArray(CANVAS_PARAMS[m]), m);
    assert.equal(SCALAR_METHODS.length, 9);
    assert.equal(NAMED_METHODS.length, 14);
    assert.equal(OPC_SCALAR + SCALAR_METHODS.length, OPC_NAMED);
    assert.equal(OPC_NAMED + NAMED_METHODS.indexOf('setSelection'), 38);
});

test('quantization', () => {
    assert.equal(quantizeCoord(10.01), 10);
    assert.equal(quantizeCoord(10.02), 10 + 1 / 32);
    assert.equal(quantizePressure(2), 1);
    assert.equal(quantizePressure(0.5), 128 / 255);
});

test('fnv1a', () => {
    assert.equal(fnv1a([]), 0x811c9dc5);
    assert.equal(fnv1a(new TextEncoder().encode('a')), 0xe40c292c);
});

function stroke(t, x, y, n, seed) {
    const samples = [];
    for (let i = 0; i < n; i++) samples.push([t + i * 8, Math.round((x + i * 3.1) * 32), Math.round((y - i * 1.7) * 32), Math.round(100 + i * 4)]);
    return { op: 'stroke', t, seed, samples, transfers: [1, Math.min(4, n), Math.min(4, n), n], upT: t + (n - 1) * 8 + 5 };
}

// every op type, at times t
function sampleOps() {
    const ops = [];
    let t = 3;
    const at = (op) => ops.push({ ...op, t: (t += 7) });
    at({ op: 'brush', brush: 'sketchyBrush', settings: { settingSize: 3.5, settingColor: { r: 1, g: 2, b: 3 }, sketchySeed: 42 } });
    at({ op: 'brush', brush: 'penBrush', settings: Object.fromEntries(BRUSH_FIELDS.penBrush.map((f, i) => [f, i % 2 ? true : 0.25 * i])) });
    at({ op: 'layer', index: 1 });
    ops.push(stroke((t += 7), 100.3, 200.7, 20, 1));
    t = ops.at(-1).upT;
    ops.push(stroke((t += 30), 300, 300, 1, 2)); // a single sample
    t = ops.at(-1).upT;
    at({ op: 'line', x0: 1, y0: 2, x1: 300.5, y1: -4, seed: 2 });
    at({ op: 'line', x0: null, y0: null, x1: 3, y1: 4, seed: 3 });
    const fields = {
        setOpacity: { layerIndex: 1, opacity: 0.73 },
        setLayerIsVisible: { layerIndex: 2, isVisible: false },
        setLayerHasClipping: { layerIndex: 0, hasClipping: true },
        moveLayer: { index: 3, delta: -2 },
        mergeLayer: { layerIndex: 2 },
        removeLayer: { index: 4 },
        duplicateLayer: { srcIndex: 1 },
        renameLayer: { index: 1, name: 'Renamed ✓' },
        setMixMode: { layerIndex: 1, mixModeStr: 'luminosity' },
        drawShape: { layerIndex: 2, shapeObj: { type: 'ellipse', x1: 200, y1: 150.5, fillRgb: { r: 200, g: 50, b: 50 }, opacity: 0.8 } },
        resize: { w: 100, h: 50, algorithm: 'smooth' },
        mergeAll: {},
    };
    for (const method of CANVAS_METHODS) at({ op: 'canvas', method, fields: fields[method] ?? { layerIndex: 1, p: { x: 0.25, s: 'a' } } });
    at({ op: 'canvas', method: 'mergeLayer', fields: { layerIndex: 1, mixModeStr: 'screen' } });
    at({ op: 'filter', name: 'blur', layer: 2, seed: 3, input: { radius: 6 } });
    at({ op: 'filter', name: 'invert', layer: 0, seed: 4, input: null });
    at({ op: 'undo' });
    at({ op: 'redo' });
    at({ op: 'active', index: 0 });
    at({ op: 'sample', id: 1, layer: 1 });
    at({ op: 'xform', sample: 1, params: { targetLayerIndex: 1, eraseLayerIndex: undefined, freeTransform: { x: 1, y: 2, width: 3, height: 4, angleDeg: 5 } } });
    at({ op: 'ffd', sample: 1, params: { ffd: { cols: 2, rows: 2, controlPoints: [[{ x: 0, y: 0 }]] } } });
    at({ op: 'copy', id: 1, mask: true });
    at({ op: 'paste', id: 1, params: { transform: { x: 1, y: 1, width: 2, height: 2, angleDeg: 0 }, isPixelated: false } });
    at({
        op: 'tiles',
        tiles: {
            replaceTop: true,
            size: { width: 300, height: 200 },
            selection: { value: undefined },
            activeLayer: -1,
            layers: [
                { src: 0, props: {} },
                { src: -1, props: { name: 'x', opacity: 0.5, index: 1 }, tiles: [undefined, { fill: 'transparent' }, { w: 1, h: 2, data: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8) }] },
            ],
        },
    });
    return ops;
}

test('a chunk round-trips, every op type, with its header', () => {
    const ops = sampleOps();
    const chunk = { startMs: 1234, ops, restore: [7, 8, 9], endHashes: [1, 0xfffffffe] };
    const file = concatBytes([encodeHeadChunk(head), encodeOpsChunk(chunk), encodeChunk(99, Uint8Array.of(1, 2))]);
    const parsed = parseKlr(file);
    assert.equal(parsed.error, undefined);
    assert.deepEqual(parsed.head, { ...head, headV: 0, hashTile: 256 });
    assert.equal(parsed.chunks.length, 1); // TILES read with it, unknown chunk 99 skipped
    const c = parsed.chunks[0];
    assert.deepEqual(
        { opsV: c.opsV, engineV: c.engineV, coder: c.coder, penFlags: c.penFlags, klrFlags: c.klrFlags, startMs: c.startMs, opCount: c.opCount, restore: c.restore, endHashes: c.endHashes, skipped: c.skipped },
        { opsV: 0, engineV: KLR_ENGINE_V, coder: 0, penFlags: 11, klrFlags: 0, startMs: 1234, opCount: ops.length, restore: [7, 8, 9], endHashes: [1, 0xfffffffe], skipped: 0 },
    );
    assert.equal(c.durationMs, ops.at(-1).t);
    assert.equal(c.ops.length, ops.length);
    c.ops.forEach((op, i) => assert.deepEqual(op, ops[i], `op ${i} ${op.op} ${op.method ?? ''}`));
    assert.equal(new Set(BRUSH_IDS).size, 7);
});

test('chunks are self-contained', () => {
    const a = encodeOpsChunk({ startMs: 0, ops: [stroke(0, 500, 500, 10, 1)], endHashes: [] });
    const b = encodeOpsChunk({ startMs: 10, ops: [stroke(0, 500, 500, 10, 1)], endHashes: [] });
    // the same op codes the same way at the start of any chunk
    assert.deepEqual(a.slice(8), b.slice(8));
    const { chunks } = parseKlr(concatBytes([encodeHeadChunk(head), a, b]));
    assert.deepEqual(chunks[1].ops, [stroke(0, 500, 500, 10, 1)]);
    assert.equal(chunks[1].startMs, 10);
    assert.equal(chunks[1].restore, undefined);
});

test('an EXT op is skipped', () => {
    const ops = [stroke(0, 50, 60, 5, 1), { op: 'ext', t: 40, code: 7, bytes: Uint8Array.of(1, 2, 3, 250) }, { op: 'undo', t: 41 }];
    const { chunks, error } = parseKlr(concatBytes([encodeHeadChunk(head), encodeOpsChunk({ startMs: 0, ops, endHashes: [5] })]));
    assert.equal(error, undefined);
    assert.equal(chunks[0].skipped, 1);
    assert.deepEqual(chunks[0].ops, [ops[0], ops[2]]);
});

test('a truncated or damaged chunk fails cleanly; the chunks before it still read', () => {
    const good = encodeOpsChunk({ startMs: 0, ops: sampleOps(), endHashes: [1] });
    const head1 = encodeHeadChunk(head);
    // the file cut short inside the second chunk
    const file = concatBytes([head1, good, good]);
    for (const cut of [1, 7, 40, Math.floor(good.length / 2), good.length - 1]) {
        const r = parseKlr(file.slice(0, file.length - cut));
        assert.equal(r.chunks.length, 1, 'cut ' + cut);
        assert.match(r.error, /chunk/);
    }
    // a chunk whose coded stream is cut short (re-framed: its length agrees)
    const payload = parseRaw(good);
    for (const keep of [0.25, 0.5, 0.9, 0.99]) {
        const short = payload.slice(0, Math.floor(payload.length * keep));
        assert.throws(() => decodeOpsChunk(short), /truncated|damaged|klr|pen-coder/, 'keep ' + keep);
        const r = parseKlr(concatBytes([head1, good, encodeChunk(CHUNK_OPS, short)]));
        assert.equal(r.chunks.length, 1);
        assert.ok(r.error);
    }
    // flipped bytes in the stream: an error, never a hang
    for (let i = 40; i < payload.length; i += 97) {
        const bad = payload.slice();
        bad[i] ^= 0x5a;
        try {
            decodeOpsChunk(bad);
        } catch (e) {
            assert.ok(e instanceof Error);
        }
    }
});

test('refuses what it does not know', () => {
    assert.throws(() => parseKlr(Uint8Array.of(1, 2, 3, 4)), /not a .klr/);
    const payload = parseRaw(encodeOpsChunk({ startMs: 0, ops: [{ op: 'undo', t: 0 }], endHashes: [] }));
    // header bytes: opsV, engineV, coder, penFlags, klrFlags
    const at = (i, v) => { const p = payload.slice(); p[i] = v; return p; };
    assert.throws(() => decodeOpsChunk(at(0, 1)), /opsV/);
    assert.throws(() => decodeOpsChunk(at(2, 1)), /coder/);
    assert.throws(() => decodeOpsChunk(at(3, 32)), /flags/);
    assert.throws(() => decodeOpsChunk(at(4, 1)), /klrFlags/);
    // an unknown opcode ends the chunk
    const sink = newSink(CODER_RANGE, KLR_CHANNELS);
    sink.u(KLR_CHANNELS[0], 63, 0);
    sink.u(KLR_CHANNELS[1], 0, 63);
    const stream = sink.finish();
    const hdr = Uint8Array.of(0, 1, 0, 11, 0, 0, 0, 1, 0, 0);
    assert.throws(() => decodeOpsChunk(concatBytes([hdr, stream])), /unknown opcode 63/);
    assert.equal(OPC.EXT, 15);
});

test('strokes are small', () => {
    // a smooth stroke of 60 samples
    const samples = [];
    for (let i = 0; i < 60; i++) samples.push([i * 16, Math.round((300 + 80 * Math.cos(i / 15)) * 32), Math.round((300 + 80 * Math.sin(i / 15)) * 32), 120 + (i % 5)]);
    const one = { op: 'stroke', t: 0, seed: 1, samples, transfers: [], upT: 59 * 16 };
    const base = encodeOpsChunk({ startMs: 0, ops: [], endHashes: [] }).length;
    const n = 20;
    const ops = Array.from({ length: n }, (_, k) => ({ ...one, t: k * 1000, samples: samples.map((s) => [s[0] + k * 1000, s[1] + k * 64, s[2], s[3]]), upT: one.upT + k * 1000 }));
    const bytes = encodeOpsChunk({ startMs: 0, ops, endHashes: [] }).length - base;
    assert.ok(bytes / (n * 60) < 2, `${(bytes / (n * 60)).toFixed(2)} B/sample`);
});

// an OPS chunk's payload (encodeOpsChunk frames it: u8 type, varint length)
function parseRaw(framed) {
    let i = 1, len = 0, m = 1;
    for (;;) { const b = framed[i++]; len += (b & 127) * m; m *= 128; if (!(b & 128)) break; }
    return framed.slice(i, i + len);
}
