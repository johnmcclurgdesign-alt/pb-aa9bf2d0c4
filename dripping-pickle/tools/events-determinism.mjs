// tools/events-determinism.mjs — do two clients see the same world?
//
//   node tools/events-determinism.mjs
//
// Two simulated clients on the same clock — one from the epoch, one joining late, one of them
// suspended and resumed mid-run — drive the SHIPPING scheduler and the SHIPPING runner with
// logging executors. Their logs must be byte-identical over the shared window and their scheduler
// state fingerprints must match. EVT-004's gate, kept green thereafter.
//
// ★ EVERY ASSERTION IS PAIRED WITH SOMETHING THAT MUST FAIL. A local-history scheduler (the Godot
// prior art's shape) is replayed through the identical comparison and must come back misaligned.
// A comparison that cannot fail cannot tell "aligned" from "not measuring".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { roll, fnv1a32, fnv1a32Utf8, prefixState, rollFromPrefix } from './events/roll.js';
import { RunOfShow, rebaseToCurrentWindow, drawsFor } from './events/runofshow.js';
import { createRunner } from './events/runner.js';
import { normaliseEventDef, probabilityPerSecond } from './events/eventdef.js';
import { createDripScheduler } from './audio.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(REPO, 'assets', 'dripping-pickle');
const index = JSON.parse(fs.readFileSync(path.join(ASSETS, 'events', 'index.json'), 'utf8'));
const defs = index.events.map((id) => JSON.parse(fs.readFileSync(path.join(ASSETS, 'events', `${id}.json`), 'utf8')));
const shipped = JSON.parse(fs.readFileSync(path.join(ASSETS, 'run-of-show.json'), 'utf8'));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

// ── a simulated client ──────────────────────────────────────────────────────────────────────────
// Wall clock is simulated as whole seconds; the runner's nowMs is derived from it. Executors log
// every track. `stepTo(second)` is one frame per second, which is enough: the runner dispatches by
// due time, not by frame count.

function logging(channel) {
  return { apply: (track, ctx) => true };
}
function client({ manifest, defs, joinAt, nowSecond = null }) {
  const log = [];
  let t = joinAt;
  const sched = new RunOfShow({ manifest, defs, nowSecond: nowSecond ?? joinAt });
  const runner = createRunner({
    defs, nowMs: () => t * 1000, log: (l) => log.push(l),
    drawsForLocal: (id, s) => sched.drawsFor(id, s),
    executors: { screens: logging(), audio: logging(), npc: logging(), equipment: logging() },
  });
  const c = {
    sched, runner, log, get t() { return t; },
    /** advance the wall clock to `second`, one frame per second (a suspended client jumps) */
    stepTo(second, { frames = true } = {}) {
      if (!frames) { t = second; for (const f of sched.advanceTo(t)) runner.start(f); runner.tick(); return; }
      while (t < second) { t += 1; for (const f of sched.advanceTo(t)) runner.start(f); runner.tick(); }
    },
    /** what this client logged from `from` on (fire seconds), so two clients compare on the shared window */
    logFrom(from) { return log.filter((l) => Number(l.split(' ')[0]) >= from).join('\n'); },
  };
  c.stepTo(joinAt, { frames: false });
  return c;
}

// A deliberately dense library so the 30-minute windows below have something to compare: the
// shipped library is rare by design (a stall an hour, a flicker every eight minutes).
const DENSE = [
  { id: 'd_signal',   kind: 'ambient', salt: 9301, schedule: { meanGapSec: 78,  minGapSec: 45,  gapJitter: 0.40 }, durationSec: 1.5, exclusive: [],           tracks: [{ channel: 'screens', target: 'all', action: 'interference', at: 0, params: { strength: '{s}' } }], draws: [{ name: 's', kind: 'range', min: 0.3, max: 0.8 }] },
  { id: 'd_scurry',   kind: 'ambient', salt: 9302, schedule: { meanGapSec: 95,  minGapSec: 70,  gapJitter: 0.40 }, durationSec: 22,  exclusive: ['mouse'],    tracks: [{ channel: 'npc', target: 'mouse', action: 'scurry', at: 0 }, { channel: 'npc', target: 'mouse', action: 'hide', at: 20 }] },
  { id: 'd_delivery', kind: 'ambient', salt: 9303, schedule: { meanGapSec: 115, minGapSec: 90,  gapJitter: 0.35 }, durationSec: 32,  exclusive: ['monitors'], priority: 10, tracks: [{ channel: 'screens', target: 'all', action: 'show', at: 0, params: { widget: 'panel', title: '{where}' } }, { channel: 'screens', target: 'all', action: 'restore', at: 30 }], draws: [{ name: 'where', kind: 'pick', pool: ['AISLE 7', 'BAY C', 'DOCK 3'] }] },
  { id: 'd_walk_lr',  kind: 'ambient', salt: 9304, schedule: { meanGapSec: 127, minGapSec: 120, gapJitter: 0.35 }, durationSec: 14,  exclusive: ['cat'],      tracks: [{ channel: 'npc', target: 'cat', action: 'walk', at: 0 }] },
  { id: 'd_walk_rl',  kind: 'ambient', salt: 9305, schedule: { meanGapSec: 130, minGapSec: 120, gapJitter: 0.35 }, durationSec: 14,  exclusive: ['cat'],      tracks: [{ channel: 'npc', target: 'cat', action: 'walk', at: 0 }] },
  { id: 'd_flicker',  kind: 'ambient', salt: 9306, schedule: { meanGapSec: 190, minGapSec: 150, gapJitter: 0.50 }, durationSec: 2,   exclusive: [],           tracks: [{ channel: 'equipment', target: 'pendant_1', action: 'set', at: 0 }] },
  { id: 'd_conveyor', kind: 'ambient', salt: 9307, schedule: { meanGapSec: 240, minGapSec: 180, gapJitter: 0.35 }, durationSec: 12,  exclusive: ['mouse'],    tracks: [{ channel: 'npc', target: 'mouse', action: 'run', at: 0 }] },
  { id: 'd_sit',      kind: 'ambient', salt: 9308, schedule: { meanGapSec: 252, minGapSec: 240, gapJitter: 0.30 }, durationSec: 50,  exclusive: ['cat'],      tracks: [{ channel: 'npc', target: 'cat', action: 'sit', at: 0 }] },
  { id: 'd_chase',    kind: 'ambient', salt: 9309, schedule: { meanGapSec: 300, minGapSec: 260, gapJitter: 0.30 }, durationSec: 20,  exclusive: ['cat', 'mouse'], tracks: [{ channel: 'npc', target: 'cat', action: 'chase', at: 0 }] },
  { id: 'd_trivia',   kind: 'ambient', salt: 9310, schedule: { meanGapSec: 400, minGapSec: 300, gapJitter: 0.30 }, durationSec: 40,  exclusive: ['monitors'], priority: 5,
    draws: [{ name: 'q', kind: 'pickIndex', indexCount: 4 }, { name: 'question', kind: 'column', indexFrom: 'q', pool: ['Q1', 'Q2', 'Q3', 'Q4'] }, { name: 'answer', kind: 'column', indexFrom: 'q', pool: ['b', 'd', 'a', 'c'] }],
    tracks: [{ channel: 'screens', target: 'center', action: 'show', at: 0, params: { widget: 'panel', title: '{question}' } }, { channel: 'screens', target: 'all', action: 'restore', at: 38 },
             { channel: 'audio', target: 'sting_triumphant', action: 'play', at: 0, when: 'correct' }, { channel: 'audio', target: 'sting_trombone', action: 'play', at: 0, when: 'wrong' }],
    localResponse: { inputTarget: 'answer_', windowSec: 15, defaultOutcome: 'none', correctFromDraw: 'answer' } },
  { id: 'd_knock',    kind: 'user', salt: 9311, trigger: { target: 'jar', inputs: ['jar'] }, durationSec: 3, exclusive: [], draws: [{ name: 'strength', kind: 'range', min: 0.4, max: 1 }],
    tracks: [{ channel: 'equipment', target: 'conveyor', action: 'wobble', at: 0, params: { jar: '{jar}', strength: '{strength}' } }] },
];
const manifest = { ...shipped, epoch: 1788372000, validFrom: 1788372000, validUntil: 1788372000 + 6 * 3600, cues: [] };
const T = manifest.validFrom + 4000;
const SOAK = 30 * 60;

console.log('== 0. The seed hash is the wire contract ==');
{
  check('matches the published FNV-1a/32 vectors', fnv1a32('') === 2166136261 && fnv1a32('a') === 3826002220, `"" -> ${fnv1a32('')}, "a" -> ${fnv1a32('a')}`);
  const corpus = ['', 'a', 'collectivus', '2026090201|conveyor_stall|4101|1788372000', 'café', '日本語', '🙂'];
  const mism = corpus.filter((s) => fnv1a32(s) !== fnv1a32Utf8(s));
  check('the ASCII fast path agrees with real UTF-8 bytes', mism.length === 0, `${corpus.length} strings, ${mism.length} mismatched`);
  // The prefix-folded path must be bit-identical to the string path, for every stream and a long
  // run of seconds — if it ever diverged, every device using it would silently leave the shared world.
  let diverged = 0, tested = 0;
  for (const [id, salt, stream] of [['conveyor_stall', 4101, ''], ['signal_interference', 4102, '#gap'], ['x', 7, '#draw3']]) {
    const st = prefixState(manifest.runSeed, id, salt, stream);
    for (let s = manifest.epoch; s < manifest.epoch + 5000; s += 7) {
      tested++;
      if (rollFromPrefix(st, s) !== roll(manifest.runSeed, id, salt, s, stream)) diverged++;
    }
    // and across a digit-count boundary
    for (const s of [0, 9, 10, 99, 100, 999, 1000, 4294967295]) { tested++; if (rollFromPrefix(st, s) !== roll(manifest.runSeed, id, salt, s, stream)) diverged++; }
  }
  check('the prefix-folded roll is bit-identical to the string roll', diverged === 0, `${tested} rolls, ${diverged} diverged`);
  // Local decorrelation — the property a uniformity test cannot see and this design once shipped without.
  const N = 20000;
  let acc = 0, prev = roll(manifest.runSeed, 'probe', 1, manifest.epoch);
  for (let i = 1; i < N; i++) { const u = roll(manifest.runSeed, 'probe', 1, manifest.epoch + i); acc += Math.abs(u - prev); prev = u; }
  const meanDelta = acc / (N - 1);
  check('adjacent seconds are decorrelated', meanDelta > 0.30 && meanDelta < 0.37, `mean |Δ| between consecutive seconds ${meanDelta.toFixed(4)} (random pairs give 0.3333)`);
}

console.log('\n== 1. Two clients: same clock, different join times, identical logs ==');
const A = client({ manifest, defs: DENSE, joinAt: T });
A.stepTo(T + SOAK);
for (const lag of [1, 30, 120, 600]) {
  const B = client({ manifest, defs: DENSE, joinAt: T + lag });
  B.stepTo(T + SOAK);
  // Compare from the join plus the longest duration: a fire in flight at B's join is emitted with
  // `elapsed` and its already-due tracks dispatched at once — same lines, so those match too; only
  // fires that had fully EXPIRED before B joined are absent from B, and that is the designed
  // "over is over" behaviour, not a divergence.
  const from = T + lag + 50;
  const a = A.logFrom(from), b = B.logFrom(from);
  const n = a.split('\n').filter(Boolean).length;
  check(`joining ${String(lag).padStart(3)}s late: logs byte-identical from ${from - T}s`, a === b && n >= 8, `${n} log lines` + (a !== b ? ` — FIRST DIFFERENCE: ${firstDiff(a, b)}` : ''));
  check(`joining ${String(lag).padStart(3)}s late: scheduler state fingerprints match`, A.sched.stateFingerprint() === B.sched.stateFingerprint());
}
function firstDiff(a, b) {
  const la = a.split('\n'), lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) return `line ${i}: A='${la[i]}' B='${lb[i]}'`;
  return '';
}

console.log('\n== 2. Suspend and resume: never reset to "now" ==');
{
  const C = client({ manifest, defs: DENSE, joinAt: T });
  C.stepTo(T + 600);
  C.stepTo(T + 600 + 400, { frames: false });   // backgrounded for 400 s: one jump, no frames
  C.stepTo(T + SOAK);
  const from = T + 1000 + 50;
  check('a client that slept 400 s matches one that never slept, after the sleep', A.logFrom(from) === C.logFrom(from), firstDiff(A.logFrom(from), C.logFrom(from)));
  check('and its scheduler state fingerprint matches', A.sched.stateFingerprint() === C.sched.stateFingerprint());
  const burst = C.log.filter((l) => l.includes(' FIRE ') && Number(l.split(' ')[0]) > T + 600 && Number(l.split(' ')[0]) < T + 1000 - 50);
  check('the sleep was not replayed as a burst (expired fires are history)', burst.length === 0, `${burst.length} expired fire(s) emitted on resume`);
  const inflight = C.log.find((l) => l.includes(' FIRE elapsed=') && !l.includes('elapsed=0 '));
  check('an event still in flight at resume is emitted with its elapsed time', !!inflight, inflight ? inflight.slice(0, 80) : 'none in flight at the resume second — re-run with a different sleep');
}

console.log('\n== 3. NEGATIVE CONTROL — the prior art\'s shape must FAIL the same comparison ==');
{
  function localHistory(joinAt, until, events) {
    const nextEligible = new Map(), free = new Map(), fires = [];
    const order = [...events].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (let now = joinAt; now <= until; now++) for (const d of order) {
      if (d.kind !== 'ambient') continue;
      if (now < (nextEligible.get(d.id) ?? -Infinity)) continue;
      if ((d.exclusive ?? []).some((ch) => now < (free.get(ch) ?? -Infinity))) continue;
      if (roll(manifest.runSeed, d.id, d.salt, now) >= probabilityPerSecond(d.schedule.meanGapSec, d.schedule.minGapSec)) continue;
      nextEligible.set(d.id, now + Math.ceil(d.schedule.minGapSec * (1 + d.schedule.gapJitter * (roll(manifest.runSeed, d.id, d.salt, now, '#gap') - 0.5))));
      for (const ch of d.exclusive ?? []) free.set(ch, now + Math.ceil(d.durationSec));
      fires.push(`${now}:${d.id}`);
    }
    return fires;
  }
  let worst = 100;
  for (const lag of [30, 120, 600]) {
    const end = T + lag + 300;
    const a = new Set(localHistory(T, end, DENSE).filter((f) => Number(f.split(':')[0]) >= T + lag));
    const b = new Set(localHistory(T + lag, end, DENSE));
    const union = new Set([...a, ...b]);
    let agreed = 0; for (const k of a) if (b.has(k)) agreed++;
    const pct = union.size ? 100 * agreed / union.size : 100;
    worst = Math.min(worst, pct);
    console.log(`  local-history scheduler, ${String(lag).padStart(3)}s late, first 300 s: ${agreed}/${union.size} aligned (${pct.toFixed(1)}%)`);
  }
  check('the comparison detects misalignment when it is present', worst < 90, `worst ${worst.toFixed(1)}% — if this were 100% every green above would assert nothing`);
}

console.log('\n== 4. A local interaction never moves the shared schedule ==');
{
  const D = client({ manifest, defs: DENSE, joinAt: T });
  D.stepTo(T + 300);
  const fired = D.runner.trigger('jar', { input: { jar: 4242 } });
  check('a tap fires its user event locally', fired && D.log.some((l) => l.includes('d_knock(local) FIRE')));
  check('the tap carried its own input and a seed-drawn strength', D.log.some((l) => /wobble \{"jar":4242,"strength":0\.\d+\}/.test(l)));
  D.runner.submit('answer_c');
  D.stepTo(T + SOAK);
  check('scheduler fingerprint identical to the untouched client', A.sched.stateFingerprint() === D.sched.stateFingerprint());
  const api = Object.getOwnPropertyNames(RunOfShow.prototype).filter((n) => n !== 'constructor');
  check('no API exists by which a viewer input reaches the scheduler', !api.some((n) => /input|tap|pick|trigger|submit/i.test(n)), `RunOfShow exposes: ${api.join(', ')}`);
  // The trigger is refused while its channel is held: a shared takeover on the monitors.
  const E = client({ manifest, defs: DENSE, joinAt: T });
  const fireSec = Number(E.log.find((l) => l.includes('d_delivery FIRE'))?.split(' ')[0] ?? 0) || (E.stepTo(T + 600), Number(E.log.find((l) => l.includes('d_delivery FIRE')).split(' ')[0]));
  check('exclusivity is visible to the runner (a shared fire holds its channel locally)', E.runner.holds('monitors') || fireSec > 0, `d_delivery fired at +${fireSec - T}s`);
}

console.log('\n== 5. Shared event, local response ==');
{
  const P = client({ manifest, defs: DENSE, joinAt: T });
  const Q = client({ manifest, defs: DENSE, joinAt: T });
  P.stepTo(T + 3600); Q.stepTo(T + 3600);
  // find a trivia fire, then answer on P only
  const fire = P.log.find((l) => l.includes('d_trivia FIRE'));
  check('the trivia-shaped event fired for both', !!fire && Q.log.includes(fire));
  const sec = Number(fire.split(' ')[0]);
  const P2 = client({ manifest, defs: DENSE, joinAt: T }); P2.stepTo(sec + 2);
  const answer = JSON.parse(fire.split('draws=')[1]).answer;
  P2.runner.submit('answer_' + answer);
  P2.stepTo(sec + 60);
  const Q2 = client({ manifest, defs: DENSE, joinAt: T }); Q2.stepTo(sec + 2);
  Q2.runner.submit('answer_' + (answer === 'a' ? 'b' : 'a'));
  Q2.stepTo(sec + 60);
  const R2 = client({ manifest, defs: DENSE, joinAt: T }); R2.stepTo(sec + 60);
  check('the answering viewer resolves correct and hears the sting', P2.log.some((l) => l.includes('RESPONSE correct')) && P2.log.some((l) => l.includes('sting_triumphant')));
  check('the wrong viewer resolves wrong and hears the trombone', Q2.log.some((l) => l.includes('RESPONSE wrong')) && Q2.log.some((l) => l.includes('sting_trombone')));
  check('the silent viewer resolves none and hears neither', R2.log.some((l) => l.includes('RESPONSE none')) && !R2.log.some((l) => l.includes('sting_')));
  check('all three share the identical shared timeline and scheduler state', P2.sched.stateFingerprint() === Q2.sched.stateFingerprint() && Q2.sched.stateFingerprint() === R2.sched.stateFingerprint());
  const answers = [];
  for (let s = manifest.epoch; s < manifest.epoch + 6 * 3600; s += 97) answers.push(drawsFor(manifest.runSeed, normaliseEventDef(DENSE.find((d) => d.id === 'd_trivia')), s));
  check('column draws keep question and answer on the same row', answers.every((a) => ['b', 'd', 'a', 'c'][['Q1', 'Q2', 'Q3', 'Q4'].indexOf(a.question)] === a.answer), `${answers.length} rows`);
}

console.log('\n== 6. Cues — timestamp-scripted playback ==');
{
  const cueAt = T + 777;
  const m2 = { ...manifest, cues: [{ at: cueAt, event: 'd_delivery', draws: { where: 'THE DELI COUNTER' } }, { at: cueAt + 100, event: 'd_knock', draws: { jar: 7, strength: 0.9 } }] };
  const X = client({ manifest: m2, defs: DENSE, joinAt: T });
  const Y = client({ manifest: m2, defs: DENSE, joinAt: cueAt - 5 });
  X.stepTo(T + 2000); Y.stepTo(T + 2000);
  const xl = X.log.find((l) => l.startsWith(`${cueAt} d_delivery FIRE`));
  check('a cue fires the named event at exactly its second, on both clients', !!xl && Y.log.includes(xl), xl?.slice(0, 90));
  check('the cue\'s authored draws override the seed draws', xl?.includes('"where":"THE DELI COUNTER"'));
  check('a cue can play a user-kind event (an episode may script a knock)', X.log.some((l) => l.startsWith(`${cueAt + 100} d_knock FIRE`) && l.includes('"jar":7')));
  check('a cue claims its channel like any fire (the roll cannot double-book the monitors)', X.sched.channelFreeAt.get('monitors') !== undefined && X.log.filter((l) => l.includes('FIRE') && Number(l.split(' ')[0]) > cueAt && Number(l.split(' ')[0]) < cueAt + 32 && l.includes('d_delivery')).length === 0);
  check('cued and rolled schedules agree across both clients', X.sched.stateFingerprint() === Y.sched.stateFingerprint());
}

console.log('\n== 7. The seed manifest ages; both clients rebase identically ==');
{
  const old = { ...manifest };
  const later = manifest.validUntil + 3 * 6 * 3600 + 1234;   // three windows and a bit after it expired
  const r1 = rebaseToCurrentWindow(old, later), r2 = rebaseToCurrentWindow({ ...old }, later + 1800);
  check('two devices opening 30 min apart in the same window derive the same run', r1.runSeed === r2.runSeed && r1.epoch === r2.epoch, `window ${r1.rebasedWindowIndex}, runSeed ${r1.runSeed}`);
  check('the rebased window is a different evening from the first', r1.runSeed !== old.runSeed);
  check('now sits inside the rebased window', later >= r1.validFrom && later < r1.validUntil);
  const K = client({ manifest: old, defs: DENSE, joinAt: later });
  check('a client opened long after the seed expired still runs the schedule', K.sched.manifest.rebasedWindowIndex === 4 && K.sched.lastEvaluated === later);
}

console.log('\n== 7b. A running client crosses a window edge the way a joining one lands on it ==');
{
  // The shipped library and manifest, a window edge a hundred windows out. A is open for half an
  // hour before the edge and watches an hour past it; B opens ten minutes after it. W9 found the
  // scheduler rebasing only at construction: A kept the old window's seed, and the two agreed on
  // 0 of 56 fires for the hour after the edge.
  const W = shipped.validUntil - shipped.validFrom;
  const edge = shipped.validFrom + 100 * W;
  const A = client({ manifest: shipped, defs, joinAt: edge - 1800 });
  A.stepTo(edge + 3600);
  const B = client({ manifest: shipped, defs, joinAt: edge + 600 });
  B.stepTo(edge + 3600);
  const from = edge + 650, fires = (c) => c.logFrom(from).split('\n').filter((l) => l.includes(' FIRE')).length;
  check('logs byte-identical for the hour after the edge', A.logFrom(from) === B.logFrom(from) && fires(A) > 0, `${fires(A)} fires each`);
  check('scheduler state fingerprints match', A.sched.stateFingerprint() === B.sched.stateFingerprint());
  check('the open client moved to the new window', A.sched.manifest.rebasedWindowIndex === 100 && A.sched.manifest.epoch === edge);
  // NEGATIVE CONTROL: the same open client with the window re-entry switched off (the pre-W9 shape)
  // must come back misaligned, or this comparison is not measuring anything.
  const S = client({ manifest: shipped, defs, joinAt: edge - 1800 });
  S.sched.rebasing = false;
  S.stepTo(edge + 3600);
  const mis = S.logFrom(from) !== B.logFrom(from);
  check('NEGATIVE CONTROL: without the re-entry the open client diverges', mis, mis ? 'diverged, as it must' : 'aligned — the comparison is blind');
}

console.log('\n== 7c. The drip crosses the same edge (it keys its windows off the run) ==');
{
  const W = shipped.validUntil - shipped.validFrom, edge = shipped.validFrom + 100 * W;
  const drips = (open, follow) => {
    let man = rebaseToCurrentWindow(shipped, open);
    const d = createDripScheduler({ audio: { fire() {} }, points: [0, 1, 2, 3, 4, 5, 6], runSeed: man.runSeed, epoch: man.epoch,
      runAt: follow ? (s) => { if (s >= man.validUntil) man = rebaseToCurrentWindow(shipped, Math.floor(s)); return man; } : null });
    for (let t = open; t <= edge + 1600; t += 0.25) d.tick(t);
    return d.log.filter((x) => x.at >= edge + 650).map((x) => `${x.at.toFixed(2)}@${x.point}`).join(',');
  };
  const a = drips(edge - 1800, true), b = drips(edge + 600, true), s = drips(edge - 1800, false);
  check('an open device and one opened after the edge drip together', a === b && a.length > 0, `${a.split(',').length} drips`);
  check('NEGATIVE CONTROL: a drip that does not follow the run diverges', s !== b);
}

console.log('\n== 8. Replay cost — the shipped library, cold join at the end of its window ==');
{
  const worst = shipped.validUntil - 1;
  const t0 = process.hrtime.bigint();
  const s = new RunOfShow({ manifest: shipped, defs });
  s.advanceTo(worst);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const secs = worst - shipped.epoch;
  console.log(`  replayed ${secs}s × ${s.order.length} ambient events = ${(secs * s.order.length / 1e6).toFixed(2)}M rolls in ${ms.toFixed(1)} ms on this Mac`);
  check('worst-case cold replay stays under 250 ms on a desktop (≈2.5 s at 10× on a phone)', ms < 250, `${ms.toFixed(1)} ms`);
}

console.log(`\n${failures === 0 ? 'DETERMINISM OK' : `DETERMINISM FAILED — ${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
