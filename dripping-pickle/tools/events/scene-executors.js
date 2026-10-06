// tools/events/scene-executors.js — the four channels, bound to what the warehouse scene can do.
//
// The runner hands each track to the executor for its channel; the executor is the ONLY thing
// that touches the world. It generalises what the scene already did by hand — the conveyor stall
// DP-W3 built, the pendant lights, the screens' hover glow, the cat's nap cycle — into a
// vocabulary an event file can name (tools/events/vocabulary.json). Adding a capability means:
// implement it here, list it in the vocabulary, author events against it. Adding an EVENT means
// none of that.
//
// Every executor returns false for a target/action it does not know, and the runner logs
// NO-EXECUTOR. `supports(target, action)` is the same knowledge exposed for the vocabulary
// check, so the JSON cannot drift ahead of the code in either direction.
//
// ★ EVERYTHING TIMED IN HERE IS WALL CLOCK. A track arrives with `ctx.late` (how far behind it
// already is, non-zero on resume or late join), and every envelope starts that far in — so a
// device joining mid-stall sees the belt restart when everyone else's does.

/**
 * @param {object} o
 * @param {object} o.screens    { units: [{ side, mats }], scrTime: {value}, content? } — mats carry __scr
 *                              (uniforms); `content` is tools/screen-content.js when the scene has it
 * @param {object} o.equipment  { targets: Map<name, Object3D>, conveyor }
 * @param {object} o.npc        { cat: { wake(params, ctx) } , … } — controllers by name
 * @param {object} [o.audio]    { sink(track, ctx) } — DP-W7 plugs in here; until then cues are recorded
 * @param {() => number} [o.nowMs]
 */
export function createSceneExecutors({ screens, equipment, npc, audio = {}, nowMs = () => performance.now() }) {
  // ── screens ───────────────────────────────────────────────────────────────────────────────
  const bursts = [];   // interference: { mats, strength, seconds, start }
  const glows = [];    // glow:         { mats, scale, seconds, start }
  const unitsFor = (target) => target === 'all' ? screens.units : screens.units.filter((u) => u.side === target);

  /** Gate A §7.4's envelope: a 0.05 s punch-in, then a ragged three-step decay (at 35 % and 70 %
   *  of the burst) so it reads as an unstable signal rather than a clean fade. */
  function burstAmount(b, t) {
    const x = (t - b.start) / 1000;
    if (x < 0 || x >= b.seconds) return 0;
    if (x < 0.05) return b.strength * (x / 0.05);
    const f = x / b.seconds;
    return b.strength * (f < 0.35 ? 1 : f < 0.7 ? 0.55 : 0.25);
  }

  const screensEx = {
    supports(target, action) {
      if (!['all', 'left', 'center', 'right'].includes(target)) return false;
      if (['interference', 'glow'].includes(action)) return true;
      // DP-W5's mission content is a CAPABILITY on the same channel, not a second executor and
      // not a scheduler change: tools/screen-content.js owns what a device is showing, this only
      // routes to it. A scene that registers no content controller supports neither.
      return !!screens.content && screens.content.supports(target, action);
    },
    apply(track, ctx) {
      if (screens.content && screens.content.supports(track.target, track.action)) {
        return screens.content.apply(track.target, track.action, track.params, ctx);
      }
      const units = unitsFor(track.target);
      if (!units.length) return false;
      const mats = units.flatMap((u) => u.mats);
      const start = nowMs() - ctx.late * 1000;
      const p = track.params;
      if (track.action === 'interference') {
        bursts.push({ mats, strength: +p.strength || 0.5, seconds: +p.seconds || 1.2, start });
        return true;
      }
      if (track.action === 'glow') {
        for (const m of mats) if (m.__glowBase === undefined) m.__glowBase = m.emissiveIntensity;
        glows.push({ mats, scale: +p.scale || 1, seconds: +p.seconds || 1, start });
        return true;
      }
      return false;
    },
    tick() {
      const now = nowMs();
      if (bursts.length) {
        const amount = new Map();
        for (let i = bursts.length - 1; i >= 0; i--) {
          const b = bursts[i];
          const a = burstAmount(b, now);
          if (now - b.start >= b.seconds * 1000) bursts.splice(i, 1);
          for (const m of b.mats) amount.set(m, Math.max(amount.get(m) ?? 0, a));
          if (!bursts.includes(b)) for (const m of b.mats) if (!amount.has(m)) amount.set(m, 0);
        }
        for (const [m, a] of amount) if (m.__scr) m.__scr.uScrNoise.value = a;
        if (!bursts.length) for (const m of amount.keys()) if (m.__scr) m.__scr.uScrNoise.value = 0;
      }
      for (let i = glows.length - 1; i >= 0; i--) {
        const g = glows[i];
        const done = now - g.start >= g.seconds * 1000;
        for (const m of g.mats) m.__glowT = done ? m.__glowBase : m.__glowBase * g.scale;
        if (done) glows.splice(i, 1);
      }
    },
  };

  // ── equipment ─────────────────────────────────────────────────────────────────────────────
  const tweens = [];   // { obj, prop, from, to, start, seconds }
  const bases = new Map();   // obj -> { prop: fitted value } captured on first touch
  const baseOf = (obj, prop) => {
    if (!bases.has(obj)) bases.set(obj, {});
    const b = bases.get(obj);
    if (b[prop] === undefined) b[prop] = obj[prop];
    return b[prop];
  };
  const valueFor = (obj, p) => (p.to !== undefined ? +p.to : baseOf(obj, p.property) * (+p.scale ?? 1));

  const equipmentEx = {
    supports(target, action) {
      if (target === 'conveyor') return !!equipment.conveyor && ['stall', 'wobble', 'clear'].includes(action);
      return equipment.targets.has(target) && ['set', 'tween'].includes(action);
    },
    apply(track, ctx) {
      const p = track.params;
      if (track.target === 'conveyor') {
        const c = equipment.conveyor;
        if (!c) return false;
        if (track.action === 'stall') { c.stall({ seconds: +p.seconds || 6, elapsed: ctx.late }); return true; }
        if (track.action === 'clear') { c.clearFloor(); return true; }
        if (track.action === 'wobble') {
          // Which jar: an index the trigger supplied (a tap knows exactly which one), or a
          // fraction of the LIVE run for an event that just means "a jar down there".
          const jar = p.jar !== undefined && p.jar !== '' ? +p.jar : c.jarAtFraction(p.slot);
          if (!Number.isFinite(jar) || jar < 0) return false;
          const strength = +p.strength || 1;
          // ★ THE RARITY IS DATA, AND SO IS THE OUTCOME. Gate A §8.4 signed a jar coming fully
          // off the belt as a RARE delight, and a threshold typed in here would be a policy
          // hidden in the engine — the event file names both the roll (drawn from the shared
          // seed, never a local dice roll) and the bar it has to beat. An event that authors
          // no `knockOffBelow` can never knock one off, which is the safe default.
          // One mechanism, not two: there is no separate "knock" action to drift out of step.
          const roll = Number(p.roll), bar = Number(p.knockOffBelow);
          if (Number.isFinite(roll) && Number.isFinite(bar) && roll < bar
              && c.knockOff({ jar, strength })) return true;
          return c.wobble({ jar, strength, seconds: +p.seconds || 2.4 });
        }
        return false;
      }
      const obj = equipment.targets.get(track.target);
      if (!obj || !p.property || !(p.property in obj)) return false;
      const to = valueFor(obj, p);
      if (track.action === 'set') { obj[p.property] = to; return true; }
      if (track.action === 'tween') {
        tweens.push({ obj, prop: p.property, from: obj[p.property], to, start: nowMs() - ctx.late * 1000, seconds: +p.seconds || 0.5 });
        return true;
      }
      return false;
    },
    tick() {
      const now = nowMs();
      for (let i = tweens.length - 1; i >= 0; i--) {
        const t = tweens[i];
        const f = Math.min(1, (now - t.start) / (t.seconds * 1000));
        const e = f * f * (3 - 2 * f);   // smoothstep
        t.obj[t.prop] = t.from + (t.to - t.from) * e;
        if (f >= 1) tweens.splice(i, 1);
      }
    },
  };

  // ── npc ───────────────────────────────────────────────────────────────────────────────────
  // The executor knows nothing about cats and must not learn anything about mice. A character is
  // a controller with methods named by action; to add one, register it and author events.
  const npcEx = {
    supports: (target, action) => !!(npc[target] && typeof npc[target][action] === 'function'),
    apply(track, ctx) {
      const ctl = npc[track.target];
      const fn = ctl && ctl[track.action];
      if (typeof fn !== 'function') return false;
      return fn.call(ctl, track.params, ctx) !== false;
    },
    tick() {},
  };

  // ── audio ─────────────────────────────────────────────────────────────────────────────────
  // DP-W7 owns sound. Until it lands, the executor RECORDS every cue (window.__events.audio) so
  // an event's audio timeline is visible and testable now, and a sink can be plugged in later
  // without touching a single event file — the id is the contract.
  const audioLog = [];
  const audioEx = {
    supports: (target, action) => ['play', 'stop', 'volume'].includes(action),
    apply(track, ctx) {
      if (!['play', 'stop', 'volume'].includes(track.action)) return false;
      audioLog.push({ second: ctx.second, event: ctx.event, target: track.target, action: track.action, params: track.params, late: ctx.late });
      if (audioLog.length > 200) audioLog.shift();
      if (typeof audio.sink === 'function') audio.sink(track, ctx);
      return true;
    },
    tick() {},
    log: audioLog,
    setSink(fn) { audio.sink = fn; },
  };

  const executors = { screens: screensEx, equipment: equipmentEx, npc: npcEx, audio: audioEx };

  return {
    executors,
    tick() { screensEx.tick(); equipmentEx.tick(); if (screens.content) screens.content.tick(); },
    /** Every vocabulary entry the registered executors do NOT support. Empty is the pass. */
    verifyVocabulary(vocab) {
      const missing = [];
      for (const [ch, targets] of Object.entries(vocab)) {
        if (ch === '_') continue;
        for (const [target, actions] of Object.entries(targets)) {
          for (const action of actions) {
            const ok = target === '*' ? executors[ch]?.supports('any', action) : executors[ch]?.supports(target, action);
            if (!ok) missing.push(`${ch}/${target}/${action}`);
          }
        }
      }
      return missing;
    },
  };
}
