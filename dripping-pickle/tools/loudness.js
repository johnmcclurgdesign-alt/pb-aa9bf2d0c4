// tools/loudness.js — the loudness instrument loops-docs 10-platform/30 §6 specifies, as pure code.
//
// AUD1 (#140, #139). One meter, three hosts: the AudioWorklet tap in tools/loudness-worklet.js runs
// it on the live output, tools/check-loudness.mjs runs it in Node against known answers, and both
// summarise through the SAME `summarise()` — so the number the gate asserts is the number the
// self-test proved. Nothing here touches the DOM or Web Audio.
//
// The method is ITU-R BS.1770-4 / EBU R128 (EBU Tech 3341), because §6's targets are R128's:
//   K-weighting   — the standard's two biquads (pre-filter shelf + RLB high-pass), designed for the
//                   context's actual sample rate, not BiquadFilterNode approximations.
//   channels      — mean square PER CHANNEL, summed with weight 1.0 for L and R. ⚠ NOT a mono
//                   down-mix: an AnalyserNode averages (L+R)/2 before you see a sample, which reads
//                   a decorrelated stereo bed 6 dB low and a centred mono source 3 dB low. The
//                   pre-AUD1 measure() did exactly that.
//   blocks        — 400 ms gating blocks at 75 % overlap (a 100 ms step), built from GAPLESS 100 ms
//                   sub-blocks: every sample the output produced is in exactly one sub-block, and a
//                   render dropout (the context skipping ahead) is counted and reported, not hidden.
//   integrated    — absolute gate −70 LUFS, then the relative gate 10 LU under the abs-gated mean.
//   short-term    — 3 s windows, ungated, every 100 ms; the target is on their maximum.
//   true peak     — 4× oversampled (a 64-tap windowed-sinc polyphase interpolator), not sample peak:
//                   a sample-peak reading under-reads an inter-sample overshoot by up to ~3 dB.
//   window        — ≥ 180 s for a conformance claim; anything shorter says so in its result.

export const TARGETS = Object.freeze({
  integratedLufs: -23, tolerance: 1.0,       // −23 LUFS ± 1.0
  shortTermMaxLufs: -15,                     // short-term (3 s) maximum ≤ −15 LUFS
  truePeakMaxDbtp: -3,                       // true peak ≤ −3 dBTP
  minSeconds: 180,                           // measurement window ≥ 3 minutes
});

export const SUB_BLOCK_SEC = 0.1;            // the 100 ms step; 4 make a gating block, 30 a short-term window
const ABS_GATE = -70, REL_GATE = -10;
const OS = 4, TAPS_PER_PHASE = 16;           // true-peak interpolation: 4×, 16 taps per phase

/** BS.1770's K-weighting at any sample rate (the analog-prototype design libebur128 uses). At 48 kHz
 *  it reproduces the standard's published coefficients to 1e-6 — the self-test checks that. */
export function kWeighting(sampleRate) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / sampleRate);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const pre = {
    b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0],
    a: [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0],
  };
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / sampleRate);
  a0 = 1 + K / Q + K * K;
  const rlb = { b: [1, -2, 1], a: [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
  return { pre, rlb };
}

/** The true-peak interpolator: a Kaiser-windowed sinc cut at the input's Nyquist, split into OS
 *  phases. Each phase is normalised to unity DC gain so a constant reads as itself. */
export function truePeakPhases(os = OS, tapsPerPhase = TAPS_PER_PHASE, beta = 8) {
  const N = os * tapsPerPhase, c = (N - 1) / 2;
  const i0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 40; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; };
  const h = new Float64Array(N);
  for (let m = 0; m < N; m++) {
    const x = (m - c) / os;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const r = (2 * m) / (N - 1) - 1;
    h[m] = sinc * i0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0(beta);
  }
  const phases = [];
  for (let p = 0; p < os; p++) {
    const ph = new Float64Array(tapsPerPhase);
    let s = 0;
    for (let k = 0; k < tapsPerPhase; k++) { ph[k] = h[p + os * k]; s += ph[k]; }
    for (let k = 0; k < tapsPerPhase; k++) ph[k] /= s;
    phases.push(ph);
  }
  return phases;
}

/**
 * The streaming half: feed it blocks of per-channel samples in order (any length — the worklet
 * hands it 128 frames at a time) and it emits one record per COMPLETE 100 ms sub-block:
 *   { sumSq: [per channel Σ K-weighted x²], n, samplePeak, truePeak }   (peaks linear, absolute)
 * Filter and interpolator state carry across calls, so the split points do not matter — the
 * self-test feeds the same signal whole and in 128-frame slices and requires identical results.
 */
export class LoudnessMeter {
  constructor({ sampleRate, channels = 2 }) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.subLen = Math.round(sampleRate * SUB_BLOCK_SEC);
    const { pre, rlb } = kWeighting(sampleRate);
    this.pre = pre; this.rlb = rlb;
    this.phases = truePeakPhases();
    this.T = this.phases[0].length;
    this.state = [];
    for (let c = 0; c < channels; c++) {
      this.state.push({
        x1: 0, x2: 0, y1: 0, y2: 0,        // pre-filter
        u1: 0, u2: 0, z1: 0, z2: 0,        // RLB high-pass
        hist: new Float64Array(this.T * 2), // true-peak history, written twice so a window is contiguous
        hp: 0,
      });
    }
    this.acc = new Float64Array(channels);
    this.n = 0; this.sp = 0; this.tp = 0;
    this.frames = 0;                       // every frame ever fed — counted, so a dropout shows as a difference
  }

  /** @param {Float32Array[]} chans  one array per channel, equal lengths (a missing channel reads as silence) */
  process(chans, out = []) {
    const len = chans[0]?.length ?? 0;
    const { pre, rlb, phases, T, channels } = this;
    const [pb0, pb1, pb2] = pre.b, [, pa1, pa2] = pre.a, [, ra1, ra2] = rlb.a;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < channels; c++) {
        const x = chans[c] ? chans[c][i] : 0;
        const s = this.state[c];
        // K-weighting: shelf, then high-pass ([1, −2, 1] numerator)
        const y = pb0 * x + pb1 * s.x1 + pb2 * s.x2 - pa1 * s.y1 - pa2 * s.y2;
        s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y;
        const z = y - 2 * s.u1 + s.u2 - ra1 * s.z1 - ra2 * s.z2;
        s.u2 = s.u1; s.u1 = y; s.z2 = s.z1; s.z1 = z;
        this.acc[c] += z * z;
        // peaks: the sample itself, and OS interpolated points from the last T samples
        const ax = x < 0 ? -x : x;
        if (ax > this.sp) this.sp = ax;
        s.hp = (s.hp + 1) % T;
        s.hist[s.hp] = x; s.hist[s.hp + T] = x;
        const base = s.hp + T;             // hist[base - k] is x[n - k]
        // ⚠ Not until the history is full: a tap opened mid-signal sees a step from the zeros it
        //   started with, and the interpolator's Gibbs ringing on that step over-read a −6 dBFS
        //   tone by up to 0.4 dB. Steady state, this design reads +0.001 / −0.17 dB to 20 kHz.
        if (this.frames < T) continue;
        for (let p = 0; p < phases.length; p++) {
          const ph = phases[p];
          let v = 0;
          for (let k = 0; k < T; k++) v += ph[k] * s.hist[base - k];
          if (v < 0) v = -v;
          if (v > this.tp) this.tp = v;
        }
      }
      this.frames++;
      if (++this.n === this.subLen) {
        out.push({ sumSq: Array.from(this.acc), n: this.n, samplePeak: this.sp, truePeak: Math.max(this.tp, this.sp) });
        this.acc.fill(0); this.n = 0; this.sp = 0; this.tp = 0;
      }
    }
    return out;
  }
}

const lufsOf = (meanSquareSum) => -0.691 + 10 * Math.log10(Math.max(meanSquareSum, 1e-20));
const db = (lin) => 20 * Math.log10(Math.max(lin, 1e-10));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

/** Loudness of `k` consecutive sub-blocks ending at index `end` (inclusive): Σ_channels mean square. */
function windowPower(subs, end, k) {
  let n = 0;
  const ch = subs[end].sumSq.length, s = new Float64Array(ch);
  for (let j = end - k + 1; j <= end; j++) { n += subs[j].n; for (let c = 0; c < ch; c++) s[c] += subs[j].sumSq[c]; }
  let p = 0;
  for (let c = 0; c < ch; c++) p += s[c] / n;    // channel weight G = 1.0 for L and R
  return p;
}

/**
 * Everything §6 asks for, from a run of sub-blocks. Pure: the gate's Node self-test and the live
 * measure() call this one function.
 * @param {object[]} subs        LoudnessMeter records, in order, with no gaps
 * @param {object}   [o]
 * @param {number}   [o.requestedSec]  what the caller asked for (a short window is reported as such)
 * @param {number}   [o.dropoutFrames] frames the context's clock skipped without rendering them — a
 *                                     realtime render dropout, NOT audio the meter missed (see below)
 * @param {number}   [o.sampleRate]
 */
export function summarise(subs, { requestedSec = null, dropoutFrames = 0, sampleRate = 48000 } = {}) {
  const seconds = subs.length * SUB_BLOCK_SEC;
  const blocks = [];                                  // 400 ms gating blocks, 100 ms step
  let momentaryMax = -Infinity;
  for (let i = 3; i < subs.length; i++) {
    const p = windowPower(subs, i, 4);
    blocks.push(p);
    momentaryMax = Math.max(momentaryMax, lufsOf(p));
  }
  let shortTermMax = -Infinity, shortTermMaxAt = null;
  for (let i = 29; i < subs.length; i++) {
    const l = lufsOf(windowPower(subs, i, 30));
    if (l > shortTermMax) { shortTermMax = l; shortTermMaxAt = r1((i + 1) * SUB_BLOCK_SEC); }
  }
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / Math.max(arr.length, 1);
  const absGated = blocks.filter((p) => lufsOf(p) > ABS_GATE);
  const relThreshold = lufsOf(mean(absGated)) + REL_GATE;
  const gated = absGated.filter((p) => lufsOf(p) > relThreshold);
  const integrated = gated.length ? lufsOf(mean(gated)) : -Infinity;
  const ungated = blocks.length ? lufsOf(mean(blocks)) : -Infinity;
  let tp = 0, sp = 0;
  for (const s of subs) { if (s.truePeak > tp) tp = s.truePeak; if (s.samplePeak > sp) sp = s.samplePeak; }

  const T = TARGETS;
  const long = seconds >= T.minSeconds - 1e-9;
  // ★ A DROPOUT IS NOT A GAP IN THE MEASUREMENT. The tap is in the graph, so it is called for every
  //   quantum the graph renders; what headless Chromium does under a heavy scene is skip ahead —
  //   `currentFrame` jumps (one 16,384-frame jump in a 20 s window, AUD1) and nothing is rendered
  //   for that span, so nothing is produced and nothing is missed. The window is still ≥ 180 s of
  //   real output. Dropouts are reported; past 5 % of the window the render is not representative.
  const dropoutSec = dropoutFrames / sampleRate;
  const steady = dropoutSec <= 0.05 * seconds;
  const checks = {
    integrated: Math.abs(integrated - T.integratedLufs) <= T.tolerance,
    shortTerm: shortTermMax <= T.shortTermMaxLufs,
    truePeak: db(tp) <= T.truePeakMaxDbtp,
  };
  return {
    method: 'BS.1770-4 / EBU R128 — K-weighted per channel, 400 ms blocks at 75 % overlap from gapless 100 ms sub-blocks, gates −70 LUFS abs / −10 LU rel; short-term 3 s; true peak 4× oversampled',
    requestedSec: requestedSec ?? r1(seconds),
    seconds: r1(seconds),
    dropoutSec: r2(dropoutSec),
    integratedLufs: r1(integrated),
    lufs: r1(integrated),                             // the pre-AUD1 name, for callers that read it
    ungatedLufs: r1(ungated),
    shortTermMaxLufs: r1(shortTermMax),
    shortTermMaxAtSec: shortTermMaxAt,
    momentaryMaxLufs: r1(momentaryMax),
    truePeakDbtp: r2(db(tp)),
    samplePeakDbfs: r2(db(sp)),
    gatedBlocks: gated.length, blocks: blocks.length,
    checks,
    // A verdict only when the measurement is one: long enough, and nothing went unsampled.
    conformance: long && steady,
    pass: long && steady && checks.integrated && checks.shortTerm && checks.truePeak,
    note: !long ? `NOT a conformance measurement: ${r1(seconds)} s < ${T.minSeconds} s (loops-docs 10-platform/30 §6)`
        : !steady ? `NOT a conformance measurement: the render dropped ${r1(dropoutSec)} s of the window (> 5 %)`
        : 'conformance window',
  };
}
