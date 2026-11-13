// Browser tests of the timelapse recording (src/app/script/embed/embed-recording.ts), in
// Chrome and WebKit through Playwright (playwright-core; Google Chrome as installed, and
// WebKit from `npx playwright-core install webkit`), against scripts/test-recording.html and the
// embed in dist/ (`node scripts/build-2draw.mjs` first, or pass --build).
//
//   node scripts/test-recording.mjs [--build] [chromium|webkit ...]
//
// Pure parts: node --test scripts/test-recording-unit.mjs
import { chromium, webkit } from 'playwright-core';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--build') || !existsSync(join(root, 'dist/embed.js'))) {
    execSync('node scripts/build-2draw.mjs', { cwd: root, stdio: 'inherit' });
}
const which = args.filter((a) => !a.startsWith('--'));
const browsers = which.length ? which : ['chromium', 'webkit'];

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
const base = `http://localhost:${server.address().port}/scripts/test-recording.html`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;

async function open(context, query = '') {
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
    page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') console.error(`  [${m.type()}]`, m.text());
    });
    await page.goto(base + query);
    await page.evaluate(() => window.ready);
    await page.waitForFunction(() => window.klecks.getRecordingInfo()?.state !== 'starting', null, { timeout: 15000 });
    await sleep(300);
    return page;
}

// One stroke on the canvas (right of the tool panel, which is on the left of the 1280×800 view).
let strokeSeed = 1;
async function stroke(page, { steps = 12, pauseMs = 200 } = {}) {
    const r = () => ((strokeSeed = (strokeSeed * 16807) % 2147483647) / 2147483647);
    const x = 380 + r() * 700, y = 120 + r() * 520; // the UI is on the left
    const a = r() * Math.PI * 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
        await page.mouse.move(x + Math.cos(a + i * 0.15) * i * 8, y + Math.sin(a + i * 0.15) * i * 8);
    }
    await page.mouse.up();
    if (pauseMs) await sleep(pauseMs);
}

const info = (page) => page.evaluate(() => window.klecks.getRecordingInfo());
const frames = (i) => i.clips.reduce((a, c) => a + c.frames, 0);

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

for (const name of browsers) {
    console.log(name);
    // Chromium: installed Google Chrome by default (its H.264 encoders are what users get);
    // PW_CHROMIUM=<path> for another build.
    const browser =
        name === 'chromium'
            ? await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : { channel: 'chrome' })
            : await webkit.launch();
    const newContext = () => browser.newContext({ viewport: { width: 1280, height: 800 } });

    await test('50 strokes: one MP4, ≤ 51 frames, the right size, the last frame close to the PNG', async () => {
        const context = await newContext();
        const page = await open(context);
        for (let i = 0; i < 50; i++) await stroke(page);
        const before = await info(page);
        assert.equal(before.state, 'recording', JSON.stringify(before));
        const clips = await page.evaluate(() => window.checkRecording());
        const after = await info(page);
        assert.equal(clips.length, 1, JSON.stringify(clips));
        const [clip] = clips;
        assert.ok(!clip.error, clip.error);
        assert.equal(clip.width, 1200);
        assert.equal(clip.height, 900);
        const n = frames(after);
        assert.ok(n >= 40 && n <= 51, `frames ${n}`);
        assert.ok(Math.abs(clip.duration * 30 - n) <= 1.5, `duration ${clip.duration} for ${n} frames`);
        assert.ok(clip.psnr >= 30, `psnr ${clip.psnr}`);
        assert.equal(after.grabsWhileDrawing, 0);
        await context.close();
        return `${n} frames, ${(clip.bytes / 1024).toFixed(0)} kB, ${clip.psnr.toFixed(1)} dB, ${after.backend}, ${after.codec}, grab ${after.grabMs.mean} ms mean / ${after.grabMs.p95} p95 / ${after.grabMs.max} max`;
    });

    await test('a fast burst makes no grab while it lasts, and one frame after', async () => {
        const context = await newContext();
        const page = await open(context);
        await stroke(page);
        const i0 = await info(page);
        for (let i = 0; i < 15; i++) await stroke(page, { pauseMs: 30 });
        const i1 = await info(page);
        assert.equal(i1.grabs, i0.grabs, 'grabbed during the burst');
        await sleep(400);
        const i2 = await info(page);
        assert.equal(i2.grabs, i0.grabs + 1, `grabs ${i0.grabs} → ${i2.grabs}`);
        assert.equal(i2.grabsWhileDrawing, 0);
        await context.close();
        return `${i2.grabsBusy} busy waits`;
    });

    await test('resume: draw, reload from the draft, draw, submit: one clip, plays through', async () => {
        const context = await newContext();
        let page = await open(context);
        for (let i = 0; i < 10; i++) await stroke(page);
        await page.evaluate(() => window.flushDraft());
        const saved = await page.evaluate(() => window.draftState.tail.video);
        assert.ok(saved && saved.clips.length === 1, JSON.stringify(saved));
        const savedFrames = saved.clips[0].frames;
        await page.reload();
        await page.evaluate(() => window.ready);
        await page.waitForFunction(() => window.klecks.getRecordingInfo()?.state !== 'starting');
        const restored = await info(page);
        assert.equal(frames(restored), savedFrames, 'restored frames');
        for (let i = 0; i < 10; i++) await stroke(page);
        const clips = await page.evaluate(() => window.checkRecording());
        const after = await info(page);
        assert.equal(clips.length, 1, JSON.stringify(after.clips));
        assert.ok(!clips[0].error, clips[0].error);
        assert.ok(after.clips[0].keys >= 2, `keyframes ${after.clips[0].keys}`);
        assert.ok(frames(after) >= savedFrames + 8, `${savedFrames} → ${frames(after)}`);
        assert.ok(Math.abs(clips[0].duration * 30 - frames(after)) <= 1.5, `duration ${clips[0].duration}`);
        assert.ok(clips[0].psnr >= 30, `psnr ${clips[0].psnr}`);
        await page.evaluate(() => window.clearDraft());
        await context.close();
        return `${savedFrames} + ${frames(after) - savedFrames} frames`;
    });

    await test('a failed draft save loses no frames', async () => {
        const context = await newContext();
        const page = await open(context);
        for (let i = 0; i < 4; i++) await stroke(page);
        await page.evaluate(() => window.flushDraft());
        await page.evaluate(() => window.failNextSaves(1));
        for (let i = 0; i < 4; i++) await stroke(page);
        await page.evaluate(() => window.flushDraft()); // fails
        assert.equal(await page.evaluate(() => window.draftState.failed), 1);
        await stroke(page);
        await page.evaluate(() => window.flushDraft());
        const tail = await page.evaluate(() => window.draftState.tail.video);
        const live = await info(page);
        assert.equal(tail.clips[0].frames, frames(live), `draft ${tail.clips[0].frames}, recorder ${frames(live)}`);
        await page.reload();
        await page.evaluate(() => window.ready);
        await page.waitForFunction(() => window.klecks.getRecordingInfo()?.state !== 'starting');
        assert.equal(frames(await info(page)), frames(live));
        await page.evaluate(() => window.clearDraft());
        await context.close();
        return `${frames(live)} frames`;
    });

    await test('a 4096×4096 canvas records at 1920×1920; grab time', async () => {
        const context = await newContext();
        const page = await open(context, '?w=4096&h=4096');
        for (let i = 0; i < 20; i++) await stroke(page, { steps: 20 });
        const clips = await page.evaluate(() => window.checkRecording());
        const i = await info(page);
        assert.equal(clips.length, 1);
        assert.equal(clips[0].width, 1920);
        assert.equal(clips[0].height, 1920);
        assert.ok(clips[0].psnr >= 30, `psnr ${clips[0].psnr}`);
        await page.evaluate(() => window.clearDraft());
        await context.close();
        return `grab ${i.grabMs.mean} ms mean / ${i.grabMs.p95} p95 / ${i.grabMs.max} max over ${i.grabMs.n}`;
    });

    await test('no VideoEncoder: no recording, no errors, the draft still saves', async () => {
        const context = await newContext();
        const page = await open(context, '?noencoder');
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        for (let i = 0; i < 3; i++) await stroke(page);
        await page.evaluate(() => window.flushDraft());
        const i = await info(page);
        assert.equal(i.state, 'unavailable');
        assert.deepEqual(await page.evaluate(() => window.klecks.getRecording().then((c) => c.length)), 0);
        const state = await page.evaluate(() => window.draftState);
        assert.ok(state.saves >= 1 && !state.tail.video, JSON.stringify(state));
        assert.deepEqual(errors, []);
        await page.evaluate(() => window.clearDraft());
        await context.close();
    });

    await browser.close();
}
// The embed has no crop, resize or rotate (inEmbed: false), so a canvas size change can't start
// a clip there. Another browser continuing a draft can: its encoder's parameter sets differ.
if (browsers.includes('chromium') && browsers.includes('webkit')) {
    console.log('chromium → webkit');
    await test('a draft continued in another browser: the clips play in order', async () => {
        const a = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : { channel: 'chrome' });
        const ca = await a.newContext({ viewport: { width: 1280, height: 800 } });
        const pa = await open(ca);
        for (let i = 0; i < 5; i++) await stroke(pa);
        await pa.evaluate(() => window.flushDraft());
        const draft = await pa.evaluate(() => window.exportDraft());
        const framesA = frames(await info(pa));
        await a.close();
        const b = await webkit.launch();
        const cb = await b.newContext({ viewport: { width: 1280, height: 800 } });
        let pb = await open(cb);
        await pb.evaluate((d) => window.importDraft(d), draft);
        await pb.reload();
        await pb.evaluate(() => window.ready);
        await pb.waitForFunction(() => window.klecks.getRecordingInfo()?.state !== 'starting');
        assert.equal(frames(await info(pb)), framesA);
        for (let i = 0; i < 5; i++) await stroke(pb);
        const clips = await pb.evaluate(() => window.checkRecording());
        const i = await info(pb);
        assert.ok(clips.length >= 1 && clips.length <= 2, JSON.stringify(i.clips));
        assert.ok(clips.every((c) => !c.error), JSON.stringify(clips));
        assert.ok(frames(i) >= framesA + 4);
        assert.ok(clips.at(-1).psnr >= 30, `psnr ${clips.at(-1).psnr}`);
        await b.close();
        return `${clips.length} clip(s): ${i.clips.map((c) => c.frames + ' frames').join(', ')}`;
    });
}

server.close();
if (failures) {
    console.error(`${failures} failed`);
    process.exit(1);
}
console.log('all passed');
