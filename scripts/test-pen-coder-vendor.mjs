// The vendored pen coder (src/app/script/klr/pen-coder.ts) and its test vectors
// (pen-coder-vectors-v1.json), copied byte for byte from 2draw.net (worker/src/pocket/pen-coder.ts,
// worker/test/fixtures/pen-coder/vectors-v1.json; PEN-CODER.md section 6 there). 2draw is the
// source of truth: never edit the copies here; to update, copy both files anew and change the
// pins below in the same commit, naming the 2draw commit (README-2draw.md, "The pen coder").
//   node --test scripts/test-pen-coder-vendor.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as P from '../src/app/script/klr/pen-coder.ts';

// copied from 2draw.net b596783a
const PEN_CODER_SHA256 = 'e2e5f3193549f029538e4f31547459019530f863d7278e5e5a91a13b4f7365cd';
const VECTORS_SHA256 = 'ab02e4bae1f93f58ed151535b13a2ff703acc34d490320309517f1292b79457b';

const file = (name) => readFileSync(new URL('../src/app/script/klr/' + name, import.meta.url));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));

test('the copies are the pinned 2draw files', () => {
    assert.equal(sha256(file('pen-coder.ts')), PEN_CODER_SHA256, 'pen-coder.ts changed: copy it anew from 2draw, never edit it here');
    assert.equal(sha256(file('pen-coder-vectors-v1.json')), VECTORS_SHA256, 'pen-coder-vectors-v1.json changed');
});

const v = JSON.parse(file('pen-coder-vectors-v1.json').toString('utf8'));

test('integer vectors, every coder, both ways', () => {
    const t = P.channelTable(v.ints.channels);
    const coders = Object.entries(v.ints.bytes);
    assert.equal(coders.length, 3);
    for (const [coder, want] of coders) {
        const sink = P.newSink(+coder, t.list);
        for (const [k, ch, val, c] of v.ints.symbols) sink[k](t.ch[ch], val, c);
        assert.equal(hex(sink.finish()), want, 'coder ' + coder);
        const b = unhex(want);
        const src = P.newSource(+coder, t.list, b, 0, b.length);
        for (const [k, ch, val, c] of v.ints.symbols) assert.equal(src[k](t.ch[ch], c), val);
    }
});

test('stroke vectors, both ways', () => {
    assert.ok(v.strokes.length > 5);
    for (const c of v.strokes) {
        const t = P.channelTable(P.penChannelSpec(c.extras));
        const ch = P.penStrokeChannels(t.ch, c.extras);
        const sink = P.newSink(c.coder, t.list);
        const enc = new P.PenStrokeEncoder(sink, ch, c.flags);
        for (const S of c.strokes) enc.stroke(S, c.grid);
        assert.equal(hex(sink.finish()), c.bytes, c.name);
        const b = unhex(c.bytes);
        const dec = new P.PenStrokeDecoder(P.newSource(c.coder, t.list, b, 0, b.length), ch, c.flags);
        for (const S of c.strokes) assert.deepEqual(dec.stroke(S[0][0]), S, c.name);
    }
});
