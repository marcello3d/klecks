// What the easel's viewport canvas costs per frame on a retina screen: panning (middle-drag),
// zooming (wheel) and drawing (pen strokes) on a 3000×3000 canvas with recording: 'klr', in
// Chrome with the GPU on, at deviceScaleFactor 1, 2 and 3. Per phase: rAF frame intervals,
// and the renderer's main-thread and the GPU process's CPU time per frame (CDP).
// --dist <dir> serves another build in place of dist/ (the "before" of a change).
//
//   node scripts/perf-klr-viewport.mjs [--build] [--dist <dir>] [--dpr 1,2,3] [--size 3000]
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
if (args.includes('--build') || !existsSync(join(root, 'dist/embed.js'))) execSync('node scripts/build-2draw.mjs', { cwd: root, stdio: 'inherit' });
const distDir = resolve(opt('--dist', join(root, 'dist')));
const dprs = opt('--dpr', '1,2,3').split(',').map(Number);
const size = Number(opt('--size', 3000));
const lockPath = '/Users/marcello/github/2draw.net/worker/scripts/lib/e2e-lock.ts';
if (existsSync(lockPath) && process.env.E2E_LOCK !== '0') await (await import(lockPath)).e2eLock('klecks perf-klr-viewport');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '');
    const file = path.startsWith('dist/') ? join(distDir, path.slice(5)) : join(root, path);
    if (!(file.startsWith(root) || file.startsWith(distDir)) || !existsSync(file) || !/^(dist|scripts)\//.test(path)) return (res.statusCode = 404), res.end();
    res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}/scripts/test-klr.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
console.log('dist:', distDir);

const browserCdp = await browser.newBrowserCDPSession();
async function cpu(cdp) {
    let gpu = NaN;
    try {
        const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
        gpu = processInfo.filter((p) => /gpu/i.test(p.type)).reduce((a, p) => a + p.cpuTime, 0);
    } catch (e) {
        console.log('no process info:', e.message);
    }
    const { metrics } = await cdp.send('Performance.getMetrics');
    const task = metrics.find((m) => m.name === 'TaskDuration').value;
    return { gpu: gpu * 1000, main: task * 1000 };
}

async function run(dpr) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(base + `?w=${size}&h=${size}`);
    await page.evaluate(() => window.ready);
    await sleep(800);
    const info = await page.evaluate(() => {
        const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
        return { css: `${c.clientWidth}x${c.clientHeight}`, px: `${c.width}x${c.height}` };
    });
    await page.evaluate(() => { api.setBrush('penBrush'); api.getBrushUi().setSize(12); });
    let s = 5;
    const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const phases = {
        pan: async () => {
            for (let i = 0; i < 6; i++) {
                await page.mouse.move(700, 400);
                await page.mouse.down({ button: 'middle' });
                for (let k = 1; k <= 30; k++) await page.mouse.move(700 + Math.sin(k / 5) * 200, 400 + Math.cos(k / 7) * 120);
                await page.mouse.up({ button: 'middle' });
            }
        },
        zoom: async () => {
            await page.mouse.move(700, 400);
            for (let i = 0; i < 6; i++) {
                for (let k = 0; k < 4; k++) { await page.mouse.wheel(0, -120); await sleep(60); }
                for (let k = 0; k < 4; k++) { await page.mouse.wheel(0, 120); await sleep(60); }
            }
        },
        draw: async () => {
            for (let i = 0; i < 20; i++) {
                const x = 420 + r() * 600, y = 150 + r() * 450, a = r() * 6.28;
                await page.mouse.move(x, y);
                await page.mouse.down();
                for (let k = 1; k <= 40; k++) await page.mouse.move(x + Math.cos(a + k * 0.08) * k * 6, y + Math.sin(a + k * 0.08) * k * 6);
                await page.mouse.up();
                await sleep(30);
            }
        },
    };
    const out = {};
    for (const [name, fn] of Object.entries(phases)) {
        await fn(); // warm up
        await sleep(300);
        await page.evaluate(() => frames.start());
        const c0 = await cpu(cdp);
        await fn();
        const c1 = await cpu(cdp);
        const f = await page.evaluate(() => frames.stop());
        out[name] = { ...f, mainPerFrame: (c1.main - c0.main) / f.frames, gpuPerFrame: (c1.gpu - c0.gpu) / f.frames };
        await sleep(300);
    }
    await ctx.close();
    return { info, out };
}

for (const dpr of dprs) {
    for (let rep = 0; rep < 2; rep++) {
        const { info, out } = await run(dpr);
        for (const [name, f] of Object.entries(out)) {
            console.log(`dpr ${dpr} viewport ${info.css} css ${info.px} px  ${name.padEnd(4)} frames ${String(f.frames).padStart(4)}, p50 ${f.p50.toFixed(1)} p95 ${f.p95.toFixed(1)} max ${f.max.toFixed(1)} ms, >20ms ${f.over20}, main ${f.mainPerFrame.toFixed(1)} ms/frame, gpu proc ${f.gpuPerFrame.toFixed(1)} ms/frame`);
        }
    }
}
await browser.close();
server.close();
