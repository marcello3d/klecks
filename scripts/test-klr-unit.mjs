// Unit tests of the .klr coder (src/app/script/klr/klr-format.ts):
//   node --test scripts/test-klr-unit.mjs
// Node runs the .ts files as they are (type stripping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BRUSH_IDS,
    CANVAS_METHODS,
    CHUNK_OPS,
    encodeChunk,
    encodeHead,
    encodeValue,
    fnv1a,
    joinKlr,
    KLR_ENGINE_V,
    KLR_FORMAT_VERSION,
    KlrOpsWriter,
    KlrUnencodable,
    parseKlr,
    quantizeCoord,
    quantizePressure,
    readValue,
} from '../src/app/script/klr/klr-format.ts';
import { ByteReader } from '../src/app/script/klr/klr-bytes.ts';

const head = {
    formatVersion: KLR_FORMAT_VERSION,
    engineV: KLR_ENGINE_V,
    build: 'abc12345',
    width: 1200,
    height: 900,
    start: {
        kind: 'blank',
        layers: [
            { name: 'Background', opacity: 1, isVisible: true, mixModeStr: 'source-over', hasClipping: false, fill: '#fff' },
            { name: 'Layer 1', opacity: 1, isVisible: true, mixModeStr: 'source-over', hasClipping: false, fill: 'transparent' },
        ],
    },
    startHashes: [0x12345678, 0xffffffff],
};

const roundTripValue = (v) => readValue(new ByteReader(encodeValue(v)));

test('values round-trip', () => {
    const v = {
        a: 1,
        b: -7,
        c: 0.5,
        d: 0.1, // not an f32: f64
        e: 'text ✓',
        f: [true, false, null, undefined, [1, [2, [3]]]],
        g: { r: 10, g: 20, b: 30 },
        h: Uint8Array.of(1, 2, 3),
        i: 2 ** 40,
        j: NaN,
        k: -Infinity,
    };
    assert.deepEqual(roundTripValue(v), v);
    assert.ok(Object.is(roundTripValue(-0), -0));
    // a multipolygon
    const poly = [[[[0, 0], [10.25, 0], [10.25, 3.3333333333], [0, 0]]]];
    assert.deepEqual(roundTripValue(poly), poly);
});

test('values refuse functions and typed arrays other than bytes', () => {
    assert.throws(() => encodeValue({ f: () => 1 }), KlrUnencodable);
    assert.throws(() => encodeValue(new Float32Array(2)), KlrUnencodable);
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

function sampleOps() {
    const ops = [];
    ops.push({ op: 'brush', brush: 'sketchyBrush', settings: { settingSize: 3.5, settingColor: { r: 1, g: 2, b: 3 }, sketchySeed: 42 } });
    ops.push({ op: 'layer', index: 1 });
    ops.push({ op: 'down', x: quantizeCoord(100.3), y: quantizeCoord(200.7), p: quantizePressure(0.4), seed: 1 });
    for (let i = 1; i < 20; i++) {
        ops.push({ op: 'move', x: quantizeCoord(100.3 + i * 3.1), y: quantizeCoord(200.7 - i * 1.7), p: quantizePressure(0.4 + i / 40) });
        if (i % 5 === 0) ops.push({ op: 'transfer' });
    }
    ops.push({ op: 'up' });
    ops.push({ op: 'line', x0: 1, y0: 2, x1: 300.5, y1: -4, p0: 1, p1: 1, seed: 2 });
    for (const method of CANVAS_METHODS) ops.push({ op: 'canvas', method, args: [1, { x: 0.25 }, 'a'] });
    ops.push({ op: 'filter', name: 'blur', layer: 2, seed: 3, input: { radius: 6 } });
    ops.push({ op: 'undo' }, { op: 'redo' }, { op: 'active', index: 0 });
    ops.push({ op: 'sample', id: 1, layer: 1 });
    ops.push({ op: 'xform', sample: 1, params: { targetLayerIndex: 1, freeTransform: { x: 1, y: 2, width: 3, height: 4, angleDeg: 5 } } });
    ops.push({ op: 'ffd', sample: 1, params: { ffd: { cols: 2, rows: 2, controlPoints: [[{ x: 0, y: 0 }]] } } });
    ops.push({ op: 'copy', id: 1, mask: true }, { op: 'paste', id: 1, params: { transform: { x: 1, y: 1, width: 2, height: 2, angleDeg: 0 } } });
    ops.push({
        op: 'tiles',
        tiles: {
            size: { width: 300, height: 200 },
            selection: { value: undefined },
            activeLayer: -1,
            layers: [
                { src: 0, props: {} },
                { src: -1, props: { name: 'x', opacity: 0.5, index: 1 }, tiles: [undefined, { fill: 'transparent' }, { w: 1, h: 2, data: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8) }] },
            ],
        },
    });
    ops.push({ op: 'hash', hashes: [1, 0xfffffffe] });
    return ops;
}

test('ops round-trip, every opcode', () => {
    const ops = sampleOps();
    const w = new KlrOpsWriter(1234);
    ops.forEach((op, i) => w.write(op, i * 7));
    const file = joinKlr(encodeHead(head), [encodeChunk(CHUNK_OPS, w.bytes()), encodeChunk(99, Uint8Array.of(1, 2))]);
    const parsed = parseKlr(file);
    assert.deepEqual(parsed.head, head);
    assert.equal(parsed.chunks.length, 1); // unknown chunk 99 skipped
    assert.equal(parsed.chunks[0].startMs, 1234);
    const got = parsed.chunks[0].ops;
    assert.equal(got.length, ops.length);
    got.forEach((op, i) => assert.deepEqual(op, { ...ops[i], t: i * 7 }, `op ${i} ${op.op}`));
    // every brush id has an index
    assert.equal(new Set(BRUSH_IDS).size, 7);
});

test('chunks are self-contained', () => {
    const a = new KlrOpsWriter(0);
    a.write({ op: 'down', x: 500, y: 500, p: 1, seed: 1 }, 0);
    const b = new KlrOpsWriter(10);
    b.write({ op: 'down', x: 500, y: 500, p: 1, seed: 1 }, 0);
    // the same op encodes the same way at the start of any chunk (deltas from 0)
    assert.deepEqual(a.bytes().slice(1), b.bytes().slice(1));
    const file = joinKlr(encodeHead(head), [encodeChunk(CHUNK_OPS, a.bytes()), encodeChunk(CHUNK_OPS, b.bytes())]);
    const { chunks } = parseKlr(file);
    assert.deepEqual(chunks[1].ops[0], { op: 'down', t: 0, x: 500, y: 500, p: 1, seed: 1 });
});

test('move is small', () => {
    const w = new KlrOpsWriter(0);
    w.write({ op: 'down', x: 100, y: 100, p: 0.5, seed: 1 }, 0);
    const before = w.length;
    w.write({ op: 'move', x: 103.5, y: 98.25, p: 0.6 }, 8);
    assert.ok(w.length - before <= 6, `move took ${w.length - before} bytes`);
});

test('refuses other files and newer versions', () => {
    assert.throws(() => parseKlr(Uint8Array.of(1, 2, 3, 4)));
    const newer = joinKlr(encodeHead({ ...head, formatVersion: KLR_FORMAT_VERSION + 1 }), []);
    assert.throws(() => parseKlr(newer), /newer/);
});
