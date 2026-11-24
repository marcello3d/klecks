// SPIKE (throwaway, branch spike-replay): is an input log of Klecks's chain-out events,
// replayed through the same build, pixel-identical? Same page, fresh page, Chrome GPU vs
// Chrome software 2D canvas vs WebKit. See worker/KLECKS-RECORDING-PLAN.md (2draw.net), Phase 0.
//
//   node scripts/spike-replay.mjs [--build] [--extras] [--strokes=600] [--size=1200x900]
//
// Prints per pairing: per-layer FNV-1a hash match, max channel delta, differing pixels, the
// first checkpoint that differs, bucket-fill mask differences, and replay strokes/s.
// Writes the logs and the JSON report to spike-out/.
import { chromium, webkit } from 'playwright-core';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) ?? `=${d}`).split('=')[1];
if (args.includes('--build') || !existsSync(join(root, 'dist/embed.js'))) {
    execSync('node scripts/build-2draw.mjs', { cwd: root, stdio: 'inherit' });
}
const EXTRAS = args.includes('--extras');
const N_STROKES = Number(flag('strokes', 600));
const CP_EVERY = Number(flag('cp', 25));
const ONLY = flag('only', '');
const [W, H] = flag('size', '1200x900').split('x').map(Number);
const out = join(root, 'spike-out');
mkdirSync(out, { recursive: true });

// one browser suite at a time on this machine (2draw.net worker/scripts/lib/e2e-lock.ts)
const lockPath = '/Users/marcello/github/2draw.net/worker/scripts/lib/e2e-lock.ts';
if (existsSync(lockPath) && process.env.E2E_LOCK !== '0') {
    const { e2eLock } = await import(lockPath);
    await e2eLock('klecks spike-replay');
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
const base = `http://localhost:${server.address().port}/scripts/spike-replay.html?w=${W}&h=${H}`;

// ---- the script: brushes first, then (with --extras) bucket fill, text, a WebGL filter, a transform
let s = 7;
const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
const pick = (a) => a[Math.floor(r() * a.length)];
const ALL_BRUSHES = ['penBrush', 'blendBrush', 'sketchyBrush', 'pixelBrush', 'chemyBrush', 'smudgeBrush', 'eraserBrush'];
const BRUSHES = flag('brushes', '') ? flag('brushes', '').split(',') : ALL_BRUSHES;
const CROSS = args.includes('--cross'); // record in chrome-gpu only, replay in the others
const color = () => ({ r: Math.floor(r() * 256), g: Math.floor(r() * 256), b: Math.floor(r() * 256) });
function brushOp(id) {
    const x = {
        penBrush: { scatter: pick([0, 0, 0.5, 2]), alpha: pick([0, 1, 2]), sizePressure: r() < 0.7 },
        blendBrush: { blending: r() },
        sketchyBrush: { scale: pick([1, 2]), blending: r() },
        pixelBrush: { tip: pick(['round', 'square']) },
        chemyBrush: { mode: pick(['fill', 'stroke']), distort: pick([0, 0.3]), xSym: r() < 0.3, gradient: r() < 0.3 },
    }[id];
    const maxSize = { pixelBrush: 12, chemyBrush: 4, smudgeBrush: 40, blendBrush: 40, eraserBrush: 50 }[id] ?? 30;
    return { op: 'brush', a: { id, size: 1 + Math.round(r() * maxSize * 4) / 4, opacity: 0.2 + Math.round(r() * 80) / 100, color: color(), x } };
}
function strokePoints() {
    const n = 8 + Math.floor(r() * 30);
    let x = 40 + r() * (W - 80), y = 40 + r() * (H - 80);
    let a = r() * Math.PI * 2;
    const step = 3 + r() * 12, turn = (r() - 0.5) * 0.4;
    const pts = [];
    for (let i = 0; i < n; i++) {
        pts.push([x + r() * 0.3, y + r() * 0.3, 0.3 + 0.7 * Math.abs(Math.sin(i * 0.3 + r()))]);
        a += turn + (r() - 0.5) * 0.2;
        x = Math.min(W - 5, Math.max(5, x + Math.cos(a) * step));
        y = Math.min(H - 5, Math.max(5, y + Math.sin(a) * step));
    }
    return pts;
}
const actions = [];
for (let i = 0; i < N_STROKES; i++) {
    if (i % 10 === 0) actions.push(brushOp(BRUSHES[Math.floor(i / 10) % BRUSHES.length]));
    if (i === Math.floor(N_STROKES / 2)) actions.push({ op: 'addLayer', a: {} });
    if (i === Math.floor(N_STROKES * 0.8)) actions.push({ op: 'layer', a: { i: 1 } });
    actions.push({ stroke: strokePoints() });
    if (i % CP_EVERY === CP_EVERY - 1) actions.push({ op: 'cp', a: {} });
}
if (EXTRAS) {
    actions.push({ op: 'layer', a: { i: 1 } });
    actions.push({ op: 'fill', a: { x: W * 0.5, y: H * 0.5, rgb: { r: 30, g: 140, b: 200 }, opacity: 1, tolerance: 64, sample: 'all', grow: 1, contiguous: true } });
    actions.push({ op: 'cp', a: {} });
    actions.push({ op: 'fill', a: { x: W * 0.25, y: H * 0.7, rgb: { r: 220, g: 60, b: 10 }, opacity: 0.8, tolerance: 20, sample: 'current', grow: 0, contiguous: true } });
    actions.push({ op: 'cp', a: {} });
    actions.push({ op: 'text', a: { text: 'Klecks replay\nspike 2draw', x: W * 0.2, y: H * 0.3, angleRad: 0.3, size: 64, align: 'left', isBold: true, isItalic: false, font: 'sans-serif', letterSpacing: 0, lineHeight: 1, fill: { color: { r: 10, g: 10, b: 10, a: 1 } }, stroke: { color: { r: 250, g: 200, b: 0, a: 0.8 }, lineWidth: 3 } } });
    actions.push({ op: 'cp', a: {} });
    actions.push({ op: 'filter', a: { filter: 'blur', input: { radius: 6 } } });
    actions.push({ op: 'cp', a: {} });
    actions.push({ op: 'filter', a: { filter: 'transform', input: { bounds: { x: 0, y: 0, width: W, height: H }, transform: { x: W / 2 + 13.5, y: H / 2 - 7.25, width: W * 0.8, height: H * 0.9, angleDeg: 11 }, isPixelated: false, doClone: false, isTransparentBg: true } } });
    actions.push({ op: 'cp', a: {} });
    actions.push(brushOp('penBrush'));
    for (let i = 0; i < 5; i++) actions.push({ stroke: strokePoints() });
}

// ---- browsers
const CONFIGS = {
    'chrome-gpu': () => chromium.launch({ channel: 'chrome', args: ['--enable-gpu', '--ignore-gpu-blocklist'] }),
    'chrome-sw': () => chromium.launch({ channel: 'chrome', args: ['--disable-accelerated-2d-canvas'] }),
    webkit: () => webkit.launch(),
};
const browsers = {};
async function openPage(cfg) {
    browsers[cfg] ??= await CONFIGS[cfg]();
    const context = await browsers[cfg].newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error(`  [${cfg} pageerror]`, e.message));
    page.on('console', (m) => {
        if (m.type() === 'error') console.error(`  [${cfg} console]`, m.text());
    });
    await page.goto(base);
    await page.evaluate(() => window.ready);
    return page;
}
const MOUSE = Number(flag('mouse', 20));
async function record(page) {
    // a few strokes with the real mouse first (pointer events → easel → chain), pen brush
    await page.evaluate(() => {
        const spike = window.__klSpike;
        spike.mode = 'record';
        spike.log = [];
        spike.nextSeed = 1;
        spike.strokes = 0;
        spike.reset();
        spike.op('brush', { id: 'penBrush', size: 6, opacity: 0.9, color: { r: 200, g: 20, b: 90 }, x: { scatter: 0, alpha: 0, sizePressure: true } });
    });
    let m = 3;
    const mr = () => (m = (m * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < MOUSE; i++) {
        const x = 400 + mr() * 600, y = 150 + mr() * 450, a = mr() * 6.28;
        await page.mouse.move(x, y);
        await page.mouse.down();
        for (let k = 1; k <= 12; k++) await page.mouse.move(x + Math.cos(a + k * 0.15) * k * 7.3, y + Math.sin(a + k * 0.15) * k * 7.3);
        await page.mouse.up();
        await new Promise((r) => setTimeout(r, 60));
    }
    return page.evaluate(async (actions) => {
        const spike = window.__klSpike;
        const t0 = performance.now();
        let strokes = 0;
        for (const a of actions) {
            if (a.stroke) {
                await spike.stroke(a.stroke, 1);
                strokes++;
            } else spike.op(a.op, a.a);
        }
        const ms = performance.now() - t0;
        spike.mode = 'idle';
        return { log: spike.log, ms, strokes, chainStrokes: spike.strokes, outsideRandom: spike.outsideCalls() };
    }, actions);
}
const NODATA = args.includes('--nodata');
const result = (page) => page.evaluate((d) => window.__klSpike.result(d), !NODATA);
const YIELD = Number(flag('yield', 0)); // ms to yield to timers before each replayed stroke
const YIELD_EV = args.includes('--yield-ev');
const replay = (page, log) => page.evaluate(([log, y, ev, m]) => ((window.__klSpike.yieldEveryEvent = ev), (window.__klSpike.yieldMode = m), window.__klSpike.replay(log, y)), [log, YIELD, YIELD_EV, flag('yield-mode', 'timeout')]);

function compare(a, b) {
    const layers = [];
    const n = Math.max(a.layers.length, b.layers.length);
    for (let i = 0; i < n; i++) {
        const la = a.layers[i], lb = b.layers[i];
        if (!la || !lb) {
            layers.push({ i, missing: true });
            continue;
        }
        if (!la.data || !lb.data) {
            layers.push({ i, hashA: la.hash, hashB: lb.hash, same: la.hash === lb.hash, maxDelta: NaN, diffPx: NaN, diffPct: NaN, alphaOnly: NaN });
            continue;
        }
        const da = Buffer.from(la.data, 'base64'), db = Buffer.from(lb.data, 'base64');
        let maxDelta = 0, diffPx = 0, sumDelta = 0, alphaOnly = 0;
        for (let p = 0; p < da.length; p += 4) {
            let m = 0, rgbDiff = false;
            for (let k = 0; k < 4; k++) {
                const d = Math.abs(da[p + k] - db[p + k]);
                if (d > m) m = d;
                if (d && k < 3) rgbDiff = true;
                sumDelta += d;
            }
            if (m) {
                diffPx++;
                if (!rgbDiff) alphaOnly++;
            }
            if (m > maxDelta) maxDelta = m;
        }
        layers.push({ i, hashA: la.hash, hashB: lb.hash, same: la.hash === lb.hash, maxDelta, diffPx, diffPct: +((100 * diffPx) / (da.length / 4)).toFixed(3), alphaOnly });
    }
    const cps = Math.min(a.checkpoints.length, b.checkpoints.length);
    let firstCp = -1;
    for (let i = 0; i < cps; i++) if (a.checkpoints[i] !== b.checkpoints[i]) { firstCp = i; break; }
    const fills = a.fillMasks.map((fa, i) => {
        const fb = b.fillMasks[i];
        if (!fb) return { missing: true };
        const ma = Buffer.from(fa.mask, 'base64'), mb = Buffer.from(fb.mask, 'base64');
        let d = 0;
        for (let k = 0; k < ma.length; k++) if (ma[k] !== mb[k]) d++;
        return { nA: fa.n, nB: fb.n, maskDiff: d };
    });
    return { layers, firstDifferingCheckpoint: firstCp, checkpoints: cps, fills };
}
const fmt = (c) =>
    c.layers.map((l) => (l.missing ? `L${l.i}: missing` : `L${l.i} ${l.same ? 'SAME ' + l.hashA : `${l.hashA}≠${l.hashB} max Δ${l.maxDelta} ${l.diffPx}px (${l.diffPct}%, alpha-only ${l.alphaOnly})`}`)).join(' | ') +
    ` | first diff cp ${c.firstDifferingCheckpoint < 0 ? 'none' : (c.firstDifferingCheckpoint + 1) * CP_EVERY + ' strokes'}` +
    (c.fills.length ? ` | fills ${c.fills.map((f) => `${f.nA}/${f.nB}px mask Δ${f.maskDiff}`).join(', ')}` : '');

const report = { size: `${W}x${H}`, extras: EXTRAS, env: {}, record: {}, pairs: [] };
const pair = (name, a, b, extra = {}) => {
    const c = compare(a, b);
    report.pairs.push({ name, ...extra, ...c });
    console.log(`${name}${extra.strokesPerSec ? ` [${extra.strokesPerSec} strokes/s]` : ''}\n  ${fmt(c)}`);
};

const live = {};
const logs = {};
for (const cfg of Object.keys(CONFIGS).filter((c) => (CROSS ? c === 'chrome-gpu' : !ONLY || c === ONLY))) {
    const page = await openPage(cfg);
    report.env[cfg] = await page.evaluate(() => window.__klSpike.env());
    console.log(`${cfg}: ${report.env[cfg].webgl}`);
    const rec = await record(page);
    logs[cfg] = rec.log;
    writeFileSync(join(out, `log-${cfg}.json`), JSON.stringify(rec.log));
    const bytes = JSON.stringify(rec.log).length;
    console.log(`  Math.random calls outside chain-out while recording: ${rec.outsideRandom}`);
    report.record[cfg] = { outsideRandom: rec.outsideRandom, ms: Math.round(rec.ms), strokes: rec.strokes, chainStrokes: rec.chainStrokes, events: rec.log.length, jsonBytes: bytes };
    console.log(`  recorded ${rec.strokes} strokes (${rec.chainStrokes} downs at chain-out), ${rec.log.length} log entries, ${(bytes / 1024).toFixed(0)} kB JSON, ${(rec.ms / 1000).toFixed(1)} s`);
    live[cfg] = await result(page);
    const rp = await replay(page, rec.log);
    pair(`${cfg}: live vs same-page replay`, live[cfg], await result(page), { strokesPerSec: Math.round(rp.strokes / (rp.ms / 1000)) });
    const rp2 = await replay(page, rec.log);
    pair(`${cfg}: live vs same-page replay #2`, live[cfg], await result(page), { strokesPerSec: Math.round(rp2.strokes / (rp2.ms / 1000)) });
    await page.context().close();
    const fresh = await openPage(cfg);
    const rp3 = await replay(fresh, rec.log);
    pair(`${cfg}: live vs fresh-page replay`, live[cfg], await result(fresh), { strokesPerSec: Math.round(rp3.strokes / (rp3.ms / 1000)) });
    await fresh.context().close();
}
if (ONLY) process.exit(0);
// cross-browser: Chrome GPU's log replayed everywhere, against Chrome GPU's live picture
for (const cfg of ['chrome-sw', 'webkit']) {
    const page = await openPage(cfg);
    const rp = await replay(page, logs['chrome-gpu']);
    pair(`chrome-gpu live vs ${cfg} replay of chrome-gpu log`, live['chrome-gpu'], await result(page), { strokesPerSec: Math.round(rp.strokes / (rp.ms / 1000)) });
    await page.context().close();
}
if (!CROSS) {
    const page = await openPage('chrome-gpu');
    const rp = await replay(page, logs['webkit']);
    pair(`webkit live vs chrome-gpu replay of webkit log`, live['webkit'], await result(page), { strokesPerSec: Math.round(rp.strokes / (rp.ms / 1000)) });
    await page.context().close();
}
for (const b of Object.values(browsers)) await b.close();
server.close();
writeFileSync(join(out, `report-${W}x${H}${EXTRAS ? '-extras' : ''}.json`), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.record));
