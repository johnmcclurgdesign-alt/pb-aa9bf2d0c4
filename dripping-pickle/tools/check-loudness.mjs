#!/usr/bin/env node
/**
 * check-loudness — does the Loop's OUTPUT meet loops-docs 10-platform/30 §6? (AUD1, #140, #139)
 *
 *   node tools/check-loudness.mjs                # the wet path: room camera, resting state, 180 s
 *   node tools/check-loudness.mjs --dry          # the same with createConvolver stripped the way the
 *                                                #   Apple TV binding lacks it (pre-TVB3 builds)
 *   node tools/check-loudness.mjs --runs 3       # fresh page per run, sequential — "repeated until it repeats"
 *   node tools/check-loudness.mjs --seconds 30   # a short look: reported, and it can NEVER pass
 *   node tools/check-loudness.mjs --shell-gain   # bridge v2 `mute` with `gain`, measured on a tone
 *   node tools/check-loudness.mjs --selftest     # the meter on known answers (Node), the live tap on a
 *                                                #   known tone, then four 180 s pages in parallel: a
 *                                                #   control that must pass and three plants that must
 *                                                #   each turn exactly their own target red
 *
 * THE TARGETS (§6, tools/loudness.js TARGETS): integrated −23 LUFS ± 1.0 · short-term (3 s) maximum
 * ≤ −15 LUFS · true peak ≤ −3 dBTP · over ≥ 3 minutes at the declared camera in its resting state.
 * Exit 0 only when every run is a conformance measurement (≥ 180 s, gapless) inside all three.
 *
 * THE INSTRUMENT is window.__audio.measure() — an AudioWorklet on the node after the limiter,
 * feeding tools/loudness.js (BS.1770-4 K-weighting per channel, 400 ms blocks at 75 % overlap,
 * −70/−10 gates, 4× true peak). The pre-AUD1 instrument polled an AnalyserNode: 54 % of the audio
 * unsampled, stereo averaged to mono, sample peak, 20 s. Its numbers are not comparable with these.
 *
 * ⚠ Headless Chromium with --mute-audio: the context renders on the audio service's clock with the
 *   output muted, so a gate run makes no sound in the room. Under the scene's load it sometimes skips
 *   ahead (a 341 ms jump in one 20 s look); `dropoutSec` reports it, and > 5 % refuses the verdict.
 * ⚠ Wall clock. A 180 s window takes 180 s; --selftest runs its four pages side by side (~4 min).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoudnessMeter, summarise, kWeighting, TARGETS } from './loudness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const DRY = argv.includes('--dry');
const SELFTEST = argv.includes('--selftest');
const SHELL_GAIN = argv.includes('--shell-gain');
const RUNS = Number(arg('--runs', 1));
const SECONDS = Number(arg('--seconds', TARGETS.minSeconds));
const SETTLE = Number(arg('--settle', 20));    // after ready: the beds fade in on the audio clock
const TIER = 'laptop';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
  return ok;
};

// ── the page ─────────────────────────────────────────────────────────────────────────────────
// The createConvolver strip, exactly the binding's shape: the method lives on BaseAudioContext, so
// a bare delete on AudioContext.prototype removes nothing (lesson deleting-createconvolver-needs-
// the-base-prototype) — delete, then shadow the inherited property with undefined.
function stripConvolver() {
  const strip = (proto) => {
    if (!proto) return;
    try { delete proto.createConvolver; } catch { /* non-configurable */ }
    if ('createConvolver' in proto) Object.defineProperty(proto, 'createConvolver', { value: undefined, configurable: true, writable: true });
  };
  strip(window.AudioContext?.prototype);
}

async function openRoom(browser, origin, { dry = false, query = '' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
  if (dry) await page.addInitScript(stripConvolver);
  await page.goto(origin + `loops/dripping-pickle/?shell=1&device=${TIER}${query}`, { waitUntil: 'domcontentloaded' });
  const ready = await page.waitForFunction(() => window.__shell?.ready && window.__audio?.engine, null, { timeout: 240000 }).then(() => true, () => false);
  if (!ready) return { context, page, errors, ready };
  const state = await page.evaluate(async () => {
    // the room camera is the one the Loop opens on; say so rather than assume it
    const a = window.__audio;
    for (let t = performance.now(); a.contextState !== 'running' && performance.now() - t < 5000;) await new Promise((r) => setTimeout(r, 100));
    return {
      camera: window.__shell.changed.at(-1) ?? null, ctx: a.contextState, unlocked: a.unlocked,
      convolver: typeof a.engine.ctx.createConvolver, noConvolverLine: a.log.some((l) => l.id === 'audio:no-convolver'),
    };
  });
  return { context, page, errors, ready, state };
}

const measureIn = (page, seconds) => page.evaluate((s) => window.__audio.measure(s), seconds);

function line(r) {
  if (r.error) return `ERROR ${r.error}`;
  return `I ${r.integratedLufs} LUFS · S-max ${r.shortTermMaxLufs} (at ${r.shortTermMaxAtSec} s) · M-max ${r.momentaryMaxLufs} · ` +
         `TP ${r.truePeakDbtp} dBTP (sample ${r.samplePeakDbfs}) · ${r.seconds} s, dropouts ${r.dropoutSec ?? 0} s, ${r.sampleRate} Hz`;
}

function judge(label, r) {
  if (!check(`${label}: measured`, !r.error, r.error || line(r))) return;
  check(`${label}: a conformance measurement (≥ ${TARGETS.minSeconds} s of output, dropouts ≤ 5 %)`, r.conformance, `${r.note}; dropouts ${r.dropoutSec} s`);
  check(`${label}: integrated ${TARGETS.integratedLufs} ± ${TARGETS.tolerance} LUFS`, r.checks.integrated, `${r.integratedLufs} LUFS`);
  check(`${label}: short-term max ≤ ${TARGETS.shortTermMaxLufs} LUFS`, r.checks.shortTerm, `${r.shortTermMaxLufs} LUFS`);
  check(`${label}: true peak ≤ ${TARGETS.truePeakMaxDbtp} dBTP`, r.checks.truePeak, `${r.truePeakDbtp} dBTP`);
}

// ── 1. the meter, in Node, on answers known in advance ──────────────────────────────────────
function meterSelftest() {
  console.log('\n== the meter on known answers (Node, tools/loudness.js) ==');
  const sr = 48000;
  const run = (segs, { slice = 128, rate = sr } = {}) => {
    const m = new LoudnessMeter({ sampleRate: rate, channels: 2 }), subs = [];
    let t = 0;
    for (const [sec, fn] of segs) {
      const N = Math.round(sec * rate);
      for (let o = 0; o < N; o += slice) {
        const L = new Float32Array(Math.min(slice, N - o)), R = new Float32Array(L.length);
        for (let i = 0; i < L.length; i++) [L[i], R[i]] = fn(t + o + i, rate);
        m.process([L, R], subs);
      }
      t += N;
    }
    return summarise(subs);
  };
  const sine = (dbfs, f = 1000, ph = 0, right = true) => (i, s) => {
    const v = 10 ** (dbfs / 20) * Math.sin(2 * Math.PI * f * i / s + ph);
    return [v, right ? v : 0];
  };
  // BS.1770-4 Table 1 / Table 2 — the coefficients at 48 kHz, as the standard prints them
  const k = kWeighting(48000);
  const pub = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585, -1.99004745483398, 0.99007225036621];
  const got = [...k.pre.b, k.pre.a[1], k.pre.a[2], k.rlb.a[1], k.rlb.a[2]];
  check('K-weighting at 48 kHz = BS.1770-4 Tables 1 and 2', got.every((v, i) => Math.abs(v - pub[i]) < 1e-6), got.map((v) => v.toFixed(6)).join(', '));
  // EBU Tech 3341 §2.9 test signals 1–5 (stereo 1 kHz), and the channel sum
  const near = (v, want, tol = 0.1) => Math.abs(v - want) <= tol;
  let r = run([[20, sine(-23)]]);
  check('3341 #1: stereo 1 kHz at −23 dBFS → M, S, I = −23.0', near(r.integratedLufs, -23) && near(r.shortTermMaxLufs, -23) && near(r.momentaryMaxLufs, -23), line(r));
  r = run([[20, sine(-33)]]);
  check('3341 #2: −33 dBFS → I = −33.0', near(r.integratedLufs, -33), `${r.integratedLufs}`);
  r = run([[10, sine(-36)], [60, sine(-23)], [10, sine(-36)]]);
  check('3341 #3: −36 / −23 / −36 dBFS → I = −23.0 (the relative gate)', near(r.integratedLufs, -23), `${r.integratedLufs}`);
  r = run([[10, sine(-72)], [10, sine(-36)], [60, sine(-23)], [10, sine(-36)], [10, sine(-72)]]);
  check('3341 #4: −72 / −36 / −23 / −36 / −72 → I = −23.0 (both gates)', near(r.integratedLufs, -23), `${r.integratedLufs}`);
  r = run([[20, sine(-26)], [20.1, sine(-20)], [20, sine(-26)]]);
  check('3341 #5: −26 / −20 / −26 dBFS → I = −23.0', near(r.integratedLufs, -23), `${r.integratedLufs}`);
  r = run([[20, sine(-23, 1000, 0, false)]]);
  check('one channel only reads 3.0 dB under both (channels SUM, they are not averaged)', near(r.integratedLufs, -26.0), `${r.integratedLufs}`);
  const a = run([[10, sine(-23)]], { slice: 128 }), b = run([[10, sine(-23)]], { slice: 4801 });
  check('slicing does not matter (128-frame quanta = 4801-frame slices)', a.integratedLufs === b.integratedLufs && a.truePeakDbtp === b.truePeakDbtp, `${a.integratedLufs}/${b.integratedLufs}`);
  r = run([[20, sine(-23)]], { rate: 44100 });
  check('44.1 kHz: the same −23.0', near(r.integratedLufs, -23), `${r.integratedLufs}`);
  // short-term: a 3 s window sees a 3.5 s burst whole
  r = run([[30, sine(-30)], [3.5, sine(-14)], [30, sine(-30)]]);
  check('short-term max sees a 3.5 s burst at −14 → −14.0', near(r.shortTermMaxLufs, -14), `${r.shortTermMaxLufs} at ${r.shortTermMaxAtSec} s`);
  // true peak: a quarter-sample-rate sine at 45° has every SAMPLE 3.01 dB under its crest
  r = run([[1, sine(-6, 12000, Math.PI / 4)]]);
  check('true peak: fs/4 at 45°, crest −6.0 → TP −6.0 ± 0.2, sample peak −9.0', near(r.truePeakDbtp, -6, 0.2) && near(r.samplePeakDbfs, -9.01, 0.05), `TP ${r.truePeakDbtp}, sample ${r.samplePeakDbfs}`);
  let worst = 0;
  for (const f of [100, 997, 3000, 5000, 8000, 10000, 12000, 15000, 18000]) for (const ph of [0, 0.4, Math.PI / 4, 1.3]) {
    worst = Math.max(worst, Math.abs(run([[0.5, sine(-6, f, ph)]]).truePeakDbtp + 6));
  }
  check('true peak within 0.2 dB of the crest, 100 Hz–18 kHz, four phases', worst <= 0.2, `worst error ${worst.toFixed(2)} dB`);
  r = run([[5, sine(-23)]]);
  check('a 5 s window is refused as conformance, and says so', !r.conformance && !r.pass && /NOT a conformance/.test(r.note), r.note);
}

// ── 2. the live tap on a known tone ─────────────────────────────────────────────────────────
// The Loop is silenced at its master (mute, which is what the shell does) and a 1 kHz tone at
// −23 dBFS is fed into `output`, the node measure() taps, in the real page under the real scene's
// load. The worklet must read the tone exactly, and count every frame.
async function liveTone(browser, origin) {
  console.log('\n== the live tap: a −23 dBFS tone in the running room ==');
  const { context, page, errors, ready } = await openRoom(browser, origin);
  if (!check('ready', ready)) { await context.close(); return; }
  const r = await page.evaluate(async () => {
    const e = window.__audio.engine, ctx = e.ctx;
    e.setMuted(true);
    await new Promise((res) => setTimeout(res, 500));
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 1000; g.gain.value = 10 ** (-23 / 20);
    o.connect(g).connect(e.output); o.start();
    const m = await e.measure(20);
    o.stop(); g.disconnect(); e.setMuted(false);
    return m;
  });
  check('the tap reads a −23 dBFS stereo tone as −23.0 LUFS', !r.error && Math.abs(r.integratedLufs + 23) <= 0.1, line(r));
  check('…and its true peak as −23.0 dBTP', !r.error && Math.abs(r.truePeakDbtp + 23) <= 0.1, `${r.truePeakDbtp}`);
  check('20 s of OUTPUT measured, dropouts counted beside it', r.seconds === 20 && Number.isFinite(r.dropoutSec), `${r.seconds} s measured, ${r.dropoutSec} s dropped (${(r.gaps ?? []).length} clock jump(s))`);
  check('20 s is reported as NOT conformance', !r.conformance && /NOT a conformance/.test(r.note ?? ''), r.note);
  check('zero page errors', errors.length === 0, errors[0] || 'none');
  await context.close();
}

// ── 3. the plants ───────────────────────────────────────────────────────────────────────────
// A controlled programme replaces the mix (the Loop muted, a tone into `output`) so each plant
// fails exactly one target regardless of what the real mix measures that day.
async function plantProgramme(kind) {
  const e = window.__audio.engine, ctx = e.ctx;
  e.setMuted(true);
  // let the mute's 60 ms ramp finish, or the mix's own last peaks land in the control's true peak
  await new Promise((res) => setTimeout(res, 500));
  const db = (d) => 10 ** (d / 20);
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = 1000;
  g.gain.value = db(kind === 'integrated' ? -21.5 : -23);     // +1.5 LU: outside ± 1, nothing else moves
  o.connect(g).connect(e.output); o.start();
  const at = ctx.currentTime + 60;
  if (kind === 'shortterm') {
    // 3.5 s at −12 dBFS: short-term −12 LUFS; integrated rises to about −22.1, still inside
    g.gain.setValueAtTime(db(-23), at); g.gain.setValueAtTime(db(-12), at + 0.01); g.gain.setValueAtTime(db(-23), at + 3.5);
  }
  if (kind === 'truepeak') {
    // 20 ms of fs/4 at 45° under a Hann window, crest −1.5 dBFS: every SAMPLE sits ~3 dB under the
    // crest, so a sample-peak meter reads about −4.5 and passes it; a true-peak meter must not
    const sr = ctx.sampleRate, n = Math.round(0.02 * sr), b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = db(-1.5) * 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1))) * Math.sin(Math.PI / 2 * i + Math.PI / 4);
    const s = ctx.createBufferSource(); s.buffer = b; s.connect(e.output); s.start(at);
  }
}

async function plants(browser, origin) {
  console.log(`\n== the gate on plants: four ${TARGETS.minSeconds} s pages side by side ==`);
  const cases = [
    ['control', 'a −23 LUFS tone: inside every target', { integrated: true, shortTerm: true, truePeak: true }],
    ['integrated', '+1.5 LU over the whole window', { integrated: false, shortTerm: true, truePeak: true }],
    ['shortterm', 'one 3.5 s burst at −12 LUFS', { integrated: true, shortTerm: false, truePeak: true }],
    ['truepeak', 'an inter-sample peak at −1.5 dBTP whose samples read −4.5', { integrated: true, shortTerm: true, truePeak: false }],
  ];
  const results = await Promise.all(cases.map(async ([kind]) => {
    const { context, page, ready } = await openRoom(browser, origin);
    if (!ready) { await context.close(); return { error: 'not ready' }; }
    await page.evaluate(plantProgramme, kind);
    const r = await measureIn(page, TARGETS.minSeconds);
    await context.close();
    return r;
  }));
  cases.forEach(([kind, what, want], i) => {
    const r = results[i];
    console.log(`\n### ${kind.toUpperCase()}: ${what}\n    ${line(r)}`);
    if (r.error) { check(`${kind}: measured`, false, r.error); return; }
    const same = ['integrated', 'shortTerm', 'truePeak'].every((k) => r.checks[k] === want[k]);
    const verdict = kind === 'control' ? r.pass : !r.pass;
    check(`${kind}: the gate ${kind === 'control' ? 'passes' : 'fails'}, on exactly ${kind === 'control' ? 'nothing' : 'its own target'}`,
      verdict && same && r.conformance,
      Object.entries(r.checks).map(([k, v]) => `${k} ${v ? 'ok' : 'RED'}`).join(', '));
    if (kind === 'truepeak') check('truepeak: a sample-peak meter would have passed it', r.samplePeakDbfs <= TARGETS.truePeakMaxDbtp, `sample ${r.samplePeakDbfs} dBFS vs TP ${r.truePeakDbtp} dBTP`);
  });
}

// ── 4. the shell's level ────────────────────────────────────────────────────────────────────
// bridge v2 `{ type: 'mute', muted, gain }` (loops-docs 30-audio §2b). Every emitter is soloed
// away, a tone goes into the bed bus — so it passes master, where the shell's gain lives — and each
// step is measured. gain is linear amplitude: 0.5 → −6.02 dB.
async function shellGain(browser, origin) {
  console.log('\n== the shell\'s gain, measured (bridge v2 mute + gain) ==');
  const { context, page, errors, ready } = await openRoom(browser, origin);
  if (!check('ready', ready)) { await context.close(); return; }
  await page.evaluate(() => {
    const e = window.__audio.engine, ctx = e.ctx;
    e.solo('__nothing__');
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 1000; g.gain.value = 10 ** (-20 / 20);
    o.connect(g).connect(e.buses.bed); o.start();
  });
  await page.waitForTimeout(3000);           // the soloed beds' own smoothing settles
  const steps = [[false, 1], [false, 0.5], [false, 0.25], [true, 1], [false, 1]];
  const got = [];
  for (const [muted, gain] of steps) {
    await page.evaluate(([m, g]) => window.__shell.mute(m, g), [muted, gain]);
    await page.waitForTimeout(300);
    const r = await measureIn(page, 10);
    const s = await page.evaluate(() => ({ muted: window.__audio.muted, shellGain: window.__audio.shellGain, paused: window.__audio.paused, ctx: window.__audio.contextState }));
    got.push({ muted, gain, r, s });
    console.log(`    mute(${muted}, ${gain}) → ${r.error ? r.error : `${r.integratedLufs} LUFS, TP ${r.truePeakDbtp}`} · Loop says muted ${s.muted}, shellGain ${s.shellGain}, paused ${s.paused}`);
  }
  const ref = got[0].r.integratedLufs;
  check('gain 0.5 → −6.0 dB (linear amplitude)', Math.abs(got[1].r.integratedLufs - ref + 6.02) <= 0.1, `${(got[1].r.integratedLufs - ref).toFixed(2)} dB`);
  check('gain 0.25 → −12.0 dB', Math.abs(got[2].r.integratedLufs - ref + 12.04) <= 0.1, `${(got[2].r.integratedLufs - ref).toFixed(2)} dB`);
  check('muted (gain 1 sent alongside) → silence: no block above the −70 LUFS gate', got[3].r.gatedBlocks === 0 && got[3].r.truePeakDbtp < -90, `${got[3].r.gatedBlocks} gated blocks, TP ${got[3].r.truePeakDbtp} dBTP`);
  check('…and mute is not pause: the context kept rendering the whole window', got[3].r.seconds >= 10 && !got[3].s.paused && got[3].s.ctx === 'running', `${got[3].r.seconds} s rendered, paused ${got[3].s.paused}, ctx ${got[3].s.ctx}`);
  check('un-muted at gain 1 → back to the reference', Math.abs(got[4].r.integratedLufs - ref) <= 0.1, `${got[4].r.integratedLufs} vs ${ref}`);
  check('zero page errors', errors.length === 0, errors[0] || 'none');
  await context.close();
}

// ── 5. the Loop ─────────────────────────────────────────────────────────────────────────────
async function conformance(browser, origin) {
  const label = DRY ? 'dry (no ConvolverNode)' : 'wet';
  const rows = [];
  for (let k = 1; k <= RUNS; k++) {
    console.log(`\n== ${label}: run ${k} of ${RUNS} — room camera, ${SETTLE} s settle, ${SECONDS} s window ==`);
    const { context, page, errors, ready, state } = await openRoom(browser, origin, { dry: DRY });
    if (!check('ready', ready)) { await context.close(); continue; }
    check('the room camera', state.camera === 'room', `cameraChanged → ${state.camera}`);
    check('the context is running', state.ctx === 'running', state.ctx);
    // Print the strip beside the number (CMP2: a dry run once measured the wet path twice).
    check(DRY ? 'createConvolver is undefined and the Loop said so' : 'createConvolver is a function',
      DRY ? state.convolver === 'undefined' && state.noConvolverLine : state.convolver === 'function',
      `typeof createConvolver = ${state.convolver}, audio:no-convolver logged ${state.noConvolverLine}`);
    await page.waitForTimeout(SETTLE * 1000);
    const r = await measureIn(page, SECONDS);
    judge(`${label} run ${k}`, r);
    check(`${label} run ${k}: zero page errors`, errors.length === 0, errors[0] || 'none');
    rows.push(r);
    await context.close();
  }
  if (rows.length > 1) {
    const span = (k) => { const v = rows.map((r) => r[k]).filter(Number.isFinite); return `${Math.min(...v)} … ${Math.max(...v)} (spread ${(Math.max(...v) - Math.min(...v)).toFixed(1)})`; };
    console.log(`\n${label} over ${rows.length} runs: I ${span('integratedLufs')} · S-max ${span('shortTermMaxLufs')} · TP ${span('truePeakDbtp')}`);
  }
  console.log('\nJSON ' + JSON.stringify(rows.map((r) => ({ ...r, method: undefined }))));
}

// ── harness ─────────────────────────────────────────────────────────────────────────────────
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

const LAUNCH = { args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] };

if (SELFTEST) meterSelftest();
if (!SELFTEST || failures === 0) {
  await withServer(async (origin) => {
    const browser = await chromium.launch(LAUNCH);
    try {
      if (SELFTEST) { await liveTone(browser, origin); await plants(browser, origin); }
      else if (SHELL_GAIN) await shellGain(browser, origin);
      else await conformance(browser, origin);
    } finally { await browser.close(); }
  });
}
console.log(failures ? `\nFAIL — ${failures} check(s)` : `\nPASS${SELFTEST ? ' — the instrument reads known answers and the gate goes red on each plant' : ''}`);
process.exit(failures ? 1 : 0);
