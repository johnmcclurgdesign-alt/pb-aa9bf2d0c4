// Device tiers, and a step-down the device earns rather than one a table hands it.
//
// ★ THE BRIDGE DOES NOT TELL A WEB LOOP WHAT IT IS RUNNING ON. Bridge v1 injects
//   bridgeVersion / on / ready / log / error / cameraChanged and no platform field, and v2
//   does not add one. So the class comes from `navigator` and GL introspection, and it is
//   a guess — which is why nothing here is allowed to depend on it being right: the class
//   only chooses a STARTING level, and the frame rate decides the rest.
//
// ★ AND A SIGNED-OFF PRESET CANNOT BE MEASURED ON THE MACHINE THAT WROTE IT. There is no
//   phone in this build environment and the browser pane cannot time a frame (three
//   instruments tried; see the BUD2 handoff). A ladder the device walks down on its own
//   evidence is the only version of this that can be trusted on hardware nobody here has.
//
// ── THE LADDER, RE-FITTED AGAINST THE DEVICE (BUD3, 2026-09-13) ─────────────
//
// ★ THE FIRST LADDER WAS ORDERED BY WHAT THE ART DIRECTOR WOULD MISS LEAST, WHICH IS THE RIGHT
//   PRINCIPLE APPLIED TO A GUESS ABOUT THE COSTS. Measured on the iPhone 12 Pro at the room
//   pose (693x390 CSS, dpr 3, baseline 146.8 ms = 6.8 fps), one state at a time, against
//   interleaved baselines that held to +/-1%:
//
//     hard shadows (no PCSS)      46.7 ms   32% of the frame     <- the biggest single lever
//     the sun stops casting       26.5 ms   18%
//     the 2nd shadow light off    25.6 ms   17%
//     AO at half resolution       23.5 ms   16%
//     PCSS at 8/12 taps           19.9 ms   14%
//     AO denoise 16 -> 1          16.3 ms   11%
//     the shafts off              14.9 ms   10%
//     GI trilinear (4 reads)      10.9 ms    7%
//     the shafts at 24 steps       4.7 ms    3%
//     SMAA off                     2.0 ms    1%
//     GI intensity 0 / lens off    0.3 ms    0%
//     the flare pass off          -1.3 ms    0%   (gated dark at this pose; free)
//     the film grain off          -0.3 ms    0%
//
//   Two of the old ladder's three content rungs were spending a look change for almost
//   nothing, and the thing worth 32% of the frame was not in it at all.
//
// ★ AND THE SHADOW LEVERS OVERLAP ALMOST COMPLETELY. Hard shadows removes the PCSS taps for
//   BOTH lights, so "the second shadow light off" is worth ~2.7 ms AFTER it (its shadow-map
//   render, nothing more) rather than the 25.6 ms it is worth alone. That is why skyShadow
//   has left the automatic ladder: it flattens the grounding under the props, and once rung 1
//   is in it buys under 2% of the frame. The capability stays — a tier hides, it does not
//   delete — it is simply not a rung.
//
// ★ RUNG 5 IS IN THE AUTOMATIC LADDER NOW. It was refused on 2026-09-10 for "flecks of
//   flicker on the bricks". That flicker was the FILM GRAIN, sampled at the render buffer's
//   size and upscaled into 2x2 blocks — not, as recorded, a dither in the AO and the edge
//   pass. It is compensated in tools/lens.js and the art director signed both halves on the
//   device on 2026-09-13: flicker "gone", softness "acceptable".
//
//   0  full        everything as art-directed
//   1  hard        PCSS off — one plain shadow compare. 46.7 ms, and on a 693 px frame the
//                  penumbra it gives up is close to invisible
//   2  AO half     n8ao at half resolution. 23.5 ms
//   3  shafts off  the raymarched light shafts stop. 14.9 ms, and #4 of what carries the look
//   4  0.75x       render scale — the first rung about PIXELS rather than content
//   5  0.5x        render scale, a quarter of the pixels
//
// ⚠ WHAT THE LADDER CANNOT REACH, AND WHY THAT IS THE ROW'S FINDING. The same three points
//   that fit the resolution curve (1.00 -> 146.8, 0.75 -> 104.5, 0.50 -> 71.3 ms) decompose the
//   frame into **46 ms fixed + 101 ms per-pixel**. The fixed half is a **21.7 fps ceiling with
//   every pixel free**, so no rung here and no resolution reaches 30 fps on an A14. The whole
//   ladder lands somewhere near 20. That is a Gate C question, not a dial.
//
// Levels 1 and above also start there: a phone never pays the full price once, because
// the first seconds are the worst ones (uploads, compiles) and a stutter then is what a
// viewer remembers.

const SAMPLES = 90;        // frames per verdict — 3 s at 30 fps
const STEP_DOWN_MS = 28;   // mean frame time above this and the level drops (30 fps = 33.3)
// ★ THE TIER OWNS ITS OWN CLOCK, AND THE FIRST CUT DID NOT — WHICH BLINDED IT TO EXACTLY
//   THE DEVICE IT EXISTS FOR. The frame loop clamps dt to 0.1 s (so one slow frame back
//   from a background tab cannot teleport the camera), so ANY device below 10 fps reports
//   a flat 100 ms for every frame. The ladder's "is this dt believable" guard rejected
//   anything over 99 ms — meaning a phone at 8 fps fed it nothing at all, never reached a
//   verdict, and sat on rung 1 forever. Measured on the device: one report in 101 s, p50 =
//   p95 = worst = 96 ms, because a single frame squeaked under the bar. Both halves were
//   individually reasonable and together they were blind.
//   So: intervals come from performance.now() here, never from the caller's dt, and the
//   sanity cap is 2 s — high enough that a real stall is DATA rather than noise, low
//   enough that a resumed tab is still discarded. document.visibilityState remains the
//   guard that matters.
const MAX_SANE_MS = 2000;
// ★ THE LADDER RUNS TO 5. It stopped at 4 from 2026-09-10 to 2026-09-13, because rung 5 was
//   refused on the picture — "a static quality over the materials, flecks of flicker on the
//   bricks". The cause was found and fixed at BUD3: the film grain is sampled at the RENDER
//   buffer's size, so half scale delivered every fleck as a 2x2 block. Compensated in
//   tools/lens.js (uGrainScale), measured back onto the full-resolution figure, and signed on
//   the device on 2026-09-13 — flicker "gone", softness "acceptable". It is worth ~33 ms on
//   top of rung 4 and it is the largest lever left, so it is automatic now.
const MAX_LEVEL = 5;
// ★ A DEVICE LEG HAS NOWHERE TO PUT A FRAME COUNTER. The app entry draws no chrome, the
//   payload URL carries no query string, and the evidence a leg actually collects is the
//   shell's console. So the frame rate is REPORTED there, on a wall clock, for the first
//   two minutes — which is exactly the window a leg watches — and then it goes quiet.
//   Wall clock, not a frame count: on the device this is measuring, frames are the thing
//   that might be scarce, and a report every N frames arrives late precisely when it is
//   most wanted (the same defect as the return control's fade, DP-W2).
const REPORT_EVERY_MS = 10000;
const REPORT_FOR_MS = 120000;
// ★ A MEAN CANNOT SAY WHETHER A FRAME RATE IS SMOOTH, AND SMOOTHNESS IS THE GATE (PROGRAM
//   decision 16, 2026-09-13: "smooth visual performance trumps a specific number"). On a
//   60 Hz display a frame is on screen for a WHOLE number of refreshes, so the only steady
//   rates are 30 (2 refreshes), 20 (3) and 15 (4); a mean of 24 is 2s and 3s alternating,
//   which is an uneven cadence however good the average looks. So every report also carries
//   the CADENCE — how the frames fall into refresh counts — plus two judder figures:
//     hitches: frames held at least one refresh longer than the window's median frame
//     jumps:   consecutive frames whose refresh counts differ, i.e. the cadence changing
//   A steady 20 reads 3v:100% with 0 jumps; a free-running 24 reads ~2v:50% 3v:50% with
//   jumps near half the frames. (BUD4, 2026-09-22.)
const REFRESH_MS = 1000 / 60;
// ★ A BLACK FLASH WITH NO FRAME GAP BEHIND IT IS THE COMPOSITOR, NOT THE LOOP (#142). So any
//   interval over this is reported the moment it happens, with its time, for the whole
//   session and not only the first two minutes — the flashes were reported "throughout".
//   Capped, so a device that stalls constantly cannot flood the bridge.
const STALL_MS = 250;
const STALL_REPORTS_MAX = 40;

/** Cadence of a list of frame intervals on a 60 Hz display. Exported for the self-test. */
export function cadenceOf(intervals, refreshMs = REFRESH_MS) {
  const v = intervals.map((ms) => Math.max(1, Math.round(ms / refreshMs)));
  const n = v.length;
  if (!n) return { hist: {}, hitches: 0, jumps: 0 };
  const hist = {};
  for (const k of v) { const b = k >= 5 ? '5+' : String(k); hist[b] = (hist[b] || 0) + 1; }
  const med = v.slice().sort((a, b) => a - b)[Math.floor(n / 2)];
  let hitches = 0, jumps = 0;
  for (let i = 0; i < n; i++) {
    if (v[i] > med) hitches++;
    if (i && v[i] !== v[i - 1]) jumps++;
  }
  return { hist, hitches, jumps, medianRefreshes: med };
}

/** A guess at the device class. Never load-bearing — it only picks where the ladder starts. */
export function detectClass(o = {}) {
  const ua = o.ua ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const touch = o.touch ?? (typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints || 0);
  const w = o.w ?? (typeof screen === 'undefined' ? 1920 : screen.width);
  const h = o.h ?? (typeof screen === 'undefined' ? 1080 : screen.height);
  if (/AppleTV|tvOS|CrKey|SmartTV|Web0S|Tizen/i.test(ua)) return 'tv';
  if (/iPhone|iPod/i.test(ua)) return 'phone';
  if (/iPad/i.test(ua)) return 'tablet';
  // ★ AN iPad IN ITS DEFAULT MODE CALLS ITSELF A Macintosh. Touch points is the tell:
  //   a Mac reports 0, an iPad reports 5. Getting this wrong gives an iPad the desktop
  //   ladder, which is survivable, or a Mac the phone ladder, which is not.
  if (/Macintosh/i.test(ua) && touch > 1) return 'tablet';
  if (/Android/i.test(ua)) return Math.min(w, h) < 600 ? 'phone' : 'tablet';
  return 'desktop';
}

const START = { desktop: 0, tv: 1, tablet: 0, phone: 1 };

// ★ AN A14 PHONE STARTS AT THE BOTTOM, BECAUSE IT ALWAYS ENDS THERE (BUD4, 2026-09-22). Every
//   device run on the iPhone 12 Pro — BUD3's two windows, BUD4's W0 — walked 1 -> 5 and stayed,
//   and the walk down is the worst ~40 s a viewer sees: 7-15 fps frames on rungs 1-4, then a
//   1,083 ms stall when rung 2 reallocates the AO's targets (measured W0, 27.6 s in). The shell
//   now names the GPU (bridge v3 `collectivus.device.gpuFamily`, 'apple7' on an A14), so the
//   start can follow the evidence instead of the class: a phone at apple7 or below starts at
//   the floor. A newer phone — apple8 and up, or a shell that does not say — still starts at 1
//   and walks, because nothing measured it.
// ★ AND SO DOES AN apple7 iPad (BUD4 W3, 2026-09-23). The iPad Pro 12.9" (M1, the shell's
//   tier=tablet gpuFamily=apple7) started at rung 0 at 5.1 fps and took ~75 s to walk to 5, where
//   it holds 25.3 fps (p50 39 ms, p95 41). The first minute of that is the worst thing a viewer
//   of that iPad sees. Every lesser apple7-or-below iPad is slower, never faster.
export function startLevel(cls, gpuFamily) {
  const fam = /^apple(\d+)$/.exec(gpuFamily || '');
  if ((cls === 'phone' || cls === 'tablet') && fam && +fam[1] <= 7) return MAX_LEVEL;
  return START[cls] ?? 0;
}

/**
 * @param {object} o
 * @param {string} [o.forced]     'phone' | 'tablet' | 'desktop' | 'tv' from ?tier=
 * @param {number} [o.pinned]     a level from ?tierlevel=, which also stops the ladder
 * @param {function} o.apply      (level) => void — the scene applies what the level means
 */
export function createPerfTier({ forced, pinned, start, apply, report, onStall, now = () => (typeof performance === 'undefined' ? Date.now() : performance.now()) } = {}) {
  const cls = forced || detectClass();
  let level = Number.isFinite(pinned) ? pinned : Number.isFinite(start) ? start : (START[cls] ?? 0);
  const locked = Number.isFinite(pinned);
  let acc = [], settled = locked;
  const t0 = now();
  let nextReport = t0 + REPORT_EVERY_MS, rep = [];
  let lastTick = t0;
  let stalls = 0;
  apply(level);

  /** Call once per frame. The argument is ignored — see MAX_SANE_MS above. */
  function tick() {
    const t = now();
    const ms = t - lastTick;
    lastTick = t;
    // ★ A FRAME TIME TAKEN WHILE THE PAGE IS HIDDEN IS A MEASUREMENT OF NOTHING. rAF stops,
    //   the next interval is however long the tab was away, and the ladder would walk
    //   itself to the bottom on a backgrounded tab — the viewer then comes back to the
    //   cheapest version of the room for no reason at all.
    const usable = ms > 0 && ms <= MAX_SANE_MS &&
                   (typeof document === 'undefined' || document.visibilityState === 'visible');
    reportTick(usable ? ms : 0);
    if (onStall && usable && ms > STALL_MS && stalls < STALL_REPORTS_MAX) {
      stalls++;
      onStall({ ms: +ms.toFixed(0), atSec: +((t - t0) / 1000).toFixed(1), level });
    }
    if (settled || level >= MAX_LEVEL) return;
    if (!usable) { acc = []; return; }
    acc.push(ms);
    if (acc.length < SAMPLES) return;
    const mean = acc.reduce((a, b) => a + b, 0) / acc.length;
    acc = [];
    if (mean > STEP_DOWN_MS) { level++; apply(level); }
    else settled = true;   // it is fast enough here; stop touching the look
  }

  function reportTick(ms) {
    if (!report) return;
    const t = now();
    if (t - t0 > REPORT_FOR_MS) { report = null; rep = []; return; }
    if (ms > 0) rep.push(ms);
    if (t < nextReport) return;
    nextReport = t + REPORT_EVERY_MS;
    if (!rep.length) return;
    const sorted = rep.slice().sort((a, b) => a - b);
    const mean = rep.reduce((a, b) => a + b, 0) / rep.length;
    const cad = cadenceOf(rep);
    report({ cls, level, frames: rep.length, fps: +(1000 / mean).toFixed(1),
             cadence: cad.hist, hitches: cad.hitches, jumps: cad.jumps,
             p50: +sorted[Math.floor(sorted.length * 0.5)].toFixed(1),
             p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
             worst: +sorted[sorted.length - 1].toFixed(1),
             sinceOpenSec: Math.round((t - t0) / 1000) });
    rep = [];
  }

  return { tick, get level() { return level; }, get cls() { return cls; },
           get settled() { return settled; }, locked };
}

// ── self-test ───────────────────────────────────────────────────────────────
// `node tools/perf-tier.js --selftest`. The ladder is three lines of arithmetic and one
// guard, and every one of them is the kind that fails silently in the picture rather than
// in a log: a tier that never steps down looks like a slow phone, one that steps down on a
// hidden tab looks like the room getting cheaper for no reason.
if (typeof process !== 'undefined' && process.argv?.includes('--selftest')) {
  const fails = [];
  const ok = (name, cond) => { if (!cond) fails.push(name); };

  // class detection, including the iPad that calls itself a Macintosh
  ok('mac is desktop',      detectClass({ ua: 'X (Macintosh; Intel Mac OS X)', touch: 0 }) === 'desktop');
  ok('ipad in desktop mode',detectClass({ ua: 'X (Macintosh; Intel Mac OS X)', touch: 5 }) === 'tablet');
  ok('iphone',              detectClass({ ua: 'X (iPhone; CPU iPhone OS 26_6)', touch: 5 }) === 'phone');
  ok('appletv',             detectClass({ ua: 'X (AppleTV; tvOS 26)', touch: 0 }) === 'tv');
  ok('small android',       detectClass({ ua: 'X (Linux; Android 14)', touch: 5, w: 412, h: 915 }) === 'phone');
  ok('large android',       detectClass({ ua: 'X (Linux; Android 14)', touch: 5, w: 1200, h: 1920 }) === 'tablet');

  // ★ THE LADDER READS A CLOCK, NOT THE CALLER'S dt, so the harness has to drive a clock.
  //   The first version of this self-test fed dt values and passed — against the version of
  //   tick() that trusted them, which is the version the phone proved blind.
  const run = (opts, intervals) => {
    const seen = [];
    let clock = 0;
    const t = createPerfTier({ ...opts, apply: (l) => seen.push(l), now: () => clock });
    intervals.forEach((ms) => { clock += ms; t.tick(); });
    return { level: t.level, seen, settled: t.settled };
  };
  const many = (n, ms) => Array.from({ length: n }, () => ms);

  // a phone starts on rung 1 and stays there when the frames are quick
  ok('fast phone settles at 1', run({ forced: 'phone' }, many(SAMPLES, 16)).level === 1);
  // slow frames walk it down one rung per verdict, and it stops at the bottom
  ok('slow phone steps to 2',   run({ forced: 'phone' }, many(SAMPLES, 50)).level === 2);
  ok('slow phone steps to 3',   run({ forced: 'phone' }, many(SAMPLES * 2, 50)).level === 3);
  ok('the ladder has a floor',  run({ forced: 'phone' }, many(SAMPLES * 10, 50)).level === MAX_LEVEL);
  // ★ THE FLOOR MOVED FROM 4 TO 5 ON 2026-09-13, when the flicker that got rung 5 refused was
  //   found to be the film grain and fixed. Pin the number rather than only comparing to the
  //   constant, or the day someone edits MAX_LEVEL this test agrees with them silently.
  ok('the floor is rung 5',     MAX_LEVEL === 5);
  ok('a slow phone reaches half resolution',
     run({ forced: 'phone' }, many(SAMPLES * 12, 200)).level === 5);
  // ★ AND IT STILL HAS TO WALK THERE ONE RUNG AT A TIME. A ladder that jumps to the bottom on
  //   the first bad verdict shows the viewer the cheapest room before trying anything else.
  ok('one rung per verdict',    run({ forced: 'phone' }, many(SAMPLES, 50)).seen.length === 2);
  // ★ the guard that matters: a hidden page, a stalled tab and a paused Loop all arrive as
  //   junk dt, and none of them is evidence about the device
  ok('a resumed tab moves nothing', run({ forced: 'phone' }, many(SAMPLES * 4, 9000)).level === 1);
  ok('a stopped clock moves nothing', run({ forced: 'phone' }, many(SAMPLES * 4, 0)).level === 1);
  // ★ THE CASE THE PHONE FOUND: the frame loop clamps dt to 0.1 s, so a device below 10 fps
  //   reported a flat 100 ms and the old "believable dt" guard threw all of it away. A
  //   genuinely slow device MUST reach the bottom rung.
  ok('8 fps walks to the floor', run({ forced: 'phone' }, many(SAMPLES * 8, 125)).level === MAX_LEVEL);
  ok('4 fps walks to the floor', run({ forced: 'phone' }, many(SAMPLES * 8, 250)).level === MAX_LEVEL);
  // a pin is a pin: it applies the level and refuses to move
  ok('pinned stays pinned',     run({ forced: 'phone', pinned: 3 }, many(SAMPLES * 4, 50)).level === 3);
  ok('pinned 0 stays 0',        run({ forced: 'phone', pinned: 0 }, many(SAMPLES * 4, 50)).level === 0);
  // desktop starts at full and a slow desktop still steps down — a weak laptop is a device too
  ok('desktop starts full',     run({ forced: 'desktop' }, many(4, 16)).level === 0);
  ok('slow desktop steps down', run({ forced: 'desktop' }, many(SAMPLES, 50)).level === 1);
  // apply() is called once at construction, so the scene is never left in an unset state
  ok('apply runs at start',     run({ forced: 'phone' }, []).seen.length === 1);

  // the console reporter: wall clock, bounded, and silent on a page nobody is looking at
  {
    let clock = 0;
    const lines = [];
    const t = createPerfTier({ forced: 'phone', pinned: 1, apply: () => {},
                               report: (r) => lines.push(r), now: () => clock });
    for (let i = 0; i < 60; i++) { clock += 33; t.tick(); }   // ~2 s: nothing yet
    ok('quiet before the first window', lines.length === 0);
    for (let i = 0; i < 300; i++) { clock += 33; t.tick(); }  // ~10 s more
    ok('reports once a window', lines.length >= 1);
    ok('reports a believable fps', Math.abs(lines[0].fps - 30.3) < 0.5);
    ok('reports the level it is on', lines[0].level === 1);
    const before = lines.length;
    clock += 200000;                                               // past the two-minute window
    for (let i = 0; i < 400; i++) { clock += 33; t.tick(); }
    ok('goes quiet after two minutes', lines.length === before);
  }

  // ★ THE CADENCE (BUD4). A mean of 24 fps is the case this exists for: it must read as an
  //   uneven cadence, and a steady 20 — a LOWER mean — must read as perfectly even.
  {
    const steady20 = cadenceOf(many(60, 50));
    ok('a steady 20 is all 3-refresh frames', steady20.hist['3'] === 60 && Object.keys(steady20.hist).length === 1);
    ok('a steady 20 has no jumps and no hitches', steady20.jumps === 0 && steady20.hitches === 0);
    const lumpy24 = cadenceOf(Array.from({ length: 60 }, (_, i) => (i % 2 ? 50 : 33.3)));
    ok('a lumpy 24 is half 2s, half 3s', lumpy24.hist['2'] === 30 && lumpy24.hist['3'] === 30);
    ok('a lumpy 24 changes cadence every frame', lumpy24.jumps === 59);
    // a steady 30 with two dropped frames: two hitches, four jumps (in and out of each)
    const hitchy30 = cadenceOf([...many(20, 33.3), 66.7, ...many(20, 33.3), 83.3, ...many(20, 33.3)]);
    ok('a dropped frame is a hitch', hitchy30.hitches === 2 && hitchy30.jumps === 4);
    ok('a long stall lands in 5+', hitchy30.hist['5+'] === 1);
    // ★ and the reporter carries it, or none of the above reaches a device log
    let clock = 0;
    const lines = [];
    const t = createPerfTier({ forced: 'phone', pinned: 5, apply: () => {},
                               report: (r) => lines.push(r), now: () => clock });
    for (let i = 0; i < 300; i++) { clock += 50; t.tick(); }
    ok('the report carries the cadence', lines.length >= 1 && lines[0].cadence['3'] > 0 && lines[0].jumps === 0);
  }

  // ★ THE STALL LINE (#142): immediate, whole-session, capped, and never for a hidden page
  {
    let clock = 0;
    const stalls = [];
    const t = createPerfTier({ forced: 'phone', pinned: 5, apply: () => {},
                               onStall: (s) => stalls.push(s), now: () => clock });
    for (let i = 0; i < 100; i++) { clock += 50; t.tick(); }
    ok('no stall on a steady frame', stalls.length === 0);
    clock += 400; t.tick();
    ok('a 400 ms gap is reported at once', stalls.length === 1 && stalls[0].ms === 400);
    clock += 300000; for (let i = 0; i < 10; i++) { clock += 50; t.tick(); }
    clock += 600; t.tick();
    ok('stalls are still reported after two minutes', stalls.length === 2);
    for (let i = 0; i < 100; i++) { clock += 300; t.tick(); }
    ok('stall reports are capped', stalls.length === STALL_REPORTS_MAX);
  }

  // ★ THE START FOLLOWS THE GPU FOR AN A14 PHONE (BUD4), AND ONLY FOR ONE
  ok('an apple7 phone starts at the floor', startLevel('phone', 'apple7') === MAX_LEVEL);
  ok('an older phone starts at the floor', startLevel('phone', 'apple6') === MAX_LEVEL);
  ok('an apple8 phone still walks from 1', startLevel('phone', 'apple8') === 1);
  ok('a phone whose shell says nothing walks from 1', startLevel('phone', undefined) === 1);
  ok('an apple7 iPad starts at the floor too', startLevel('tablet', 'apple7') === MAX_LEVEL);
  ok('an apple8 iPad still walks from 0', startLevel('tablet', 'apple8') === 0);
  ok('an apple7 Mac is not a tablet', startLevel('desktop', 'apple7') === 0);
  ok('a start is honoured', run({ forced: 'phone', start: 5 }, []).level === 5);

  if (fails.length) { console.error('perf-tier selftest FAILED:', fails.join(', ')); process.exit(1); }
  console.log(`perf-tier selftest: all 46 checks pass`);
}
