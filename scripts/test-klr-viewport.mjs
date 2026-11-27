// The easel's viewport at device pixels (useNativeResolution): what it draws lines up with the
// pointer at deviceScaleFactor 1, 2 and 3, before and after a two-finger pinch that zooms and
// rotates. Real input in Chrome: a pen stroke must land under the mouse path; the select
// tool's lasso (drawn by renderAfter) and the shape tool's preview (a layer's compositeObj) must
// be under the pointer mid-drag. Pixels are read from page screenshots (device pixels).
//
// Also, in Chrome and WebKit: no checkerboard (the canvas's CSS background) along the edges of
// a filter preview or the easel at any sub-pixel position (Safari drew a GPU canvas one device
// pixel off its CSS box, a dashed line along the preview's bottom).
//
//   node scripts/test-klr-viewport.mjs [--build] [--dist <dir>] [--dpr 1,2,3] [--edges-only]
import { chromium, webkit } from 'playwright-core';
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
const lockPath = '/Users/marcello/github/2draw.net/worker/scripts/lib/e2e-lock.ts';
if (existsSync(lockPath) && process.env.E2E_LOCK !== '0') await (await import(lockPath)).e2eLock('klecks test-klr-viewport');

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

let failures = 0;
const filterHashes = [];
const check = (ok, msg) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
    if (!ok) failures++;
};

// distance in CSS px from each point to the nearest dark pixel of the screenshot
async function distances(page, points, dark = 100) {
    const png = (await page.screenshot()).toString('base64');
    return page.evaluate(
        async ({ png, points, dark }) => {
            const im = new Image();
            im.src = 'data:image/png;base64,' + png;
            await im.decode();
            const c = document.createElement('canvas');
            c.width = im.width;
            c.height = im.height;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(im, 0, 0);
            const dpr = im.width / innerWidth;
            const R = Math.ceil(8 * dpr);
            return points.map(([x, y]) => {
                const cx = Math.round(x * dpr), cy = Math.round(y * dpr);
                const d = ctx.getImageData(cx - R, cy - R, 2 * R + 1, 2 * R + 1).data;
                let best = Infinity;
                for (let j = 0; j <= 2 * R; j++) {
                    for (let i = 0; i <= 2 * R; i++) {
                        const k = (j * (2 * R + 1) + i) * 4;
                        if (d[k] + d[k + 1] + d[k + 2] < dark * 3) best = Math.min(best, Math.hypot(i - R, j - R));
                    }
                }
                return best / dpr;
            });
        },
        { png, points, dark },
    );
}

const along = (pts, n = 6) => {
    const out = [];
    for (let s = 0; s + 1 < pts.length; s++) {
        for (let k = 1; k < n; k++) {
            const t = k / n;
            out.push([pts[s][0] + (pts[s + 1][0] - pts[s][0]) * t, pts[s][1] + (pts[s + 1][1] - pts[s][1]) * t]);
        }
    }
    return out;
};

async function drag(page, pts, release = true) {
    await page.mouse.move(...pts[0]);
    await page.mouse.down();
    for (let s = 0; s + 1 < pts.length; s++) {
        for (let k = 1; k <= 10; k++) {
            await page.mouse.move(pts[s][0] + ((pts[s + 1][0] - pts[s][0]) * k) / 10, pts[s][1] + ((pts[s + 1][1] - pts[s][1]) * k) / 10);
        }
    }
    if (release) await page.mouse.up();
    await sleep(250);
}

// two fingers around (cx, cy): spread from r0 to r1 and turn by turnDeg
async function pinch(cdp, cx, cy, r0, r1, turnDeg) {
    const at = (t) => {
        const r = r0 + (r1 - r0) * t, a = ((turnDeg * t) / 180) * Math.PI;
        return [
            { x: cx - Math.cos(a) * r, y: cy - Math.sin(a) * r, id: 1 },
            { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, id: 2 },
        ];
    };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
    for (let k = 1; k <= 20; k++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(k / 20) });
        await sleep(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(600);
}


// The checkerboard made magenta, so any of it showing is easy to find; the preview (Tilt Shift's)
// and the easel's canvas moved by a fraction of a CSS pixel, so its device-pixel edges fall
// between pixels; the rows and columns along each edge, read from a page screenshot.
const MAGENTA = '* { --kl-checkerboard-background: rgb(255, 0, 255) !important; }';
async function edgeLeaks(page, el) {
    const r = await el.evaluate((c) => { const b = c.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; });
    const png = (await page.screenshot()).toString('base64');
    return page.evaluate(async ({ png, r }) => {
        const im = new Image();
        im.src = 'data:image/png;base64,' + png;
        await im.decode();
        const c = document.createElement('canvas');
        c.width = im.width; c.height = im.height;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(im, 0, 0);
        const dpr = im.width / innerWidth;
        const L = Math.max(0, Math.floor(r[0] * dpr)), T = Math.max(0, Math.floor(r[1] * dpr));
        const R = Math.min(im.width, Math.ceil(r[2] * dpr)), B = Math.min(im.height, Math.ceil(r[3] * dpr));
        const count = (x, y, w, h) => {
            const d = ctx.getImageData(x, y, w, h).data;
            let n = 0;
            for (let k = 0; k < d.length; k += 4) if (d[k] - d[k + 1] > 12 && d[k + 2] - d[k + 1] > 12) n++;
            return n;
        };
        const leaks = {
            top: count(L, T, R - L, 2),
            bottom: count(L, B - 2, R - L, 2),
            left: count(L, T, 2, B - T),
            right: count(R - 2, T, 2, B - T),
        };
        return Object.entries(leaks).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n} px`).join(', ');
    }, { png, r });
}

async function edgeChecks(type, name) {
    const b = type === chromium ? browser : await type.launch();
    for (const dpr of dprs) {
        const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr });
        const page = await ctx.newPage();
        await page.goto(base + '?w=1200&h=900');
        await page.evaluate(() => window.ready);
        await sleep(500);
        await page.addStyleTag({ content: MAGENTA });
        const easel = await page.evaluateHandle(() => [...document.querySelectorAll('canvas')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]);
        const bad = [];
        for (const off of [0, 0.25, 0.5, 0.75]) {
            await easel.evaluate((c, off) => { c.style.marginTop = c.style.marginLeft = `${off}px`; }, off);
            await sleep(300);
            const leak = await edgeLeaks(page, easel);
            if (leak) bad.push(`+${off}: ${leak}`);
        }
        await easel.evaluate((c) => { c.style.marginTop = c.style.marginLeft = ''; });
        check(!bad.length, `${name} dpr ${dpr}: no checkerboard along the easel's edges${bad.length ? ` (${bad.join('; ')})` : ''}`);

        await page.click('[title="Edit"]');
        await page.locator('button', { hasText: /^\s*Tilt Shift\s*$/ }).first().click({ timeout: 10000 });
        await sleep(800);
        const preview = await page.evaluateHandle(() => {
            const h = [...document.querySelectorAll('div')].find((el) => el.style.position === 'absolute' && el.style.cursor === 'move' && el.style.borderRadius);
            return h.parentElement.querySelector('canvas');
        });
        bad.length = 0;
        for (const off of [0, 0.25, 0.5, 0.75]) {
            await page.evaluate((off) => { const box = document.querySelector('.kl-popup-box'); box.style.top = box.style.left = `${off}px`; }, off);
            await sleep(300);
            const leak = await edgeLeaks(page, preview);
            if (leak) bad.push(`+${off}: ${leak}`);
            // --crops <dir>: the preview's bottom edge with the real checkerboard, for a look
            if (opt('--crops') && off === 0.25) {
                const r = await preview.evaluate((c) => { const b = c.getBoundingClientRect(); return [b.left, b.bottom]; });
                await page.evaluate(() => document.querySelectorAll('style').forEach((st) => st.textContent.includes('255, 0, 255') && (st.disabled = true)));
                await sleep(200);
                await page.screenshot({ path: join(opt('--crops'), `${name}-dpr${dpr}-preview-bottom.png`), clip: { x: r[0] - 6, y: r[1] - 10, width: 120, height: 20 } });
                await page.evaluate(() => document.querySelectorAll('style').forEach((st) => (st.disabled = false)));
            }
        }
        check(!bad.length, `${name} dpr ${dpr}: no checkerboard along the tilt shift preview's edges${bad.length ? ` (${bad.join('; ')})` : ''}`);
        await ctx.close();
    }
    if (b !== browser) await b.close();
}

await edgeChecks(chromium, 'chrome');
await edgeChecks(webkit, 'webkit');

for (const dpr of args.includes('--edges-only') ? [] : dprs) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr, hasTouch: true });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await page.goto(base + '?w=1200&h=900');
    await page.evaluate(() => window.ready);
    await sleep(800);
    const px = await page.evaluate(() => {
        const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
        return { w: c.width, cw: c.clientWidth };
    });
    console.log(`dpr ${dpr}: viewport canvas ${px.w} px for ${px.cw} CSS px`);
    await page.evaluate(() => { api.setBrush('penBrush'); api.getBrushUi().setSize(3); api.setColor({ r: 0, g: 0, b: 0 }); });
    const tol = 1.5;

    const stroke = async (label, pts) => {
        await drag(page, pts);
        // not next to a corner, which the brush's line smoothing rounds off (as at 1× before)
        const at = along(pts).filter(([x, y]) => pts.slice(1, -1).every(([cx, cy]) => Math.hypot(x - cx, y - cy) > 40));
        const d = await distances(page, at);
        const worst = d.indexOf(Math.max(...d));
        check(d[worst] <= tol, `dpr ${dpr} ${label}: stroke under the mouse path (max ${d[worst].toFixed(2)} CSS px, at ${at[worst].map(Math.round)})`);
        await page.evaluate(() => api.undo());
        await sleep(200);
    };
    await stroke('fit view', [[450, 300], [800, 300], [800, 500], [520, 620]]);

    // the select tool's polygon (renderAfterViewport: drawn on the viewport canvas), while placing it
    const poly = async (label) => {
        await page.evaluate(() => {
            const app = klecks.embed.klApp;
            app.easel.setTool('select');
            app.easel.toolsMap.select.setSelectShape('poly');
        });
        const pts = [[480, 260], [760, 290], [700, 520], [500, 470]];
        for (const p of pts.slice(0, 3)) {
            await page.mouse.move(...p);
            await page.mouse.down();
            await page.mouse.up();
            await sleep(400);
        }
        for (let k = 1; k <= 10; k++) await page.mouse.move(700 + (-200 * k) / 10, 520 + (-50 * k) / 10); // the open end follows the pointer
        await sleep(250);
        const d = await distances(page, along(pts));
        check(Math.max(...d) <= 2, `dpr ${dpr} ${label}: select polygon under the pointer (max ${Math.max(...d).toFixed(2)} CSS px)`);
        await page.keyboard.press('Escape');
        await page.evaluate(() => klecks.embed.klApp.easel.setTool('brush'));
        await sleep(200);
    };
    await poly('fit view');

    // shape tool preview (a compositeObj on the layer), mid-drag: a rectangle's corner
    const shape = async (label) => {
        await page.evaluate(() => klecks.embed.klApp.easel.setTool('shape'));
        await drag(page, [[520, 280], [780, 520]], false);
        const d = await distances(page, [[780, 520], [650, 520], [780, 400], [520, 400]]);
        await page.mouse.up();
        await sleep(200);
        check(Math.max(...d) <= tol + 1, `dpr ${dpr} ${label}: shape preview corner and edges under the pointer (max ${Math.max(...d).toFixed(2)} CSS px)`);
        await page.evaluate(() => { api.undo(); klecks.embed.klApp.easel.setTool('brush'); });
        await sleep(200);
    };
    await shape('fit view');

    await pinch(cdp, 640, 420, 80, 150, 25);
    const t = await page.evaluate(() => klecks.embed.klApp.easel.getTransform());
    console.log(`dpr ${dpr}: after pinch scale ${t.scale.toFixed(3)}, angle ${t.angleDeg.toFixed(1)}°`);
    check(t.angleDeg % 360 !== 0 && Math.abs(t.scale) > 0.5, `dpr ${dpr}: pinch zoomed and rotated`);
    await page.evaluate(() => klecks.embed.klApp.easel.setTool('brush'));
    await stroke('pinched, rotated', [[460, 320], [780, 330], [760, 520], [520, 600]]);
    await poly('pinched, rotated');
    await shape('pinched, rotated');
    await ctx.close();

    // a filter dialog's preview (Preview, its own ProjectViewport at device pixels): two dots on
    // Tilt Shift's focus points must be under its handles (DOM, CSS px); a handle dragged; the
    // result applied must not depend on the screen (the same hashes at every dpr) and the .klr
    // must replay to it
    const fctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr });
    try {
    const fpage = await fctx.newPage();
    await fpage.goto(base + '?w=1200&h=900');
    await fpage.evaluate(() => window.ready);
    await sleep(500);
    await fpage.evaluate(async () => {
        api.setBrush('penBrush'); api.getBrushUi().setSize(24); api.setColor({ r: 0, g: 0, b: 0 });
        await stroke([[300, 450, 1], [301, 450, 1]]);
        await stroke([[900, 450, 1], [901, 450, 1]]);
    });
    await fpage.click('[title="Edit"]');
    await fpage.locator('button', { hasText: /^\s*Tilt Shift\s*$/ }).first().click({ timeout: 10000 });
    await sleep(800);
    const dlg = await fpage.evaluate(() => {
        const handles = [...document.querySelectorAll('div')].filter((el) => el.style.position === 'absolute' && el.style.cursor === 'move' && el.style.borderRadius);
        const canvases = [...document.querySelectorAll('canvas')].filter((c) => c.closest('.kl-popup, [class*="modal"], [class*="popup"]') || false);
        const all = [...document.querySelectorAll('canvas')];
        // the preview: the canvas the handles sit on
        const host = handles[0]?.parentElement;
        const c = host ? [...host.querySelectorAll('canvas')][0] : undefined;
        return {
            handles: handles.map((h) => { const r = h.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }),
            canvas: c ? { w: c.width, cw: c.clientWidth } : null,
            n: [canvases.length, all.length],
        };
    });
    check(dlg.handles.length === 2 && !!dlg.canvas, `dpr ${dpr} tilt shift: dialog with 2 handles and a preview canvas (${dlg.handles.length} handles)`);
    if (dlg.canvas) {
        const want = Math.round(dlg.canvas.cw * Math.min(dpr, 3));
        check(dlg.canvas.w === want, `dpr ${dpr} tilt shift: preview canvas ${dlg.canvas.w} px for ${dlg.canvas.cw} CSS px (want ${want})`);
    }
    if (dlg.handles.length === 2) {
        const setVis = (v) => fpage.evaluate((v) => [...document.querySelectorAll('div')].filter((el) => el.style.position === 'absolute' && el.style.cursor === 'move' && el.style.borderRadius).forEach((h) => (h.style.visibility = v)), v);
        await setVis('hidden');
        await sleep(300);
        // centroid of the dark pixels around each handle
        const png = (await fpage.screenshot()).toString('base64');
        const cents = await fpage.evaluate(async ({ png, pts }) => {
            const im = new Image();
            im.src = 'data:image/png;base64,' + png;
            await im.decode();
            const c = document.createElement('canvas');
            c.width = im.width; c.height = im.height;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(im, 0, 0);
            const dpr = im.width / innerWidth, R = Math.ceil(16 * dpr);
            return pts.map(([x, y]) => {
                const cx = Math.round(x * dpr), cy = Math.round(y * dpr);
                const d = ctx.getImageData(cx - R, cy - R, 2 * R + 1, 2 * R + 1).data;
                let sx = 0, sy = 0, n = 0;
                for (let j = 0; j <= 2 * R; j++) for (let i = 0; i <= 2 * R; i++) {
                    const k = (j * (2 * R + 1) + i) * 4;
                    if (d[k] + d[k + 1] + d[k + 2] < 300) { sx += i - R; sy += j - R; n++; }
                }
                return n ? Math.hypot(sx / n, sy / n) / dpr : Infinity;
            });
        }, { png, pts: dlg.handles });
        check(Math.max(...cents) <= 1.5, `dpr ${dpr} tilt shift: the dots the preview draws are under the handles (off by ${cents.map((d) => d.toFixed(2)).join(', ')} CSS px)`);
        await setVis('visible');
        const [hx, hy] = dlg.handles[1];
        await fpage.mouse.move(hx, hy);
        await fpage.mouse.down();
        for (let k = 1; k <= 10; k++) await fpage.mouse.move(hx, hy + 4 * k);
        await fpage.mouse.up();
        await sleep(300);
        const moved = await fpage.evaluate(() => { const h = [...document.querySelectorAll('div')].filter((el) => el.style.position === 'absolute' && el.style.cursor === 'move' && el.style.borderRadius)[1].getBoundingClientRect(); return [h.left + h.width / 2, h.top + h.height / 2]; });
        check(Math.hypot(moved[0] - hx, moved[1] - hy - 40) <= 1, `dpr ${dpr} tilt shift: the dragged handle followed the pointer (at ${moved.map((v) => v.toFixed(1)).join(',')}, pointer ${hx.toFixed(1)},${(hy + 40).toFixed(1)})`);
    }
    await fpage.locator('button', { hasText: /^\s*ok\s*$/i }).first().click({ timeout: 10000 });
    await sleep(800);
    const live = await fpage.evaluate(() => liveHashes());
    filterHashes.push({ dpr, live: live.join() });
    const klr = await fpage.evaluate(() => klrBase64());
    const ppage = await fctx.newPage();
    await ppage.goto(base + '?player');
    await ppage.evaluate(() => window.ready);
    const rep = await ppage.evaluate((b) => replay(b).hashesFresh, klr);
    check(rep.join() === live.join(), `dpr ${dpr} tilt shift: the .klr replays to the applied layers`);
    } catch (e) {
        check(false, `dpr ${dpr} tilt shift: ${e.message.split('\n')[0]}`);
    }
    await fctx.close();
}
if (filterHashes.length) check(new Set(filterHashes.map((h) => h.live)).size === 1, `tilt shift applied through the dialog: the same layers at dpr ${filterHashes.map((h) => h.dpr).join(', ')}`);
await browser.close();
server.close();
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
