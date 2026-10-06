// Cat behaviours — a named list of clips with how long each one is held.
//
// A BEHAVIOR is data, not code:
//
//   { id: 'nap', name: 'Nap', loop: true, steps: [
//       { clip: 'lie_sleep',       seconds: 20, fade: 0.4 },
//       { clip: 'lie_sleep_end',   seconds: 1.6, fade: 0.3 },
//       ...
//   ] }
//
// The point of it being data is that the warehouse cat's nap is currently a
// hand-written setTimeout chain in loops/dripping-pickle/index.html. Once a
// behaviour is authored in the sequencer and saved, that chain becomes a name.
//
// This module knows nothing about three.js. It is handed the scene's own
// crossfader and asks it to play clips at the right moments, which keeps the
// one place that understands AnimationMixer in the scene where it already
// lived. `play(name, fade)` and `info(name) -> {seconds, loop}` are the whole
// contract.

export const BEHAVIOR_VERSION = 1;

// A loop clip has no natural length to borrow, so a new step gets a few
// seconds of it. A one-shot borrows its own duration, which is almost always
// what you want — a transition should play exactly once and then move on.
export const DEFAULT_HOLD = 3.0;

export const uid = () =>
  'b' + Math.random().toString(36).slice(2, 8);

/**
 * Fill in the gaps and clamp the nonsense, so a hand-edited behaviors.json or
 * an older save still loads. Never throws — a behaviour with no usable steps
 * comes back with an empty list rather than exploding at play time.
 */
export function normaliseBehavior(b, info = null) {
  const steps = Array.isArray(b?.steps) ? b.steps : [];
  return {
    id:    typeof b?.id === 'string' && b.id ? b.id : uid(),
    name:  typeof b?.name === 'string' && b.name.trim() ? b.name.trim() : 'Untitled',
    loop:  b?.loop !== false,          // behaviours repeat unless told not to
    notes: typeof b?.notes === 'string' ? b.notes : '',
    steps: steps
      .filter((s) => s && typeof s.clip === 'string' && s.clip)
      .map((s) => {
        const nat = info?.(s.clip)?.seconds;
        const fallback = Number.isFinite(nat) && nat > 0 ? nat : DEFAULT_HOLD;
        const secs = Number(s.seconds);
        return {
          clip: s.clip,
          // 0.05 s floor: a zero-length step would be skipped in the same frame
          // it started, so a mistyped 0 silently deletes the step from playback
          // while leaving it visible on the timeline.
          seconds: Number.isFinite(secs) && secs > 0 ? Math.max(0.05, secs) : fallback,
          fade: Number.isFinite(Number(s.fade)) ? Math.max(0, Number(s.fade)) : 0.3,
        };
      }),
  };
}

/** The default hold for a clip just dropped on the timeline. */
export function defaultHold(clip, info) {
  const d = info?.(clip);
  if (d && d.loop === false && Number.isFinite(d.seconds) && d.seconds > 0) {
    return Math.round(d.seconds * 20) / 20;      // to the nearest 0.05 s
  }
  return DEFAULT_HOLD;
}

export const totalSeconds = (b) =>
  (b?.steps ?? []).reduce((a, s) => a + (Number(s.seconds) || 0), 0);

/**
 * Where a global time lands. Returns { index, localT }, clamped to the
 * behaviour rather than wrapping — the caller decides what running off the end
 * means, because a scrub should stop at the end and playback should loop.
 */
export function stepAt(behavior, T) {
  const steps = behavior?.steps ?? [];
  if (!steps.length) return { index: -1, localT: 0 };
  let t = Math.max(0, T);
  for (let i = 0; i < steps.length; i++) {
    if (t < steps[i].seconds || i === steps.length - 1) {
      return { index: i, localT: Math.min(t, steps[i].seconds) };
    }
    t -= steps[i].seconds;
  }
  return { index: steps.length - 1, localT: 0 };
}

/**
 * Where inside its own clip a step is at local time `t`.
 * A looping clip wraps; a one-shot clamps and holds its last frame, which is
 * exactly what clampWhenFinished does during real playback.
 */
export function clipTimeFor(step, t, info) {
  const d = info?.(step.clip)?.seconds;
  if (!Number.isFinite(d) || d <= 0) return 0;
  return info(step.clip).loop === false ? Math.min(t, d) : t % d;
}

/**
 * The pose at global time T, as a list of weighted clips ready to hand to the
 * scene: [{ clip, time, weight }].
 *
 * ★ This is the whole reason scrubbing is not just "play the clip at time t".
 * Inside a step's first `fade` seconds TWO clips are live, and a scrub that
 * ignores that snaps through every transition — which is precisely the moment
 * you are scrubbing to look at. The outgoing clip is held at the time it
 * reached when its own step ended.
 */
export function poseAt(behavior, T, info) {
  const steps = behavior?.steps ?? [];
  const { index: i, localT } = stepAt(behavior, T);
  if (i < 0) return [];
  const step = steps[i];
  const out = [{ clip: step.clip, time: clipTimeFor(step, localT, info), weight: 1 }];

  const fade = Number(step.fade) || 0;
  if (fade <= 0 || localT >= fade) return out;

  // Whatever ran before this step — the one before it, or the last step when the
  // behaviour loops round. Same clip twice in a row is not a transition at all
  // (play() would decline to restart it), so there is nothing to blend.
  const prev = i > 0 ? steps[i - 1] : (behavior.loop ? steps[steps.length - 1] : null);
  if (!prev || prev.clip === step.clip) return out;

  const w = localT / fade;
  out[0].weight = w;
  out.push({ clip: prev.clip, time: clipTimeFor(prev, prev.seconds, info), weight: 1 - w });
  return out;
}

/**
 * Runs a behaviour against the scene's crossfader.
 *
 *   const player = createBehaviorPlayer({ play, info });
 *   player.start(behavior);
 *   // in the frame loop, BEFORE mixer.update(dt):
 *   player.update(dt);
 *
 * ★ Update BEFORE the mixer, for the same reason the wander step does: this is
 * what chooses the clip and starts the fade, and the mixer is what advances it.
 * Called after, every step change is one frame stale — invisible at 3 s holds
 * and very visible at 0.1 s ones.
 */
export function createBehaviorPlayer({ play, info = null, onStep = null }) {
  let behavior = null;
  let index = -1;
  let elapsed = 0;
  let running = false;

  function enter(i, fade) {
    index = i;
    elapsed = 0;
    const s = behavior.steps[i];
    // fade === null means "use the step's own fade". An explicit 0 is passed on
    // the very first step so a behaviour starts crisply on the pose you picked
    // rather than sliding in from whatever the cat happened to be doing.
    play(s.clip, fade === null ? s.fade : fade);
    onStep?.(i, s);
  }

  return {
    start(b, { fromStart = true } = {}) {
      behavior = b;
      running = !!(b && b.steps.length);
      if (!running) { index = -1; elapsed = 0; return; }
      if (fromStart || index < 0 || index >= b.steps.length) enter(0, 0);
      else { elapsed = 0; enter(index, null); }
    },

    stop() { running = false; },

    /** Jump straight to a step — the timeline's click-to-scrub. */
    goTo(i) {
      if (!behavior || !behavior.steps[i]) return;
      running = true;
      enter(i, null);
    },

    update(dt) {
      if (!running || !behavior) return;
      const step = behavior.steps[index];
      if (!step) { running = false; return; }
      elapsed += dt;
      if (elapsed < step.seconds) return;

      // Carry the overshoot rather than dropping it. At 60 fps a 0.1 s step
      // overshoots by up to a frame, and swallowing it every step makes a long
      // behaviour drift measurably slower than the sum of its numbers.
      const carry = elapsed - step.seconds;
      const next = index + 1;
      if (next < behavior.steps.length) { enter(next, null); elapsed = carry; return; }
      if (behavior.loop) { enter(0, null); elapsed = carry; return; }
      running = false;
    },

    get running()  { return running; },
    get index()    { return index; },
    get elapsed()  { return elapsed; },
    get behavior() { return behavior; },
    /** 0..1 through the current step — the playhead. */
    get stepT() {
      const s = behavior?.steps[index];
      return s ? Math.min(1, elapsed / s.seconds) : 0;
    },
  };
}

/**
 * Load the saved behaviours. Same two-ways-in bargain as the feedback panel:
 * served by tools/dev-server.mjs the API answers and saving works; opened any
 * other way (GitHub Pages, file://) it falls back to the committed JSON and
 * goes read-only rather than pretending a save worked.
 *
 * Returns { behaviors, writable }.
 */
export async function loadBehaviors(staticPath = '../../assets/cat/behaviors.json') {
  try {
    const r = await fetch('/api/behaviors', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      return { behaviors: (d.behaviors ?? []).map((b) => normaliseBehavior(b)), writable: true };
    }
  } catch { /* not on the dev server */ }
  try {
    const r = await fetch(staticPath, { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      return { behaviors: (d.behaviors ?? []).map((b) => normaliseBehavior(b)), writable: false };
    }
  } catch { /* nothing committed yet */ }
  return { behaviors: [], writable: false };
}
