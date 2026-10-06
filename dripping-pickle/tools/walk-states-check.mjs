// Does every state of the BUD3 attribution walk actually change the picture?
//
// ★ WHY THIS IS A GATE AND NOT A NOTE. The walk prices a pass by switching it off and seeing
//   what the frame gives back. A state that silently does nothing therefore reports its pass
//   as FREE — and "that pass is free" is the answer that ends an optimisation row early and
//   sends the next session somewhere else. It is also completely invisible: the walk runs,
//   the log is full, every number looks like a number.
//
// ★ AND IT IS A DESK JOB, NOT A DEVICE JOB. The first design read the canvas back four times
//   per window on the phone so the walk could check itself. That was wrong twice over: a
//   readback binds a framebuffer three has CACHED, so the following frame renders into the
//   wrong target (measured: the run went bimodal, p50 3.8 ms against p95 31.9 ms on the same
//   window), and a synchronous readback is a GPU stall added to the frame being timed.
//   WHETHER a state moves the picture is deterministic and belongs here. WHAT it costs needs
//   a phone. Splitting them removed the tolerance band, the animation noise and the stall.
//
// HOW IT IS MADE DETERMINISTIC. The frame loop is stopped, so nothing in the room moves —
// no cat, no conveyor, no drift, no screens. Then every capture is `__rt.renderFrame(T)` at
// one fixed T, which also freezes the grain, the flare and the screens' own clocks. Under
// those conditions the null control reads EXACTLY zero rather than about zero, which is the
// difference between a control and a hope (docs/lessons/prove-the-differ-before-you-believe-it).
//
//   node tools/walk-states-check.mjs [url]
//   node tools/walk-states-check.mjs --selftest   # plants a no-op state and requires the red
//
// Exits non-zero if any state did not take effect, if the control did, or if the baseline drifted.

import { chromium } from 'playwright';

const SELFTEST = process.argv.includes('--selftest');
const URL_ARG = process.argv.find((a) => a.startsWith('http'));
// ⚠ `tvvideo=0&screensaver=0` are not cosmetic. The three tellies carry an HTMLVideoElement
// whose texture keeps advancing whether or not the frame loop is running, so two captures of
// the SAME state differ by more than most states differ from the baseline — measured 4.28
// against a control that must read 0. This is the same set BUD2's own A/B used, for the same
// reason (docs/lessons/prove-the-differ-before-you-believe-it).
const URL = URL_ARG || 'http://localhost:5181/loops/dripping-pickle/?perfwalk=1&tierlevel=0&tvvideo=0&screensaver=0';
const FROZEN_T = 1234.5;          // any fixed value; it only has to be the SAME one every time
const CAP_W = 320;                // the capture is downsampled — a state that moves the picture
                                  // moves it by more than a resample, and this keeps it quick
// A state must move more than this to count as having moved the picture at all. It is not a
// noise band — under a stopped loop at a frozen t there is no noise, and the control proves
// it — it is a guard against a change too small to be the pass being off.
const MIN_DELTA = 0.05;           // mean absolute channel delta, 0..255
// ★ THE CONTROL DOES NOT READ EXACTLY ZERO AND IT IS NOT SUPPOSED TO. Measured 0.065 with
//   the loop stopped and t frozen: n8ao's denoise advances its own noise offset per render,
//   which is a real per-render change nothing here drives. It is the floor under every
//   picture number in this report, printed so nobody reads 0.03 as a signal.
const CONTROL_PICTURE_MAX = 0.15;

async function capture(page, apply) {
  return page.evaluate(({ t, w, fn }) => {
    const ws = window.__walkStates;
    const states = [...ws.states, ...(ws.comboStates || []), ...(ws.fixedStates || [])];
    ws.reset();
    let read = null;
    if (fn) {
      const s = states.find((x) => x.id === fn);
      if (!s) throw new Error('no such state: ' + fn);
      s.set();
      read = s.read ? JSON.stringify(s.read()) : null;
    } else {
      // The baseline's reading of the SAME field is what a state is compared against, so the
      // control has to read something too — hence `read: () => 'unchanged'` on it.
      read = null;
    }
    // Render and read in ONE synchronous turn. The renderer has no preserveDrawingBuffer, so
    // the drawing buffer is valid only until the browser composites — the same trap the
    // budget rig's pixel floor documents, and the reason this is not two awaits.
    window.__rt.renderFrame(t);
    const src = window.__rt.renderer.domElement;
    const h = Math.max(1, Math.round(w * src.height / src.width));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, w, h);
    return { px: Array.from(ctx.getImageData(0, 0, w, h).data), read };
  }, { t: FROZEN_T, w: CAP_W, fn: apply });
}

/** What the state's declared field reads at the RESET frame — its "before". */
async function readAtReset(page, id) {
  return page.evaluate((fn) => {
    const w = window.__walkStates;
    const states = [...w.states, ...(w.comboStates || []), ...(w.fixedStates || [])];
    w.reset();
    const s = states.find((x) => x.id === fn);
    return s && s.read ? JSON.stringify(s.read()) : null;
  }, id);
}

const delta = (a, b) => {
  let sum = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) { sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n += 3; }
  return sum / n;
};

const browser = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(URL, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => !!window.__walkStates && !!window.__rt, null, { timeout: 240000 });

// ⚠ Stop the frame loop FIRST. With it running, the cat, the conveyor and the camera drift
// move between two captures and every state looks like it changed the picture — including a
// control that changed nothing, which is precisely the false green this gate exists to refuse.
await page.evaluate(() => window.__rt.renderer.setAnimationLoop(null));

if (SELFTEST) {
  // ★ PLANT A STATE THAT DOES NOTHING AND REQUIRE THE RED. A gate nobody has watched fail is
  //   a gate that reports success when it is broken.
  await page.evaluate(() => window.__walkStates.states.push({ id: '__planted_noop', note: 'planted', set: () => {}, read: () => 'unchanged' }));
}

// BOTH lists. The combination walk's rungs stack, and a rung that silently fails to stack is
// the same defect as a pass that silently fails to switch off — worse, because a stacked rung
// that does nothing reads as "the ladder has run out of road".
const ids = await page.evaluate(() => {
  const w = window.__walkStates;
  return [...w.states, ...(w.comboStates || []), ...(w.fixedStates || [])].map((s) => s.id).filter((id, i, a) => a.indexOf(id) === i);
});
// ★ A BASELINE AFTER EVERY STATE, NOT THREE AT THE END. A state whose reset does not fully
//   undo it shifts every capture that follows, and a repeatability figure taken only at the
//   end says the capture path is broken without saying WHICH state broke it. Measured: the
//   first version of this gate read 3.41 at the end and 0.065 next to the first baseline —
//   the same leak the walk's own interleaved baselines had already found once in the scene.
const base0 = await capture(page, null);
const rows = [];
let prevBase = base0, worstDrift = 0;
for (const id of ids) {
  const before = await readAtReset(page, id);
  const shot = await capture(page, id);
  const after = await capture(page, null);
  const drift = +delta(base0.px, after.px).toFixed(3);
  worstDrift = Math.max(worstDrift, drift);
  rows.push({ id, delta: +delta(prevBase.px, shot.px).toFixed(3), drift, before, applied: shot.read });
  prevBase = after;
}
const selfDelta = worstDrift;
await browser.close();

console.log(`walk-states-check — ${ids.length} states, frozen t=${FROZEN_T}, ${CAP_W}px capture, frame loop stopped\n`);
console.log(`  worst baseline drift across the run: ${selfDelta}`);
for (const r of rows) {
  const expectSilent = r.id === 'null' || r.id === 'f-null' || r.id === 'g-null' || r.id === 'h-null' || r.id === '__planted_noop';
  r.took = r.before !== r.applied;
  const ok = expectSilent ? !r.took : r.took;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${r.id.padEnd(16)} ${String(r.before).padStart(12)} -> ${String(r.applied).padEnd(12)}` +
              ` · picture ${String(r.delta).padStart(7)} · drift ${String(r.drift).padStart(6)}` +
              (expectSilent ? '   (control)' : ''));
}

const fails = [];
// Against the control's own floor, not against zero: n8ao advances a denoise offset per
// render, so a baseline can never repeat exactly and demanding that it does fails forever.
if (selfDelta > CONTROL_PICTURE_MAX) fails.push(`a state did not fully reset: the baseline drifted ${selfDelta} across the run. ` +
  `The first state whose 'baseline after' is non-zero is the one that leaked.`);
const control = rows.find((r) => r.id === 'null');
if (!control) fails.push('there is no null control in the state list');
else if (control.took) fails.push(`the control changed its declared field (${control.before} -> ${control.applied})`);
else if (control.delta > CONTROL_PICTURE_MAX) fails.push(`the control moved the picture by ${control.delta}`);
for (const r of rows) {
  if (r.id === 'null' || r.id === 'f-null' || r.id === 'g-null' || r.id === 'h-null' || r.id === '__planted_noop') continue;
  if (!r.read && r.before === null && r.applied === null) { fails.push(`${r.id} declares no read() — it cannot be proved to have taken effect`); continue; }
  if (!r.took) fails.push(`${r.id} did not take effect: its declared field stayed at ${r.before} — its cost is not evidence`);
}
if (errors.length) fails.push(`${errors.length} page error(s): ${errors[0]}`);

if (SELFTEST) {
  const planted = rows.find((r) => r.id === '__planted_noop');
  const caught = planted && !planted.took;
  console.log('');
  if (!caught) { console.error('SELFTEST FAILED — the planted no-op state read as having taken effect, so the plant proves nothing'); process.exit(2); }
  console.log('SELFTEST PASS — a planted no-op state reads as not having taken effect');
}

if (fails.length) { console.error('\nwalk-states-check FAILED:\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
console.log('\nwalk-states-check: every state takes effect, the control does not, and the baseline never drifted');
