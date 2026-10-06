// tools/events/runner.js — HOW an event plays out once it has fired. Pure: no DOM, no three.js.
//
// The scheduler (runofshow.js) decides WHEN. This file takes a fire — from the schedule, from a
// manifest cue, or from a local tap — and walks its timeline: every track at its `at`, resolved
// against the fire's draws, handed to the executor for its channel. Executors are the only thing
// that touches the world, and the scene registers them; this file knows nothing about cats,
// conveyors or screens, which is what keeps "add an event" from ever meaning "add code".
//
// ★ NOTHING IN HERE REACHES THE SCHEDULER. A local trigger, a submitted answer, a track that
// fails — none of it can move when the next shared event fires. If it could, one viewer tapping a
// prop would drift them away from everyone else and the shared clock would stop being shared.
// tools/events-determinism.mjs asserts this by fingerprint, not by reading this comment.
//
// ★ TIMELINE TIME IS WALL CLOCK, NEVER ACCUMULATED FRAME dt. An 8-second stall on a throttled tab
// held for 14 s when its duration was integrated from dt (DP-W3). Tracks are due at
// fireMs + at*1000, where fireMs is derived from the fire's absolute second, so a resumed or
// late-joined client dispatches what it missed immediately and the rest on schedule.

import { normaliseEventDef, sharedTracks, outcomeTracks, resolveTrack } from './eventdef.js';

/**
 * @param {object} o
 * @param {object[]} o.defs        EventDefs (raw JSON; normalised here)
 * @param {object}  o.executors    { screens, audio, npc, equipment } — each { apply(track, ctx) }.
 *                                  apply returns false for a target/action it does not know.
 * @param {() => number} [o.nowMs]  wall clock in ms. Default performance.now-independent Date.now,
 *                                  so an absolute fire second maps onto it directly.
 * @param {(line: string) => void} [o.log]  deterministic log sink (the determinism check diffs it)
 * @param {(id: string, open: boolean) => void} [o.onLocalWindow]  the UI hook for answer markers
 * @param {(id: string, second: number) => object} [o.drawsForLocal] draws for a local trigger —
 *                                  the scene passes the scheduler's, so a tap draws from the run seed
 */
export function createRunner({ defs, executors, nowMs = () => Date.now(), log = null,
                               onLocalWindow = null, drawsForLocal = null }) {
  const byId = new Map(defs.map(normaliseEventDef).map((d) => [d.id, d]));
  const active = [];             // running instances
  const held = new Map();        // channel -> ms it is released (shared and local alike)

  const emit = (line) => { if (log) log(line); };

  function dispatch(inst, track, atSec) {
    const resolved = resolveTrack(track, inst.draws);
    const ex = executors[resolved.channel];
    const ctx = {
      event: inst.def.id, second: inst.second, draws: inst.draws,
      elapsed: (nowMs() - inst.fireMs) / 1000,           // since the fire, wall clock
      late: Math.max(0, (nowMs() - inst.fireMs) / 1000 - atSec), // how far behind this track is
      durationSec: inst.def.durationSec, local: inst.local, cue: inst.cue,
    };
    const known = ex ? ex.apply(resolved, ctx) !== false : false;
    emit(`${inst.second} ${inst.def.id}${inst.local ? '(local)' : ''} +${atSec} ${resolved.channel}/${resolved.target}/${resolved.action} ${JSON.stringify(resolved.params)}${track.when ? ` when=${track.when}` : ''}${known ? '' : ' NO-EXECUTOR'}`);
    return known;
  }

  /** Start a fire. `elapsed` > 0 means it fired that long ago (resume / late join): tracks already
   *  due are dispatched at once, in order, and the executor sees `late`. */
  function start(fire, { local = false } = {}) {
    const def = byId.get(fire.id);
    if (!def) { emit(`${fire.second} ${fire.id} UNKNOWN-EVENT`); return null; }
    const elapsed = fire.elapsed ?? 0;
    // Over is over: a fire whose duration has expired is history, not state.
    if (elapsed >= def.durationSec) return null;
    const inst = {
      def, second: fire.second, draws: fire.draws ?? {}, local, cue: !!fire.cue,
      fireMs: nowMs() - elapsed * 1000,
      pending: sharedTracks(def).map((t) => ({ t, at: t.at })).sort((a, b) => a.at - b.at),
      response: def.localResponse
        ? { closesMs: nowMs() - elapsed * 1000 + def.localResponse.windowSec * 1000, value: null, resolved: false }
        : null,
    };
    for (const ch of def.exclusive) held.set(ch, inst.fireMs + def.durationSec * 1000);
    active.push(inst);
    emit(`${inst.second} ${def.id}${local ? '(local)' : ''} FIRE elapsed=${elapsed} draws=${JSON.stringify(inst.draws)}`);
    if (inst.response && onLocalWindow && elapsed * 1000 < def.localResponse.windowSec * 1000) onLocalWindow(def.id, true);
    tick();
    return inst;
  }

  /** Dispatch everything that is due. Call once per frame; cheap when nothing is pending. */
  function tick() {
    const now = nowMs();
    for (let i = active.length - 1; i >= 0; i--) {
      const inst = active[i];
      while (inst.pending.length && inst.fireMs + inst.pending[0].at * 1000 <= now) {
        const { t, at } = inst.pending.shift();
        dispatch(inst, t, at);
      }
      const r = inst.response;
      if (r && !r.resolved && now >= r.closesMs) {
        r.resolved = true;
        if (onLocalWindow) onLocalWindow(inst.def.id, false);
        const lr = inst.def.localResponse;
        let outcome;
        if (r.value === null) outcome = lr.defaultOutcome;
        else if (!lr.correctFromDraw) outcome = 'correct';
        else outcome = String(r.value) === String(inst.draws[lr.correctFromDraw]) ? 'correct' : 'wrong';
        emit(`${inst.second} ${inst.def.id} RESPONSE ${outcome}`);
        // Outcome tracks run on THIS viewer only, timed from the window close.
        const base = (r.closesMs - inst.fireMs) / 1000;
        for (const t of outcomeTracks(inst.def, outcome).sort((a, b) => a.at - b.at)) {
          inst.pending.push({ t, at: base + t.at });
        }
        inst.pending.sort((a, b) => a.at - b.at);
      }
      if (!inst.pending.length && (!r || r.resolved) && now >= inst.fireMs + inst.def.durationSec * 1000) {
        active.splice(i, 1);
      }
    }
  }

  /**
   * A viewer tapped a hotspot. Fires the event bound to that target LOCALLY: it never writes
   * scheduler state. Refused while the event's channel is held (by a shared or a local instance) —
   * two takeovers on one set of screens is worse than a tap that does nothing. Returns true if fired.
   */
  function trigger(target, { second = Math.floor(nowMs() / 1000), input = {} } = {}) {
    for (const def of byId.values()) {
      if (!def.enabled || !def.trigger || def.trigger.target !== target) continue;
      const now = nowMs();
      // ★ A DROPPED TRIGGER USED TO RETURN false AND LOG NOTHING, and that is the one drop in
      // this engine somebody is WATCHING happen: a viewer pressed a thing. `exclusive` drops
      // rather than queues (by design — a queued response arrives after the moment that earned
      // it), so a tap on the mouse during his own errand was swallowed with no line anywhere,
      // which reads as the interaction being broken. The caller can now show the press was
      // refused, and the log says why. Found in DP-W8 by pressing the mouse.
      for (const ch of def.exclusive) {
        if (now < (held.get(ch) ?? -Infinity)) {
          emit(`${second} ${def.id}(local) DROPPED exclusive=${ch}`);
          return false;
        }
      }
      // Shared-seed draws at the tap second, then the tap's own inputs (which jar) on top.
      const draws = { ...(drawsForLocal ? drawsForLocal(def.id, second) : {}) };
      for (const k of def.trigger.inputs ?? []) if (k in input) draws[k] = input[k];
      return !!start({ id: def.id, second, draws }, { local: true });
    }
    return false;
  }

  /**
   * A viewer's answer. `target` is matched as a PREFIX of the response's inputTarget so a
   * multiple-choice answer needs one hit region per option and one field: "answer_c" against
   * inputTarget "answer_" submits "c". Returns true if an open window took it.
   */
  function submit(target) {
    const now = nowMs();
    for (const inst of active) {
      const r = inst.response;
      if (!r || r.resolved || now >= r.closesMs || r.value !== null) continue;
      const prefix = inst.def.localResponse.inputTarget;
      if (!String(target).startsWith(prefix)) continue;
      r.value = String(target).slice(prefix.length);
      emit(`${inst.second} ${inst.def.id} SUBMIT ${JSON.stringify(r.value)}`);
      return true;
    }
    return false;
  }

  /** Fire an event immediately with explicit draws, bypassing everything. Tools and screenshots. */
  function fireNow(id, draws = {}, second = Math.floor(nowMs() / 1000)) {
    return start({ id, second, draws }, { local: true });
  }

  return {
    start, tick, trigger, submit, fireNow,
    get active() { return active.map((i) => ({ id: i.def.id, second: i.second, local: i.local, pending: i.pending.length })); },
    holds: (ch) => nowMs() < (held.get(ch) ?? -Infinity),
    /** Hotspots this library declares — the shell's hotspot declaration reads this, not the scene. */
    triggers: () => [...byId.values()].filter((d) => d.enabled && d.trigger).map((d) => ({ target: d.trigger.target, event: d.id })),
    def: (id) => byId.get(id),
  };
}
