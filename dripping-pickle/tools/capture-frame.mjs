#!/usr/bin/env node
/**
 * capture-frame — one frame of the SHIPPING entry, read back from the canvas, headless.
 *
 *   node tools/capture-frame.mjs --out reference/strip/01-room.jpg
 *   node tools/capture-frame.mjs --out x.png --size 3840x2160 --query "tierlevel=0" --event delivery_mission --wait 14
 *   node tools/capture-frame.mjs --out y.jpg --camera screens --wait 5
 *
 * WHY (W9). The strip (#47) was captured by hand in the Browser pane, which stops rAF whenever it is
 * hidden and reads the canvas back black outside a painted frame (reference/strip/README.md). Playwright
 * has been a devDependency since DQ21, so the procedure can be a command. The read is ARMED inside a
 * frame (two rAFs, then toDataURL) — never awaited across one — which is the trap the README names.
 * The canvas is the whole picture a viewer gets; the DOM controls (the ZOOM chip, the aim marker) are
 * not in it, which is what a master and a look comparison both want.
 *
 * Prints the frame's mean R,G,B and sd, the way reference/strip/README.md records a baseline.
 */
import { chromium, webkit } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const out = arg('--out', null);
if (!out) { console.error('usage: capture-frame.mjs --out <file.jpg|png> [--size WxH] [--query q] [--event id] [--camera id] [--wait s]'); process.exit(2); }
const [W, H] = arg('--size', '1280x720').split('x').map(Number);
const query = arg('--query', '');
const event = arg('--event', null), cam = arg('--camera', null);
const waitS = Number(arg('--wait', 6));
const quality = Number(arg('--quality', 0.92));
// --no-chip: hold the ZOOM prompt at zero. It is drawn INTO the frame by the lens pass, so a canvas
// read carries it; a master must not (the shell draws its own chrome). --browser webkit: Playwright's
// Chromium has no H.264, so the screens there show the screensaver; WebKit plays the pickle video.
const noChip = process.argv.includes('--no-chip');
const engine = arg('--browser', 'chromium');

async function withServer(fn) {
  const port = 5300 + Math.floor(Math.random() * 400);
  const server = spawn(process.execPath, [path.join(ROOT, 'tools/dev-server.mjs'), String(port)], { cwd: ROOT, stdio: 'ignore' });
  const origin = `http://127.0.0.1:${port}/`;
  for (let t = Date.now(); Date.now() - t < 15000;) {
    try { if ((await fetch(origin + 'budgets.json')).ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  try { return await fn(origin); } finally { server.kill(); }
}

await withServer(async (origin) => {
  const browser = engine === 'webkit' ? await webkit.launch()
    : await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
    // ?shell=1 only so a camera can be asked for the way the shell asks; it changes nothing else.
    await page.goto(origin + `loops/dripping-pickle/?shell=1${query ? '&' + query : ''}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__shell?.ready, null, { timeout: 180000 });
    if (event) await page.waitForFunction(() => window.__events, null, { timeout: 60000 });
    if (noChip) await page.evaluate(() => { const l = window.__lens, set = l.setPrompt.bind(l); l.setPrompt = () => set(0); set(0); });
    if (event) await page.evaluate((id) => window.__events.fire(id), event);
    if (cam) await page.evaluate((id) => window.__shell.camera(id), cam);
    await page.waitForTimeout(waitS * 1000);
    const type = /\.png$/i.test(out) ? 'image/png' : 'image/jpeg';
    const shot = await page.evaluate(({ type, quality }) => new Promise((done) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const c = document.querySelector('canvas');
        const url = c.toDataURL(type, quality);
        // stats from the same painted frame, on a 2D copy
        const k = document.createElement('canvas'); k.width = c.width; k.height = c.height;
        const g = k.getContext('2d'); g.drawImage(c, 0, 0);
        const px = g.getImageData(0, 0, k.width, k.height).data;
        const sum = [0, 0, 0], sq = [0, 0, 0]; let n = 0;
        for (let i = 0; i < px.length; i += 4) { n++; for (let j = 0; j < 3; j++) { sum[j] += px[i + j]; sq[j] += px[i + j] ** 2; } }
        const mean = sum.map((s) => s / n), sd = sq.map((s, j) => Math.sqrt(s / n - mean[j] ** 2));
        done({ url, w: c.width, h: c.height, mean, sd });
      }));
    }), { type, quality });
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.url.split(',')[1], 'base64'));
    const f = (a) => a.map((v) => v.toFixed(2)).join(', ');
    console.log(`${out}: ${shot.w}x${shot.h} · mean ${f(shot.mean)} · sd ${f(shot.sd)} · ${fs.statSync(out).size} B · page errors ${errors.length}${errors[0] ? ' — ' + errors[0] : ''}`);
  } finally { await browser.close(); }
});
