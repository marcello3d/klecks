// What recording: 'klr' costs while drawing: all-software 2D canvases (softwareCanvases(),
// layer-context.ts) and the recorder, against upstream canvases (GPU where Chrome likes) with
// no recording. Fast real-mouse strokes (pen, then blend) at 1200×900 and 3000×3000 in Chrome
// with the GPU on; frame intervals from rAF and long tasks.
//
//   node scripts/perf-klr-canvas.mjs [--build]
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--build') || !existsSync(join(root, 'dist/embed.js'))) execSync('node scripts/build-2draw.mjs', { cwd: root, stdio: 'inherit' });
const lockPath = '/Users/marcello/github/2draw.net/worker/scripts/lib/e2e-lock.ts';
if (existsSync(lockPath) && process.env.E2E_LOCK !== '0') await (await import(lockPath)).e2eLock('klecks perf-klr-canvas');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '');
    const file = join(root, path);
    if (!file.startsWith(root) || !existsSync(file) || !/^(dist|scripts)\//.test(path)) return (res.statusCode = 404), res.end();
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}/scripts/test-klr.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page0 = await ctx.newPage();
await page0.goto(base + '?idle');
const gpu = await page0.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : 'no webgl';
});
await page0.close();
console.log('renderer:', gpu);

async function run(mode, w, h, brush) {
    const page = await ctx.newPage();
    await page.goto(base + `?${mode === 'gpu' ? 'norec' : ''}&w=${w}&h=${h}`);
    await page.evaluate(() => window.ready);
    await sleep(500);
    await page.evaluate((b) => { api.setBrush(b); api.getBrushUi().setSize(b === 'blendBrush' ? 30 : 12); }, brush);
    let s = 5;
    const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
    // warm up (first strokes allocate), then measure
    for (let pass = 0; pass < 2; pass++) {
        if (pass === 1) await page.evaluate(() => frames.start());
        for (let i = 0; i < (pass ? 30 : 4); i++) {
            const x = 420 + r() * 600, y = 150 + r() * 450, a = r() * 6.28;
            await page.mouse.move(x, y);
            await page.mouse.down();
            for (let k = 1; k <= 40; k++) await page.mouse.move(x + Math.cos(a + k * 0.08) * k * 6, y + Math.sin(a + k * 0.08) * k * 6);
            await page.mouse.up();
            await sleep(30); // fast strokes, one after another
        }
    }
    const f = await page.evaluate(() => frames.stop());
    await page.close();
    return f;
}

const rows = [];
for (const [w, h] of [[1200, 900], [3000, 3000]]) {
    for (const brush of ['penBrush', 'blendBrush']) {
        for (const mode of ['gpu', 'software+klr', 'gpu', 'software+klr']) {
            const f = await run(mode, w, h, brush);
            rows.push({ size: `${w}x${h}`, brush, mode, ...f });
            console.log(`${w}x${h} ${brush.padEnd(10)} ${mode.padEnd(13)} frames ${f.frames}, p50 ${f.p50.toFixed(1)} p95 ${f.p95.toFixed(1)} max ${f.max.toFixed(1)} ms, >20ms ${f.over20}, >33ms ${f.over33}, long tasks ${f.longTasks} (max ${f.longMax.toFixed(0)} ms)`);
        }
    }
}
await browser.close();
server.close();
