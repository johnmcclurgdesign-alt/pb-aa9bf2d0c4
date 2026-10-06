// tools/events/library.js — load every authored event from assets/dripping-pickle/events/.
//
// This is the whole of "adding an event needs no engine code": drop a JSON file in that folder,
// add its id to index.json (a browser cannot list a directory), and it is live. Validation is
// the same validateEventDef the tools run, so a malformed file surfaces as a console error at
// load rather than as an event that silently never fires.
//
// Browser-only (fetch). The Node tools read the directory with fs and cross-check index.json.

import { normaliseEventDef, validateEventDef, validateLibrary } from './eventdef.js';
import { validateManifest } from './runofshow.js';

// How long the shell gets to answer `runOfShow()` before the seed is used. The channel is
// specified and NOT BUILT on any shell (loops-docs 55 §6, web 20 §3.2), so today every call
// either does not exist or never resolves — and a promise that never resolves must not hold the
// room behind its loading cover.
const SHELL_MANIFEST_WAIT_MS = 1500;

let manifestPromise = null;

/**
 * The run of show this Loop plays: the shell's, when it hands over a valid one for THIS Loop,
 * else the seed inside the payload (the offline floor — a bundled Loop must open with no network).
 * Memoised, so the scheduler and the drip read the SAME manifest: two readers that fetched
 * separately could disagree the day the shell starts answering, and then the drip would run on a
 * different evening from the world.
 * ★ Never a reason to fail. Every refusal falls back to the seed and says why on the device log.
 * @param {string} base  URL of assets/dripping-pickle (no trailing slash)
 * @returns {Promise<{ manifest: object, source: 'shell' | 'seed', why: string }>}
 */
export function loadRunOfShow(base) {
  manifestPromise ??= (async () => {
    const seed = await fetch(`${base}/run-of-show.json`).then((r) => r.json());
    const clv = typeof window !== 'undefined' ? window.collectivus : null;
    if (typeof clv?.runOfShow !== 'function') return { manifest: seed, source: 'seed', why: 'shell has no runOfShow()' };
    let fresh = null, why = '';
    try {
      fresh = await Promise.race([
        Promise.resolve(clv.runOfShow()),
        new Promise((resolve) => setTimeout(() => resolve(undefined), SHELL_MANIFEST_WAIT_MS)),
      ]);
    } catch (e) { why = `runOfShow() threw (${e?.message ?? e})`; }
    if (fresh === undefined && !why) why = `runOfShow() did not answer in ${SHELL_MANIFEST_WAIT_MS} ms`;
    else if (!fresh && !why) why = 'runOfShow() declined';
    else if (fresh && fresh.loopId !== seed.loopId) why = `runOfShow() is for '${fresh.loopId}', not '${seed.loopId}'`;
    else if (fresh) {
      const problems = validateManifest(fresh);
      if (!problems.length) return { manifest: fresh, source: 'shell', why: 'runOfShow()' };
      why = `runOfShow() invalid: ${problems[0]}`;
    }
    return { manifest: seed, source: 'seed', why };
  })();
  return manifestPromise;
}

/**
 * @param {string} base  URL of assets/dripping-pickle (no trailing slash)
 * @returns {Promise<{ defs: object[], manifest: object, manifestSource: string, errors: string[] }>}
 */
export async function loadLibrary(base) {
  const errors = [];
  const [index, ros] = await Promise.all([
    fetch(`${base}/events/index.json`).then((r) => r.json()),
    loadRunOfShow(base),
  ]);
  const manifest = ros.manifest;
  const files = await Promise.all(index.events.map(async (id) => {
    try {
      return { id, raw: await fetch(`${base}/events/${id}.json`).then((r) => r.json()) };
    } catch (e) {
      errors.push(`${id}: failed to load (${e.message})`);
      return null;
    }
  }));
  const defs = [];
  for (const f of files) {
    if (!f) continue;
    if (f.raw.id !== f.id) {
      // The id is what the log prints and what every tool greps for. Letting it drift from the
      // filename makes an event impossible to find from a log line.
      errors.push(`${f.id}.json: id '${f.raw.id}' does not match the filename`);
      continue;
    }
    const def = normaliseEventDef(f.raw);
    const problems = validateEventDef(def);
    if (problems.length) { for (const p of problems) errors.push(`${f.id}: ${p}`); continue; }
    defs.push(def);
  }
  errors.push(...validateLibrary(defs));
  return { defs, manifest, manifestSource: `${ros.source} (${ros.why})`, errors };
}
