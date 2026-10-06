// How much of this frame moves when nothing in the room does — and which pass is doing it.
//
// ★ WHY THIS EXISTS. Rung 5 of the device tier (half render scale, a quarter of the pixels)
//   is worth roughly twice the frame rate of every content rung put together, and it was
//   REFUSED on the picture on 2026-09-10: "a static quality over the materials, flecks of
//   flicker on the bricks". BUD2 measured the flicker — 0.91% of pixels moving >= 8/255
//   between consecutive frames at full resolution against 1.39% at a quarter, each of those
//   upscaled into a 2x2 block so the visible area quadruples — and cleared the film grain
//   (?grain=0 read 1.38%, i.e. no change). It then attributed the rest to "the per-pixel
//   dither in the AO and the edge pass" WITHOUT MEASURING IT.
//
// ★ THAT ATTRIBUTION IS WRONG, AND SO IS THE CONTROL THAT PRODUCED IT. `?grain=0` IS SILENTLY
//   IGNORED unless the dev panel exists: the looks panel replays URL params for its dials, and
//   that replay loop lives inside `if (menu)`, which is `DEV && ...`. Measured three ways on
//   2026-09-13 — `?grain=0` leaves uGrain at 0.035, `?dev=1&grain=0` sets it to 0 — so BUD2's
//   control never fired and "1.38%, unchanged" was the same frame measured twice.
//   With the grain ACTUALLY off, a parked room is bit-identical frame to frame: max channel
//   delta 0, mean delta 0, 0.000% of pixels moving. There is no dither in the AO or the edge
//   pass contributing anything. The flicker IS the film grain, and SMAA amplifies it at edges
//   (smaa-off drops the largest excursion from 78.6 to 6.4 while the mean barely moves).
//
// WHAT IT MEASURES, AT TWO SPATIAL FREQUENCIES, because they answer different questions.
//   FINE — the full canvas. Single-pixel change, which is what film grain IS and is meant to
//   look like. This is the figure comparable to BUD2's 0.91% / 1.39%.
//   COARSE — the same frames downsampled to 320px first, which averages single-pixel noise
//   away and leaves only change that covers an AREA. This is the one that tracks the
//   complaint: at half render scale every grain sample is upscaled into a 2x2 block, so the
//   flecks acquire a size and the coarse figure goes UP while the fine figure goes down.
//   Reporting only the fine figure is how a frame can measure "less flicker" and look worse.
//
// ⚠ THE MOVERS HAVE TO BE OUT. The cat, the mouse, the conveyor and the telly video all move
//   real pixels, and a flicker figure that includes them measures the room, not the dither.
//   `?cat=0&mouse=0&belt=0&tvvideo=0&screensaver=0` is the parked room, and `?drift=0` is
//   already the default.
//
//   node tools/flicker-check.mjs                     # the shipped frame, full and half scale
//   node tools/flicker-check.mjs --attribute         # ...and once per suspect state
//   node tools/flicker-check.mjs --selftest          # plants a known flicker and requires it
//
// A state's number is read against the baseline at the SAME render scale: a pass that is
// causing the flicker shows a large drop, one that is not shows none.

import { chromium } from 'playwright';

const SELFTEST = process.argv.includes('--selftest');
const ATTRIBUTE = process.argv.includes('--attribute') || SELFTEST;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const THRESH = Number(arg('--thresh', 8));
const FRAMES = Number(arg('--frames', 24));
const BASE = process.argv.find((a) => a.startsWith('http')) ||
  'http://localhost:5181/loops/dripping-pickle/';
// The parked room. Everything here is a MOVER, not a look dial — see the ⚠ above.
const PARKED = 'perfwalk=1&tierlevel=0&cat=0&mouse=0&belt=0&tvvideo=0&screensaver=0';
const URL = BASE + (BASE.includes('?') ? '&' : '?') + PARKED;

// The suspects, in the order BUD2's guess named them. `null` is the control: it must read the
// same as the baseline, and if it does not, nothing else here is evidence.
const SUSPECTS = ['null', 'grain-off', 'ao-denoise1', 'ao+shafts-off', 'shafts-off',
                  'pcss-hard', 'smaa-off', 'lens-off', 'gi-cheap'];

const browser = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(URL, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => !!window.__walkStates && !!window.__rt, null, { timeout: 240000 });

/**
 * Consecutive frames, captured from inside the animation loop.
 * ⚠ Each capture must happen in the SAME turn as the frame that drew it — the renderer has no
 * preserveDrawingBuffer, so a capture a tick later reads a cleared buffer and every pair
 * compares identical, which reads as "no flicker" (docs/lessons/the-canvas-reads-back-black-outside-the-paint-turn).
 */
async function measure(page, stateId, scale) {
  return page.evaluate(async ({ id, sc, frames, thresh }) => {
    const { states, reset } = window.__walkStates;
    reset();
    if (sc !== 1) states.find((s) => s.id === `res0${String(sc).slice(2).padEnd(2, '0')}`)?.set();
    if (id && id !== 'null') states.find((s) => s.id === id)?.set();
    await new Promise((r) => setTimeout(r, 900));   // let the change settle and any target rebuild

    const src = window.__rt.renderer.domElement;
    // ⚠ FULL CANVAS RESOLUTION, NOT A THUMBNAIL. Downsampling averages the grain away: the
    // same frame reads 0.267% of pixels moving at 320px and several times that at 1280. A
    // flicker figure is only comparable to another one taken the same way, so this takes the
    // canvas as presented — which is also what an eye is looking at.
    // The canvas is captured at its CSS size whatever the render scale is, so a reduced
    // backing store is upscaled here exactly as the browser upscales it for the viewer.
    const W = src.clientWidth || src.width, H = src.clientHeight || src.height;
    const CW = 320, CH = Math.max(1, Math.round(CW * H / W));
    const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h;
                           return c.getContext('2d', { willReadFrequently: true }); };
    const fineCtx = mk(W, H), coarseCtx = mk(CW, CH);
    const lum = (ctx, w, h) => {
      const d = ctx.getImageData(0, 0, w, h).data;
      const out = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) out[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
      return out;
    };
    const fine = [], coarse = [];
    await new Promise((resolve) => {
      let n = 0;
      const step = () => {
        fineCtx.drawImage(src, 0, 0, W, H);
        coarseCtx.drawImage(src, 0, 0, CW, CH);
        fine.push(lum(fineCtx, W, H)); coarse.push(lum(coarseCtx, CW, CH));
        if (++n >= frames) return resolve();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const pct = (shots) => {
      let moved = 0, pairs = 0, maxd = 0;
      for (let k = 1; k < shots.length; k++) {
        const a = shots[k - 1], b = shots[k];
        for (let i = 0; i < a.length; i++) { const dd = Math.abs(a[i] - b[i]); if (dd >= thresh) moved++; if (dd > maxd) maxd = dd; }
        pairs += a.length;
      }
      return { pct: +(100 * moved / pairs).toFixed(3), max: +maxd.toFixed(1) };
    };
    const f = pct(fine), c2 = pct(coarse);
    return { fine: f.pct, coarse: c2.pct, maxDelta: f.max };
  }, { id: stateId, sc: scale, frames: FRAMES, thresh: THRESH });
}

if (SELFTEST) {
  // ★ PLANT A FLICKER AND REQUIRE IT. A flicker meter nobody has watched read a KNOWN flicker
  //   is a meter that reports 0.00% on a broken capture path — which is exactly what a
  //   capture taken outside the paint turn does, and it looks like good news.
  // ⚠ The plant has to be INSIDE the render. The first version overlaid a flashing DOM
  //   element, which the WebGL canvas readback cannot see at all — a plant that proves
  //   nothing is worse than no plant, because it reads as the tool being fine.
  await page.evaluate(() => {
    window.__walkStates.states.push({
      id: '__planted_flicker',
      set: () => {
        const r = window.__rt.renderer;
        const base = r.toneMappingExposure;
        let on = false;
        window.__plantTimer = setInterval(() => { on = !on; r.toneMappingExposure = on ? base * 1.6 : base; }, 8);
      },
      read: () => 'planted',
    });
  });
}

const rows = [];
const scales = [1, 0.5];
for (const sc of scales) {
  const base = await measure(page, null, sc);
  rows.push({ scale: sc, id: 'baseline', ...base });
  if (ATTRIBUTE) for (const id of SUSPECTS) rows.push({ scale: sc, id, ...(await measure(page, id, sc)) });
}
let planted = null;
if (SELFTEST) {
  planted = (await measure(page, '__planted_flicker', 1)).fine;
  await page.evaluate(() => { clearInterval(window.__plantTimer); });
}
await browser.close();

console.log(`flicker-check — pixels moving >= ${THRESH}/255 between consecutive frames, ` +
            `${FRAMES} frames, full canvas, room PARKED (${PARKED})\n`);
for (const sc of scales) {
  const b = rows.find((r) => r.scale === sc && r.id === 'baseline');
  console.log(`  render scale ${sc}   fine ${b.fine.toFixed(3)}%   coarse ${b.coarse.toFixed(3)}%   max delta ${b.maxDelta}`);
  for (const r of rows.filter((x) => x.scale === sc && x.id !== 'baseline')) {
    console.log(`     ${r.id.padEnd(16)} fine ${String(r.fine.toFixed(3)).padStart(7)}%  coarse ${String(r.coarse.toFixed(3)).padStart(7)}%` +
                `  max ${String(r.maxDelta).padStart(6)}` +
                (r.id === 'null' ? '   (control — must match the baseline)' : ''));
  }
  console.log('');
}
if (errors.length) console.error(`⚠ ${errors.length} page error(s): ${errors[0]}`);

if (SELFTEST) {
  const b = rows.find((r) => r.scale === 1 && r.id === 'baseline').fine;
  console.log(`  planted flicker (exposure flipped 1.6x every 8 ms): ${planted.toFixed(3)}% ` +
              `against a baseline of ${b.toFixed(3)}%`);
  if (!(planted > b + 5)) {
    console.error('\nSELFTEST FAILED — a 1.6x exposure flip did not register. The capture path is ' +
                  'not reading consecutive frames, and every 0.00% this tool prints is meaningless.');
    process.exit(2);
  }
  const ctrl = rows.find((r) => r.scale === 1 && r.id === 'null');
  if (ctrl && Math.abs(ctrl.fine - b) > 0.25) {
    console.error(`\nSELFTEST FAILED — the control moved ${Math.abs(ctrl.fine - b).toFixed(3)} pts; run-to-run ` +
                  'noise is larger than the differences this tool is asked to resolve.');
    process.exit(2);
  }
  console.log('\nSELFTEST PASS — a planted flicker registers, and the control does not move');
}
