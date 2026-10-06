// tools/events/eventdef.js — one authored Loop event, as data. The schema and its validator.
//
// An event is one JSON file in assets/dripping-pickle/events/. Adding one touches no engine code:
// docs/EVENTS.md is the authoring guide, and this file is the only place the shape is defined.
// The Godot plan's §4 design (EventDef as data, shared vs local per track, naturalness as a
// requirement) is ported here as a schema, not as code.
//
// The shape:
//
//   {
//     "id": "conveyor_stall",              // == filename stem; what the log and the tools grep for
//     "kind": "ambient",                   // ambient: shared clock. user: local trigger only.
//     "enabled": true,
//     "description": "authors only",
//     "salt": 4101,                        // this event's private PRNG stream — NEVER reused
//     "schedule": {                        // ambient only. Gaps, never probabilities.
//       "meanGapSec": 3600, "minGapSec": 1800, "gapJitter": 0.4
//     },
//     "trigger": { "target": "conveyor" }, // optional on ambient (two paths, one timeline);
//                                          // required on user
//     "durationSec": 9,                    // how long it holds its channel(s); cover the last track
//     "exclusive": ["conveyor"],           // a channel name, or a list — DROPPED when busy, never queued
//     "priority": 0,                       // ties on a channel: priority desc, then id asc
//     "draws": [ ... ],                    // content that varies per occurrence (see below)
//     "tracks": [                          // the timeline. `at` seconds after the fire.
//       { "channel": "equipment", "target": "conveyor", "action": "stall", "at": 0,
//         "params": { "seconds": 6 }, "when": "" }
//     ],
//     "localResponse": {                   // optional: a per-viewer response on a SHARED event
//       "inputTarget": "answer_", "windowSec": 10, "defaultOutcome": "none",
//       "correctFromDraw": "answer"
//     }
//   }
//
// Timestamp-scripted playback (episode mode, Production) needs NOTHING added here: every track is
// already a timestamp, and the run-of-show manifest carries `cues` — absolute seconds at which a
// named event fires with authored draws. See runofshow.js. The schema was designed for that from
// day one (PLAN decision 6) so an episode is a manifest, not a second engine.

export const KINDS = ['ambient', 'user'];
export const CHANNELS = ['screens', 'audio', 'npc', 'equipment'];
export const DRAW_KINDS = ['pick', 'pickIndex', 'range', 'column'];
export const OUTCOMES = ['correct', 'wrong', 'none'];

/** Fill defaults so every consumer reads one shape. Does not validate. */
export function normaliseEventDef(raw) {
  const d = { ...raw };
  d.kind = d.kind ?? 'ambient';
  d.enabled = d.enabled !== false;
  d.description = d.description ?? '';
  d.priority = d.priority ?? 0;
  d.durationSec = d.durationSec ?? 1;
  d.exclusive = channelsOf(d);
  d.draws = d.draws ?? [];
  d.tracks = (d.tracks ?? []).map((t) => ({
    channel: t.channel, target: t.target ?? '', action: t.action ?? '',
    at: t.at ?? 0, params: t.params ?? {}, when: t.when ?? '',
  }));
  if (d.schedule) {
    d.schedule = { gapJitter: 0.35, ...d.schedule };
  }
  if (d.localResponse) {
    d.localResponse = { windowSec: 10, defaultOutcome: 'none', correctFromDraw: '', ...d.localResponse };
  }
  return d;
}

/** `exclusive` accepts a string or a list; everything downstream sees a list. */
export function channelsOf(def) {
  const x = def.exclusive;
  if (!x) return [];
  return Array.isArray(x) ? x.filter(Boolean) : [x];
}

/**
 * Per-second fire probability from an authored mean gap. The mean gap INCLUDES the cooldown, so
 * the roll only has (mean - min) seconds of window to hit its rate — rolling against 1/mean would
 * make every event slower than authored by exactly its cooldown. One place, so the loop and the
 * simulator cannot disagree about what the number means.
 */
export function probabilityPerSecond(meanGapSec, minGapSec) {
  const window = Math.max(meanGapSec - minGapSec, 1);
  return Math.min(Math.max(1 / window, 0), 1);
}

/** Tracks with no `when` are the shared timeline. */
export const sharedTracks = (def) => def.tracks.filter((t) => !t.when);
/** Tracks gated on a local-response outcome. */
export const outcomeTracks = (def, outcome) => def.tracks.filter((t) => t.when === outcome);

/**
 * Author-error report, empty when the def is well formed. Every rule here is a way an event
 * silently never fires, fires wrongly, or desynchronises two viewers.
 */
export function validateEventDef(def) {
  const e = [];
  const id = def.id;
  if (!id || typeof id !== 'string') return ['id is missing'];
  if (!/^[a-z][a-z0-9_]*$/.test(id)) e.push(`id '${id}' must be snake_case (it is a filename and a log token)`);
  if (!KINDS.includes(def.kind)) e.push(`kind must be one of ${KINDS.join('|')}, got '${def.kind}'`);
  if (!Number.isInteger(def.salt)) e.push('salt must be an integer (this event\'s private PRNG stream)');

  if (def.kind === 'ambient') {
    const s = def.schedule;
    if (!s) e.push('ambient event needs a schedule { meanGapSec, minGapSec, gapJitter }');
    else {
      if (!(s.minGapSec > 0)) e.push('schedule.minGapSec must be positive');
      if (!(s.meanGapSec > s.minGapSec)) e.push(`schedule.meanGapSec (${s.meanGapSec}) must exceed minGapSec (${s.minGapSec}) — the event could never reach its authored rate`);
      // A frequent event with no jitter fires the instant its cooldown lifts, every time, and
      // acquires a beat. The single most likely way to author train tracks.
      if (!(s.gapJitter > 0) && s.meanGapSec < 3600) e.push('schedule.gapJitter must be > 0 for anything firing more than once an hour');
      if (s.gapJitter > 2) e.push('schedule.gapJitter above 2 lets the jittered floor go negative');
      if (def.exclusive.length && def.durationSec > s.minGapSec) {
        e.push(`durationSec (${def.durationSec}) exceeds minGapSec (${s.minGapSec}) — it would hold its channel past its own next eligibility`);
      }
    }
  } else if (!def.trigger || !def.trigger.target) {
    e.push('user event needs trigger.target (the hotspot id that fires it)');
  }
  if (def.trigger && typeof def.trigger.target !== 'string') e.push('trigger.target must be a string');
  if (!(def.durationSec > 0)) e.push('durationSec must be positive');
  for (const ch of def.exclusive) if (typeof ch !== 'string' || !ch) e.push('exclusive channel names must be non-empty strings');

  // Draws: one stream consumed top to bottom, so order is part of the event's identity.
  // A trigger's declared inputs (what the tap itself supplies — WHICH jar) are readable by tracks
  // like draws; they are the one kind of content that is local by nature.
  const drawNames = new Set();
  if (def.trigger && def.trigger.inputs !== undefined) {
    if (!Array.isArray(def.trigger.inputs) || def.trigger.inputs.some((x) => typeof x !== 'string')) e.push('trigger.inputs must be a list of names');
    else for (const n of def.trigger.inputs) drawNames.add(n);
  }
  const indexCounts = new Map();
  for (const d of def.draws) {
    if (!d.name) { e.push('a draw has no name'); continue; }
    if (drawNames.has(d.name)) e.push(`duplicate draw '${d.name}'`);
    drawNames.add(d.name);
    if (!DRAW_KINDS.includes(d.kind)) { e.push(`draw '${d.name}': kind must be one of ${DRAW_KINDS.join('|')}`); continue; }
    if (d.kind === 'pick' && (!Array.isArray(d.pool) || d.pool.length === 0)) e.push(`draw '${d.name}': pick needs a non-empty pool`);
    if (d.kind === 'pickIndex') {
      if (!(Number.isInteger(d.indexCount) && d.indexCount > 0)) e.push(`draw '${d.name}': pickIndex needs a positive integer indexCount`);
      else indexCounts.set(d.name, d.indexCount);
    }
    if (d.kind === 'range' && !(typeof d.min === 'number' && typeof d.max === 'number' && d.max >= d.min)) e.push(`draw '${d.name}': range needs numeric min <= max`);
    if (d.kind === 'column') {
      // The stream is consumed top to bottom; a column naming an index BELOW it would read row 0
      // forever — identically on every device, so no alignment check could ever catch it.
      if (!indexCounts.has(d.indexFrom)) e.push(`draw '${d.name}': column reads '${d.indexFrom}', which is not a pickIndex listed above it`);
      else if (!Array.isArray(d.pool) || d.pool.length !== indexCounts.get(d.indexFrom)) {
        e.push(`draw '${d.name}': column has ${d.pool ? d.pool.length : 0} rows but '${d.indexFrom}' spans ${indexCounts.get(d.indexFrom)} — the columns would not line up`);
      }
    }
  }

  // Tracks.
  let lastAt = 0;
  if (def.tracks.length === 0) e.push('an event with no tracks fires, logs, aligns, and does nothing');
  for (const t of def.tracks) {
    const label = `track ${t.channel}/${t.target}/${t.action}`;
    if (!CHANNELS.includes(t.channel)) e.push(`${label}: channel must be one of ${CHANNELS.join('|')}`);
    if (!t.action) e.push(`${label}: action is missing`);
    if (!(t.at >= 0)) e.push(`${label}: at must be >= 0`);
    if (t.when && !OUTCOMES.includes(t.when)) e.push(`${label}: when must be one of ${OUTCOMES.join('|')} or empty`);
    if (t.when && !def.localResponse) e.push(`${label}: is gated on '${t.when}' but the event has no localResponse`);
    if (!t.when) lastAt = Math.max(lastAt, t.at);
    for (const ref of drawRefs(t)) {
      if (!drawNames.has(ref)) e.push(`${label}: references draw '{${ref}}', which does not exist`);
    }
  }
  if (lastAt > def.durationSec) e.push(`the last shared track is at ${lastAt}s but durationSec is ${def.durationSec} — the channel would be released before the timeline ends`);

  const lr = def.localResponse;
  if (lr) {
    if (!lr.inputTarget) e.push('localResponse.inputTarget is missing');
    if (!(lr.windowSec > 0)) e.push('localResponse.windowSec must be positive');
    if (!OUTCOMES.includes(lr.defaultOutcome)) e.push(`localResponse.defaultOutcome must be one of ${OUTCOMES.join('|')}`);
    if (lr.correctFromDraw && !drawNames.has(lr.correctFromDraw)) e.push(`localResponse.correctFromDraw names '${lr.correctFromDraw}', which is not a draw`);
    if (lr.windowSec > def.durationSec) e.push(`localResponse.windowSec (${lr.windowSec}) exceeds durationSec (${def.durationSec})`);
  }
  return e;
}

/** Every `{name}` a track references, in its target and its string params. */
export function drawRefs(track) {
  const out = new Set();
  const scan = (s) => { for (const m of String(s).matchAll(/\{([a-zA-Z0-9_]+)\}/g)) out.add(m[1]); };
  scan(track.target);
  for (const v of Object.values(track.params ?? {})) if (typeof v === 'string') scan(v);
  return [...out];
}

/** Cross-event rules: ids and salts unique. Two events sharing a salt fire in lockstep, and the
 *  collision surfaces only as a vague "these always happen together" a long way from its cause. */
export function validateLibrary(defs) {
  const e = [];
  const ids = new Map(), salts = new Map();
  for (const d of defs) {
    if (ids.has(d.id)) e.push(`duplicate event id '${d.id}'`);
    ids.set(d.id, d);
    if (Number.isInteger(d.salt)) {
      if (salts.has(d.salt)) e.push(`'${d.id}' reuses salt ${d.salt} (also '${salts.get(d.salt)}')`);
      salts.set(d.salt, d.id);
    }
  }
  const triggers = new Map();
  for (const d of defs) {
    const t = d.trigger && d.trigger.target;
    if (!t) continue;
    if (triggers.has(t)) e.push(`'${d.id}' and '${triggers.get(t)}' both claim trigger target '${t}' — a tap can only fire one`);
    triggers.set(t, d.id);
  }
  return e;
}

/**
 * Substitute `{draw}` references. A param that is EXACTLY "{name}" receives the raw value (a float
 * stays a float); inside a longer string it is substituted as text. The target is substituted too,
 * so what plays can be drawn, not only what it says. `at` is never substituted: timing is what the
 * channel window is sized against.
 */
export function substitute(value, draws) {
  if (typeof value !== 'string') return value;
  const exact = value.match(/^\{([a-zA-Z0-9_]+)\}$/);
  if (exact) return exact[1] in draws ? draws[exact[1]] : value;
  return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k) => (k in draws ? String(draws[k]) : m));
}

export function resolveTrack(track, draws) {
  const params = {};
  for (const [k, v] of Object.entries(track.params ?? {})) params[k] = substitute(v, draws);
  return { ...track, target: substitute(track.target, draws), params };
}
