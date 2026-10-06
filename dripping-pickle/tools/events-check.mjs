// tools/events-check.mjs — is the event library well formed, and can the scene actually play it?
//
//   node tools/events-check.mjs
//
// Refuses to pass anything that would fire, log, align, and do nothing. Every rule here is a
// failure that is silent in the browser: a file the index forgot, an id that drifted from its
// filename, a salt two events share, a track naming a target no executor implements.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseEventDef, validateEventDef, validateLibrary, CHANNELS } from './events/eventdef.js';
import { RunOfShow, validateManifest } from './events/runofshow.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(REPO, 'assets', 'dripping-pickle');
const EVENTS_DIR = path.join(ASSETS, 'events');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

/** Read the library from disk the way the browser reads it from index.json — and cross-check. */
export function loadLibraryFs() {
  const index = JSON.parse(fs.readFileSync(path.join(EVENTS_DIR, 'index.json'), 'utf8'));
  const onDisk = fs.readdirSync(EVENTS_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => f.replace(/\.json$/, '')).sort();
  const listed = [...index.events].sort();
  const raws = listed.map((id) => ({ id, raw: JSON.parse(fs.readFileSync(path.join(EVENTS_DIR, `${id}.json`), 'utf8')) }));
  const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'run-of-show.json'), 'utf8'));
  return { index: listed, onDisk, raws, manifest, defs: raws.map((r) => normaliseEventDef(r.raw)) };
}

const lib = loadLibraryFs();
const vocab = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'events', 'vocabulary.json'), 'utf8'));

console.log('== the folder and its index agree ==');
{
  const missing = lib.onDisk.filter((id) => !lib.index.includes(id));
  const phantom = lib.index.filter((id) => !lib.onDisk.includes(id));
  check('every event file is listed in index.json', missing.length === 0, missing.length ? `NOT LISTED: ${missing.join(', ')}` : `${lib.onDisk.length} files`);
  check('index.json names no file that does not exist', phantom.length === 0, phantom.join(', '));
  check('the library is not empty', lib.index.length > 0);
}

console.log('\n== every event is well formed ==');
for (const { id, raw } of lib.raws) {
  const def = normaliseEventDef(raw);
  const problems = raw.id === id ? validateEventDef(def) : [`id '${raw.id}' does not match filename '${id}.json'`];
  check(`${id.padEnd(22)} ${def.kind.padEnd(7)} salt ${String(def.salt).padStart(5)}`, problems.length === 0, problems.join('; '));
}
{
  const cross = validateLibrary(lib.defs);
  check('ids, salts and trigger targets are unique across the library', cross.length === 0, cross.join('; '));
}

console.log('\n== every track names something the scene can do (tools/events/vocabulary.json) ==');
// A drawn target is resolved against every value its draw pool can produce.
function targetsOf(def, track) {
  const m = String(track.target).match(/^\{([a-zA-Z0-9_]+)\}$/);
  if (!m) return [track.target];
  const d = def.draws.find((x) => x.name === m[1]);
  if (!d) return [track.target];
  if (d.kind === 'pick' || d.kind === 'column') return [...new Set(d.pool.map(String))];
  return [track.target];
}
for (const def of lib.defs) {
  const bad = [];
  for (const t of def.tracks) {
    const ch = vocab[t.channel] || {};
    for (const target of targetsOf(def, t)) {
      const actions = ch[target] || ch['*'];
      if (!actions || !actions.includes(t.action)) bad.push(`${t.channel}/${target}/${t.action}`);
    }
  }
  check(`${def.id.padEnd(22)} ${def.tracks.length} track(s) all executable`, bad.length === 0, bad.length ? `NO EXECUTOR FOR: ${bad.join(', ')}` : '');
}
check('the vocabulary only names real channels', Object.keys(vocab).filter((k) => k !== '_').every((k) => CHANNELS.includes(k)));

console.log('\n== the seed manifest ==');
{
  const me = validateManifest(lib.manifest);
  check('run-of-show.json validates', me.length === 0, me.join('; '));
  const windowH = (lib.manifest.validUntil - lib.manifest.validFrom) / 3600;
  check('validity window is bounded (replay cost on a phone)', windowH > 0 && windowH <= 24, `${windowH} h`);
  for (const id of Object.keys(lib.manifest.events ?? {})) check(`override '${id}' names a library event`, lib.defs.some((d) => d.id === id));
  for (const c of lib.manifest.cues ?? []) check(`cue at ${c.at} names a library event`, lib.defs.some((d) => d.id === c.event), c.event);
}

console.log('\n== the scheduler accepts the library as shipped ==');
{
  let ok = true, detail = '';
  try {
    const s = new RunOfShow({ manifest: lib.manifest, defs: lib.defs, nowSecond: Math.floor(Date.now() / 1000) });
    const ambient = s.order.map((d) => d.id);
    detail = `ambient order: ${ambient.join(' > ')}; rebased window ${s.manifest.rebasedWindowIndex ?? 0}`;
    check('at least one ambient event is scheduled', ambient.length > 0);
  } catch (e) { ok = false; detail = e.message; }
  check('RunOfShow constructs', ok, detail);
}

console.log(`\n${failures === 0 ? 'EVENTS CHECK OK' : `EVENTS CHECK FAILED — ${failures}`}`);
process.exit(failures === 0 ? 0 : 1);
