// tools/events-sim.mjs — does the run of show feel mechanical? The naturalness audit.
//
//   node tools/events-sim.mjs [--hours N] [--verbose]     fast-forward the shipped library
//   node tools/events-sim.mjs --selftest                   prove each audit still catches its pathology
//
// PLAN §6.5 (binding): no fixed offsets, per-event salts, and content unpredictability — a question
// whose right answer sits in the same place every time is the same bug as a fixed offset. This file
// runs the SHIPPING scheduler (runofshow.js) over the SHIPPING library, so the schedule it audits is
// the one a viewer gets, not a second model of it.
//
// ★ RUN --selftest FIRST. Each audit is paired with a synthetic schedule carrying the exact pathology
// it hunts, and must FAIL it — an audit nobody has watched fail may be asserting nothing. And every
// audit states its denominator: an audit with nothing to look at prints as NOT AUDITED, never as ok.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunOfShow } from './events/runofshow.js';
import { normaliseEventDef } from './events/eventdef.js';

const args = process.argv.slice(2);
const HOURS = args.includes('--hours') ? Number(args[args.indexOf('--hours') + 1]) : 24;
const VERBOSE = args.includes('--verbose');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(REPO, 'assets', 'dripping-pickle');

function loadLibrary() {
  const index = JSON.parse(fs.readFileSync(path.join(ASSETS, 'events', 'index.json'), 'utf8'));
  const defs = index.events.map((id) => normaliseEventDef(JSON.parse(fs.readFileSync(path.join(ASSETS, 'events', `${id}.json`), 'utf8'))));
  const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'run-of-show.json'), 'utf8'));
  return { defs, manifest };
}

/** Every fire the scheduler evaluates over a span, not only the emitted ones. */
export function simulate(manifest, defs, spanSec) {
  const s = new RunOfShow({ manifest, defs });
  s.lastEvaluated = manifest.epoch - 1;
  const fires = [];
  const until = manifest.epoch + spanSec;
  while (s.lastEvaluated < until) {
    const now = ++s.lastEvaluated;
    for (const f of s._evaluateSecond(now)) fires.push(f);
  }
  return { fires, scheduler: s };
}

// ── small stats ───────────────────────────────────────────────────────────────────────────────
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function pearson(a, b) {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}
const modeOf = (values) => {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((x, y) => y[1] - x[1])[0];
};

// ── the audits ────────────────────────────────────────────────────────────────────────────────
// Each returns { name, ok, detail, empty }. Thresholds are what a viewer would notice.

/** The same interval between consecutive fires of one event, over and over, is the most direct
 *  form of a beat. Without cooldown jitter an event fires the instant its floor lifts, every time. */
function auditRepeatedGaps(fires, events) {
  const worst = [];
  for (const def of events) {
    const secs = fires.filter((f) => f.id === def.id).map((f) => f.second);
    if (secs.length < 6) continue;
    const gaps = secs.slice(1).map((s, i) => s - secs[i]);
    // Bucket to 1 s. Some repetition is chance; a dominant bucket is a rhythm.
    const [modeVal, n] = modeOf(gaps);
    worst.push({ id: def.id, mode: modeVal, share: n / gaps.length, n, of: gaps.length });
  }
  worst.sort((a, b) => b.share - a.share);
  const bad = worst.filter((w) => w.share > 0.25);
  return {
    name: 'no event settles onto a repeated gap', ok: bad.length === 0, empty: worst.length === 0,
    detail: worst.length === 0 ? 'NO EVENT FIRED SIX TIMES — not audited'
      : `worst: ${worst[0].id} repeats a ${worst[0].mode}s gap ${worst[0].n}/${worst[0].of} (${(worst[0].share * 100).toFixed(0)}%, limit 25%)`,
  };
}

/** Consecutive gaps must not predict each other: positive lag-1 correlation is clumping, negative
 *  is a short/long alternation — both read as a pattern even when every gap looks random alone. */
function auditGapAutocorrelation(fires, events) {
  let worst = { r: 0 }, audited = 0;
  for (const def of events) {
    const secs = fires.filter((f) => f.id === def.id).map((f) => f.second);
    if (secs.length < 21) continue;
    const gaps = secs.slice(1).map((s, i) => s - secs[i]);
    const r = pearson(gaps.slice(0, -1), gaps.slice(1));
    audited++;
    if (Math.abs(r) > Math.abs(worst.r)) worst = { id: def.id, r, n: gaps.length };
  }
  return {
    name: 'consecutive gaps do not predict each other', ok: Math.abs(worst.r) <= 0.25, empty: audited === 0,
    detail: audited === 0 ? 'NO EVENT FIRED 21 TIMES — not audited' : `worst: ${worst.id} lag-1 r = ${worst.r.toFixed(3)} over ${worst.n} gaps (limit |0.25|)`,
  };
}

/** "Trivia always starts 30 s after the cat jumps" — PLAN's named failure. For every ordered pair,
 *  the lag from each A to the next B within two minutes; a dominant lag means they are chained. */
function auditFixedOffsets(fires, events) {
  const byId = new Map(events.map((d) => [d.id, fires.filter((f) => f.id === d.id).map((f) => f.second)]));
  let worst = { share: 0 }, pairs = 0;
  for (const a of events) for (const b of events) {
    if (a.id === b.id) continue;
    const A = byId.get(a.id), B = byId.get(b.id);
    if (A.length < 5 || B.length < 5) continue;
    pairs++;
    const lags = [];
    let j = 0;
    for (const t of A) {
      while (j < B.length && B[j] <= t) j++;
      if (j < B.length && B[j] - t <= 120) lags.push(B[j] - t);
    }
    if (lags.length < 5) continue;
    const [lag, n] = modeOf(lags);
    const share = n / lags.length;
    if (share > worst.share) worst = { a: a.id, b: b.id, lag, n, observed: lags.length, share };
  }
  return {
    name: 'no pair of events sits at a fixed offset', ok: pairs > 0 && worst.share <= 0.4, empty: pairs === 0,
    detail: pairs === 0 ? 'NO PAIR FIRED FIVE TIMES EACH — not audited'
      : worst.a ? `worst: ${worst.b} follows ${worst.a} by ${worst.lag}s in ${worst.n}/${worst.observed} (${(worst.share * 100).toFixed(0)}%, limit 40%)`
      : `${pairs} pairs; no pair ever followed within 120 s five times`,
  };
}

/** Two events landing on the same second repeatedly read as one event and usually mean a shared
 *  or colliding salt. */
function auditCoFiring(fires) {
  const bySecond = new Map();
  for (const f of fires) bySecond.set(f.second, [...(bySecond.get(f.second) || []), f.id]);
  const pairCounts = new Map();
  for (const ids of bySecond.values()) {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const key = [ids[i], ids[j]].sort().join(' + ');
      pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    }
  }
  const worst = [...pairCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const limit = Math.max(3, Math.round(fires.length * 0.01));
  return {
    name: 'no two events fire together repeatedly', ok: !worst || worst[1] <= limit, empty: fires.length === 0,
    detail: worst ? `worst: ${worst[0]} co-fired ${worst[1]}× (limit ${limit} of ${fires.length} fires)` : `no co-firing at all in ${fires.length} fires`,
  };
}

/** Does the whole schedule repeat on a period? Seeding from time-of-day made the Godot build's
 *  entire day repeat bit for bit; any manifest keyed off a repeating period can reintroduce it. */
function auditPeriodicity(fires, spanSec) {
  const set = new Set(fires.map((f) => `${f.second}:${f.id}`));
  let worst = { period: null, share: 0 };
  const last = fires.length ? fires[fires.length - 1].second : 0;
  for (const period of [3600, 6 * 3600, 12 * 3600, 24 * 3600]) {
    if (spanSec < period * 2) continue;
    let matched = 0, tested = 0;
    for (const f of fires) {
      if (f.second + period > last) continue;
      tested++;
      if (set.has(`${f.second + period}:${f.id}`)) matched++;
    }
    if (tested < 20) continue;
    const share = matched / tested;
    if (share > worst.share) worst = { period, share, matched, tested };
  }
  return {
    name: 'the schedule does not repeat on a period', ok: worst.share <= 0.1, empty: worst.period === null,
    detail: worst.period === null ? `span ${spanSec}s too short to test any period — NOT AUDITED`
      : `worst: ${worst.matched}/${worst.tested} fires recur exactly ${worst.period}s later (${(worst.share * 100).toFixed(0)}%, limit 10%)`,
  };
}

/** A schedule can be unpredictable and still be a dead room, or a frantic one. Bounds are for this
 *  library's authored density (TestFlight bar: interesting for 30 minutes) and are re-fitted when
 *  the library grows — say so in the commit when you move them. */
function auditDensity(fires, spanSec, { minPerHour = 8, maxPerHour = 240, maxSilence = 900 } = {}) {
  if (fires.length < 2) return { name: 'the world is neither empty nor frantic', ok: false, empty: true, detail: 'fewer than two fires' };
  const gaps = fires.slice(1).map((f, i) => f.second - fires[i].second);
  const longest = Math.max(...gaps);
  const perHour = (fires.length / spanSec) * 3600;
  return {
    name: 'the world is neither empty nor frantic', ok: longest <= maxSilence && perHour >= minPerHour && perHour <= maxPerHour, empty: false,
    detail: `${perHour.toFixed(0)} fires/hour (want ${minPerHour}–${maxPerHour}), longest silence ${longest}s (want ≤ ${maxSilence})`,
  };
}

/** Exclusivity actually held — a correctness check, but the simulator is the only place the whole
 *  timeline is visible at once. Two takeovers on one set of screens would be obvious to a viewer. */
function auditExclusivity(fires, events) {
  const byId = new Map(events.map((d) => [d.id, d]));
  const byChannel = new Map();
  for (const f of fires) {
    const def = byId.get(f.id);
    for (const ch of def?.exclusive ?? []) byChannel.set(ch, [...(byChannel.get(ch) || []), { id: f.id, from: f.second, to: f.second + def.durationSec }]);
  }
  let overlaps = 0, checked = 0, example = '';
  for (const [ch, list] of byChannel) {
    list.sort((a, b) => a.from - b.from);
    for (let i = 1; i < list.length; i++) {
      checked++;
      if (list[i].from < list[i - 1].to) { overlaps++; if (!example) example = `${ch}: ${list[i - 1].id}@${list[i - 1].from} still running when ${list[i].id}@${list[i].from} fired`; }
    }
  }
  return {
    name: 'no two events ever overlap on an exclusive channel', ok: overlaps === 0, empty: checked === 0,
    detail: checked === 0 ? 'NO CHANNEL SAW TWO FIRES — not audited' : overlaps ? `${overlaps} overlap(s); first: ${example}` : `${checked} consecutive pairs across ${byChannel.size} channel(s), none overlapping`,
  };
}

/** The realised rate should land near what the author asked for. Not a naturalness test on its
 *  own, but a schedule at half its authored rate is usually a bug hiding behind plausible noise. */
function auditRate(fires, events, spanSec) {
  const rows = [];
  for (const def of events) {
    if (!def.schedule) continue;
    const n = fires.filter((f) => f.id === def.id).length;
    if (n < 10) continue;
    const observed = spanSec / n;
    rows.push({ id: def.id, authored: def.schedule.meanGapSec, observed, ratio: observed / def.schedule.meanGapSec });
  }
  const worst = rows.sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)))[0];
  return {
    name: 'every event fires at about its authored rate', ok: !worst || (worst.ratio > 0.6 && worst.ratio < 1.7), empty: rows.length === 0,
    detail: rows.length === 0 ? 'NO EVENT FIRED TEN TIMES — not audited' : `worst: ${worst.id} observed mean gap ${worst.observed.toFixed(0)}s vs authored ${worst.authored}s (×${worst.ratio.toFixed(2)}, want 0.6–1.7)`,
  };
}

/**
 * ★ CONTENT PREDICTABILITY — the answer-position bug class. It is not enough that WHEN is
 * unpredictable; a draw whose value can be guessed is the same bug. Three ways a draw gives itself
 * away, each measured over the fires that actually happened:
 *   (a) a dominant value — one option far more often than its share of the pool;
 *   (b) a value that repeats from the previous fire far more often than chance;
 *   (c) a value that tracks time or another draw — correlation with the fire second, with the
 *       gap since the previous fire, or with a sibling draw (an odd jar that always wears the same
 *       label is this one).
 * Discrete draws are compared against their pool; numeric ranges are quartiled.
 */
function auditContent(fires, events) {
  const findings = [];
  let audited = 0;
  for (const def of events) {
    const draws = def.draws ?? [];
    if (!draws.length) continue;
    const mine = fires.filter((f) => f.id === def.id);
    if (mine.length < 20) continue;
    audited++;
    const series = {};
    for (const d of draws) {
      const vals = mine.map((f) => f.draws[d.name]);
      let sym, n;
      if (d.kind === 'range') {
        const q = (d.max - d.min) / 4;
        sym = vals.map((v) => Math.min(3, Math.floor((v - d.min) / q)));
        n = 4;
      } else if (d.kind === 'pickIndex') { sym = vals; n = d.indexCount; }
      else {
        // pick / column: distinct pool VALUES (a repeated value in a pick pool is a deliberate weight)
        const distinct = [...new Set(d.pool.map((x) => JSON.stringify(x)))];
        sym = vals.map((v) => distinct.indexOf(JSON.stringify(v)));
        n = distinct.length;
        if (n < 2) continue;
        // expected share of the mode for a weighted pool is the heaviest weight
        const counts = new Map();
        for (const x of d.pool) counts.set(JSON.stringify(x), (counts.get(JSON.stringify(x)) || 0) + 1);
        const heaviest = Math.max(...counts.values()) / d.pool.length;
        const [, cnt] = modeOf(sym);
        const share = cnt / sym.length;
        if (share > Math.min(0.95, heaviest * 1.5 + 0.12)) findings.push(`${def.id}.${d.name}: one value ${(share * 100).toFixed(0)}% of the time (pool weight ${(heaviest * 100).toFixed(0)}%)`);
        // a pool with repeated values is a deliberate weighting; the repeat test below assumes uniform
        series[d.name] = { sym, n, weighted: heaviest * d.pool.length !== 1 };
        continue;
      }
      series[d.name] = { sym, n, weighted: false };
      const [, cnt] = modeOf(sym);
      const share = cnt / sym.length;
      if (share > Math.min(0.95, (1 / n) * 1.6 + 0.12)) findings.push(`${def.id}.${d.name}: one value/quartile ${(share * 100).toFixed(0)}% of the time (uniform is ${(100 / n).toFixed(0)}%)`);
    }
    for (const [name, s] of Object.entries(series)) {
      // (b) repeats from the previous fire
      let repeats = 0;
      for (let i = 1; i < s.sym.length; i++) if (s.sym[i] === s.sym[i - 1]) repeats++;
      const expected = s.weighted ? null : 1 / s.n;
      if (expected !== null && repeats / (s.sym.length - 1) > expected * 2 + 0.1) findings.push(`${def.id}.${name}: repeats the previous fire's value ${(100 * repeats / (s.sym.length - 1)).toFixed(0)}% of the time (chance ${(expected * 100).toFixed(0)}%)`);
      // (c) tracks time
      const secs = mine.map((f) => f.second % 3600);
      const gaps = mine.map((f, i) => (i ? f.second - mine[i - 1].second : 0));
      const rt = Math.abs(pearson(s.sym, secs)), rg = Math.abs(pearson(s.sym, gaps));
      if (rt > 0.3) findings.push(`${def.id}.${name}: correlates with the minute of the hour (r ${rt.toFixed(2)})`);
      if (rg > 0.3) findings.push(`${def.id}.${name}: correlates with the gap since the previous fire (r ${rg.toFixed(2)})`);
    }
    // (c) tracks a sibling draw: for every pair, the worst conditional shift of one given the other.
    //
    // ★ COLUMNS READ OFF THE SAME pickIndex ARE PERFECTLY CORRELATED BY CONSTRUCTION, AND THAT IS
    // THE MECHANISM WORKING. A trivia question and its answer, a countdown's six steps, a report's
    // topic and its body — the whole point of pickIndex + column is that they are one row. Testing
    // them against each other flags r = 1.00 on correct data, so the pair is exempt when both
    // draws derive from the same row (and a column against its own index likewise). Draws that do
    // NOT share a row are still tested, which is where the real tell lives: an odd jar whose LABEL
    // is drawn independently and still predicts its contents.
    const rowOf = new Map();
    for (const d of draws) if (d.kind === 'column') rowOf.set(d.name, d.indexFrom);
    const sameRow = (a, b) => (rowOf.get(a) ?? a) === (rowOf.get(b) ?? b);
    //
    // ★ AND THE TEST HAS TO HAVE THE POWER TO ANSWER. Correlating two nominal draws through their
    // symbol INDICES is only meaningful when the fires outnumber the values: with a 64-value id
    // against a 54-value cargo list and 53 fires, almost every (a, b) cell is empty or holds one
    // sample, and r wanders — this audit reported "mid_a predicts cargo, r 0.38" on two draws that
    // are provably independent (separate positions in one PRNG stream). Requiring n >= 2x the
    // larger pool keeps the small-pool cases the audit was written for (an answer key against its
    // question, a jar label against its contents) and declines the ones it cannot see.
    const names = Object.keys(series);
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      if (sameRow(names[i], names[j])) continue;
      const A = series[names[i]], B = series[names[j]];
      if (A.sym.length < 2 * Math.max(A.n, B.n)) continue;
      const r = Math.abs(pearson(A.sym, B.sym));
      if (r > 0.35) findings.push(`${def.id}: ${names[i]} predicts ${names[j]} (r ${r.toFixed(2)}) — one tells you the other`);
    }
  }
  return {
    name: 'no draw is predictable (the answer-position class)', ok: findings.length === 0, empty: audited === 0,
    detail: audited === 0 ? 'NO EVENT WITH DRAWS FIRED 20 TIMES — not audited' : findings.length ? findings.slice(0, 3).join('; ') : `${audited} event(s) with draws, no value dominates, repeats, or tracks time or a sibling`,
  };
}

/**
 * ★ POOL DEPTH — the 30-minute repetition audit (PLAN §4, TestFlight bar: "30+ minutes with no
 * repeating elements"). The naturalness audits above ask whether the SCHEDULE gives itself away;
 * this one asks whether the CONTENT runs out. They are different failures: a mission every twenty
 * minutes with eight customers in the pool is perfectly unpredictable and still shows the same
 * customer twice inside a single dwell.
 *
 * The bar is authored, not guessed: a draw declares `repeatWindowSec` — "a viewer must not see
 * this value twice inside this window" — and the audit slides that window across the whole
 * simulation. A parameter that is MEANT to repeat (which screen an interference burst hits, three
 * values deep, four times an hour) simply does not declare one, so the audit never has an opinion
 * about it and cannot be made to pass by widening a pool nobody looks at.
 *
 * ★ THE MEASURE IS THE FRACTION OF DWELLS THAT SEE A REPEAT, NOT WHETHER ONE EVER HAPPENS. Over a
 * long enough run a repeat is certain — that is the birthday problem, not a shallow pool, and an
 * audit that forbids it outright can only be satisfied by pools nobody could author. What a
 * viewer experiences is one window, so the question is what fraction of windows contain a repeat:
 * 2 % is the bar, i.e. one dwell in fifty sees the same customer twice, which is rare enough to
 * read as coincidence rather than as the room running out of things to say.
 *
 * It also reports the combinatorial depth per event, which is the number a reviewer actually
 * wants: how long before a viewer could see the same briefing twice.
 */
function auditPoolDepth(fires, events, spanSec) {
  const findings = [];
  const depths = [];
  const rates = [];
  let audited = 0;
  for (const def of events) {
    const draws = (def.draws ?? []).filter((d) => d.kind !== 'column');
    if (!draws.length) continue;
    const mine = fires.filter((f) => f.id === def.id);
    if (mine.length < 2) continue;
    // depth: the product of every draw's distinct value count (columns ride their pickIndex)
    let space = 1;
    for (const d of draws) {
      const n = d.kind === 'pick' ? new Set(d.pool.map((x) => JSON.stringify(x))).size
              : d.kind === 'pickIndex' ? d.indexCount
              : 8;   // a continuous range is not a countable element; count it conservatively
      space *= Math.max(1, n);
    }
    const perHour = (mine.length / spanSec) * 3600;
    // Only events that DECLARE a repeat window are content events; reporting the shallowest
    // across everything names cat_stirs, whose two range draws are a wobble, not content.
    if (draws.some((d) => d.repeatWindowSec > 0)) depths.push({ id: def.id, space, perHour, hours: space / Math.max(perHour, 1e-6) });
    for (const d of draws) {
      const w = d.repeatWindowSec;
      if (!(w > 0)) continue;
      audited++;
      // Slide the window one minute at a time and ask, of the dwells a viewer could actually
      // start, how many contain a repeat of this draw.
      const step = 60;
      let windows = 0, hit = 0, worst = null;
      for (let t0 = spanSec > w ? 0 : -1; t0 >= 0 && t0 <= spanSec - w; t0 += step) {
        windows++;
        const inWin = mine.filter((f) => f.second - mine[0].second + (mine[0].second - fires[0].second) >= 0
          && f.second >= fires[0].second + t0 && f.second < fires[0].second + t0 + w);
        const seenIn = new Set();
        let repeated = false;
        for (const f of inWin) {
          const v = JSON.stringify(f.draws[d.name]);
          if (seenIn.has(v)) { repeated = true; if (!worst) worst = { value: f.draws[d.name], at: f.second - fires[0].second }; }
          seenIn.add(v);
        }
        if (repeated) hit++;
      }
      const share = windows ? hit / windows : 0;
      rates.push({ id: def.id, name: d.name, share, windows, worst });
      if (share > 0.02) findings.push(`${def.id}.${d.name}: ${(share * 100).toFixed(1)}% of ${w}s dwells see a repeated value (limit 2.0%)`);
    }
    // ★ AND THE WHOLE CONTENT TUPLE — but ONLY on an event that declares a window, the same
    //   gate the depth report above already applies. This audit is about content a viewer
    //   COUNTS: "that's the third flooded-cold-store report tonight". It is not about an
    //   ambient character's habits. Caper running the same patrol twice in ten minutes is a
    //   mouse, not a repeat, and the library has no honest pool that makes it rare — you
    //   would be authoring twenty-seven routes through one room to satisfy an audit, which
    //   is tuning the check instead of the Loop (DP-W5's rule, from the other direction:
    //   a parameter meant to repeat must not declare a window).
    //
    //   The gate is narrow ON PURPOSE and the self-test guards both sides of it: the `thin`
    //   fixture declares a window and must still FAIL, and `habit` declares none and must
    //   still be exempt. Widening this into "skip the tuple when it is inconvenient" is the
    //   failure mode the columns exemption was nearly widened into.
    if (!draws.some((d) => d.repeatWindowSec > 0)) continue;
    const seen = new Map();
    for (const f of mine) {
      const key = JSON.stringify(draws.map((d) => f.draws[d.name]));
      if (seen.has(key)) findings.push(`${def.id}: an identical draw set recurred after ${f.second - seen.get(key)}s`);
      seen.set(key, f.second);
    }
  }
  depths.sort((a, b) => a.hours - b.hours);
  const shallow = depths[0];
  rates.sort((a, b) => b.share - a.share);
  const worstRate = rates[0] ?? { id: '-', name: '-', share: 0 };
  return {
    name: 'content pools are deep enough for a 30-minute dwell', ok: findings.length === 0, empty: audited === 0,
    detail: audited === 0 ? 'NO DRAW DECLARES repeatWindowSec — not audited'
      : findings.length ? findings.slice(0, 3).join('; ')
      : `${audited} declared draw(s); worst ${worstRate.id}.${worstRate.name} repeats in ${(worstRate.share * 100).toFixed(1)}% of dwells (limit 2.0%); shallowest event ${shallow.id} = ${shallow.space.toExponential(1)} combinations at ${shallow.perHour.toFixed(1)}/h (${(shallow.hours / 24).toExponential(1)} days of distinct content)`,
  };
}

const AUDITS = [
  (f, e, s) => auditRate(f, e, s),
  (f, e) => auditRepeatedGaps(f, e),
  (f, e) => auditGapAutocorrelation(f, e),
  (f, e) => auditFixedOffsets(f, e),
  (f) => auditCoFiring(f),
  (f, e, s) => auditPeriodicity(f, s),
  (f, e, s) => auditDensity(f, s),
  (f, e) => auditExclusivity(f, e),
  (f, e) => auditContent(f, e),
  (f, e, s) => auditPoolDepth(f, e, s),
];

export function runAudits(fires, events, spanSec, label) {
  console.log(`\n${label} — ${fires.length} fires over ${(spanSec / 3600).toFixed(1)} h`);
  let failed = 0;
  for (const audit of AUDITS) {
    const r = audit(fires, events, spanSec);
    // An audit with nothing to look at is NOT a pass.
    const ok = r.ok && !r.empty;
    console.log(`  ${ok ? 'ok  ' : (r.empty ? 'N/A ' : 'FAIL')}  ${r.name}\n          ${r.detail}`);
    if (!ok) failed++;
  }
  return failed;
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────

function selftest() {
  console.log('== SELF-TEST — each audit is shown a schedule carrying its own pathology ==');
  const ev = (id, extra = {}) => normaliseEventDef({ id, kind: 'ambient', salt: 100 + id.charCodeAt(0), schedule: { meanGapSec: 120, minGapSec: 60, gapJitter: 0.4 }, durationSec: 5, tracks: [{ channel: 'audio', target: 'x', action: 'play' }], ...extra });
  const events = [ev('a'), ev('b'), ev('c')];
  let failures = 0;
  const expectFail = (label, r) => {
    const caught = !r.ok || r.empty;
    console.log(`  ${caught ? 'ok  ' : 'FAIL'}  ${label}\n          ${r.detail}`);
    if (!caught) failures++;
  };

  const metronome = [];
  for (let t = 0; t < 3600; t += 60) metronome.push({ id: 'a', second: t, draws: {} });
  expectFail('repeated-gap audit catches a metronome', auditRepeatedGaps(metronome, events));

  const alternating = [];
  for (let t = 0, i = 0; i < 40; i++) { alternating.push({ id: 'a', second: t, draws: {} }); t += i % 2 ? 30 + (i % 7) : 150 + (i % 5); }
  expectFail('autocorrelation audit catches short/long alternation', auditGapAutocorrelation(alternating, events));

  const chained = [];
  for (let t = 0; t < 3600; t += 137) { chained.push({ id: 'a', second: t, draws: {} }); chained.push({ id: 'b', second: t + 30, draws: {} }); }
  expectFail('fixed-offset audit catches a chained event', auditFixedOffsets(chained, events));

  const together = [];
  for (let t = 0; t < 3600; t += 90) { together.push({ id: 'a', second: t, draws: {} }); together.push({ id: 'b', second: t, draws: {} }); }
  expectFail('co-firing audit catches a shared salt', auditCoFiring(together));

  const periodic = [];
  for (let h = 0; h < 6; h++) for (const o of [17, 233, 719, 1801, 2903]) periodic.push({ id: 'a', second: h * 3600 + o, draws: {} });
  expectFail('periodicity audit catches a repeating hour', auditPeriodicity(periodic, 6 * 3600));

  expectFail('density audit catches a dead world', auditDensity([{ id: 'a', second: 0 }, { id: 'a', second: 2000 }], 3600));

  const clash = [ev('a', { exclusive: ['monitors'], durationSec: 30 }), ev('b', { exclusive: ['monitors'], durationSec: 30 })];
  expectFail('exclusivity audit catches two takeovers overlapping', auditExclusivity([{ id: 'a', second: 0 }, { id: 'b', second: 10 }], clash));

  const slow = [ev('a')];
  const halfRate = [];
  for (let t = 0; t < 24 * 3600; t += 300) halfRate.push({ id: 'a', second: t, draws: {} });
  expectFail('rate audit catches an event at 40% of its authored rate', auditRate(halfRate, slow, 24 * 3600));

  // The answer-position bug: option "c" is right 70% of the time.
  const trivia = [ev('a', { draws: [{ name: 'answer', kind: 'pick', pool: ['a', 'b', 'c', 'd'] }] })];
  const biased = [];
  for (let i = 0; i < 60; i++) biased.push({ id: 'a', second: i * 100, draws: { answer: i % 10 < 7 ? 'c' : ['a', 'b', 'd'][i % 3] } });
  expectFail('content audit catches a dominant answer position', auditContent(biased, trivia));

  const sticky = [];
  for (let i = 0; i < 60; i++) sticky.push({ id: 'a', second: i * 100, draws: { answer: ['a', 'a', 'a', 'b', 'b', 'b', 'c', 'c', 'c', 'd', 'd', 'd'][i % 12] } });
  expectFail('content audit catches a value that sticks between fires', auditContent(sticky, trivia));

  const twin = [ev('a', { draws: [{ name: 'content', kind: 'pick', pool: [0, 1, 2, 3] }, { name: 'label', kind: 'pick', pool: [0, 1, 2, 3] }] })];
  const tell = [];
  for (let i = 0; i < 60; i++) { const c = (i * 7 + (i >> 2)) % 4; tell.push({ id: 'a', second: i * 100, draws: { content: c, label: c } }); }
  expectFail('content audit catches a label that tells you the contents', auditContent(tell, twin));

  // The pool-depth audit's own pathology: a three-value pool that claims a 30-minute repeat
  // window while firing every five minutes cannot possibly honour it.
  const thin = [ev('a', { draws: [{ name: 'customer', kind: 'pick', pool: ['X', 'Y', 'Z'], repeatWindowSec: 1800 }] })];
  const thinFires = [];
  for (let i = 0; i < 120; i++) thinFires.push({ id: 'a', second: i * 300, draws: { customer: ['X', 'Y', 'Z'][(i * 7) % 3] } });
  expectFail('pool-depth audit catches a pool too shallow for a 30-minute dwell', auditPoolDepth(thinFires, thin, 120 * 300));

  // ★ THE OTHER SIDE OF THAT GATE. An ambient character's habits repeat by nature and declare
  // no window; the tuple check must leave them alone. Identical draw sets here, minutes apart —
  // if this ever reports a finding, the exemption has been lost and every mouse errand becomes
  // an audit failure. (The `thin` case above is what stops the exemption widening into "never
  // test anything": it declares a window and must still fail.)
  const habit = [ev('a', { draws: [{ name: 'route', kind: 'pick', pool: ['p', 'q'] }] })];
  const habitFires = [];
  for (let i = 0; i < 120; i++) habitFires.push({ id: 'a', second: i * 200, draws: { route: i % 2 ? 'p' : 'q' } });
  {
    const r = auditPoolDepth(habitFires, habit, 120 * 200);
    const passed = r.ok;
    console.log(`  ${passed ? 'ok  ' : 'FAIL'}  pool-depth audit does NOT flag an ambient habit that declares no window\n          ${r.detail}`);
    if (!passed) failures++;
  }

  // ★ AND A POSITIVE CONTROL, because the exemption added for columns could just as easily have
  // switched the sibling test off altogether. Columns read off ONE pickIndex are correlated by
  // construction and must NOT be flagged; the `twin` case above proves independent draws still are.
  const rowed = [ev('a', {
    draws: [
      { name: 'row', kind: 'pickIndex', indexCount: 8 },
      { name: 'question', kind: 'column', indexFrom: 'row', pool: [0, 1, 2, 3, 4, 5, 6, 7] },
      { name: 'answer', kind: 'column', indexFrom: 'row', pool: ['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd'] },
    ],
  })];
  const rowedFires = [];
  for (let i = 0; i < 80; i++) {
    const r = (i * 5 + (i >> 3)) % 8;
    rowedFires.push({ id: 'a', second: i * 137, draws: { row: r, question: r, answer: ['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd'][r] } });
  }
  {
    const r = auditContent(rowedFires, rowed);
    const passed = r.ok && !r.empty;
    console.log(`  ${passed ? 'ok  ' : 'FAIL'}  content audit does NOT flag columns read off one pickIndex\n          ${r.detail}`);
    if (!passed) failures++;
  }

  // ★ AND THE OTHER DIRECTION: the audits must PASS the real schedule, or "fails everything" would
  // look identical to "works".
  const { defs, manifest } = loadLibrary();
  const span = 24 * 3600;
  const { fires } = simulate(manifest, defs, span);
  const real = runAudits(fires, defs, span, '  and the shipped library over 24 h, which must PASS');
  if (real > 0) { console.log('  FAIL  the audits reject the shipped schedule'); failures += real; }

  console.log(`\n${failures === 0 ? 'SELF-TEST OK' : `SELF-TEST FAILED — ${failures}`}`);
  return failures;
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────

if (args.includes('--selftest')) process.exit(selftest() === 0 ? 0 : 1);

const { defs, manifest } = loadLibrary();
const spanSec = HOURS * 3600;
const t0 = performance.now();
const { fires } = simulate(manifest, defs, spanSec);
const ms = performance.now() - t0;

if (VERBOSE) {
  for (const f of fires) {
    const rel = f.second - manifest.epoch;
    const hh = String(Math.floor(rel / 3600)).padStart(2, '0'), mm = String(Math.floor((rel % 3600) / 60)).padStart(2, '0'), ss = String(rel % 60).padStart(2, '0');
    console.log(`  ${hh}:${mm}:${ss}  ${f.id.padEnd(20)} ${JSON.stringify(f.draws)}`);
  }
}
const counts = new Map();
for (const f of fires) counts.set(f.id, (counts.get(f.id) || 0) + 1);
console.log(`simulated ${HOURS} h in ${ms.toFixed(0)} ms — fires per event:`);
for (const def of defs) {
  if (def.kind !== 'ambient') { console.log(`  ${def.id.padEnd(20)}  (user event — local only, never scheduled)`); continue; }
  const n = counts.get(def.id) || 0;
  console.log(`  ${def.id.padEnd(20)} ${String(n).padStart(5)}   authored mean gap ${String(def.schedule.meanGapSec).padStart(5)}s` + (n > 1 ? `, observed ${String(Math.round(spanSec / n)).padStart(5)}s` : ''));
}
const failed = runAudits(fires, defs, spanSec, 'naturalness audit');
console.log(`\n${failed === 0 ? 'NATURALNESS OK' : `NATURALNESS FAILED — ${failed} audit(s)`}`);
process.exit(failed === 0 ? 0 : 1);
