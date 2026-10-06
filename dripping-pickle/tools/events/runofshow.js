// tools/events/runofshow.js — WHEN things happen. Pure: no DOM, no three.js, no I/O.
//
// The loop imports this, and so do tools/events-sim.mjs and tools/events-determinism.mjs, so the
// schedule the tools print is the schedule the loop runs and not a second model of it.
//
// ── THE RULE ───────────────────────────────────────────────────────────────────────────────────
//
//     SCHEDULE STATE IS A PURE FUNCTION OF (manifest, library, second). NOTHING ELSE.
//
// Not of join time, not of what this viewer did, not of how long the tab has been open. A client
// arriving at any moment REPLAYS from the manifest epoch and lands on byte-identical cooldown and
// channel tables. loops-docs 10-platform/55 measured why the shared clock alone is not enough: two
// clients joining 120 s apart agreed on 50.0% of fires over their first 300 s, because the Godot
// prior art accumulated those tables as local history. That flaw is FRONT-LOADED — worst at the
// moment somebody opens a second device next to the first.
//
// ── WHAT THE MANIFEST IS, HERE ─────────────────────────────────────────────────────────────────
// The reference Loop inlines its events in the manifest. Dripping Pickle keeps EventDefs as files
// (the world side: tracks, draws, responses) and the manifest carries the run: runSeed, epoch,
// validity window, optional per-event schedule OVERRIDES keyed by id, and `cues` — absolute seconds
// at which a named event fires with authored draws. Cues are timestamp-scripted playback: an episode
// is a manifest with cues and no engine change. The wire hash and the evaluation order are exactly
// loops-docs §3–§4; what this file adds on top is documented in docs/EVENTS.md and pushed back to
// loops-docs as findings.
//
// ── RESUME ─────────────────────────────────────────────────────────────────────────────────────
// advanceTo(now) after a pause replays every missed second for STATE and emits only fires still in
// flight or within a few seconds of now. ⚠ It never resets to "now" — resetting is what made a
// resumed client diverge from one that never slept. An in-flight fire is emitted with `elapsed`, so
// executors pick it up mid-breath rather than from the top (55 §5, corrected 2026-08-27).

import { roll, fmix32, prefixState, rollFromPrefix } from './roll.js';
import { probabilityPerSecond, normaliseEventDef, validateEventDef, validateLibrary } from './eventdef.js';

/** A fire older than this is replayed for STATE but not emitted, unless its duration still covers
 *  now. State is always complete; emission is windowed, so a resume is never a burst. */
export const EMIT_HORIZON_SEC = 3;

/** Replay is bounded by the validity window, and the ceiling keeps that honest. */
export const MAX_REPLAY_SEC = 30 * 24 * 3600;

// ── the manifest ───────────────────────────────────────────────────────────────────────────────

export function validateManifest(m) {
  const e = [];
  if (!m || typeof m !== 'object') return ['manifest is not an object'];
  if (m.manifestVersion !== 1) e.push(`manifestVersion must be 1, got ${m.manifestVersion}`);
  for (const f of ['runSeed', 'epoch', 'validFrom', 'validUntil', 'prefetchLeadSec']) {
    if (!Number.isInteger(m[f])) e.push(`${f} must be an integer second`);
  }
  if (e.length) return e;
  if (m.epoch > m.validFrom) e.push('epoch must not be after validFrom');
  if (m.validUntil <= m.validFrom) e.push('validUntil must be after validFrom');
  if (m.prefetchLeadSec <= 0) e.push('prefetchLeadSec must be positive');
  if (m.validUntil - m.epoch > MAX_REPLAY_SEC) e.push(`replay span ${m.validUntil - m.epoch}s exceeds the ${MAX_REPLAY_SEC}s ceiling`);
  if (m.events !== undefined && !(m.events && typeof m.events === 'object' && !Array.isArray(m.events))) {
    e.push('events must be an object of per-id schedule overrides (the EventDefs themselves live in the library)');
  }
  for (const c of m.cues ?? []) {
    if (!Number.isInteger(c.at)) e.push(`cue for '${c.event}' needs an integer at`);
    if (!c.event) e.push(`cue at ${c.at} names no event`);
  }
  return e;
}

/**
 * ★ A SEED MANIFEST AGES, AND REPLAY GROWS WITHOUT BOUND. The shell's refresh channel is specified
 * and not built, so a bundled Loop runs on its seed forever — and replay runs epoch → now, which
 * lengthens every day the install exists (loops-docs 55 §6: 243 ms on a Mac for a manifest 27.8 h
 * old, months of seconds after an App Store release). Past validUntil the window rolls forward by
 * whole windows and runSeed is re-derived per window, so consecutive windows are different evenings
 * rather than the same six hours repeating. A pure function of (manifest, wall clock), so every
 * device computes the same window index. Cues are absolute and are NOT shifted.
 */
export function rebaseToCurrentWindow(manifest, nowSecond) {
  const windowSec = manifest.validUntil - manifest.validFrom;
  if (!(windowSec > 0) || nowSecond < manifest.validUntil) return manifest;
  const windowIndex = Math.floor((nowSecond - manifest.validFrom) / windowSec);
  const shift = windowIndex * windowSec;
  return {
    ...manifest,
    runSeed: fmix32((manifest.runSeed ^ fmix32(windowIndex)) >>> 0),
    epoch: manifest.epoch + shift,
    validFrom: manifest.validFrom + shift,
    validUntil: manifest.validUntil + shift,
    rebasedWindowIndex: windowIndex,
  };
}

/** Apply the manifest's per-event overrides to the library. The library is the world; the manifest
 *  is the run. A fetched manifest can retune or disable an event without shipping a payload. */
export function applyOverrides(defs, manifest) {
  const ov = manifest.events ?? {};
  return defs.map((d) => {
    const o = ov[d.id];
    if (!o) return d;
    const out = { ...d };
    if (o.enabled !== undefined) out.enabled = o.enabled;
    if (o.priority !== undefined) out.priority = o.priority;
    if (o.durationSec !== undefined) out.durationSec = o.durationSec;
    if (o.schedule) out.schedule = { ...(d.schedule ?? {}), ...o.schedule };
    return out;
  });
}

// ── content draws ──────────────────────────────────────────────────────────────────────────────

/**
 * Values that vary per occurrence, drawn from the fire second so every viewer draws identically.
 * ★ A synchronised EVENT is not a synchronised EXPERIENCE. Anything a viewer can SEE vary comes
 * from here, never from a Math.random() inside the thing being driven.
 */
export function drawsFor(runSeed, def, second) {
  const out = {};
  let stream = 0;
  for (const d of def.draws ?? []) {
    if (d.kind === 'column') {
      // Reads across a row already picked by `indexFrom` and consumes NOTHING, which is what makes
      // adding one later safe: the draws below it are unmoved.
      out[d.name] = d.pool[out[d.indexFrom]];
      continue;
    }
    const u = roll(runSeed, def.id, def.salt, second, `#draw${stream++}`);
    if (d.kind === 'pick') out[d.name] = d.pool[Math.floor(u * d.pool.length)];
    else if (d.kind === 'pickIndex') out[d.name] = Math.floor(u * d.indexCount);
    else if (d.kind === 'range') out[d.name] = d.min + u * (d.max - d.min);
  }
  return out;
}

// ── the scheduler ──────────────────────────────────────────────────────────────────────────────

export class RunOfShow {
  /**
   * @param {object} o
   * @param {object} o.manifest   the run-of-show manifest (seed or fetched)
   * @param {object[]} o.defs     EventDefs (raw JSON is fine; they are normalised here)
   * @param {number} [o.nowSecond] the current unix second, for rebasing an aged seed manifest.
   *                               Omit in tools that want the manifest exactly as authored.
   */
  constructor({ manifest, defs, nowSecond = null }) {
    const me = validateManifest(manifest);
    if (me.length) throw new Error('manifest: ' + me.join('; '));
    const normalised = applyOverrides(defs.map(normaliseEventDef), manifest);
    const le = [];
    for (const d of normalised) for (const x of validateEventDef(d)) le.push(`${d.id}: ${x}`);
    le.push(...validateLibrary(normalised));
    if (le.length) throw new Error('library: ' + le.join('; '));

    this.defs = new Map(normalised.map((d) => [d.id, d]));
    // ★ priority DESC, then id ASC. Never directory order: a winner that depends on how a
    // filesystem returned files desynchronises two devices.
    this.order = normalised
      .filter((d) => d.enabled && d.kind === 'ambient')
      .sort((a, b) => (b.priority - a.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // ★ A RUNNING CLIENT MUST CROSS A WINDOW EDGE THE WAY A JOINING ONE LANDS ON IT (W9, 2026-09-24).
    // Rebasing only at construction left a device that was open across validUntil rolling the OLD
    // window's seed, while a device opened after the edge rebased onto the new one: measured on the
    // shipped library, the two agreed on 0 of 56 fires over the next hour. The seed's windows turn
    // at 00/06/12/18 UTC, so a 30-minute dwell crosses one about one time in twelve. So the seed is
    // kept, and advanceTo() re-enters the window it is in — new seed, new epoch, state replayed from
    // that epoch — exactly as a client opening at that second would. `rebasing` is off for the tools
    // that want the manifest as authored (nowSecond omitted).
    this.seedManifest = manifest;
    this.rebasing = nowSecond !== null;
    this._useManifest(this.rebasing ? rebaseToCurrentWindow(manifest, nowSecond) : manifest);
  }

  /** Point the scheduler at one window's manifest: prefix states, cues, empty state. */
  _useManifest(m) {
    this.manifest = m;
    // One FNV prefix state per (event, stream), computed once per window. Replay is the hot path.
    this.prefix = new Map();
    for (const d of this.order) {
      this.prefix.set(d.id, {
        fire: prefixState(this.manifest.runSeed, d.id, d.salt, ''),
        gap: prefixState(this.manifest.runSeed, d.id, d.salt, '#gap'),
        p: probabilityPerSecond(d.schedule.meanGapSec, d.schedule.minGapSec),
      });
    }
    // Cues by second. Absolute, never rebased; a cue outside the window simply never comes up.
    this.cues = new Map();
    for (const c of this.manifest.cues ?? []) {
      if (!this.defs.has(c.event)) throw new Error(`manifest cue at ${c.at} names unknown event '${c.event}'`);
      if (!this.cues.has(c.at)) this.cues.set(c.at, []);
      this.cues.get(c.at).push(c);
    }
    for (const list of this.cues.values()) list.sort((a, b) => (a.event < b.event ? -1 : 1));
    this.reset();
  }

  reset() {
    this.nextEligible = new Map();   // id -> second it may next fire
    this.channelFreeAt = new Map();  // channel -> second it is released
    this.lastEvaluated = null;
  }

  covers(second) { return second >= this.manifest.validFrom && second < this.manifest.validUntil; }
  shouldPrefetch(second) { return second >= this.manifest.validUntil - this.manifest.prefetchLeadSec; }

  /**
   * Evaluate every whole second up to and including `second`; return the fires to SHOW now. The
   * first call replays from the epoch — that is what lands a late joiner on identical state. Each
   * emitted fire carries `elapsed` (seconds since it fired), non-zero for an in-flight fire found
   * on resume or join, so executors can seek rather than start from the top.
   */
  advanceTo(second) {
    if (this.lastEvaluated === null) this.lastEvaluated = this.manifest.epoch - 1;
    const emitted = [];
    while (this.lastEvaluated < second) {
      // Past the edge: re-enter the window this second belongs to, and replay it from its epoch.
      // A fire still in flight from the old window stays with the runner that is playing it; the
      // new window's state starts where a client opening now would start it.
      if (this.rebasing && this.lastEvaluated + 1 >= this.manifest.validUntil) {
        this._useManifest(rebaseToCurrentWindow(this.seedManifest, this.lastEvaluated + 1));
        this.lastEvaluated = this.manifest.epoch - 1;
        continue;
      }
      this.lastEvaluated += 1;
      const now = this.lastEvaluated;
      for (const f of this._evaluateSecond(now)) {
        const age = second - now;
        if (age <= EMIT_HORIZON_SEC || age < f.durationSec) emitted.push({ ...f, elapsed: age });
      }
    }
    return emitted;
  }

  /** All fires in one second, cues first (scripted playback pre-empts the roll), then the roll in
   *  priority order. Public so the tools collect EVERY fire rather than only the emitted ones. */
  _evaluateSecond(now) {
    const fires = [];
    for (const c of this.cues.get(now) ?? []) {
      const def = this.defs.get(c.event);
      this._claim(def, now);
      const draws = { ...drawsFor(this.manifest.runSeed, def, now), ...(c.draws ?? {}) };
      fires.push({ id: def.id, second: now, draws, durationSec: def.durationSec, cue: true });
    }
    for (const def of this.order) {
      if (now < (this.nextEligible.get(def.id) ?? -Infinity)) continue;
      // Dropped, never queued: a queued event fires a fixed offset behind the one it waited on.
      if (!this._channelsFree(def, now)) continue;
      const px = this.prefix.get(def.id);
      if (rollFromPrefix(px.fire, now) >= px.p) continue;
      this._claim(def, now);
      fires.push({ id: def.id, second: now, draws: drawsFor(this.manifest.runSeed, def, now), durationSec: def.durationSec, cue: false });
    }
    return fires;
  }

  _channelsFree(def, now) {
    for (const ch of def.exclusive) if (now < (this.channelFreeAt.get(ch) ?? -Infinity)) return false;
    return true;
  }

  _claim(def, now) {
    if (def.schedule) {
      // Jitter the cooldown per occurrence from this event's own stream, so successive gaps never
      // settle onto the floor and turn into a beat a viewer can feel coming.
      const px = this.prefix.get(def.id);
      const j = (px ? rollFromPrefix(px.gap, now) : roll(this.manifest.runSeed, def.id, def.salt, now, '#gap')) - 0.5;
      const gap = def.schedule.minGapSec * (1 + def.schedule.gapJitter * j);
      this.nextEligible.set(def.id, now + Math.ceil(gap));
    }
    for (const ch of def.exclusive) this.channelFreeAt.set(ch, now + Math.ceil(def.durationSec));
  }

  /** Two devices agreeing on fires is necessary, not sufficient — they must agree on the state that
   *  decides the NEXT hour. */
  stateFingerprint() {
    const parts = [];
    for (const id of [...this.nextEligible.keys()].sort()) parts.push(`${id}=${this.nextEligible.get(id)}`);
    for (const ch of [...this.channelFreeAt.keys()].sort()) parts.push(`${ch}@${this.channelFreeAt.get(ch)}`);
    return parts.join(',');
  }

  /** Draws for a def at a second, from THIS run's seed — the runner uses it for local triggers. */
  drawsFor(id, second) {
    const def = this.defs.get(id);
    return def ? drawsFor(this.manifest.runSeed, def, second) : {};
  }
}
