// Browser tests of the .klr input recording (src/app/script/klr/), in Chrome and WebKit through
// Playwright (playwright-core; Google Chrome as installed, WebKit from
// `npx playwright-core install webkit`), against scripts/test-klr.html and the embed in dist/
// (`node scripts/build-2draw.mjs` first, or pass --build).
//
//   node scripts/test-klr.mjs [--build] [chromium|webkit ...]
//
// 1. Draw with all seven brushes (real mouse strokes and scripted ones through the draw chain)
//    and every op type: fills, shapes, gradient, text, filters, selection, select transform and
//    warp, every layer op, canvas resize and crop, in-app copy and paste, undo and redo. Replay
//    the .klr in a fresh page with only the headless player: every layer's hash equals the live
//    one, every chunk's HASH matched, the catch-all never fired.
// 2. Outside images are refused: a pasted file, a dropped file, the paste button with nothing
//    copied in Klecks.
// Coder unit tests: node --test scripts/test-klr-unit.mjs
import { chromium, webkit } from 'playwright-core';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { CHUNK_OPS, encodeChunk, KlrOpsWriter, parseKlr } from '../src/app/script/klr/klr-format.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--build') || !existsSync(join(root, 'dist/embed.js'))) {
    execSync('node scripts/build-2draw.mjs', { cwd: root, stdio: 'inherit' });
}
const which = args.filter((a) => !a.startsWith('--'));
const browsers = which.length ? which : ['chromium', 'webkit'];

// one browser suite at a time on this machine (2draw.net's worker/scripts/lib/e2e-lock.ts)
const lockPath = '/Users/marcello/github/2draw.net/worker/scripts/lib/e2e-lock.ts';
if (existsSync(lockPath) && process.env.E2E_LOCK !== '0') {
    const { e2eLock } = await import(lockPath);
    await e2eLock('klecks test-klr');
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

async function open(context, query = '') {
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
    page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') console.error(`  [${m.type()}]`, m.text());
    });
    await page.goto(base + query);
    await page.evaluate(() => window.ready);
    await sleep(300);
    return page;
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

// real pointer strokes: pointer events → easel → draw chain, the easel's frames in between
let mouseSeed = 3;
async function mouseStrokes(page, brushId, n) {
    await page.evaluate((id) => api.setBrush(id), brushId);
    const r = () => (mouseSeed = (mouseSeed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < n; i++) {
        const x = 420 + r() * 600, y = 150 + r() * 450, a = r() * 6.28;
        await page.mouse.move(x, y);
        await page.mouse.down();
        for (let k = 1; k <= 14; k++) await page.mouse.move(x + Math.cos(a + k * 0.15) * k * 7.3, y + Math.sin(a + k * 0.15) * k * 7.3);
        await page.mouse.up();
        await sleep(60);
    }
}

// everything else, in the page through the app's own paths (klecks.embed.klApp.getKlrApi())
async function drive(page) {
    return page.evaluate(async ({ DEBUG, UNTIL }) => {
        const kc = api.klCanvas;
        let W = kc.getWidth(), H = kc.getHeight();
        let s = 7;
        const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
        const color = () => ({ r: Math.floor(r() * 256), g: Math.floor(r() * 256), b: Math.floor(r() * 256) });
        const pts = () => {
            const n = 8 + Math.floor(r() * 24);
            let x = 40 + r() * (W - 80), y = 40 + r() * (H - 80), a = r() * 6.28;
            const step = 3 + r() * 10, turn = (r() - 0.5) * 0.4;
            const out = [];
            for (let i = 0; i < n; i++) {
                out.push([x + r() * 0.3, y + r() * 0.3, 0.3 + 0.7 * Math.abs(Math.sin(i * 0.3 + r()))]);
                a += turn;
                x = Math.min(W - 5, Math.max(5, x + Math.cos(a) * step));
                y = Math.min(H - 5, Math.max(5, y + Math.sin(a) * step));
            }
            return out;
        };
        const tick = () => sleep(5); // undo/redo ignore a second call in the same task
        const brushSetup = {
            penBrush: (b) => { b.setScatter(r() < 0.5 ? 0 : 2); b.setAlpha(Math.floor(r() * 3)); b.sizePressure(r() < 0.7); },
            blendBrush: (b) => b.setBlending(r()),
            sketchyBrush: (b) => { b.setScale(r() < 0.5 ? 1 : 2); b.setBlending(r()); },
            pixelBrush: (b) => b.setTip(r() < 0.5 ? 'round' : 'square'),
            chemyBrush: (b) => { b.setMode(r() < 0.5 ? 'fill' : 'stroke'); b.setDistort(r() < 0.5 ? 0 : 0.3); b.setXSymmetry(r() < 0.3); b.setGradient(r() < 0.3); },
            smudgeBrush: () => {},
            eraserBrush: () => {},
        };
        const strokesWith = async (id, n) => {
            api.setBrush(id);
            const ui = api.getBrushUi();
            ui.setSize(1 + Math.round(r() * 30 * 4) / 4);
            ui.setOpacity(0.2 + Math.round(r() * 80) / 100);
            if (id !== 'eraserBrush') api.setColor(color());
            brushSetup[id](api.getBrush());
            for (let i = 0; i < n; i++) {
                await stroke(pts(), i % 3);
                if (DEBUG) done.push(`${id} #${i}`);
            }
        };
        const BRUSHES = ['penBrush', 'blendBrush', 'sketchyBrush', 'pixelBrush', 'chemyBrush', 'smudgeBrush', 'eraserBrush'];
        const done = [];
        // a sealed chunk (with its HASH) per group: a mismatch names the group, and the chunks
        // after it show they decode on their own
        const push = done.push.bind(done);
        done.push = (name) => { if (!klecks.embed.klr.seal()) throw new Error('could not seal after ' + name); return push(name); };
        done.push('mouse strokes');

        // all brushes on layer 1, twice over with other settings
        api.selectLayer(1);
        for (let round = 0; round < 2; round++) for (const id of BRUSHES) await strokesWith(id, 6);
        // a shift+click line
        api.setBrush('penBrush');
        api.chainIn({ type: 'line', x0: 100, y0: 100, x1: 700.3, y1: 420.9, pressure0: 1, pressure1: 1 });
        await sleep(20);
        done.push('brushes');
        if (UNTIL === 'brushes') return done;

        // fills, shapes, gradient, text
        kc.floodFill(1, W * 0.5, H * 0.5, { r: 30, g: 140, b: 200 }, 1, 64, 'all', 1, true);
        kc.floodFill(1, W * 0.25, H * 0.7, null, 0.8, 20, 'current', 0, false);
        const l2 = kc.addLayer(1);
        api.selectLayer(l2);
        kc.layerFill(l2, { r: 250, g: 240, b: 10 });
        kc.eraseLayer({ layerIndex: l2, useAlphaLock: false, useSelection: false });
        kc.drawShape(l2, { type: 'ellipse', x1: 200, y1: 150, x2: 500, y2: 400, fillRgb: { r: 200, g: 50, b: 50 }, opacity: 0.8 });
        kc.drawShape(l2, { type: 'line', x1: 50, y1: 600, x2: 900, y2: 100, strokeRgb: { r: 20, g: 20, b: 120 }, lineWidth: 7, angleRad: 0.1 });
        kc.drawShape(l2, { type: 'rect', x1: 600, y1: 500, x2: 800, y2: 700, strokeRgb: { r: 0, g: 120, b: 20 }, lineWidth: 3, isOutwards: true });
        kc.drawGradient(l2, { type: 'radial', color1: { r: 10, g: 200, b: 100 }, isReversed: false, opacity: 0.5, doLockAlpha: false, doSnap: false, x1: 300, y1: 300, x2: 700, y2: 500, angleRad: 0, isEraser: false });
        kc.text(l2, { text: 'Klecks .klr\ntest', x: W * 0.2, y: H * 0.3, angleRad: 0.3, size: 64, align: 'left', isBold: true, isItalic: false, font: 'sans-serif', letterSpacing: 0, lineHeight: 1, fill: { color: { r: 10, g: 10, b: 10, a: 1 } }, stroke: { color: { r: 250, g: 200, b: 0, a: 0.8 }, lineWidth: 3 } });
        await strokesWith('penBrush', 3);
        done.push('fill/shape/gradient/text');

        // layer ops
        kc.renameLayer(l2, 'Renamed');
        kc.setOpacity(l2, 0.7);
        kc.setLayerIsVisible(l2, false);
        kc.setLayerIsVisible(l2, true);
        kc.setMixMode(l2, 'multiply');
        const l3 = kc.duplicateLayer(l2);
        kc.setLayerHasClipping(l3, true);
        kc.setLayerHasClipping(l3, false);
        kc.moveLayer(l3, -1);
        api.selectLayer(l3);
        await strokesWith('blendBrush', 3);
        kc.mergeLayer(l2 + 1 >= kc.getLayerCount() ? l2 : l2 + 1);
        const l4 = kc.addLayer(kc.getLayerCount() - 1);
        api.selectLayer(l4);
        await strokesWith('sketchyBrush', 3);
        kc.removeLayer(l4);
        api.selectLayer(kc.getLayerCount() - 1);
        done.push('layers');

        // filters on the current layer
        const ok = (name, input) => { if (!api.applyFilter(name, input)) throw new Error('filter ' + name); };
        ok('blur', { radius: 4 });
        ok('invert', null);
        ok('hueSaturation', { hue: 0.2, saturation: 0.1 });
        ok('brightnessContrast', { brightness: 0.1, contrast: 0.2 });
        ok('unsharpMask', { radius: 3, strength: 0.6 });
        ok('noise', { seed: 123.5, presetIndex: 0, scale: 80, opacity: 0.4, isReversed: false, channels: 'rgb', mixModeStr: 'source-over', colA: { r: 0, g: 0, b: 0 }, colB: { r: 255, g: 255, b: 255 } });
        ok('flip', { horizontal: true, vertical: false, flipCanvas: false });
        ok('transform', { bounds: { x: 0, y: 0, width: W, height: H }, transform: { x: W / 2 + 13.5, y: H / 2 - 7.25, width: W * 0.8, height: H * 0.9, angleDeg: 11 }, isPixelated: false, doClone: false, isTransparentBg: true });
        await strokesWith('smudgeBrush', 3);
        done.push('filters');

        // selection, strokes inside it, select transform, warp, clear inside
        const li = kc.getLayerCount() - 1;
        kc.setSelection([[[[100, 100], [600, 100], [600, 500], [100, 500], [100, 100]]]]);
        await strokesWith('penBrush', 3);
        await strokesWith('blendBrush', 2);
        if (!api.transformSelection({ freeTransform: { x: 400, y: 330, width: 450, height: 380, angleDeg: 15 } })) throw new Error('transform');
        if (!api.transformSelection({ freeTransform: { x: 700, y: 500, width: 300, height: 300, angleDeg: -20 }, clone: true })) throw new Error('clone');
        const sel = kc.getSelection();
        kc.setSelection([[[[150, 150], [550, 150], [550, 450], [150, 450], [150, 150]]]]);
        const cp = [0, 1, 2].map((row) => [0, 1, 2].map((col) => ({ x: 150 + col * 200 + (row === 1 && col === 1 ? 40 : 0), y: 150 + row * 150 + (row === 1 && col === 1 ? -30 : 0) })));
        if (!api.transformSelection({ ffd: { cols: 3, rows: 3, controlPoints: cp } })) throw new Error('warp');
        kc.eraseLayer({ layerIndex: li, useAlphaLock: false, useSelection: true });
        kc.layerFill(li, { r: 90, g: 0, b: 160 }, undefined, true);
        done.push('selection' + (sel ? '' : ' (transform dropped it)'));

        // in-app copy and paste (keeps the selection mask), then outside the selection
        api.copy();
        kc.setSelection(undefined);
        api.paste({ transform: { x: W * 0.6, y: H * 0.4, width: W * 0.5, height: H * 0.5, angleDeg: 10 }, isPixelated: false });
        await strokesWith('chemyBrush', 2);
        api.copy();
        api.paste({ transform: { x: W * 0.3, y: H * 0.6, width: W * 0.3, height: H * 0.3, angleDeg: -5 }, isPixelated: true });
        done.push('copy/paste');

        // undo, redo, and a branch after undo
        for (let i = 0; i < 4; i++) { api.undo(); await tick(); }
        for (let i = 0; i < 2; i++) { api.redo(); await tick(); }
        await strokesWith('pixelBrush', 3);
        api.undo(); await tick();
        api.undo(); await tick();
        api.redo(); await tick();
        await strokesWith('eraserBrush', 2);
        done.push('undo/redo');

        // canvas size: resize, crop/extend, rotate, then draw on the new canvas
        kc.resize(Math.round(W * 0.9), Math.round(H * 0.9));
        kc.cropExtend({ left: 20, right: 10, top: -15, bottom: 30, fillColor: { r: 255, g: 255, b: 255 } });
        W = kc.getWidth(); H = kc.getHeight();
        await strokesWith('penBrush', 3);
        ok('rotate', { deg: 90 });
        W = kc.getWidth(); H = kc.getHeight();
        await strokesWith('blendBrush', 2);
        api.undo(); await tick();
        done.push('canvas size');

        // merge everything, last strokes
        kc.mergeAll();
        api.selectLayer(0);
        await strokesWith('smudgeBrush', 2);
        await strokesWith('penBrush', 2);
        await sleep(300);
        return done;
    }, { DEBUG: !!process.env.KLR_DEBUG, UNTIL: process.env.KLR_UNTIL });
}

// bytes the strokes take: the stroke ops of each chunk encoded on their own
function strokeBytes(file) {
    let bytes = 0;
    for (const chunk of file.chunks) {
        const w = new KlrOpsWriter(0);
        for (const op of chunk.ops) if (['brush', 'layer', 'down', 'move', 'up', 'line', 'transfer'].includes(op.op)) w.write(op, op.t);
        bytes += encodeChunk(CHUNK_OPS, w.bytes()).length;
    }
    return bytes;
}

for (const name of browsers) {
    console.log(name);
    const browser =
        name === 'chromium'
            ? await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : { channel: 'chrome' })
            : await webkit.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

    await test('every op recorded, fresh-page replay matches per layer, no catch-all', async () => {
        const page = await open(context);
        await mouseStrokes(page, 'penBrush', 4);
        await mouseStrokes(page, 'blendBrush', 3);
        await mouseStrokes(page, 'smudgeBrush', 2);
        const done = await drive(page);
        const base64 = await page.evaluate(() => klrBase64());
        const info = await page.evaluate(() => klecks.getKlrInfo());
        const live = await page.evaluate(() => {
            const kc = api.klCanvas;
            return kc.getLayersReference().map((l) => {
                const d = l.context.getImageData(0, 0, kc.getWidth(), kc.getHeight()).data;
                let h = 0x811c9dc5;
                for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193); }
                return h >>> 0;
            });
        });
        await page.close();
        const bytes = Buffer.from(base64, 'base64');
        const file = parseKlr(new Uint8Array(bytes));
        const ops = file.chunks.flatMap((c) => c.ops);
        const counts = {};
        for (const op of ops) counts[op.op === 'canvas' ? op.method : op.op] = (counts[op.op === 'canvas' ? op.method : op.op] ?? 0) + 1;
        const lastHash = ops.filter((o) => o.op === 'hash').at(-1);
        assert.deepEqual(lastHash.hashes, live, 'the last HASH is the live picture');
        assert.equal(info.catchAll, 0, 'catch-all fired');
        assert.equal(info.unencodable, 0, 'an op did not encode');
        assert.equal(counts.tiles ?? 0, 0);
        if (!process.env.KLR_UNTIL) for (const op of ['down', 'move', 'up', 'line', 'transfer', 'brush', 'layer', 'filter', 'undo', 'redo', 'active', 'sample', 'xform', 'ffd', 'copy', 'paste', 'hash', 'floodFill', 'layerFill', 'eraseLayer', 'drawShape', 'drawGradient', 'text', 'addLayer', 'duplicateLayer', 'removeLayer', 'renameLayer', 'setOpacity', 'setLayerIsVisible', 'setLayerHasClipping', 'setMixMode', 'moveLayer', 'mergeLayer', 'mergeAll', 'resize', 'cropExtend', 'setSelection']) {
            assert.ok(counts[op] > 0, 'no ' + op + ' op');
        }
        const brushes = new Set(ops.filter((o) => o.op === 'brush').map((o) => o.brush));
        assert.equal(brushes.size, process.env.KLR_UNTIL ? brushes.size : 7, 'all seven brushes');

        const fresh = await open(context, '?player');
        const replay = await fresh.evaluate((b) => window.replay(b), base64);
        await fresh.close();
        assert.equal(replay.startMismatch, false, 'start picture');
        if (replay.hashMismatches.length && process.env.KLR_DEBUG) {
            const c = replay.hashMismatches[0].chunk;
            console.log('first mismatch in', done[c], JSON.stringify(file.chunks[c].ops.filter((o) => o.op !== 'move').slice(0, 40)));
        }
        assert.deepEqual(replay.hashMismatches.map((m) => ({ ...m, group: done[m.chunk] })).slice(0, 5), [], 'chunk HASH mismatches');
        assert.deepEqual(replay.hashes, live, 'per-layer hashes, replay vs live');
        const sb = strokeBytes(file);
        return (
            `${done.length} groups, ${info.strokes} strokes, ${info.ops} ops, ${file.chunks.length} chunks, ` +
            `${bytes.length} B (${(bytes.length / info.strokes).toFixed(1)} B/stroke all in, ` +
            `${(sb / info.strokes).toFixed(1)} B/stroke strokes only), replay ${Math.round(replay.ms)} ms, ` +
            `${Math.round(replay.strokes / (replay.ms / 1000))} strokes/s, ${replay.hashChecks} chunk hashes matched`
        );
    });

    await test('outside images are refused; nothing recorded, nothing added', async () => {
        const page = await open(context);
        const before = await page.evaluate(() => ({ layers: api.klCanvas.getLayerCount(), ops: klecks.getKlrInfo().ops }));
        await page.evaluate(async () => {
            const png = await new Promise((r) => {
                const c = document.createElement('canvas');
                c.width = c.height = 20;
                c.getContext('2d').fillRect(0, 0, 20, 20);
                c.toBlob(r, 'image/png');
            });
            const file = new File([png], 'outside.png', { type: 'image/png' });
            const paste = new DataTransfer();
            paste.items.add(file);
            document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: paste, bubbles: true, cancelable: true }));
            const drop = new DataTransfer();
            drop.items.add(file);
            const target = document.elementFromPoint(700, 400);
            target.dispatchEvent(new DragEvent('dragover', { dataTransfer: drop, bubbles: true, cancelable: true }));
            target.dispatchEvent(new DragEvent('drop', { dataTransfer: drop, bubbles: true, cancelable: true }));
            api.paste(); // the Edit tab's paste button, nothing copied in Klecks yet
            await sleep(500);
        });
        const after = await page.evaluate(() => ({
            layers: api.klCanvas.getLayerCount(),
            ops: klecks.getKlrInfo().ops,
            refused: api.getRefusedImports(),
            note: document.body.innerText.includes('Only what you copied in Klecks can be pasted here.'),
            catchAll: klecks.getKlrInfo().catchAll,
        }));
        await page.close();
        assert.equal(after.layers, before.layers, 'a layer was added');
        assert.equal(after.ops, before.ops, 'something was recorded');
        assert.equal(after.refused, 3, 'refusals');
        assert.equal(after.catchAll, 0);
        assert.ok(after.note, 'the note is shown');
        return `${after.refused} refused`;
    });

    await browser.close();
}
server.close();
if (failures) {
    console.log(`${failures} failed`);
    process.exit(1);
}
console.log('all passed');
