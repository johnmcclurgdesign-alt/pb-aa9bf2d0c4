#!/usr/bin/env node
/**
 * dwell-plan — what the shared schedule WILL show in a watched window, before anyone sits down.
 *
 *   node tools/dwell-plan.mjs                        # the next 30 minutes from now, local time
 *   node tools/dwell-plan.mjs --at 2026-09-24T19:10  # a window starting then (local time)
 *   node tools/dwell-plan.mjs --find ride --hours 6  # every jar ride due in the next six hours
 *
 * WHY (W9). Schedule state is a pure function of (manifest, library, second) — so a device leg does not
 * have to hope a rare beat turns up while somebody is watching; it can be told the minute. A watched
 * dwell becomes a checklist with times, and a beat that was due and did not appear is a finding rather
 * than bad luck. This is the SHIPPING scheduler (tools/events/runofshow.js) and the seed manifest, rebased
 * exactly as the Loop rebases it, so the plan and the room agree to the second (± the device clock).
 * ⚠ Only AMBIENT events are here. User events (a jar knock, the radio, the dial) happen when a viewer
 *   presses, and the drip is on its own ~22 s bed; the checklist carries both as things to DO or hear.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunOfShow } from './events/runofshow.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = path.join(ROOT, 'assets', 'dripping-pickle');
const seed = JSON.parse(fs.readFileSync(path.join(A, 'run-of-show.json'), 'utf8'));
const idx = JSON.parse(fs.readFileSync(path.join(A, 'events', 'index.json'), 'utf8'));
const defs = idx.events.map((id) => JSON.parse(fs.readFileSync(path.join(A, 'events', `${id}.json`), 'utf8')));

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const minutes = Number(arg('--minutes', 30));
const at = arg('--at', null);
const start = at ? Math.floor(new Date(at).getTime() / 1000) : Math.floor(Date.now() / 1000);
const find = arg('--find', null), hours = Number(arg('--hours', 6));

// What a person watching sees for each ambient fire, in the words of the room.
const SAY = {
  delivery_mission: (d) => `MISSION on the screens${d.city ? ` — ${d.city}` : ''}${d.cargo ? ` (${d.cargo})` : ''}`,
  mission_report: () => 'MISSION REPORT on the screens',
  cat_hunts: () => 'CAT hunts the mouse',
  cat_stirs: () => 'CAT stirs (gets up / moves)',
  mouse_errand: () => 'MOUSE errand across the floor',
  mouse_belt_run: (d) => (d.mode === 'ride' ? '★ JAR RIDE — the mouse rides a jar lid along the belt' : 'MOUSE runs the belt rail') +
    (d.roll < 0.04 ? ' · and knocks a jar OFF the belt' : ' · a jar wobbles'),
  pendant_flicker: () => 'pendant light flickers',
  signal_interference: () => 'screens: signal interference',
  conveyor_stall: () => 'BELT STALLS, one jar trembles, restarts',
};

/** Every ambient fire in [from, from + sec), from a client that opened at `from` (it replays to it). */
function firesIn(from, sec) {
  const s = new RunOfShow({ manifest: seed, defs, nowSecond: from });
  s.advanceTo(from - 1);
  const out = [];
  for (let t = from; t < from + sec; t++) for (const f of s.advanceTo(t)) if (f.elapsed === 0) out.push(f);
  return out;
}
const clock = (t) => new Date(t * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });

if (find) {
  const want = find === 'ride' ? (f) => f.id === 'mouse_belt_run' && f.draws.mode === 'ride' : (f) => f.id === find;
  console.log(`every ${find} due in the next ${hours} h (a dwell that starts up to ${minutes} min before one holds it):`);
  const all = firesIn(start, hours * 3600 + minutes * 60).filter(want);
  for (const f of all) console.log(`  ${clock(f.second)}  (${new Date(f.second * 1000).toISOString()})  ${SAY[f.id]?.(f.draws) ?? f.id}`);
  if (!all.length) console.log('  none');
  process.exit(0);
}

const fires = firesIn(start, minutes * 60);
console.log(`Dwell plan — ${clock(start)} to ${clock(start + minutes * 60)} (${minutes} min), ${fires.length} scheduled beats`);
for (const f of fires) {
  const m = Math.floor((f.second - start) / 60), s = (f.second - start) % 60;
  console.log(`  +${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}  ${clock(f.second)}  ${SAY[f.id]?.(f.draws) ?? f.id}`);
}
const has = (id, pred = () => true) => fires.some((f) => f.id === id && pred(f));
console.log('\nchecklist coverage in this window:');
for (const [label, ok] of [
  ['missions', has('delivery_mission')], ['report', has('mission_report')],
  ['cat beats', has('cat_hunts') || has('cat_stirs')], ['mouse beats', has('mouse_errand') || has('mouse_belt_run')],
  ['JAR RIDE', has('mouse_belt_run', (f) => f.draws.mode === 'ride')],
]) console.log(`  ${ok ? 'due' : 'NOT due'}  ${label}`);
console.log('  (do)   jar knock — press a jar yourself');
console.log('  (hear) drip — about every 22 s, all the time');
