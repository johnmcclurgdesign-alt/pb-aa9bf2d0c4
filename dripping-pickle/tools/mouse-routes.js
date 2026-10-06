// tools/mouse-routes.js — NPC-003. "Caper", the Outpost mouse, and the routes
// he runs. The asset is built by tools/blender-build-mouse.py (ORIGINAL).
//
// WHY ROUTES AND NOT STEERING (decision, Josh, 2026-09-06):
//   The cat ROAMS, so he needs a walkability grid, an arc radius and a
//   containment constraint. The mouse does not roam — canon has him running
//   errands: "enters and exits through the wall crack, runs the conveyor like a
//   highway, evades the cat with the confidence of a professional". Authored
//   routes make that literal, they make NPC-004's chase / evade / conveyor-run /
//   hole-escape a choice of ROUTE plus a SPEED PROFILE (which is the data shape
//   the event engine already wants), and containment is by construction: there
//   is no wall-clip failure mode to measure because he is never free to find one.
//   The cost is that routes are authored against this room and must be
//   re-checked when props move — hence checkRoutes(), below, which is the whole
//   reason that cost is affordable.
//
// ★ EVERY ROUTE WAS FITTED AGAINST MEASURED PROP BOUNDS, NOT A FLOOR PLAN.
//   The obvious wall-hugging return leg from the crack runs straight over
//   Prop_Pillow_1..3 (x 1.17-2.03, z -0.08..0.78) — the cat's bed — and the
//   obvious wall climb starts inside Prop_Weird_Russian_Device001_5
//   (x 1.70-2.03, z 1.47-1.84) with Prop_Tool_Cart (z 1.62-2.55) right behind
//   it. Both were found by checkRoutes(), not by looking.
//
// ★ AND THE SAME TRANSFORM DISCIPLINE AS THE CAT. This module requires
//   matrixAutoUpdate = false and writes `matrix` itself, in motion AND at rest,
//   so there is never a handover between two owners. `userData.noMove` because
//   his pose is an OUTPUT (a dragged pose is a value the route overwrites);
//   `userData.noBlock` because he lives in `pickables` with the room and without
//   it the CAT's walkability grid measures the mouse as a wall.

import * as THREE from 'three';

// ── the room, as measured ──────────────────────────────────────────────────
// World space matches conveyor.js: +X toward the front wall, +Z screen-right.
export const FLOOR_Y = 0.012;          // the mouse's belly clears the boards
const WALL_X = 2.069;                  // front wall plane — corner-dressing.js
const CRACK_Z = 1.20;

// The belt, from conveyor.js DEFAULTS. Read, never re-typed: if the belt moves,
// belt_run has to move with it or the mouse runs through thin air.
const BELT = { y: 2.32, xA: 0.85, zB: 1.87, xExit: 2.07, zEntry: -2.37 };
// He stands ON the belt, not in it. 0.012 rather than a hair, because a
// Catmull-Rom flattening out of a descent UNDERSHOOTS: at 0.006 the curve dipped
// to 2.3146, i.e. 5.4 mm INSIDE the belt surface, over u 0.433-0.451. The
// descent below is also stepped down gently for the same reason — the ride
// height is margin, not a fix for a curve that arrives too steeply.
const BELT_RIDE = 0.012;
// ★ THE CAMERA-SIDE RAIL. Belt edges are 0.60 and 1.10 on run A; the rail is
//   0.022 wide inside the near edge and stands 0.025 proud, so its top is 2.345.
//   x 0.611 is the middle of it and the only line on this belt the loop camera
//   can see. See the measured table on belt_run.
// ★ 0.585, NOT 0.611 — THE HANGER LEGS OWN THE RAIL'S CENTRELINE. The probe
//   found two strikes 1.5 m apart on the rail run, which is hangerPitch exactly;
//   sweeping along z shows obstructions at z -1.63, -0.13 and +1.39 for x
//   0.600-0.611 and NOTHING at 0.585. So he runs the rail's outer edge, half a
//   body off the belt — which a mouse does anyway, measures the same 94 %
//   visible, and puts more of his silhouette clear of the belt edge.
const RAIL_X = 0.585;
const RAIL_Y = BELT.y + 0.025 + 0.007;   // rail top, plus a little
// A jar lid: base 2.32 + body 0.16 + lid 0.018 = 2.498. 2.516 puts him ON the
// lid and measures 100 % visible down run A, against 87 % at the lid itself.
export const JAR_LID_Y = 2.516;

// ── routes ─────────────────────────────────────────────────────────────────
// Each is a list of world points. `loop` closes it. `clip` overrides the clip
// the speed profile would otherwise pick, for the stretch after that point.
export const ROUTES = {
  // Out through the crack. The only route with a signed clip override: the
  // squeeze is IN PLACE in the .glb, so this route is what moves him through.
  hole_exit: {
    loop: false,
    pts: [
      [WALL_X + 0.055, FLOOR_Y, CRACK_Z],   // inside the wall, unseen
      [WALL_X - 0.010, FLOOR_Y, CRACK_Z],
      [WALL_X - 0.075, FLOOR_Y, CRACK_Z - 0.02],
    ],
    clipUntil: [['squeeze', 0.62]],       // squeeze for the first 62% of it
  },

  // Reverse of the above — he is never caught for keeps.
  hole_enter: {
    loop: false,
    pts: [
      [WALL_X - 0.075, FLOOR_Y, CRACK_Z - 0.02],
      [WALL_X - 0.010, FLOOR_Y, CRACK_Z],
      [WALL_X + 0.055, FLOOR_Y, CRACK_Z],
    ],
    clipUntil: [['scurry', 0.30], ['squeeze', 1.0]],
  },

  // The ambient errand: out into the room, down the open floor, back. Stays
  // clear of the pillow, the drawer unit and the crate stack.
  patrol_floor: {
    loop: true,
    pts: [
      [2.030, FLOOR_Y,  1.200],
      [1.750, FLOOR_Y,  1.150],
      [1.400, FLOOR_Y,  1.050],
      [1.050, FLOOR_Y,  0.800],
      [0.820, FLOOR_Y,  0.300],
      [0.740, FLOOR_Y, -0.300],
      [0.820, FLOOR_Y, -0.850],
      // ★ THE CORNER HERE IS THREE POINTS, NOT ONE. A single waypoint at
      //   (1.450, -0.700) reads as clear — the drawer unit ends at z = -0.796 —
      //   but a Catmull-Rom spline BULGES BETWEEN its control points, and
      //   checkRoutes found the curve 10 cm inside Prop_Vintage_Wooden_Drawer_01001
      //   (x 1.249-1.955, z -2.107..-0.796) over u 0.53-0.56. Waypoint clearance
      //   is not curve clearance.
      [1.020, FLOOR_Y, -0.930],
      [1.180, FLOOR_Y, -0.760],
      [1.240, FLOOR_Y, -0.360],
      [1.060, FLOOR_Y,  0.550],
      [1.360, FLOOR_Y,  1.060],
      [1.780, FLOOR_Y,  1.170],
    ],
  },

  // Up the crate stack and back. A vertical face is a ladder to a mouse; this
  // is the short version of the move belt_run makes on the brick.
  //
  // ★ IT IS A STACK OF TWO. Prop_Crate_Left_Lower tops out at y 0.472 and
  //   Prop_Crate_Left_Upper stands on it to 0.935 — so the first cut climbed
  //   onto a lid with another crate sitting on it and spent the last quarter of
  //   the route INSIDE that crate. checkRoutes named both boxes; the floor plan
  //   and the loop camera name neither.
  crate_dash: {
    loop: false,
    pts: [
      [2.030, FLOOR_Y,  1.200],
      [1.500, FLOOR_Y,  0.900],
      [1.050, FLOOR_Y,  0.100],
      [0.900, FLOOR_Y, -0.700],
      [0.740, FLOOR_Y, -1.120],
      // the climb hugs the stack's room-facing end face at z = -1.219, staying
      // a whisker OUTSIDE it — inside is a route through solid wood
      [0.720, 0.180,   -1.196],
      [0.720, 0.660,   -1.198],
      // ★ CLEAR THE TOP BEFORE TURNING IN, not while turning in. Cresting at
      //   the crate's own height sags the spline back through the lid over
      //   u 0.85-0.87 — a corner is exactly where a Catmull-Rom overshoots.
      [0.720, 1.000,   -1.195],
      [0.715, 0.985,   -1.330],
      [0.700, 0.980,   -1.560],
      [0.620, 0.980,   -1.820],
    ],
  },

  // ★ THE HIGHWAY. Out of the crack, north along the skirting, up the brick at
  //   z = 1.35 — the one column of wall between the Russian devices (z < 1.47)
  //   and the tool cart (z > 1.62) — onto the belt, and down the exit leg
  //   against the jar flow to the entry cut-out, where he is out of sight.
  //   A 2.3 m brick wall is a ladder to a mouse; this is the animal, not a cheat.
  // ★★★ THE BELT IS ONLY WORTH RUNNING WHERE THE CAMERA CAN SEE IT, AND THAT
  //   IS ONE RAIL, FIVE CENTIMETRES WIDE (Josh, 2026-09-06).
  //
  //   The loop eye is at (-4.97, 1.30, 0.20) and the belt is at 2.32 — the
  //   camera looks UP at it, so its top surface is not visible at all. Measured
  //   visible fraction of a line down run A, projected at 16:9 and occlusion-
  //   raycast against the room:
  //
  //       camera-side rail, x 0.600-0.612 ...... 94 %
  //       five centimetres inboard, x 0.66 ......  0 %
  //       belt centreline, x 0.85 ...............  0 %
  //       a jar lid, x 0.85 at y 2.52 ........... 100 %
  //
  //   Nought to ninety-four across 5 cm. The first cut ran the belt down its
  //   middle and measured 34 % visible overall, with the ENTIRE belt section
  //   occluded — a mouse running where nobody can see him is not set dressing,
  //   it is a sim nobody watches.
  //
  //   The exit leg (along z = 1.87) is a dead leg: 0-43 % at every height and
  //   nearly head-on. So the route lives on run A and is entered through the
  //   belt's OWN cut-out rather than by climbing the wall. That also deletes
  //   every collision the climb caused — the exit hood, the rail, the jars.
  belt_run: {
    loop: false,
    pts: [
      [0.900, RAIL_Y, BELT.zEntry - 0.10],   // inside the cut-out, unseen
      [0.760, RAIL_Y, BELT.zEntry + 0.04],
      [0.640, RAIL_Y, BELT.zEntry + 0.22],   // out onto the camera-side rail
      [RAIL_X, RAIL_Y, -1.900],
      [RAIL_X, RAIL_Y, -1.200],
      [RAIL_X, RAIL_Y, -0.400],
      [RAIL_X, RAIL_Y,  0.400],
      [RAIL_X, RAIL_Y,  1.000],
      // round the corner on the SAME rail — it is the outer one here, r = 0.75
      // about the turn centre (1.35, 1.37) — and out of sight as it goes
      [0.700, RAIL_Y,  1.560],
      [0.820, RAIL_Y,  1.900],
      [1.350, RAIL_Y,  2.120],
      [1.700, RAIL_Y,  2.120],
      [2.000, RAIL_Y,  2.120],   // into the exit cut-out (x 2.06, z 1.56-2.18)
    ],
  },
};

// ── speed profiles ─────────────────────────────────────────────────────────
// A mouse does not travel at a speed, it travels in bursts. A profile is a
// sequence of {v, t} segments; v = 0 is a hold and picks a stationary clip.
//
// ★ SEEDED, NOT RANDOM. Same posture as DP-W3's jar contents and DP-W4's
//   fires: two clients that agree about the clock agree about the mouse, and a
//   run can be replayed from its seed. Math.random() here would make the mouse
//   the one thing in the room that cannot be reproduced.
function hash32(x) {                     // fmix32, as the event engine uses
  x |= 0; x = (x + 0x7ed55d16 + (x << 12)) | 0; x = (x ^ 0xc761c23c ^ (x >>> 19)) | 0;
  x = (x + 0x165667b1 + (x << 5)) | 0;   x = ((x + 0xd3a2646c) ^ (x << 9)) | 0;
  x = (x + 0xfd7046c5 + (x << 3)) | 0;   x = (x ^ 0xb55a4f09 ^ (x >>> 16)) | 0;
  return (x >>> 0) / 4294967296;
}

export const PROFILES = {
  // brisk, with the odd check over the shoulder
  errand: { dart: [0.42, 0.68], hold: [0.25, 0.90], holdEvery: [1.1, 2.4], sniffOdds: 0.45 },
  // flat out — nothing stops
  bolt:   { dart: [0.95, 1.25], hold: [0.00, 0.00], holdEvery: [99, 99], sniffOdds: 0.0 },
  // the cat is somewhere. Short runs, long freezes.
  wary:   { dart: [0.55, 0.85], hold: [0.60, 1.80], holdEvery: [0.5, 1.1], sniffOdds: 0.15 },
};

function buildProfile(name, seed, totalLen) {
  const p = PROFILES[name] || PROFILES.errand;
  const segs = [];
  let s = 0, dist = 0;
  const rnd = () => hash32(seed + 0x9e37 * (s++));
  const lerp = ([a, b], t) => a + (b - a) * t;
  while (dist < totalLen) {
    const v = lerp(p.dart, rnd());
    const run = lerp(p.holdEvery, rnd());
    segs.push({ v, len: Math.min(run * v, totalLen - dist) });
    dist += segs[segs.length - 1].len;
    if (dist >= totalLen) break;
    const ht = lerp(p.hold, rnd());
    if (ht > 0.01) segs.push({ v: 0, hold: ht, still: rnd() < p.sniffOdds ? 'sniff' : 'freeze', len: 0 });
  }
  return segs;
}

// ── the controller ─────────────────────────────────────────────────────────
export function createMouse({ scene, model, mixer, clips, gi = null } = {}) {
  if (!model || !mixer) throw new Error('createMouse needs model + mixer');

  // ★ ONE TRANSFORM, ALWAYS. See the header.
  model.matrixAutoUpdate = false;
  model.userData.noMove = true;
  model.userData.noBlock = true;
  model.traverse((o) => { if (o.isSkinnedMesh) o.frustumCulled = false; });

  const actions = {};
  for (const [name, clip] of Object.entries(clips)) {
    const a = mixer.clipAction(clip);
    if (name === 'squeeze') { a.setLoop(THREE.LoopRepeat, Infinity); }
    actions[name] = a;
  }

  // ★ FOOT SLIDE IS ONE MEASURED NUMBER, and it is measured by the SAME code
  //   that measures the cat's — the rig is authored facing Blender -Y precisely
  //   so that measureAuthoredSpeed's +Z convention and claw_* naming apply
  //   unmodified. Set at load, never stored, so a re-export cannot leave a stale
  //   value behind. The fallback is only for a rig with no claw_ bones at all.
  let authored = 0.35;
  const setAuthored = (v) => { if (v && isFinite(v) && v > 0.02) authored = v; };

  const curves = {};
  for (const [id, r] of Object.entries(ROUTES)) {
    const pts = r.pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    curves[id] = new THREE.CatmullRomCurve3(pts, !!r.loop, 'catmullrom', 0.5);
  }

  const state = {
    routeId: null, t: 0, dist: 0, len: 0, segs: [], seg: 0, held: 0,
    running: false, profile: 'errand', seed: 0, clip: null, visible: false, frozenUntil: 0,
    laps: 0, onDone: null,
    // ride mode — he is a passenger, not a traveller
    mode: 'route', ride: null,
  };

  const pos = new THREE.Vector3(), tan = new THREE.Vector3();
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const ONE = new THREE.Vector3(1, 1, 1);

  const setVisible = (v) => { state.visible = v; model.visible = v; };
  setVisible(false);

  function play(name) {
    if (state.clip === name || !actions[name]) return;
    const next = actions[name];
    next.reset().setEffectiveWeight(1).play();
    if (state.clip && actions[state.clip]) next.crossFadeFrom(actions[state.clip], 0.16, false);
    state.clip = name;
  }

  /** Which clip this point on the route wants, before the profile has a say. */
  function clipOverride(r, u) {
    if (!r.clipUntil) return null;
    for (const [name, until] of r.clipUntil) if (u <= until) return name;
    return null;
  }

  function run(routeId, { profile = 'errand', seed = 0, onDone = null } = {}) {
    const c = curves[routeId];
    if (!c) throw new Error(`unknown mouse route: ${routeId}`);
    state.routeId = routeId;
    state.len = c.getLength();
    state.segs = buildProfile(profile, (seed | 0) || 1, state.len);
    state.seg = 0; state.held = 0; state.dist = 0; state.t = 0;
    state.profile = profile; state.seed = seed; state.running = true;
    state.laps = 0; state.onDone = onDone;
    setVisible(true);
    place(0);
    return state;
  }

  /**
   * ★ HE RIDES A JAR (Josh, 2026-09-06). A jar lid measures 100 % visible down
   * run A against 94 % for the rail and 0 % for the belt itself, and it needs no
   * climb at all — the jar arrives through the cut-out already carrying him, so
   * he is a stowaway rather than an implausible wall-scaler.
   *
   * The position comes from the InstancedMesh's own matrix every frame, NOT
   * from a copy of the conveyor's path maths. The belt's distance accumulator
   * is the single source of truth for where a jar is; re-deriving it here would
   * be a second implementation free to drift, and DP-W3's own note is that a
   * wrapped accumulator looks perfect while being wrong.
   */
  /**
   * Stow away on a jar. `instance` picks WHICH jar to board, and is resolved to that jar's
   * global index immediately — see instanceOfJar() in conveyor.js for why holding the slot
   * instead is a bug you can watch: he blinks onto the neighbouring jar every time one leaves
   * the visible run (reported 2026-09-08). The ride ends by itself when the jar he is on goes
   * into the wall, which is the beat: he is carried out through the exit hood.
   */
  function rideJar(conveyor, { instance = 0, jar: wantJar = -1, offsetY = 0.196, still = 'freeze' } = {}) {
    if (!conveyor || !conveyor.jarMeshes || !conveyor.jarMeshes.length) return null;
    const jar = wantJar >= 0 ? wantJar
      : (conveyor.jarAtInstance ? conveyor.jarAtInstance(instance) : -1);
    if (!(jar >= 0)) return null;          // nothing on the belt to board
    state.mode = 'ride';
    state.ride = { conveyor, jar, offsetY, still, last: null };
    state.running = true;
    state.routeId = 'jar_ride';
    setVisible(true);
    return state;
  }

  const rideM = new THREE.Matrix4(), rideP = new THREE.Vector3();
  const rideQ = new THREE.Quaternion(), rideS = new THREE.Vector3();

  function updateRide() {
    const r = state.ride;
    const mesh = r.conveyor.jarMeshes[0];
    // ★ RE-RESOLVE THE SLOT EVERY FRAME. It is not stable: see rideJar above.
    const slot = r.conveyor.instanceOfJar ? r.conveyor.instanceOfJar(r.jar) : -1;
    if (!mesh || slot < 0 || slot >= mesh.count) { finish(); return; }
    mesh.getMatrixAt(slot, rideM);
    rideM.decompose(rideP, rideQ, rideS);
    // the jar's own world transform, in case the conveyor group is ever moved
    rideP.applyMatrix4(mesh.matrixWorld);
    rideP.y += r.offsetY;
    // face along travel, derived from where the jar actually went
    let yaw = 0;
    if (r.last) {
      const dx = rideP.x - r.last.x, dz = rideP.z - r.last.z;
      if (dx * dx + dz * dz > 1e-8) { yaw = Math.atan2(dx, dz); r.yaw = yaw; }
      else yaw = r.yaw || 0;
    }
    r.last = rideP.clone();
    q.setFromAxisAngle(up, yaw);
    model.matrix.compose(rideP, q, ONE);
    model.matrixWorldNeedsUpdate = true;
    play(r.still);
  }

  function stop() { state.running = false; state.mode = 'route'; state.ride = null; state.frozenUntil = 0; }

  /** Knocked along by a paw (INT-004). He is on a route, so "moved" means moved ALONG it —
   *  a lateral shove would put him off the authored curve, which is the one guarantee routes
   *  buy over steering. A few centimetres per strike reads as contact. */
  function bump(metres = 0.05) {
    if (!state.running || state.mode !== 'route') return false;
    state.dist = Math.min(state.len - 0.001, state.dist + (Number(metres) || 0));
    return true;
  }

  /** Let him go before the freeze expires. */
  function thaw() { state.frozenUntil = 0; }

  /** Tap-freeze: hold him exactly where he is for `seconds`, then carry on. Returns false when
   *  there is nothing to freeze — a mouse inside the wall is not a beat anyone can watch. */
  function freeze(seconds = 6) {
    if (!state.running || !state.visible) return false;
    const secs = Number(seconds);
    state.frozenUntil = performance.now() + (Number.isFinite(secs) ? secs : 6) * 1000;
    play('freeze');
    return true;
  }
  function hide() { stop(); setVisible(false); }

  function place(u) {
    const c = curves[state.routeId];
    pos.copy(c.getPointAt(Math.min(1, Math.max(0, u))));
    tan.copy(c.getTangentAt(Math.min(1, Math.max(0, u)))).normalize();
    // yaw only — a mouse on a wall still reads right, and banking a 13 px animal
    // buys nothing while risking a pose nobody can debug.
    const yaw = Math.atan2(tan.x, tan.z);
    q.setFromAxisAngle(up, yaw);
    model.matrix.compose(pos, q, ONE);
    model.matrixWorldNeedsUpdate = true;
  }

  function update(dt) {
    if (!state.running) return;
    // ── tap-freeze (INT-004) ────────────────────────────────────────────────
    // ★ HE STOPS WHERE HE IS AND THE ROUTE IS NOT TOUCHED. A freeze that cleared
    //   the queue would be a different animal afterwards — he would give up the
    //   errand he was on and the release would look like a teleport back into a
    //   new plan. Holding the route and refusing to advance it means the release
    //   is literally him carrying on, which is what a startled mouse does.
    // ★ AND IT IS WALL CLOCK, not accumulated dt: the duration of a beat is a
    //   schedule (DP-W3's stall, DP-W7's fades), and driving it from frame time
    //   stretches it exactly when frames are scarce.
    if (state.frozenUntil) {
      if (performance.now() < state.frozenUntil) { play('freeze'); return; }
      state.frozenUntil = 0;
    }
    if (state.mode === 'ride') { updateRide(); return; }
    const r = ROUTES[state.routeId];
    const seg = state.segs[state.seg];
    if (!seg) { finish(); return; }

    if (seg.v === 0) {
      // ★ A HOLD IS WALL CLOCK IN SPIRIT AND FRAME TIME HERE ONLY BECAUSE dt IS
      //   ALREADY CLAMPED BY THE CALLER. The scene passes a clamped dt; the
      //   caller's own clock is what decides how long a stall lasts. Keeping the
      //   hold on dt would stretch it exactly when frames are scarce — the
      //   defect measured on the return affordance and the conveyor stall — so
      //   the scene drives holds from performance.now() via update(dtWallClock).
      state.held += dt;
      play(seg.still || 'freeze');
      if (state.held >= seg.hold) { state.held = 0; state.seg++; }
      return;
    }

    state.dist += seg.v * dt;
    if (state.dist >= segEnd()) { state.seg++; }

    const u = state.dist / state.len;
    const forced = clipOverride(r, u);
    play(forced || 'scurry');
    // rate = travel / authored. This is the whole of foot slide.
    if (actions.scurry) actions.scurry.setEffectiveTimeScale(seg.v / authored);

    if (u >= 1) {
      if (r.loop) { state.dist -= state.len; state.laps++; state.seg = 0;
                    state.segs = buildProfile(state.profile, ((state.seed | 0) || 1) + state.laps, state.len); }
      else { place(1); finish(); return; }
    }
    place(state.dist / state.len);
  }

  function segEnd() {
    let d = 0;
    for (let i = 0; i <= state.seg; i++) d += state.segs[i]?.len || 0;
    return d;
  }

  function finish() {
    state.running = false;
    const cb = state.onDone; state.onDone = null;
    if (cb) cb(state.routeId);
  }

  if (gi && model) model.traverse((o) => { if (o.isMesh && o.material) gi.patch(o.material); });

  // Where he is, this frame, in world metres. NPC-004's cat pursues a live
  // position and the proximity reflex measures against one, so both need a
  // reading that cannot go stale: it comes off the matrix the update above
  // just wrote, never off a copy the controller keeps.
  const readPos = new THREE.Vector3();

  return {
    model, mixer, actions, state, curves, ROUTES, PROFILES,
    run, rideJar, stop, hide, update, setVisible, freeze, bump, thaw,
    get frozen() { return state.frozenUntil > performance.now(); },
    /** Which jar he is riding, by GLOBAL index, or -1. */
    get ridingJar() { return state.ride ? state.ride.jar : -1; },
    get position() { return readPos.setFromMatrixPosition(model.matrix); },
    /** Is he out in the room where something could reach him? (not in the wall, not on the belt) */
    get onFloor() {
      return state.visible && state.mode === 'route'
        && state.routeId !== 'belt_run' && state.routeId !== 'jar_ride';
    },
    setAuthoredSpeed: setAuthored,
    get authoredSpeed() { return authored; },
    /** Sample every route and report the closest approach to each obstacle. */
    checkRoutes: (obstacles, samples = 400, opts = {}) =>
      checkRoutes(curves, obstacles, samples, opts),
    /** Raycast probe along a route — see probeRoute(). */
    probeRoute: (routeId, root, opts = {}) => probeRoute(curves[routeId], root, opts),
    /** Can the loop camera actually SEE this route? — see sampleVisibility(). */
    visibility: (routeId, camera, root, opts = {}) =>
      sampleVisibility(curves[routeId], camera, root, opts),
  };
}

/**
 * ★ THE ROUTE CHECK IS THE REASON AUTHORED ROUTES ARE AFFORDABLE. It samples
 * each curve and reports any sample inside a prop's bounding box, plus the
 * tightest clearance. Run it against the live scene after ANY prop move — a
 * route that has drifted inside the tool cart looks completely correct from the
 * loop camera, because the mouse is 13 px and the cart is opaque.
 */
export function checkRoutes(curves, obstacles, samples = 400, opts = {}) {
  // ★ TWO EXEMPTIONS, AND EACH ONE IS A DIFFERENT TEST RATHER THAN A HOLE.
  //   Widening a check until it passes is tuning the check instead of the Loop,
  //   so neither of these simply drops an obstacle:
  //
  //   stepHeight — anything whose top is below 0.12 m is FLOOR to a mouse (rugs,
  //     cables, the cat's 5 cm pillow). This is the same class rule NPC-001
  //     needed for the cat, where Prop_Pillow_2 blocked the very cell he was
  //     placed to sleep on. It is a rule about height, never a list of names.
  //
  //   ridable — the belt is a SURFACE he travels on, and a bounding box cannot
  //     tell "standing on" from "inside": Conveyor_Frame's box spans the whole
  //     L-shaped path AND its hangers to the roof (y 2.01-5.03), so every
  //     correct point on the belt reads as a hit and its box top is useless as
  //     a floor. The caller therefore passes the SURFACE HEIGHT explicitly —
  //     {'Conveyor_Frame': 2.32} — and a point below it is still a violation,
  //     reported as "(under)". Riding under the belt cannot pass.
  //
  // ★ KNOWN LIMIT, STATED RATHER THAN HIDDEN: this is a bounding-box test, so
  //   it cannot see the belt's HANGER RODS, which are merged into
  //   Conveyor_Frame and cross the belt every 1.5 m. belt_run may pass through
  //   one. Checking that needs a raycast against the real triangles, which this
  //   does not do — do not read a green belt_run as "nothing on the belt".
  const stepHeight = opts.stepHeight ?? 0.12;
  const ridable = opts.ridable || {};
  const p = new THREE.Vector3();
  const report = {};
  for (const [id, c] of Object.entries(curves)) {
    const hits = [];
    let tightest = { d: Infinity, name: null, u: 0 };
    for (let i = 0; i <= samples; i++) {
      const u = i / samples;
      c.getPointAt(u, p);
      for (const o of obstacles) {
        if (o.box.max.y <= stepHeight) continue;              // floor to a mouse
        if (o.box.containsPoint(p)) {
          if (o.name in ridable) {
            if (p.y >= ridable[o.name] - 1e-4) continue;      // standing on it
            hits.push({ u: +u.toFixed(3), name: o.name + ' (under)' });
          } else hits.push({ u: +u.toFixed(3), name: o.name });
          continue;
        }
        if (o.name in ridable) continue;     // clearance to a surface is not a metric
        const d = o.box.distanceToPoint(p);
        if (d < tightest.d) tightest = { d: +d.toFixed(4), name: o.name, u: +u.toFixed(3) };
      }
    }
    // collapse runs of consecutive hits into one entry per obstacle
    const byName = {};
    for (const h of hits) (byName[h.name] ||= []).push(h.u);
    report[id] = {
      length: +c.getLength().toFixed(3),
      inside: Object.entries(byName).map(([n, us]) =>
        ({ name: n, from: us[0], to: us[us.length - 1] })),
      tightest,
    };
  }
  return report;
}


/**
 * ★ THE BOX TEST CANNOT JUDGE THE CONVEYOR AT ALL, SO THIS DOES.
 *
 * The belt is L-shaped and its hanger rods are merged into one mesh, so a
 * bounding box spans the whole rectangle from floor level to the roof: every
 * correct point on the belt reads as a collision, and every hanger reads as
 * clear. Both errors point the wrong way, which is the worst kind.
 *
 * probeRoute walks the route and casts a short ray ALONG TRAVEL — the question
 * a running mouse actually asks — against real triangles. Keep `root` small
 * (the conveyor group, a single prop); three's Raycaster is linear in triangles
 * with no BVH, and this building is 428k of them, which is the same reason
 * cat-walk.js uses a grid instead of whiskers.
 *
 * Returns the hits, so a hanger strike is a NAMED FINDING rather than an
 * absence of evidence.
 *
 * READ THE EPISODES, DO NOT JUST COUNT THEM. A forward ray on a DESCENDING
 * tangent necessarily hits the surface the route is landing on — the belt, a
 * crate lid — a few centimetres ahead. That is the probe working, not a
 * collision. What is a real finding is a hit whose distance approaches zero on
 * something the route is not landing on, which is how the sixteen jar strikes
 * and the rail graze were both found.
 */
export function probeRoute(curve, root, { samples = 300, reach = 0.09 } = {}) {
  if (!curve || !root) return null;
  const ray = new THREE.Raycaster();
  ray.far = reach;
  const p = new THREE.Vector3(), t = new THREE.Vector3();
  const hits = [];
  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    curve.getPointAt(u, p);
    curve.getTangentAt(u, t).normalize();
    ray.set(p, t);
    const hit = ray.intersectObject(root, true)[0];
    if (hit) hits.push({ u: +u.toFixed(3), name: hit.object.name, d: +hit.distance.toFixed(4) });
  }
  // collapse consecutive samples into episodes
  const eps = [];
  for (const h of hits) {
    const last = eps[eps.length - 1];
    if (last && last.name === h.name && h.u - last.to <= 2.5 / samples) {
      last.to = h.u; last.n++; last.minD = Math.min(last.minD, h.d);
    } else eps.push({ name: h.name, from: h.u, to: h.u, n: 1, minD: h.d });
  }
  return { samples, reach, episodes: eps };
}


/**
 * ★★★ "THE MOUSE RUNNING WHERE THE CAMERA CANNOT SEE HIM IS USELESS" (Josh,
 * 2026-09-06), MADE INTO A TEST.
 *
 * The repo already knew this about set dressing — the mouse crack itself moved
 * off canon's front-right corner because every point along that wall base is
 * occluded from the shipped pose, and DP-W2's cable run was correct, on the
 * wall, inside the room, and invisible. A ROUTE is set dressing that moves, so
 * it needs the same test, and it needs it as a number rather than as a habit.
 *
 * Projects each sample at the SHIPPED framing (16:9, whatever focal is dialled)
 * and raycasts from the eye to it. Returns the in-frame and unoccluded
 * fractions plus a per-sample map, so a route that is half-hidden tells you
 * WHICH half.
 *
 * Two things it will get wrong if you let it. Raycast against the room, not the
 * whole scene — under ?dev=1 the TransformControls gizmo sits between the eye
 * and everything, and every route reads 0 % visible, which looks like a
 * catastrophic finding and is an artifact of the reviewer tool. And exclude the
 * mouse himself, or he occludes the point he is standing on.
 */
export function sampleVisibility(curve, camera, root, {
  samples = 60, eye = null, aspect = 16 / 9, exclude = 'NPC_Mouse_Caper',
} = {}) {
  if (!curve || !camera || !root) return null;
  const from = eye ? new THREE.Vector3().fromArray(eye) : camera.getWorldPosition(new THREE.Vector3());
  const test = new THREE.PerspectiveCamera(camera.fov, aspect, 0.05, 100);
  test.position.copy(from);
  test.quaternion.copy(camera.getWorldQuaternion(new THREE.Quaternion()));
  test.updateMatrixWorld(true);
  test.updateProjectionMatrix();

  const ray = new THREE.Raycaster();
  const p = new THREE.Vector3(), d = new THREE.Vector3(), ndc = new THREE.Vector3();
  let inFrame = 0, seen = 0;
  const map = [];
  for (let i = 0; i <= samples; i++) {
    curve.getPointAt(i / samples, p);
    ndc.copy(p).project(test);
    if (!(Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z < 1)) { map.push('.'); continue; }
    inFrame++;
    d.subVectors(p, from);
    const dist = d.length();
    d.normalize();
    ray.set(from, d);
    ray.near = 0.05;
    ray.far = dist - 0.03;
    const blocked = ray.intersectObject(root, true).some((h) => {
      let a = h.object;
      while (a) { if (a.name === exclude) return false; a = a.parent; }
      return true;
    });
    if (blocked) map.push('o'); else { seen++; map.push('#'); }
  }
  const n = samples + 1;
  return {
    inFrame: +(inFrame / n * 100).toFixed(1),
    visible: +(seen / n * 100).toFixed(1),
    map: map.join(''),      // '#' seen, 'o' occluded, '.' out of frame
  };
}
