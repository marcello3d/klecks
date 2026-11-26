// Browser tests of drafts with the .klr recording (format klecks-tiles-2, embed-draft.ts), in
// Chrome and WebKit through Playwright, against scripts/test-klr.html and the embed in dist/
// (`node scripts/build-2draw.mjs` first, or pass --build).
//
//   node scripts/test-klr-draft.mjs [--build] [--measure] [chromium|webkit ...]
//
// 1. Draw; a checkpoint comes by itself after CHECKPOINT_CHANGES changes; reload right after a
//    checkpoint and between two (the tail holding unsealed work): the restored picture is the
//    checkpoint's, exactly; keep drawing; the submitted .klr replays in a fresh page to the
//    final live hashes, RESTORE checks included.
// 2. The klecks-tiles-1 fixtures of 2draw.net (worker/test/fixtures/drafts/kleki, read only)
//    open to their expected.png and save on as tiles-2.
// 3. A tiles-1 draft with an MP4 recording's video pieces opens under recording: 'klr' and
//    submits without a timelapse.
// --measure: ~300 strokes at 1200×900 and 3000×3000: draft bytes, checkpoint ms, restore ms.
import { chromium, webkit } from 'playwright-core';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { parseKlr } from '../src/app/script/klr/klr-format.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--build') || !existsSync(join(root, 'dist/embed.js'))) {
    execSync('node scripts/build-2draw.mjs', { cwd: root, stdio: 'inherit' });
}
const MEASURE = args.includes('--measure');
const which = args.filter((a) => !a.startsWith('--'));
const browsers = which.length ? which : ['chromium', 'webkit'];
// 2draw.net's draft fixtures, read only (KLR_FIXTURES=<dir> to point elsewhere)
const FIXTURES =
    process.env.KLR_FIXTURES ??
    [
        '/Users/marcello/github/2draw.net/worker/test/fixtures/drafts/kleki',
        '/Users/marcello/github/2draw.net/.claude/worktrees/switch-to-klecks-9d52fa/worker/test/fixtures/drafts/kleki',
    ].find((d) => existsSync(d));

const lockPath = '/Users/marcello/github/2draw.net/worker/scripts/lib/e2e-lock.ts';
if (existsSync(lockPath) && process.env.E2E_LOCK !== '0') {
    const { e2eLock } = await import(lockPath);
    await e2eLock('klecks test-klr-draft');
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '');
    const file = join(root, path);
    if (!file.startsWith(root) || !existsSync(file) || !/^(dist|scripts)\//.test(path)) {
        res.statusCode = 404;
        return res.end();
    }
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://localhost:${server.address().port}/scripts/test-klr.html`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;

function watch(page) {
    page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
    page.on('console', (m) => {
        if (m.type() === 'error' || (m.type() === 'warning' && !m.text().includes('willReadFrequently'))) console.error(`  [${m.type()}]`, m.text());
    });
}
async function open(context, query = '') {
    const page = await context.newPage();
    watch(page);
    await page.goto(base + query);
    await page.evaluate(() => window.ready);
    await sleep(300);
    return page;
}
async function reload(page) {
    await page.reload();
    await page.evaluate(() => window.ready);
    await sleep(300);
}

async function test(name, fn) {
    process.stdout.write(`  ${name} ... `);
    try {
        const note = await fn();
        console.log('ok' + (note ? ` (${note})` : ''));
    } catch (e) {
        failures++;
        console.log('FAILED');
        console.error(e);
    }
}

// n scripted strokes, brushes in turn, a rest every `restEvery` (a quiet gap for checkpoints)
async function draw(page, n, { seed = 1, restEvery = 0, restMs = 900 } = {}) {
    await page.evaluate(
        async ({ n, seed, restEvery, restMs }) => {
            const kc = api.klCanvas;
            const W = kc.getWidth(), H = kc.getHeight();
            let s = seed;
            const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
            const BRUSHES = ['penBrush', 'blendBrush', 'sketchyBrush', 'pixelBrush', 'chemyBrush', 'smudgeBrush', 'penBrush', 'eraserBrush'];
            const scale = Math.max(1, Math.min(W, H) / 900);
            for (let i = 0; i < n; i++) {
                if (i % 6 === 0) {
                    const id = BRUSHES[Math.floor(i / 6) % BRUSHES.length];
                    api.setBrush(id);
                    api.getBrushUi().setSize(2 + Math.round(r() * 20 * scale));
                    api.getBrushUi().setOpacity(0.3 + Math.round(r() * 70) / 100);
                    if (id !== 'eraserBrush') api.setColor({ r: Math.floor(r() * 256), g: Math.floor(r() * 256), b: Math.floor(r() * 256) });
                }
                const m = 10 + Math.floor(r() * 25);
                let x = 40 + r() * (W - 80), y = 40 + r() * (H - 80), a = r() * 6.28;
                const step = (3 + r() * 10) * scale;
                const pts = [];
                for (let k = 0; k < m; k++) {
                    pts.push([x, y, 0.3 + 0.7 * Math.abs(Math.sin(k * 0.3 + r()))]);
                    a += (r() - 0.5) * 0.5;
                    x = Math.min(W - 5, Math.max(5, x + Math.cos(a) * step));
                    y = Math.min(H - 5, Math.max(5, y + Math.sin(a) * step));
                }
                await stroke(pts, i % 2);
                if (restEvery && i % restEvery === restEvery - 1) await sleep(restMs);
            }
        },
        { n, seed, restEvery, restMs },
    );
}

const state = (page) => page.evaluate(() => ({ ...draftState, tail: undefined, klrOpen: !!draftState.tail?.klr?.open, klrPieces: draftState.tail?.klr?.pieces.length ?? 0, format: draftState.tail?.format, info: klecks.getDraftInfo(), klr: klecks.getKlrInfo() }));
const hashes = (page) => page.evaluate(() => liveHashes());

async function replayFresh(context, base64) {
    const fresh = await open(context, '?player');
    const result = await fresh.evaluate((b) => window.replay(b), base64);
    await fresh.close();
    return result;
}

// a 2draw device-copy fixture (test/draft-fixtures harness dump) as the store's `saved`
function fixtureToSaved(dir) {
    const d = JSON.parse(readFileSync(join(dir, 'draft.json'), 'utf8'));
    const stores = d.device.indexedDB.find((x) => x.name === '2draw-device-copies').stores;
    const rec = stores.find((x) => x.name === 'copies').records[0].value;
    const pieces = stores.find((x) => x.name === 'pieces').records.map((x) => x.value).sort((a, b) => a.n - b.n);
    const bytes = (v) => v.$ab ?? v.$ta ?? v.data;
    const tailB64 = bytes(rec.files.tail);
    const tail = JSON.parse(Buffer.from(tailB64, 'base64').toString('utf8'));
    return {
        format: rec.meta?.format ?? tail.format,
        tail: tailB64,
        pieces: pieces.filter((p) => p.n > 0).map((p) => bytes(p.data)), // piece 0 is the head
        expected: readFileSync(join(dir, 'expected.png')).toString('base64'),
        note: d.note,
    };
}

for (const name of browsers) {
    console.log(name);
    const browser =
        name === 'chromium'
            ? await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : { channel: 'chrome' })
            : await webkit.launch();

    await test('checkpoints, reloads, exact restore, the .klr replays to the final picture', async () => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await open(context, '?idle');
        await page.evaluate(() => clearDraft());
        await page.goto(base + '?draft');
        await page.evaluate(() => window.ready);
        await sleep(300);

        // a checkpoint by itself after 50 changes and a rest
        await draw(page, 52, { seed: 3 });
        await sleep(1500);
        let st = await state(page);
        assert.ok(st.saves >= 1, 'no checkpoint after 52 strokes');
        assert.equal(st.format, 'klecks-tiles-2');
        assert.ok(st.klrOpen, 'the open chunk rides in the tail');
        const auto = st.saves;

        // reload right after a checkpoint
        await draw(page, 10, { seed: 5 });
        await page.evaluate(() => { api.klCanvas.floodFill(1, 300, 300, { r: 10, g: 200, b: 90 }, 1, 30, 'current', 0, true); api.undo(); });
        await page.evaluate(() => flushDraft());
        const h1 = await hashes(page);
        let part1;
        {
            // what the draft keeps replays to the checkpoint's picture
            const part = (part1 = await page.evaluate(() => klrDraftBase64()));
            const ctx = await browser.newContext();
            const r = await replayFresh(ctx, part);
            await ctx.close();
            const liveCached = await page.evaluate(() => klecks.embed.klr.hashLayers(true));
            assert.deepEqual({ fresh: r.hashesFresh, cached: r.hashes, liveCached }, { fresh: h1, cached: h1, liveCached: h1 }, 'the draft\'s recording replays to the checkpoint');
        }
        await reload(page);
        assert.deepEqual(await hashes(page), h1, 'restored right after a checkpoint');
        {
            // the restored recording: the draft's, then RESTORE with the restored picture
            const now = parseKlr(new Uint8Array(Buffer.from(await page.evaluate(() => klrDraftBase64()), 'base64')));
            const before = parseKlr(new Uint8Array(Buffer.from(part1, 'base64')));
            assert.deepEqual(now.chunks[0].ops, before.chunks[0].ops, 'chunk 0 kept as it was');
            assert.deepEqual({ op: now.chunks[1].ops[0].op, hashes: now.chunks[1].ops[0].hashes }, { op: 'restore', hashes: h1 }, 'RESTORE holds the restored picture');
        }

        // keep drawing, a checkpoint, more drawing that isn't saved, reload
        await draw(page, 12, { seed: 7 });
        await page.evaluate(() => { api.copy(); api.paste({ transform: { x: 600, y: 450, width: 500, height: 400, angleDeg: 8 } }); });
        await draw(page, 3, { seed: 8 });
        await page.evaluate(() => flushDraft());
        const h2 = await hashes(page);
        st = await state(page);
        assert.ok(st.klrOpen, 'unsealed work in the tail');
        await draw(page, 8, { seed: 9 }); // between checkpoints: lost with the reload
        assert.notDeepEqual(await hashes(page), h2);
        await reload(page);
        assert.deepEqual(await hashes(page), h2, 'restored between checkpoints: the last checkpoint');

        // fresh history after restore: nothing to undo yet
        const undone = await page.evaluate(async () => { const before = liveHashes(); api.undo(); await sleep(10); return before.join() === liveHashes().join(); });
        assert.ok(undone, 'undo right after a restore changes nothing');
        await draw(page, 10, { seed: 11 });
        await page.evaluate(async () => { api.undo(); await sleep(10); api.undo(); await sleep(10); api.redo(); await sleep(10); });
        await draw(page, 4, { seed: 12 });
        await sleep(200);
        const final = await hashes(page);
        const base64 = await page.evaluate(() => klrBase64());
        const klrInfo = await page.evaluate(() => klecks.getKlrInfo());
        await context.close();

        const file = parseKlr(new Uint8Array(Buffer.from(base64, 'base64')));
        const restores = file.chunks.flatMap((c) => c.ops).filter((o) => o.op === 'restore').length;
        assert.equal(restores, 2, 'a RESTORE per reload');
        assert.equal(klrInfo.catchAll, 0, 'catch-all fired');
        const replay = await replayFresh(await browser.newContext(), base64);
        assert.equal(replay.startMismatch, false);
        assert.deepEqual(replay.hashMismatches, [], 'HASH / RESTORE mismatches');
        assert.deepEqual(replay.hashes, final, 'replay vs final live');
        return `${auto} checkpoint(s) by itself, ${file.chunks.length} chunks, ${restores} restores, ${replay.hashChecks} hash checks, ${base64.length * 3 / 4 | 0} B .klr`;
    });

    await test('klecks-tiles-1 fixtures open as drawn and save on as tiles-2', async () => {
        if (!FIXTURES) throw new Error('no fixtures (KLR_FIXTURES)');
        const dirs = readdirSync(FIXTURES).filter((d) => d.startsWith('klecks-tiles-1-')).sort();
        assert.ok(dirs.length >= 4);
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        for (const dir of dirs) {
            const f = fixtureToSaved(join(FIXTURES, dir));
            const tail = JSON.parse(Buffer.from(f.tail, 'base64').toString('utf8'));
            const page = await open(context, '?idle');
            await page.evaluate((d) => importDraft(d), { format: f.format, tail: f.tail, pieces: f.pieces });
            // the tiles-1 reader, as 2draw opens these today (no recording: the composite is
            // drawn as when the fixture was made; under 'klr' canvases are software ones and a
            // half-opacity layer composites with other rounding)
            await page.goto(base + `?draft&norec&w=${tail.width}&h=${tail.height}`);
            await page.evaluate(() => window.ready);
            await sleep(300);
            const diff = await page.evaluate((png) => pngDiff(png), f.expected);
            assert.deepEqual(diff, { differing: 0 }, dir);
            await draw(page, 2, { seed: 13 });
            await page.evaluate(() => flushDraft());
            const st = await page.evaluate(() => draftState.tail?.format);
            assert.equal(st, 'klecks-tiles-2', dir + ' saves on as tiles-2');
            const after = await page.evaluate(() => pngBase64());
            await reload(page);
            assert.deepEqual(await page.evaluate((p) => pngDiff(p), after), { differing: 0 }, dir + ' reopens from tiles-2');
            // and under recording: 'klr' it opens too, with the same layers (tiles are exact)
            await page.goto(base + `?draft&w=${tail.width}&h=${tail.height}`);
            await page.evaluate(() => window.ready);
            await sleep(300);
            const layers = await page.evaluate(() => api.klCanvas.getLayerCount());
            assert.equal(layers, tail.layers.length, dir + ' under klr');
            await page.close();
        }
        await context.close();
        return `${dirs.length} fixtures`;
    });

    await test('a tiles-1 draft with video pieces opens under klr and submits without a timelapse', async () => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await open(context, '?idle');
        await page.evaluate(() => clearDraft());
        await page.goto(base + '?draft&mp4');
        await page.evaluate(() => window.ready);
        await page.waitForFunction(() => klecks.getRecordingInfo()?.state !== 'starting', null, { timeout: 15000 });
        await sleep(300);
        for (let i = 0; i < 6; i++) {
            const x = 420 + i * 60, y = 200 + i * 30;
            await page.mouse.move(x, y);
            await page.mouse.down();
            for (let k = 1; k <= 10; k++) await page.mouse.move(x + k * 9, y + k * 5);
            await page.mouse.up();
            await sleep(250);
        }
        await sleep(500);
        await page.evaluate(() => flushDraft());
        const png = await page.evaluate(() => pngBase64());
        const d = await page.evaluate(() => exportDraft());
        const tail = JSON.parse(Buffer.from(d.tail, 'base64').toString('utf8'));
        const hasVideo = !!tail.video?.clips?.length;
        // as the tiles-1 build wrote it: the same tail, the old format name
        tail.format = 'klecks-tiles-1';
        const old = { format: 'klecks-tiles-1', tail: Buffer.from(JSON.stringify(tail)).toString('base64'), pieces: d.pieces };
        await page.evaluate((x) => importDraft(x), old);
        await page.goto(base + '?draft');
        await page.evaluate(() => window.ready);
        await sleep(300);
        assert.deepEqual(await page.evaluate((p) => pngDiff(p), png), { differing: 0 });
        const clips = await page.evaluate(async () => (await klecks.getRecording()).length);
        assert.equal(clips, 0, 'no timelapse');
        await draw(page, 3, { seed: 17 });
        const out = await page.evaluate(async () => ({ klr: klecks.getKlr()?.length ?? 0, png: (await klecks.getPNG()).size, psd: (await klecks.getPSD()).size }));
        assert.ok(out.klr > 0 && out.png > 0 && out.psd > 0);
        await page.evaluate(() => flushDraft());
        const st = await state(page);
        assert.equal(st.format, 'klecks-tiles-2');
        await context.close();
        return `${hasVideo ? 'with' : 'WITHOUT (no encoder)'} video pieces; .klr ${out.klr} B`;
    });

    if (MEASURE) {
        for (const [w, h] of [[1200, 900], [3000, 3000]]) {
            await test(`measure: 300 strokes at ${w}x${h}`, async () => {
                const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
                const page = await open(context, '?idle');
                await page.evaluate(() => clearDraft());
                await page.goto(base + `?draft&w=${w}&h=${h}`);
                await page.evaluate(() => window.ready);
                await sleep(300);
                await draw(page, 300, { seed: 21, restEvery: 25 });
                await sleep(1500);
                await page.evaluate(() => flushDraft());
                const st = await state(page);
                const live = await hashes(page);
                await reload(page);
                const restored = await page.evaluate(() => klecks.getDraftInfo().restoreMs);
                assert.deepEqual(await hashes(page), live);
                await context.close();
                const i = st.info;
                return (
                    `draft ${(st.bytes / 1024).toFixed(0)} kB in ${st.pieces} pieces + tail ${(st.tailBytes / 1024).toFixed(1)} kB ` +
                    `(${i.klrPieces} .klr pieces, .klr ${(st.klr.bytes / 1024).toFixed(1)} kB); ` +
                    `${i.checkpoints} checkpoints, last ${i.lastMs.toFixed(1)} ms, max ${i.maxMs.toFixed(1)} ms main thread; ` +
                    `restore ${restored.toFixed(0)} ms; hash tiles read ${st.klr.hashTilesRead}`
                );
            });
        }
    }
    await browser.close();
}
server.close();
if (failures) {
    console.log(`${failures} failed`);
    process.exit(1);
}
console.log('all passed');
