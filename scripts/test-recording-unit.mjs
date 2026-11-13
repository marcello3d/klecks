// Unit tests of the recording's pure parts (src/app/script/embed/recording-format.ts):
//   node --test scripts/test-recording-unit.mjs
// Node runs the .ts file as is (type stripping; it has only type imports).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    base64ToBytes,
    bytesToBase64,
    checkVideoTail,
    chunksToPieces,
    diffComposed,
    packChunks,
    placement,
    thinStride,
    unpackChunks,
    videoRect,
    videoSize,
} from '../src/app/script/embed/recording-format.ts';

const MIB = 1024 * 1024;
const bytes = (n, v = n) => new Uint8Array(n).fill(v & 255);

test('pieces pack and unpack', () => {
    const chunks = [
        { bytes: bytes(10), key: true },
        { bytes: bytes(0), key: false },
        { bytes: bytes(300), key: false },
    ];
    const back = unpackChunks(packChunks(chunks));
    assert.deepEqual(back, chunks);
    assert.throws(() => unpackChunks(packChunks(chunks).slice(0, -1)), /truncated/);
});

test('chunks split into pieces under the limit, a large one alone', () => {
    const chunks = [bytes(40), bytes(40), bytes(40), bytes(200), bytes(10)].map((b, i) => ({ bytes: b, key: i === 0 }));
    const pieces = chunksToPieces(chunks, 100);
    assert.deepEqual(pieces.map((p) => unpackChunks(p).length), [2, 1, 1, 1]);
    assert.deepEqual(pieces.flatMap(unpackChunks), chunks);
    assert.ok(pieces.slice(0, 2).every((p) => p.length <= 100));
});

test('the tail round trip', () => {
    const description = new Uint8Array([1, 100, 0, 51, 255]);
    const tail = JSON.parse(
        JSON.stringify({
            v: 1,
            clips: [{ codec: 'avc1.640033', description: bytesToBase64(description), width: 1920, height: 1440, fps: 30, frames: 3, pieces: [4, 5] }],
        }),
    );
    const v = checkVideoTail(tail, 6);
    assert.deepEqual(base64ToBytes(v.clips[0].description), description);
    assert.throws(() => checkVideoTail(tail, 5), /Malformed/);
    assert.throws(() => checkVideoTail({ v: 2, clips: [] }, 5), /Unsupported/);
});

test('the thinning schedule', () => {
    assert.equal(thinStride(0), 1);
    assert.equal(thinStride(8 * MIB - 1), 1);
    assert.equal(thinStride(8 * MIB), 2);
    assert.equal(thinStride(12 * MIB), 4);
    assert.equal(thinStride(14 * MIB), 8);
    assert.equal(thinStride(15.5 * MIB), 0);
});

test('video sizes: long side at most the cap, even', () => {
    assert.deepEqual(videoSize(2000, 1500, 1920), [1920, 1440]);
    assert.deepEqual(videoSize(4096, 4096, 1920), [1920, 1920]);
    assert.deepEqual(videoSize(501, 333, 1920), [502, 334]);
    assert.deepEqual(videoSize(1, 1, 1920), [2, 2]);
});

const layer = (index, tiles, extra = {}) => ({ name: 'l', opacity: 1, isVisible: true, mixModeStr: 'source-over', hasClipping: false, index, tiles, ...extra });
const state = (w, h, layers) => ({ size: { width: w, height: h }, layerMap: Object.fromEntries(layers.map((l, i) => ['L' + i, l])) });

test('the dirty rectangle from two history states', () => {
    // 600×300: 3×2 tiles of 256
    const t = Array.from({ length: 6 }, (_, i) => ({ id: 't' + i }));
    const fill = { fill: '#fff' };
    const a = state(600, 300, [layer(0, [fill, fill, fill, fill, fill, fill]), layer(1, t)]);
    assert.deepEqual(diffComposed(a, a), { kind: 'none' });
    const changed = t.slice();
    changed[1] = { id: 'x' };
    changed[5] = { id: 'y' };
    const b = state(600, 300, [layer(0, a.layerMap.L0.tiles), layer(1, changed)]);
    assert.deepEqual(diffComposed(a, b), { kind: 'rect', x0: 256, y0: 0, x1: 600, y1: 300 });
    const c = state(600, 300, [layer(0, a.layerMap.L0.tiles), layer(1, t, { opacity: 0.5 })]);
    assert.deepEqual(diffComposed(a, c), { kind: 'full' });
    assert.deepEqual(diffComposed(a, state(600, 300, [layer(0, t)])), { kind: 'full' });
    assert.deepEqual(diffComposed(a, state(300, 600, [])), { kind: 'resize' });
    // the active layer or the selection don't count
    assert.deepEqual(diffComposed(a, { ...a, activeLayerId: 'z', selection: {} }), { kind: 'none' });
});

test('placement and the rectangle in video pixels', () => {
    const fill = placement(2000, 1500, 1920, 1440, true);
    assert.deepEqual(videoRect(fill, 1920, 1440, { x0: 256, y0: 0, x1: 512, y1: 256 }), { x: 244, y: 0, w: 249, h: 247 });
    // a canvas that doesn't fit the clip's frame: fitted and centred
    const fit = placement(1500, 2000, 1920, 1440, false);
    assert.deepEqual([fit.w, fit.h, fit.ox, fit.oy], [1080, 1440, 420, 0]);
});
