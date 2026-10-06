/**
 * The cat's idle set — a POSE GRAPH, not a playlist (NPC-005, issue #32).
 *
 * ★ EVERY POSE CHANGE ROUTES THROUGH `sit`, AND THAT IS THE ASSET, NOT A CHOICE.
 * The pack exports `trans_sit_belly` / `trans_belly_sit` and `trans_sit_side` /
 * `trans_side_sit` and NOTHING between belly and side, so the set is a graph whose
 * edges are the transition clips and whose only hub is the sit. Play a lie clip from
 * a standing pose and the cat teleports through the floor between two poses; the
 * clips do not know where the body was.
 *
 * ★ AND EVERY REST STATE MUST HAVE A WAY OUT. The repo's own history: the first cat
 * export shipped `Lie_belly_start/loop/sleep` with no `Lie_belly_end`, so he could lie
 * down and never stand up. It does not fail as a missing clip — it fails as "the cat
 * never moves again", twenty minutes later, with nothing logged. `assertConnected()`
 * runs at construction over the edges that ACTUALLY loaded and throws, because a
 * one-way pose is a hang.
 *
 * Ownership: this module never touches the transform. `cat-walk.js` owns `matrix`
 * whenever he is roaming; the idle set only runs while he is parked, and it plays
 * clips through the `play()` the page hands in — the page keeps owning `current`, so
 * the nap chain's crossfades and `catWalkRate`'s locomotion swap stay honest.
 *
 * Timing is WALL CLOCK (`performance.now()`), never accumulated dt: a hold driven by
 * frame time stretches exactly when frames are scarce, and this Loop targets 30 FPS
 * on a phone. Same defect class as the conveyor stall and the return affordance.
 */

import * as THREE from 'three';

/** The graph. `enter`/`exit` name the transition clips; `loop` is what holds the pose. */
export const POSE_GRAPH = {
  stand: { loop: null, groom: ['lick', 'scratch', 'sharpen'], idles: true },
  sit: { loop: 'sit_loop', groom: ['lick'], idles: false },
  lie_belly: { loop: 'lie_loop', groom: [], idles: false },
  lie_side: { loop: 'lieside_loop', groom: [], idles: false },
};

/** Directed edges: [from, to, clip]. A missing clip prunes the edge, not the node. */
export const POSE_EDGES = [
  ['stand', 'sit', 'sit_start'],
  ['sit', 'stand', 'sit_end'],
  ['sit', 'lie_belly', 'trans_sit_belly'],
  ['lie_belly', 'sit', 'trans_belly_sit'],
  ['sit', 'lie_side', 'trans_sit_side'],
  ['lie_side', 'sit', 'trans_side_sit'],
  // The side-lie also has its own start/end against standing, which is what keeps
  // the graph connected when the sit chain is trimmed out of the payload.
  ['stand', 'lie_side', 'lieside_start'],
  ['lie_side', 'stand', 'lieside_end'],
];

/**
 * Breadth-first route between two poses over the loaded edges.
 * Returns an array of edges, or null when there is no way.
 */
export function routeBetween(edges, from, to) {
  if (from === to) return [];
  const seen = new Set([from]);
  const queue = [[from, []]];
  while (queue.length) {
    const [at, path] = queue.shift();
    for (const e of edges) {
      if (e.from !== at || seen.has(e.to)) continue;
      const next = [...path, e];
      if (e.to === to) return next;
      seen.add(e.to);
      queue.push([e.to, next]);
    }
  }
  return null;
}

/**
 * ★ STRONGLY CONNECTED, NOT MERELY REACHABLE. "He can get to the sofa" is not the
 * question; "can he get back" is. Checked pairwise so the error names the pose that
 * would have trapped him rather than saying the graph is bad.
 */
export function assertConnected(edges, poses) {
  const dead = [];
  for (const a of poses) {
    for (const b of poses) {
      if (a === b) continue;
      if (!routeBetween(edges, a, b)) dead.push(`${a} -> ${b}`);
    }
  }
  if (dead.length) {
    throw new Error(`cat-idles: no way out of a rest pose (${dead.join(', ')}) — `
      + 'a one-way pose does not fail as a missing clip, it fails as a cat that never moves again');
  }
}

/**
 * @param {object}   o
 * @param {THREE.AnimationMixer} o.mixer
 * @param {Map<string, THREE.AnimationAction>} o.clips  name -> action, whatever loaded
 * @param {(action) => void} o.play    the page's crossfade; it owns `current`
 * @param {() => number} [o.now]       wall clock, ms
 * @param {() => number} [o.random]
 * @param {string} [o.startPose]  the pose the body is ALREADY in when this takes over.
 *   Not cosmetic: the page hands over mid-nap-chain, where he is lying on his belly,
 *   and a graph that assumes standing plays a sit_start from a lying body — which
 *   reads as the cat snapping upright through the floor. It is a claim about the
 *   rig's current pose and only the caller knows it.
 */
export function createCatIdles({ mixer, clips, play, now = () => performance.now(), random = Math.random, startPose = 'stand' }) {
  const has = (name) => clips.has(name);
  const act = (name) => clips.get(name);

  // Build from what actually loaded. The idle set is a deferred second wave, so a slow
  // connection or a trimmed payload must degrade to fewer poses, never to a hang.
  const edges = POSE_EDGES.filter(([, , clip]) => has(clip))
    .map(([from, to, clip]) => ({ from, to, clip }));
  const poses = ['stand', ...Object.keys(POSE_GRAPH).filter((p) => p !== 'stand'
    && edges.some((e) => e.to === p) && (!POSE_GRAPH[p].loop || has(POSE_GRAPH[p].loop)))];
  assertConnected(edges, poses);

  const idleNames = [...clips.keys()].filter((n) => /^idle_/.test(n));
  const groomFor = (pose) => (POSE_GRAPH[pose]?.groom ?? []).filter(has);

  let pose = poses.includes(startPose) ? startPose : 'stand';
  let queue = [];           // pending transition edges
  let holdUntil = 0;
  let running = null;       // the one-shot currently playing, if any
  let onSettled = null;     // called when a requested route completes
  let enabled = false;
  let last = { action: null, at: 0 };

  const oneShot = (name) => {
    const a = act(name);
    if (!a) return null;
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    running = a;
    last = { action: name, at: now() };
    play(a);
    return a;
  };

  const holdPose = () => {
    running = null;
    // ★ A HOLD NEEDS SOMETHING PLAYING, OR IT IS A FREEZE-FRAME. The one-shots
    // clamp on their last frame, so a standing pose with no loop clip parks him in
    // whatever half-pose `lick` or `scratch` ended on for the length of the hold —
    // a still cat that is still in the WRONG way, and it reads as the animation
    // having broken rather than as him standing there. `stand` has no authored
    // loop, so a standing idle is the loop.
    const loop = POSE_GRAPH[pose]?.loop
      ?? (idleNames.length ? idleNames[Math.floor(random() * idleNames.length)] : null);
    if (loop && has(loop)) { const a = act(loop); a.reset(); a.setLoop(THREE.LoopRepeat, Infinity); play(a); }
    // ★ REST LENGTHS MUST VARY A LOT. A cat that sits for exactly eight seconds
    // every time reads as scripted no matter how good the clip is — the 2026-08-16
    // note that opened this work said so, and it is the whole difference between
    // an idle set and a playlist. Standing beats are short; a settled pose holds.
    const [lo, hi] = pose === 'stand' ? [2.5, 9] : [12, 48];
    holdUntil = now() + (lo + random() * (hi - lo)) * 1000;
  };

  const step = () => {
    if (queue.length) { const e = queue.shift(); pose = e.to; if (!oneShot(e.clip)) step(); return; }
    const done = onSettled; onSettled = null;
    holdPose();
    if (done) done();
  };

  mixer.addEventListener('finished', (ev) => {
    // ★ ONE-SHOTS END ON THE MIXER'S EVENT, NEVER ON `action.time`. Through browser
    // automation the pane advances the mixer a handful of frames per inspection, so
    // a time poll simply never comes true — the documented hang that left the cat
    // standing in `rising` forever. This has bitten twice in this file's history.
    // ★ THIS MUST NOT BE GATED ON `enabled`, AND GATING IT COSTS A ROUND. Every
    // exit disables the chooser FIRST and then asks for a route home, so an
    // `enabled` test here stops the chain on its first clip: `roam()` returns true,
    // the scheduler logs a fire, and the cat stands on his pillow forever. That is
    // precisely the "a command must work from every phase, or it lies" defect this
    // file's neighbours were fixed for. `enabled` belongs to the CHOOSER (`tick`);
    // a transition already in flight always finishes.
    if (ev.action !== running) return;
    step();
  });

  const api = {
    get pose() { return pose; },
    get poses() { return poses.slice(); },
    get enabled() { return enabled; },
    get busy() { return !!running || queue.length > 0; },
    get last() { return { ...last }; },
    /** ★ WHAT THE EXIT IS ACTUALLY WAITING FOR (#96). `busy` says a transition is in
     *  flight; this says WHICH action and whether the mixer can still finish it. An
     *  action with `isRunning` false will never dispatch `finished`, and that is the
     *  difference between "he is getting up" and "he is never getting up". */
    get waitingOn() {
      if (!running) return null;
      return {
        clip: last.action,
        weight: +running.getEffectiveWeight().toFixed(3),
        time: +running.time.toFixed(3),
        duration: +running.getClip().duration.toFixed(3),
        isRunning: running.isRunning(),
        enabled: running.enabled,
        paused: running.paused,
        queued: queue.length,
      };
    },

    /**
     * How long a route to `target` will take IN ANIMATION SECONDS — the sum of the clips it
     * will play, plus whatever is left of the one in flight. Not wall clock: the mixer is
     * advanced by the frame loop's dt, which is CLAMPED, so on a device below 10 fps animation
     * time runs slower than the clock and any wall-clock deadline over it fires early.
     * Returns null when there is no route.
     */
    secondsTo(target) {
      if (!poses.includes(target)) return null;
      const route = routeBetween(edges, pose, target);
      if (!route) return null;
      let t = route.reduce((a, e) => a + (act(e.clip)?.getClip().duration ?? 0), 0);
      if (running) t += Math.max(0, running.getClip().duration - running.time);
      return t;
    },

    /** Route to a pose. Resolves through `sit` when the assets demand it. */
    to(target, done) {
      if (!poses.includes(target)) return false;
      const route = routeBetween(edges, pose, target);
      if (!route) return false;
      queue = route.slice();
      onSettled = done ?? null;
      if (!running) step();
      return true;
    },

    /** A one-shot from the CURRENT pose — grooming, or a standing idle. */
    perform(name) {
      if (!has(name) || running) return false;
      return !!oneShot(name);
    },

    /**
     * The hallucination stare: hold a standing idle and stop reconsidering. Art
     * direction, not a mechanism — the body is already yawed by whoever parked him.
     */
    stare(seconds = 12) {
      if (pose !== 'stand') return false;
      if (idleNames.length) oneShot(idleNames[Math.floor(random() * idleNames.length)]);
      holdUntil = now() + seconds * 1000;
      return true;
    },

    /** Enable/disable. Disabling parks the chooser; it does NOT abandon a transition. */
    setEnabled(v) { enabled = !!v; if (enabled && !running && !queue.length) holdPose(); },

    /**
     * Bring him back to standing so something else can drive the body. Returns the
     * number of transitions it will take, so a caller can decide whether to wait.
     */
    standUp(done) {
      if (pose === 'stand' && !api.busy) { done?.(); return 0; }
      const route = routeBetween(edges, pose, 'stand') ?? [];
      queue = route.slice();
      onSettled = done ?? null;
      if (!running) step();
      return route.length;
    },

    /** The chooser. Call every frame; it only acts when a hold expires. */
    tick() {
      if (!enabled || running || queue.length || now() < holdUntil) return;
      const roll = random();
      const grooms = groomFor(pose);
      if (pose === 'stand') {
        if (roll < 0.35 && poses.length > 1) {
          const rest = poses.filter((p) => p !== 'stand');
          api.to(rest[Math.floor(random() * rest.length)]);
        } else if (roll < 0.70 && grooms.length) {
          oneShot(grooms[Math.floor(random() * grooms.length)]);
        } else if (idleNames.length) {
          oneShot(idleNames[Math.floor(random() * idleNames.length)]);
        } else {
          holdPose();
        }
      } else if (roll < 0.30 && grooms.length) {
        oneShot(grooms[Math.floor(random() * grooms.length)]);
      } else {
        api.to('stand');
      }
    },
  };
  return api;
}
