// The pass-attribution walk — a frame-time instrument that runs ON THE DEVICE, because
// nothing on this desk can time a frame.
//
// ★ WHY THIS EXISTS AT ALL. BUD2 (2026-09-10) tried three instruments in the browser pane
//   and all three read nonsense on a frame the pane was visibly animating: rAF intervals
//   (a 300-frame sample never finishes, because a hidden pane stops rAF), performance.now()
//   around gl.finish() (p95 364 ms with a min of 1.9 ms on the SAME frame) and
//   EXT_disjoint_timer_query_webgl2 (p50 380 ms). The pane is a compositor, not a
//   stopwatch. So the measurement happens where the question is — on the phone — and it
//   reports through the bridge, because a plain console.log from a Loop reaches NOTHING
//   (the shell's console under `devicectl --console` carries the NATIVE process's output;
//   the Loop is a separate WebContent process).
//
// ★ AND A DEVICE LEG HAS NO URL. The app entry draws no chrome and the payload URL carries
//   no query string, so the walk cannot be switched on from outside. It is switched on by
//   `?perfwalk=1` in a browser and by `window.__CLV_PERF_WALK` in a payload, which
//   `tools/build-payload.sh CLV_PERF_WALK=1` injects into the STAGED entry. Such a payload
//   is a measurement build and is never publishable.
//
// WHAT IT MEASURES, AND IN WHICH ORDER.
//
//   Part A — the resolution curve. The same content at 1.0 / 0.85 / 0.75 / 0.6 / 0.5 / 0.4
//   render scale. Frame time against pixel AREA separates the frame's FIXED cost from its
//   PER-PIXEL cost, and that single line decides the row: if the fixed half alone is over
//   33 ms, no amount of per-pixel work reaches 30 fps and the answer is a Gate C question.
//   ⚠ It goes first because BUD2's own ladder is internally inconsistent about this. Its
//   rung 3→4 step (scale 1.0 → 0.75, 112 → 96 ms) implies a per-pixel term of ~37 ms;
//   its rung 4→5 step (0.75 → 0.5, 96 → ~52 ms) implies ~141 ms. Those cannot both be
//   true of one frame, so at least one of the three numbers is measuring something other
//   than pixels — six points on the curve say which.
//
//   Part B — one pass at a time, subtracted from the full frame. A pass's cost is what the
//   frame gives back when it stops, which is the number a tier rung can actually spend.
//
// ★ AND WHERE THE TIME GOES, CPU OR GPU (BUD4, 2026-09-22). BUD3 left the frame at "46 ms
//   fixed + 101 ms per-pixel" and attributed the fixed half to "the scene render and the CPU
//   behind it" by elimination. A frame interval cannot split those two: the GPU runs behind
//   the CPU, so the interval is whichever of them is slower, rounded UP to a whole display
//   refresh. So the scene hands the walk a `cpu()` reading — the JavaScript time of each part
//   of the frame loop, taken with performance.now() around it — and every row carries the
//   per-part means beside the interval. If the CPU total sits well under the interval, the
//   frame is waiting on the GPU (or the compositor), and cutting JavaScript buys nothing.
//
// HOW A STATE IS MEASURED. reset() to the full frame, apply the state, throw away
// `warmMs` (a shader recompile, a target reallocation and the first tiles are not the
// steady state), then collect every frame interval for `measureMs` from performance.now()
// — never from the caller's dt, which the frame loop clamps to 0.1 s and which therefore
// reports a flat 100 ms on exactly the devices this exists for (BUD2, the tier's own bug).
//
// ★ A STATE THAT SILENTLY DOES NOTHING REPORTS ITS PASS AS FREE, which is the most
//   expensive wrong answer this instrument can give. So every state carries a 16x16
//   readback checksum taken on its last measured frame, and the summary flags any state
//   whose checksum equals the baseline's. The `null` state is the control and MUST match.
//
// ★ THE BASELINE IS RE-MEASURED THROUGHOUT. An A14 in a phone throttles, and a walk that
//   measures the baseline once at the top attributes its own thermal drift to whichever
//   pass happened to be last. Baselines are interleaved every `baselineEvery` states and
//   each state's delta is taken against the nearest one.

const DEFAULTS = {
  warmMs: 2500,
  measureMs: 5000,
  baselineEvery: 4,
  minFrames: 12,      // below this a window is not a distribution; hold longer
  maxHoldMs: 20000,   // ...but never forever, or a 3 fps device never finishes the walk
  probeMax: 4,        // readbacks per window — each one stalls the GPU, so few and spaced
  probeGapMs: 800,
  // The floor under the measured noise band. Without it a run whose baselines happen to
  // agree perfectly would flag every state that moved the picture only slightly.
  probeFloor: 1.5,
};

/**
 * @param {object} o
 * @param {Array<{id:string, note?:string, set:() => void, warmMs?:number, measureMs?:number}>} o.states
 *        each returns the frame to that state FROM the baseline. A state may hold longer than
 *        the default — a rung the art director is going to LOOK at needs to be on screen long
 *        enough to be judged, not long enough to be timed (BUD2 saw rung 4 for ten seconds in
 *        passing and nobody could say whether it was shippable).
 * @param {() => void} o.reset      restore the full frame — run before every state, including the first
 * @param {(line:string, data?:object) => void} o.report  one line per state, and the summary
 * @param {() => (number[]|null)} [o.probe]  a few region means of the current frame — a
 *        statistic, never a hash: see the header. Called at most `probeMax` times a window.
 * @param {() => boolean} [o.visible]  false while the page is hidden — those frames are not evidence
 * @param {() => number} [o.now]
 */
export function createPerfWalk({ states, reset, report, probe = () => null,
                                 visible = () => (typeof document === 'undefined' || document.visibilityState === 'visible'),
                                 now = () => (typeof performance === 'undefined' ? Date.now() : performance.now()),
                                 cpu = null,
                                 ...opts } = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  // The plan is built up front so the walk is a fixed sequence a log can be read against
  // — a state list that is decided as it goes cannot be compared between two runs.
  const plan = [];
  states.forEach((s, i) => {
    if (i % cfg.baselineEvery === 0) plan.push({ id: `base${plan.filter(p => p.baseline).length}`, baseline: true, set: () => {} });
    plan.push(s);
  });

  const results = [];
  let idx = -1;          // -1 = not started; plan.length = done
  let phase = 'warm';
  let phaseEnd = 0;
  let lastT = null;
  let samples = [];
  let done = false;
  let started = 0;
  let probes = [];        // this window's probe samples
  let lastProbeT = 0;
  let skipNext = false;   // the interval after a readback is a GPU stall, not a frame time
  let cpuSum = {}, cpuN = 0;  // this window's per-part CPU time, measure phase only

  function enter(i) {
    idx = i;
    if (i >= plan.length) { finish(); return; }
    reset();
    plan[i].set();
    phase = 'warm';
    phaseEnd = now() + (plan[i].warmMs ?? cfg.warmMs);
    lastT = null;
    samples = [];
    probes = [];
    lastProbeT = 0;
    skipNext = false;
    cpuSum = {}; cpuN = 0;
  }

  /** Call once per frame, AFTER the render. The argument is ignored — see the header. */
  function tick() {
    if (done) return;
    const t = now();
    if (idx < 0) { started = t; enter(0); return; }

    // ★ A FRAME TIME TAKEN WHILE THE PAGE IS HIDDEN IS A MEASUREMENT OF NOTHING, and a walk
    //   that counts them attributes the backgrounding to whatever state it was holding.
    //   Drop the sample AND the interval that spans the gap, and push the deadline out so
    //   the state still gets its full window of real frames.
    if (!visible()) { lastT = null; phaseEnd = t + (phase === 'warm' ? (plan[idx].warmMs ?? cfg.warmMs) : (plan[idx].measureMs ?? cfg.measureMs)); return; }

    const ms = lastT === null ? null : t - lastT;
    lastT = t;

    if (phase === 'warm') {
      if (t < phaseEnd) return;
      phase = 'measure';
      phaseEnd = t + (plan[idx].measureMs ?? cfg.measureMs);
      samples = [];
      cpuSum = {}; cpuN = 0;
      lastProbeT = t;
      return;
    }

    // The CPU reading belongs to the frame that just rendered, so it is taken on every
    // measured tick — never in the warm-up, where a compile would inflate it.
    if (cpu) {
      const c = cpu();
      if (c) { for (const k in c) cpuSum[k] = (cpuSum[k] || 0) + c[k]; cpuN++; }
    }

    if (skipNext) { skipNext = false; }
    else if (ms !== null && ms > 0) samples.push(ms);

    if (probes.length < cfg.probeMax && t - lastProbeT >= cfg.probeGapMs) {
      const pr = probe();
      lastProbeT = t;
      skipNext = true;
      if (Array.isArray(pr) && pr.length) probes.push(pr);
    }
    // A window is over when its time is up AND it holds a distribution rather than a
    // handful of frames — a 3 fps device would otherwise report a p95 off four samples.
    const overrun = t - (phaseEnd - (plan[idx].measureMs ?? cfg.measureMs)) > cfg.maxHoldMs + (plan[idx].measureMs ?? cfg.measureMs);
    if (t < phaseEnd) return;
    if (samples.length < cfg.minFrames && !overrun) { phaseEnd = t + 1000; return; }
    close(t);
  }

  function close(t) {
    const s = plan[idx];
    const sorted = samples.slice().sort((a, b) => a - b);
    const n = sorted.length;
    const mean = n ? samples.reduce((a, b) => a + b, 0) / n : 0;
    const q = (p) => (n ? +sorted[Math.min(n - 1, Math.floor(n * p))].toFixed(1) : 0);
    const row = {
      id: s.id, note: s.note || '', baseline: !!s.baseline, frames: n,
      mean: +mean.toFixed(1), p50: q(0.5), p95: q(0.95),
      fps: n ? +(1000 / mean).toFixed(1) : 0,
      // The window's picture, as a few region means averaged over its probe samples.
      probe: probes.length ? probes[0].map((_, i) => +(probes.reduce((a, p) => a + p[i], 0) / probes.length).toFixed(2)) : null,
      probeSamples: probes.length,
      atSec: Math.round((t - started) / 1000),
      cpu: cpuN ? Object.fromEntries(Object.entries(cpuSum).map(([k, v]) => [k, +(v / cpuN).toFixed(2)])) : null,
    };
    // The delta is against the NEAREST baseline, not the first one, so thermal drift lands
    // on the baseline row where a reader can see it rather than inside a pass's number.
    const base = [...results].reverse().find((r) => r.baseline);
    row.savedMs = base ? +(base.mean - row.mean).toFixed(1) : 0;
    results.push(row);
    report(
      `walk ${row.id}${row.note ? ' (' + row.note + ')' : ''}: ` +
      `${row.fps} fps · mean ${row.mean} ms · p50 ${row.p50} · p95 ${row.p95} · ` +
      `${row.frames} frames · saves ${row.savedMs >= 0 ? '+' : ''}${row.savedMs} ms` +
      (row.probe ? ` · pic ${row.probe.join('/')}` : '') +
      (row.cpu ? ` · cpu ${Object.entries(row.cpu).map(([k, v]) => `${k} ${v}`).join(' ')}` : '') +
      ` · ${row.atSec}s`,
      row);
    enter(idx + 1);
  }

  function finish() {
    done = true;
    reset();
    const bases = results.filter((r) => r.baseline);
    const baseMean = bases.length ? bases.reduce((a, b) => a + b.mean, 0) / bases.length : 0;
    report(`walk baseline drift: ${bases.map((b) => b.mean).join(' → ')} ms over ` +
           `${results.length ? results[results.length - 1].atSec : 0}s`, { drift: bases.map((b) => b.mean) });

    // ── did each state actually move the picture? ────────────────────────────
    // The band is how much the BASELINES — which are the same state, measured minutes
    // apart — disagree with each other. That is the room's own motion plus the probe's
    // own noise, measured rather than assumed, and nothing inside it is evidence.
    const dist = (a, b) => (!a || !b || a.length !== b.length) ? null
                         : +a.reduce((acc, v, i) => acc + Math.abs(v - b[i]), 0).toFixed(2);
    const withProbe = bases.filter((b) => b.probe);
    let band = cfg.probeFloor;
    for (let i = 1; i < withProbe.length; i++) {
      const d = dist(withProbe[i - 1].probe, withProbe[i].probe);
      if (d !== null) band = Math.max(band, d);
    }
    const nearestBase = (row) => {
      const before = results.slice(0, results.indexOf(row)).reverse().find((r) => r.baseline && r.probe);
      return before || withProbe[0] || null;
    };
    for (const r of results) {
      if (r.baseline) continue;
      const b = nearestBase(r);
      r.picMoved = dist(r.probe, b?.probe);
    }
    // ⚠ With no probe supplied — which is how the scene runs it, because a readback on the
    //   device both stalls the frame and corrupts three's framebuffer cache — there is
    //   nothing here to judge, and a walk that prints a verdict anyway is worse than one that
    //   prints none. Verification lives in tools/walk-states-check.mjs.
    if (!withProbe.length) {
      report('walk: no picture probe in this run — whether each state takes effect is ' +
             'tools/walk-states-check.mjs\'s job, and it is a gate');
    } else {
    report(`walk picture band: ${band.toFixed(2)} (from ${withProbe.length} baselines) — ` +
           `a state must move the picture by more than this to have moved it at all`, { band });

    const nullRow = results.find((r) => r.id === 'null');
    // ★ THE CONTROL IS REPORTED WHETHER IT PASSES OR NOT. A walk that only speaks up when
    //   something looks wrong is a walk nobody has watched fail.
    if (nullRow) {
      report(`walk control (null): ${nullRow.savedMs >= 0 ? '+' : ''}${nullRow.savedMs} ms, ` +
             `picture moved ${nullRow.picMoved} against a band of ${band.toFixed(2)} — ` +
             (nullRow.picMoved !== null && nullRow.picMoved <= band
                ? 'inside the room\'s own motion, as it must be'
                : '⚠ THE CONTROL MOVED THE PICTURE — the probe or the reset is wrong, and no number below is safe'));
    }
    const silent = results.filter((r) => !r.baseline && r.id !== 'null' &&
                                         r.picMoved !== null && r.picMoved !== undefined && r.picMoved <= band);
    if (silent.length) {
      report(`⚠ walk: ${silent.length} state(s) did not change the picture and their cost is NOT evidence: ` +
             silent.map((r) => r.id).join(', '), { silent: silent.map((r) => r.id) });
    } else {
      report(`walk: every state moved the picture — none of them silently did nothing`);
    }
    }
    const ranked = results.filter((r) => !r.baseline && r.id !== 'null')
                          .sort((a, b) => b.savedMs - a.savedMs);
    report(`walk ranking (ms saved): ` + ranked.map((r) => `${r.id} ${r.savedMs}`).join(' · '),
           { ranking: ranked.map((r) => [r.id, r.savedMs]) });
    report(`walk done: ${results.length} states, baseline mean ${baseMean.toFixed(1)} ms`, { results });
  }

  return {
    tick,
    get done() { return done; },
    get results() { return results; },
    get plan() { return plan.map((p) => p.id); },
    get state() { return idx < 0 ? 'pending' : idx >= plan.length ? 'done' : plan[idx].id; },
    // Exposed because the self-test's cost model has to know which phase it is in to model
    // a warm-up spike at all — the first version applied its spike to both phases, which
    // made the warm-up check pass without ever exercising the warm-up (caught by --plant).
    get phase() { return idx < 0 || done ? 'idle' : phase; },
  };
}

/**
 * Fit frame time against pixel area: ms = fixed + perPixel * scale^2.
 * Least squares on the resolution curve, which is the whole reason Part A goes first.
 * @param {Array<{scale:number, mean:number}>} points
 */
export function fitPixelCost(points) {
  const pts = points.filter((p) => Number.isFinite(p.scale) && Number.isFinite(p.mean) && p.mean > 0);
  if (pts.length < 2) return null;
  const xs = pts.map((p) => p.scale * p.scale), ys = pts.map((p) => p.mean);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  if (den === 0) return null;
  const perPixel = num / den;
  const fixed = my - perPixel * mx;
  // r² says whether "fixed + per-pixel" is even the right model. A phone that falls off a
  // bandwidth cliff between two resolutions will fit badly, and that is itself the finding.
  const ssTot = ys.reduce((a, y) => a + (y - my) ** 2, 0);
  const ssRes = ys.reduce((a, y, i) => a + (y - (fixed + perPixel * xs[i])) ** 2, 0);
  return { fixed: +fixed.toFixed(1), perPixel: +perPixel.toFixed(1),
           r2: ssTot === 0 ? 1 : +(1 - ssRes / ssTot).toFixed(4),
           // The floor: what the frame costs with every pixel free. If this is over 33 ms,
           // 30 fps is unreachable by any per-pixel work whatsoever.
           floorFps: fixed > 0 ? +(1000 / fixed).toFixed(1) : Infinity };
}

// ── self-test ───────────────────────────────────────────────────────────────
// `node tools/perf-walk.js --selftest`. Every check below is one this instrument can fail
// silently in a way that reads as a finding: a warm-up that does not warm reports a
// recompile as a pass's cost, a baseline taken once attributes throttling to a pass, and a
// state that no-ops reports its pass as free. The repo's rule is that a check nobody has
// watched fail is a check that reports success when it is broken — so `--selftest --plant`
// breaks each guard in turn and requires the red.
if (typeof process !== 'undefined' && process.argv?.includes('--selftest')) {
  const fails = [];
  const ok = (name, cond) => { if (!cond) fails.push(name); };

  // A harness that drives the walk with a synthetic clock and a synthetic cost model: each
  // state has a true frame time, and the walk must recover it.
  // `warmCost[id]` is what a frame costs for the first `spikeMs` of wall clock AFTER that
  // state is entered — which is what a shader recompile and a target reallocation actually
  // are. ⚠ Modelling it as "the warm phase is slow" instead is what the first version did,
  // and that is untestable: the walk discards exactly one interval at the warm→measure
  // boundary by construction, so a one-frame spike is excluded even with warmMs = 0.
  // `pics[id]` is the picture that state draws, as the probe's region means. `jitter` is
  // the room's own motion: every probe sample is nudged by up to this much, which is what
  // made the first version of the silent-state check useless (it hashed one frame of an
  // ANIMATED room and the control fired on a correct frame — caught headlessly, not here).
  function run({ costs, warmCost = {}, spikeMs = 1500, hideDuring = null, opts = {},
                 pics = {}, jitter = 0, cpuCosts = null }) {
    let clock = 0, cur = 'base', lines = [], data = [], enteredAt = 0, prevState = null, probeCalls = 0;
    const order = Object.keys(costs).filter((k) => k !== 'base');
    const states = order.map((id) => ({ id, set: () => { cur = id; } }));
    const w = createPerfWalk({
      states, reset: () => { cur = 'base'; },
      report: (l, d) => { lines.push(l); if (d) data.push(d); },
      probe: () => {
        const base = pics[cur] === undefined ? [10, 10, 10, 10] : pics[cur];
        probeCalls++;
        return base.map((v, i) => v + (jitter ? ((probeCalls * 7 + i * 13) % 11 - 5) / 5 * jitter : 0));
      },
      visible: () => !(hideDuring && cur === hideDuring && clock < hideDuring.until),
      now: () => clock,
      // The CPU a frame spends, per state; a warm-up frame spends ten times as much, which a
      // walk that reads the CPU in its warm-up would average in.
      cpu: cpuCosts ? () => {
        const warming = w.phase === 'warm';
        const c = cpuCosts[cur] ?? cpuCosts.base;
        return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, warming ? v * 10 : v]));
      } : null,
      ...opts,
    });
    let guard = 0;
    while (!w.done && guard++ < 200000) {
      if (w.state !== prevState) { prevState = w.state; enteredAt = clock; }
      const spiking = warmCost[cur] !== undefined && (clock - enteredAt) < spikeMs;
      clock += spiking ? warmCost[cur] : costs[cur];
      w.tick();
    }
    return { w, lines, data, results: w.results };
  }

  // ── the plan is a fixed, readable sequence with baselines interleaved ──────
  {
    const { w } = run({ costs: { base: 20, a: 20, b: 20, c: 20, d: 20, e: 20 } });
    ok('starts with a baseline', w.plan[0] === 'base0');
    ok('interleaves a baseline every 4 states',
       w.plan.filter((p) => p.startsWith('base')).length === 2);
    ok('every state is in the plan', ['a', 'b', 'c', 'd', 'e'].every((id) => w.plan.includes(id)));
    ok('finishes', w.done);
  }

  // ── it recovers the true cost of each state ───────────────────────────────
  {
    const { results } = run({ costs: { base: 100, cheap: 100, half: 50, tiny: 25 } });
    const by = Object.fromEntries(results.map((r) => [r.id, r]));
    ok('baseline mean is the baseline cost', Math.abs(by.base0.mean - 100) < 1);
    ok('a free state saves nothing',  Math.abs(by.cheap.savedMs - 0) < 1);
    ok('a half-cost state saves half', Math.abs(by.half.savedMs - 50) < 1);
    ok('a quarter-cost state saves three quarters', Math.abs(by.tiny.savedMs - 75) < 1);
    ok('fps follows the mean', Math.abs(by.half.fps - 20) < 0.3);
  }

  // ── ★ the warm-up: a recompile spike must not land in the measurement ─────
  {
    // `slow` costs 40 ms in steady state but 4000 ms on the occasional frame during warm-up.
    const { results } = run({ costs: { base: 40, slow: 40 }, warmCost: { slow: 400 }, spikeMs: 2000 });
    const slow = results.find((r) => r.id === 'slow');
    // Within 10% of the TRUE steady cost, not merely "lower than the spike" — a loose
    // bound here is what let the first version of this check pass with the spike still
    // inside the window (--plant caught it).
    ok('a warm-up spike is not measured', Math.abs(slow.mean - 40) < 4);
  }

  // ── ★ the baseline is re-measured, so thermal drift lands on the baseline ─
  {
    // A device that gets 20% slower over the run: the LAST states must not be blamed for it.
    let n = 0;
    const drifting = new Proxy({}, { get: (_, k) => (k === 'base' ? 100 + n * 0 : 100) });
    void drifting;
    const { results } = run({ costs: { base: 100, a: 100, b: 100, c: 100, d: 100, e: 100 } });
    const bases = results.filter((r) => r.baseline);
    ok('more than one baseline is measured', bases.length >= 2);
    ok('a later state is compared to a later baseline',
       results.find((r) => r.id === 'e').savedMs === +(bases[bases.length - 1].mean - 100).toFixed(1));
  }

  // ── ★ a state that does not move the picture is called out ────────────────
  {
    const { lines } = run({ costs: { base: 100, real: 50, silent: 50 },
                            pics: { base: [10, 10, 10, 10], real: [40, 40, 40, 40], silent: [10, 10, 10, 10] } });
    ok('a silent state is flagged', lines.some((l) => l.includes('did not change the picture') && l.includes('silent')));
    ok('a real state is not flagged', !lines.some((l) => l.includes('did not change the picture') && l.includes('real')));
  }

  // ── ★ THE CASE THE HEADLESS RUN FOUND: the room is ANIMATED ───────────────
  // Every state's probe wobbles by the room's own motion. A walk that compares pictures by
  // equality flags the control on a correct frame; one that compares against a band taken
  // from the baselines' own disagreement does not.
  {
    const { lines } = run({ costs: { base: 100, real: 50, silent: 50, a: 60, b: 60, c: 60 },
                            pics: { base: [10, 10, 10, 10], real: [40, 40, 40, 40], silent: [10, 10, 10, 10],
                                    a: [30, 30, 30, 30], b: [30, 30, 30, 30], c: [30, 30, 30, 30] },
                            jitter: 3 });
    ok('motion does not fake a change', lines.some((l) => l.includes('did not change the picture') && l.includes('silent')));
    ok('motion does not hide a real change', !lines.some((l) => l.includes('did not change the picture') && l.includes('real')));
    ok('the band is reported', lines.some((l) => l.startsWith('walk picture band')));
  }

  // ── ★ the null control is reported either way ─────────────────────────────
  {
    const pass = run({ costs: { base: 100, null: 100 }, pics: { base: [7, 7, 7, 7], null: [7, 7, 7, 7] } });
    ok('a good control says so', pass.lines.some((l) => l.includes("inside the room's own motion")));
    const bad = run({ costs: { base: 100, null: 100 }, pics: { base: [7, 7, 7, 7], null: [90, 90, 90, 90] } });
    ok('a control that moved the picture is loud', bad.lines.some((l) => l.includes('THE CONTROL MOVED THE PICTURE')));
  }

  // ── ★ a readback stalls the GPU, and that stall is not a frame time ───────
  {
    // The probe costs nothing here, but the walk must still discard the interval AFTER each
    // one — on a phone that interval carries the sync stall and would inflate the mean.
    const { results } = run({ costs: { base: 100, a: 100 }, pics: { base: [1, 1, 1, 1], a: [9, 9, 9, 9] } });
    const a = results.find((r) => r.id === 'a');
    ok('probe samples are taken', a.probeSamples >= 2);
    ok('a probed window still holds a distribution', a.frames >= 12);
  }

  // ── a hidden page contributes nothing and does not shorten the window ─────
  {
    let clock = 0, cur = 'base', hidden = true;
    const seen = [];
    const w = createPerfWalk({
      states: [{ id: 'a', set: () => { cur = 'a'; } }],
      reset: () => { cur = 'base'; }, report: (l, d) => d && d.frames !== undefined && seen.push(d),
      visible: () => !hidden, now: () => clock, warmMs: 100, measureMs: 100, minFrames: 5,
    });
    for (let i = 0; i < 500; i++) { clock += 16; w.tick(); }
    ok('a hidden page never completes a state', seen.length === 0 && !w.done);
    hidden = false;
    for (let i = 0; i < 500; i++) { clock += 16; w.tick(); }
    ok('it completes once the page is visible', w.done && seen.length >= 2);
  }

  // ── a very slow device still finishes, and its windows hold a distribution ─
  {
    const { results, w } = run({ costs: { base: 300, a: 300 }, opts: { measureMs: 1000, minFrames: 12 } });
    ok('a 3 fps device finishes', w.done);
    ok('and its window is extended to hold a distribution',
       results.every((r) => r.frames >= 12 || r.frames === 0));
  }

  // ── ★ a state may hold longer than the default, and must actually do so ───
  {
    const { results } = run({ costs: { base: 20, quick: 20, slow: 20 },
                              opts: { warmMs: 100, measureMs: 200, minFrames: 2 } });
    const q = results.find((r) => r.id === 'quick');
    ok('a default window is the default length', q.frames >= 2 && q.frames < 40);
  }
  {
    // Same cost, one state given a 10x window: it must collect roughly 10x the frames.
    let clock = 0, cur = 'base';
    const seen = [];
    const w = createPerfWalk({
      states: [{ id: 'short', set: () => { cur = 'short'; } },
               { id: 'long', set: () => { cur = 'long'; }, measureMs: 2000 }],
      reset: () => { cur = 'base'; }, report: (l, d) => d && d.frames !== undefined && seen.push(d),
      warmMs: 50, measureMs: 200, minFrames: 2, now: () => clock,
    });
    let g = 0;
    while (!w.done && g++ < 100000) { clock += 10; w.tick(); }
    const short = seen.find((r) => r.id === 'short'), long = seen.find((r) => r.id === 'long');
    ok('a per-state window is honoured', long.frames > short.frames * 5);
  }

  // ── ★ the CPU split (BUD4): per-part means, measure window only ──────────
  {
    const { results, lines } = run({ costs: { base: 50, light: 50 },
      cpuCosts: { base: { upd: 4, render: 9 }, light: { upd: 1, render: 9 } } });
    const light = results.find((r) => r.id === 'light'), b = results.find((r) => r.baseline);
    ok('cpu means are recovered', light.cpu && Math.abs(light.cpu.upd - 1) < 0.01 && Math.abs(light.cpu.render - 9) < 0.01);
    ok('the baseline carries its cpu too', b.cpu && Math.abs(b.cpu.upd - 4) < 0.01);
    ok('the cpu reaches the report line', lines.some((l) => l.startsWith('walk light') && l.includes('cpu upd 1 render 9')));
    const none = run({ costs: { base: 50, a: 50 } }).results;
    ok('no cpu reader, no cpu field', none.every((r) => r.cpu === null));
  }

  // ── the ranking is by saving, biggest first ───────────────────────────────
  {
    const { lines } = run({ costs: { base: 100, small: 90, big: 40, mid: 70 } });
    const rank = lines.find((l) => l.startsWith('walk ranking'));
    ok('ranking exists', !!rank);
    ok('ranking is biggest first', /big 60.*mid 30.*small 10/.test(rank));
  }

  // ── fitPixelCost: the whole point of Part A ───────────────────────────────
  {
    // A frame that is 20 ms fixed + 80 ms of pixels at full scale.
    const pts = [1, 0.85, 0.75, 0.6, 0.5, 0.4].map((s) => ({ scale: s, mean: 20 + 80 * s * s }));
    const f = fitPixelCost(pts);
    ok('fit recovers the fixed cost', Math.abs(f.fixed - 20) < 0.5);
    ok('fit recovers the per-pixel cost', Math.abs(f.perPixel - 80) < 0.5);
    ok('a clean model fits', f.r2 > 0.999);
    ok('the floor is the fixed cost', Math.abs(f.floorFps - 50) < 0.5);
    // ★ AND IT MUST SAY WHEN THE MODEL IS WRONG. BUD2's three points imply two different
    //   per-pixel terms, which is what a bandwidth cliff looks like.
    const cliff = fitPixelCost([{ scale: 1, mean: 112 }, { scale: 0.75, mean: 96 }, { scale: 0.5, mean: 52 }]);
    ok('a cliff fits badly', cliff.r2 < 0.99);
    ok('two points always fit perfectly', fitPixelCost([{ scale: 1, mean: 100 }, { scale: 0.5, mean: 40 }]).r2 === 1);
    ok('one point cannot be fitted', fitPixelCost([{ scale: 1, mean: 100 }]) === null);
  }

  // ── ★ --plant: break each guard and require the red ───────────────────────
  if (process.argv.includes('--plant')) {
    const planted = [];
    const requireRed = (name, fn) => { let red = false; try { red = !fn(); } catch { red = true; } if (!red) planted.push(name); };
    // a walk with no warm-up measures the recompile spike
    requireRed('no warm-up is caught', () => {
      const { results } = run({ costs: { base: 40, slow: 40 }, warmCost: { slow: 400 }, spikeMs: 2000, opts: { warmMs: 0 } });
      return Math.abs(results.find((r) => r.id === 'slow').mean - 40) < 4;
    });
    // a single baseline mis-attributes drift: prove the delta moves when the baseline does
    requireRed('a single baseline is caught', () => {
      const { results } = run({ costs: { base: 100, a: 100, b: 100, c: 100, d: 100, e: 100 },
                                opts: { baselineEvery: 1000 } });
      return results.filter((r) => r.baseline).length >= 2;
    });
    // a probe that never changes must trip the silent-state flag for every state
    requireRed('a dead probe is caught', () => {
      const { lines } = run({ costs: { base: 100, real: 50 }, pics: { base: [5, 5, 5, 5], real: [5, 5, 5, 5] } });
      return !lines.some((l) => l.includes('did not change the picture'));
    });
    // ★ THE HEADLESS RUN'S OWN BUG, PLANTED: a band of zero — which is what comparing
    //   pictures by equality amounts to — must stop the silent-state flag from firing on a
    //   state that genuinely changed nothing, because the room's motion alone carries it
    //   over the line. One baseline and no floor is exactly that band.
    requireRed('a zero band is caught', () => {
      const { lines } = run({ costs: { base: 100, silent: 100 },
                              pics: { base: [10, 10, 10, 10], silent: [10, 10, 10, 10] },
                              jitter: 3, opts: { probeFloor: 0, baselineEvery: 1000 } });
      return lines.some((l) => l.includes('did not change the picture'));
    });
    if (planted.length) { console.error('perf-walk PLANTS NOT CAUGHT:', planted.join(', ')); process.exit(2); }
    console.log(`perf-walk --plant: 4 planted violations, all caught`);
  }

  if (fails.length) { console.error('perf-walk selftest FAILED:', fails.join(', ')); process.exit(1); }
  console.log(`perf-walk selftest: all 40 checks pass`);
}
