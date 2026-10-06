// Walk the cat around a real room without walking through it.
//
// This is the cat-sequencer steering with the circular leash taken out and wall avoidance
// put in. Everything that was learned there still applies and is repeated here rather than
// cross-referenced, because the failure modes are all silent:
//
//   ★ A CAT CHANGES DIRECTION, NOT PACE. Steering is used for its DIRECTION only. A steering
//     force is a vector and part of it points along the velocity, so letting it drive speed
//     brakes him — measured 0.45 -> 0.07 m/s when the old leash fired, and at the bottom of
//     that the heading is noise, so he stopped and spun: 367 pivot frames in five minutes.
//     Instead: hold `travelDir` across frames, move it toward what steering asked by at most
//     maxTurnRate * dt, and rebuild the velocity at a CONSTANT speed. The path radius is then
//     speed / turnRate by construction rather than by hoping the forces work out.
//   ★ SET AN ARC RADIUS IN METRES, never a force or a turn speed. force = v^2/r, rate = v/r.
//   ★ WanderBehavior picks its target on a SPHERE, so it will steer a ground animal into the
//     air. Pin y every frame.
//   ★ setRenderComponent needs matrixAutoUpdate = false, or three recomposes the matrix from
//     position/quaternion and silently discards everything Yuka wrote — he animates
//     perfectly on the spot and never moves an inch.
//   ★ Start with a non-zero velocity or the first frames have no heading to face: measured
//     522 deg/s against a 47 deg/s cap, then clean forever after.
//   ★ Low jitter did NOT read as calm, it read as driving in circles — a property of Yuka's
//     WanderBehavior, which this module no longer uses. The ambient heading is now an
//     explicit hold-and-reconsider process; see the long note at `wanderGoal`.
//     Do not widen radius/distance to compensate — that makes the circling worse.
//
// ── AVOIDANCE, AND WHY IT IS A GRID AND NOT RAYCASTS ─────────────────────────────────────
// The obvious build is a fan of raycast whiskers. three's Raycaster is linear in triangles
// with no BVH, and this building is 428k of them — seven whiskers a frame is three million
// triangle tests per frame for a cat. So the room is measured ONCE into a coarse walkability
// grid and the whiskers become array lookups.
//
// A cell is blocked if any mesh's bounding box overlaps it in XZ *and* overlaps the cat's
// own height band in Y. The band is what keeps the floor walkable and the roof irrelevant
// without needing to name either. Boxes are coarse — a diagonal beam blocks its whole
// rectangle — which is the right error to make: he keeps clear of things rather than
// clipping them.
//
// ★ THE LOOKAHEAD MUST BE LONGER THAN THE TURNING CIRCLE OR AVOIDANCE IS IMPOSSIBLE BY
// CONSTRUCTION. He cannot turn tighter than the arc radius, so a wall spotted at less than
// that distance is already a collision. Derived from the radius, never typed.

import * as THREE from 'three';
import * as YUKA from 'yuka';

/**
 * What travel speed was this walk clip authored for? Measured off the clip, not guessed.
 *
 * ★ FOOT SLIDE IS ONE NUMBER AND IT IS THIS ONE. Clip rate = travel speed / authored speed,
 * so the paws only stay planted when the authored speed is right. It had been ASSUMED to be
 * 0.45 to match the travel speed, which makes the rate exactly 1.0 and looks deliberate. It
 * is really 0.472, so the paws were sweeping backward 4.9% faster than the room was going
 * past — about 2 cm of slip per stance. Small, and exactly what "a tiny bit of foot slide"
 * looks like.
 *
 * HOW: freeze the body at the origin, so a claw's world position IS its position relative to
 * the cat. Step the clip. A paw that is planted must sweep backward at precisely the travel
 * speed, so the backward speed of a claw during its stance phase is the answer. Stance is the
 * bottom of its vertical travel, which needs no threshold picked by eye — the lift is only
 * 3-4 cm and the bottom 15% of it is unambiguous.
 *
 * Measured here: all four claws inside 0.471-0.473, quartiles 0.467-0.475. That tight a
 * spread is why a single number can kill this almost completely.
 *
 * Re-run it after ANY re-export of the walk clip rather than carrying the number forward.
 */
export function measureAuthoredSpeed({ model, mixer, action, samples = 240 } = {}) {
  let skinned = null;
  model.traverse((o) => { if (!skinned && o.isSkinnedMesh) skinned = o; });
  if (!skinned || !action) return null;
  const claws = skinned.skeleton.bones.filter((b) => /^claw_/.test(b.name));
  if (!claws.length) return null;

  const saved = model.matrix.clone();
  const wasTime = action.time, wasWeight = action.getEffectiveWeight();
  const wasRunning = action.isRunning();
  const wasAuto = model.matrixAutoUpdate;
  action.play().setEffectiveWeight(1);
  // ★ THE SAME matrixAutoUpdate TRAP AS setRenderComponent, IN A NEW PLACE, AND IT DOES NOT
  // LOOK LIKE ONE. Freezing the body means writing `matrix` — but with matrixAutoUpdate on,
  // updateMatrixWorld RECOMPOSES it from position/quaternion/scale on the very next line and
  // the identity is gone. The claws then get measured in WORLD space, so the cat's yaw rotates
  // the backward sweep out of Z and the answer comes back short by cos(yaw): 0.197 against a
  // true 0.472 at 125 degrees. It reads as a plausible number, which is what makes it nasty —
  // and it then sets the clip rate to 2.29 and gives you far MORE slide than you started with.
  model.matrixAutoUpdate = false;
  model.matrix.identity();
  model.updateMatrixWorld(true);

  const dur = action._clip.duration, dt = dur / samples;
  const track = claws.map(() => []);
  const p = new THREE.Vector3();
  for (let i = 0; i <= samples; i++) {
    action.time = i * dt;
    mixer.update(0);                       // evaluate at this time without advancing it
    model.updateMatrixWorld(true);
    claws.forEach((b, k) => { b.getWorldPosition(p); track[k].push({ y: p.y, z: p.z }); });
  }

  model.matrix.copy(saved);
  model.matrixAutoUpdate = wasAuto;
  model.updateMatrixWorld(true);
  action.time = wasTime; action.setEffectiveWeight(wasWeight);
  if (!wasRunning) action.stop();

  const medians = [];
  for (const s of track) {
    const ys = s.map((q) => q.y);
    const lo = Math.min(...ys), thr = lo + (Math.max(...ys) - lo) * 0.15;
    const v = [];
    for (let i = 1; i < s.length; i++) {
      if (s[i].y <= thr && s[i - 1].y <= thr) {
        const back = -(s[i].z - s[i - 1].z) / dt;   // forward is +Z, so a planted paw goes -Z
        if (back > 0) v.push(back);
      }
    }
    if (v.length) { v.sort((a, b) => a - b); medians.push(v[Math.floor(v.length / 2)]); }
  }
  if (!medians.length) return null;
  return medians.reduce((a, b) => a + b, 0) / medians.length;
}

export function createCatWalk({
  model,                    // the loaded cat scene
  building,                 // what he must not walk through
  floorY,                   // world Y he stands on
  speed = 0.45,             // metres per second — the WALKING speed, and the default target
  turnRadius = 0.55,        // ★ the arc, in metres, AT `speed`. Everything else derives from it.
  stride = 0.45,            // the travel speed the walk clip was authored for
  trotStride = 0.9,         // ditto for the trot clip; measured at load, never typed
  trotSpeed = 1.05,         // how fast he travels when asked to hurry
  accel = 1.4,              // m/s^2 — how briskly he changes pace. A cat is not a vehicle.
  intentTau = 0.15,         // seconds — softens the fan's DISCRETE steps, nothing more now
  intentTauAvoid = 0.08,    // ditto while avoidance is engaged: a wall needs answering NOW
  wanderHoldSec = [1.8, 4.5],   // how long he commits to a heading before reconsidering
  wanderTurnDeg = 75,           // how far he may reconsider at once, degrees either side
  avoidCommitSec = 0.40,        // how long an avoidance correction is held — swept, see below
  ringWeight = 0.35,            // the probe ring's authority — a bias, never a decision
  lookMult = 3.5,               // lookahead as a multiple of the arc — swept, see update()
  cell = 0.3,               // walkability grid resolution, metres
  clearance = 0.22,         // how far his body is kept off a blocked cell, metres
  personal = 0.55,          // radius of the probe ring that keeps him off the skirting
  stepOver = 0.12,          // anything shorter than this is floor: rugs, cables, a pillow
  onClip = () => {},        // (name, rate) => void — the scene owns the mixer
} = {}) {

  // ── measure the room once ──────────────────────────────────────────────────
  // `building` may be one root or several — the Outpost's blockers are the shell, the
  // props, the conveyor's legs and the corner dressing, and they are separate loads.
  const roots = Array.isArray(building) ? building : [building];
  const bounds = new THREE.Box3();
  for (const r of roots) bounds.union(new THREE.Box3().setFromObject(r));
  // The band a cat actually occupies. Anything overlapping it is in his way; the floor
  // stops just below it and the roof starts far above, so neither needs naming.
  const bandLo = floorY + 0.06, bandHi = floorY + 0.55;
  // ★ A CAT STEPS OVER A PILLOW, AND THE GRID HAS NO IDEA. The band alone made the
  // Outpost's nap spot UNWALKABLE — `Prop_Pillow_2` is 6 cm tall, so it lands inside the
  // band and blocks the very cell the art director placed him to sleep on. He could then
  // never walk home from a roam, and `goTo` would have sat in 'homing' forever: a cat
  // stuck mid-room, with nothing logged and every other number green.
  // Anything whose top is below the step height is floor as far as he is concerned —
  // rugs, cables, a pillow, a dropped clipboard. It is a class, not a list of names.
  const stepTop = floorY + stepOver;

  const nx = Math.max(1, Math.ceil((bounds.max.x - bounds.min.x) / cell));
  const nz = Math.max(1, Math.ceil((bounds.max.z - bounds.min.z) / cell));
  const blocked = new Uint8Array(nx * nz);
  const idx = (ix, iz) => iz * nx + ix;

  const box = new THREE.Box3();
  let blockers = 0;
  // ★ THE CAT MUST NOT BE A BLOCKER, AND HE IS IN THE SAME GROUP AS THE ROOM. In the
  // warehouse everything selectable lives under one `pickables` group — the shell, the
  // props, the belt AND the cat — so the obvious "measure the group" call bakes his own
  // bounding box into the grid as wall. He then starts inside a blocked cell, the flood
  // fill refuses to seed, and the room comes back 0 cells reachable, which reads as the
  // grid being broken rather than as him blocking himself. Anything carrying
  // `userData.noBlock` (or under something that does) is furniture for the picker and
  // air for the grid.
  const traverse = (o, fn) => {
    if (!o.visible || o.userData?.noBlock) return;
    fn(o);
    for (const c of o.children) traverse(c, fn);
  };
  for (const r of roots) traverse(r, (o) => {
    if (!o.isMesh) return;
    box.setFromObject(o);
    if (box.max.y < bandLo || box.min.y > bandHi) return;   // above or below him
    if (box.max.y <= stepTop) return;                       // he steps over it
    blockers++;
    const ix0 = Math.max(0, Math.floor((box.min.x - clearance - bounds.min.x) / cell));
    const ix1 = Math.min(nx - 1, Math.floor((box.max.x + clearance - bounds.min.x) / cell));
    const iz0 = Math.max(0, Math.floor((box.min.z - clearance - bounds.min.z) / cell));
    const iz1 = Math.min(nz - 1, Math.floor((box.max.z + clearance - bounds.min.z) / cell));
    for (let iz = iz0; iz <= iz1; iz++)
      for (let ix = ix0; ix <= ix1; ix++) blocked[idx(ix, iz)] = 1;
  });

  // ★ "INSIDE THE BUILDING'S BOUNDING BOX" IS NOT "INSIDE THE ROOM", AND A DOORWAY IS THE
  // DIFFERENCE. The grid spans the whole bbox, so the ground OUTSIDE the walls is unblocked
  // too — and the building has a door. Measured: he walked out through it, and once past
  // the bbox every cell reads blocked, so avoidance had no clear heading to offer and he
  // simply kept going. Twenty minutes in he was 650 m away and still walking.
  //
  // So flood fill from where he starts and keep only that connected region. Anything he
  // cannot reach by walking becomes wall, which closes the doorway, the outside, and any
  // other leak nobody has found yet — without needing to name a single one of them.
  function confineToReachable(sx, sz) {
    let ix = Math.floor((sx - bounds.min.x) / cell);
    let iz = Math.floor((sz - bounds.min.z) / cell);
    ix = Math.min(nx - 1, Math.max(0, ix)); iz = Math.min(nz - 1, Math.max(0, iz));
    const reach = new Uint8Array(nx * nz);
    if (blocked[idx(ix, iz)]) return 0;                 // caller already relocated him
    const stack = [ix, iz];
    reach[idx(ix, iz)] = 1;
    let n = 1;
    while (stack.length) {
      const z0 = stack.pop(), x0 = stack.pop();
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x1 = x0 + dx, z1 = z0 + dz;
        if (x1 < 0 || z1 < 0 || x1 >= nx || z1 >= nz) continue;
        const i = idx(x1, z1);
        if (reach[i] || blocked[i]) continue;
        reach[i] = 1; n++; stack.push(x1, z1);
      }
    }
    for (let i = 0; i < blocked.length; i++) if (!reach[i]) blocked[i] = 1;
    return n;
  }

  // Outside the building is blocked too, so he cannot leave through a doorway.
  const isBlocked = (x, z) => {
    const ix = Math.floor((x - bounds.min.x) / cell);
    const iz = Math.floor((z - bounds.min.z) / cell);
    if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) return true;
    return blocked[idx(ix, iz)] === 1;
  };

  // How far the room is clear along a heading, up to `max`. Stepping at half a cell so a
  // corner cannot be missed between samples.
  const clearAhead = (x, z, ang, max) => {
    const sx = Math.sin(ang), sz = Math.cos(ang), step = cell * 0.5;
    for (let d = step; d <= max; d += step) {
      if (isBlocked(x + sx * d, z + sz * d)) return d - step;
    }
    return max;
  };

  // ── steering ───────────────────────────────────────────────────────────────
  const entityManager = new YUKA.EntityManager();
  const vehicle = new YUKA.Vehicle();
  // ★ YUKA'S WanderBehavior IS GONE, AND THE REASON IS ARITHMETIC (Josh, 2026-09-06:
  // "it seems intoxicated"). Its force is constant (~5) and always truncated to
  // `maxForce = v^2/r`, so over one frame it bends the heading by
  // atan(maxForce*dt/v) = 2.15 degrees at 30 fps — while the turn cap is
  // `maxTurnRate*dt` = v/r*dt = the SAME 2.15 degrees. The two are identical by
  // construction, both being derived from v and r. So the ambient heading was a random
  // walk whose step size was exactly the turn limit: the cat sat at full lock
  // permanently and reversed whenever the walk did. Measured on the shipped ambient
  // cat: ~2 reversals per second, median run of consistent turning 1.2-2.1 degrees.
  //
  // Low-passing that signal does not fix it, because the noise IS the exploration —
  // damping the sum took him from 52 half-metre cells in five minutes to 6, orbiting.
  // Restlessness and smoothness need SEPARATE TIMESCALES, so the ambient heading is now
  // an explicit slow process: hold a heading for a few seconds, then choose a new one and
  // turn to it at the arc's rate. Big changes, rarely — which is what an animal choosing
  // where to go looks like, and it is the same insight as the jitter note it replaces
  // (low jitter read as driving in circles because the SIGN took a minute to flip; here
  // the sign is chosen outright, so the two failure modes stop being a trade).
  //
  // Yuka still owns position integration and turns the body toward the velocity we write,
  // which is all it was ever doing for us underneath the wander.
  entityManager.add(vehicle);
  let wanderGoal = 0;              // the heading he currently intends to travel
  let wanderHold = 0;              // seconds left on it
  const rnd = (a, b) => a + Math.random() * (b - a);

  // ── pace ───────────────────────────────────────────────────────────────────
  // `speed` is now a CURRENT value that chases `speedTarget` at `accel`. NPC-001 held it
  // constant deliberately ("a cat changes direction, not pace") and that is still right for
  // wandering — but a chase has no other way to read as a chase, so pace became a dial the
  // caller sets rather than a constant nobody can reach.
  const baseSpeed = speed;
  let speedTarget = speed;

  // ★ AND THE CLIP RATE IS DRIVEN BY MEASURED TRAVEL, NOT BY THE COMMANDED SPEED. It used
  // to be `speed / stride` — two constants, so the rate was the single value 0.954 emitted
  // every frame for the life of the session. It could not tell standing from turning from
  // walking, which is exactly how it read. The containment constraint reverts steps and the
  // wall-slide eats displacement, so what the body ACTUALLY does is the only honest input:
  // measured 3.3% of frames under 0.05 m/s while the feet ran at full rate.
  let measured = speed;          // EMA of real displacement per second

  // ★ THE ARC GROWS WITH PACE, SO THE TURN CAP DOES NOT. A cat at a trot cannot corner
  // like a cat at a walk, and holding `turnRadius` fixed while raising speed would raise
  // `speed/turnRadius` — handing the fastest gait the HARDEST turning. That is backwards
  // physically and it looks it. Scaling the arc linearly with speed keeps the cap constant
  // across every gait, so the pursuit reads as a wider, committed curve rather than a
  // faster slew.
  const arcAt = (v) => turnRadius * (v / baseSpeed);
  function applyTurn() {
    vehicle.maxSpeed = speed;
    const r = arcAt(speed);
    vehicle.maxForce = (speed * speed) / r;
    vehicle.maxTurnRate = speed / r;
  }
  applyTurn();

  // Drop him on the first walkable cell at or near where the scene put him.
  const start = new THREE.Vector3();
  model.getWorldPosition(start);
  if (isBlocked(start.x, start.z)) {
    let best = null;
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      if (blocked[idx(ix, iz)]) continue;
      const x = bounds.min.x + (ix + 0.5) * cell, z = bounds.min.z + (iz + 0.5) * cell;
      const d = (x - start.x) ** 2 + (z - start.z) ** 2;
      if (!best || d < best.d) best = { x, z, d };
    }
    if (best) start.set(best.x, start.y, best.z);
  }
  const reachable = confineToReachable(start.x, start.z);

  // Non-zero velocity from the first frame — see the note at the top.
  const a0 = Math.random() * Math.PI * 2;
  vehicle.position.set(start.x, floorY, start.z);
  vehicle.rotation.fromEuler(0, a0, 0);
  vehicle.velocity.set(Math.sin(a0) * speed, 0, Math.cos(a0) * speed);
  // Yuka's forward is +Z and this cat's head is +Z too, so no correction. Guess it wrong
  // and he moonwalks.
  vehicle.setRenderComponent(model, (entity, rc) => { rc.matrix.copy(entity.worldMatrix); });
  model.matrixAutoUpdate = false;   // REQUIRED — see the note at the top

  // The direction he is actually TRAVELLING. Held across frames so it can only change at
  // the arc's rate, which is what makes the path a curve rather than a set of instant turns.
  let travelDir = a0;
  // ★ HIS HEADING INTENT IS DAMPED, AND THIS IS THE DRUNK-WALK FIX (Josh, 2026-09-06).
  // The rate limiter was faithfully following a signal that is noise: wander re-rolls its
  // target every frame, the avoidance fan returns DISCRETE deviations that flip sides
  // between frames, and the personal-space ring is eight binary probes over 0.3 m cells
  // that switch on and off as he moves. Measured on the shipped ambient cat: about TWO
  // direction reversals per second, with a median run of consistent turning of 1.2-2.1
  // degrees. He was not arcing, he was vibrating.
  //
  // Widening the arc does not help and can hurt (0.75 m measured 4.72 reversals/s against
  // 0.40 m's 1.92) — the arc bounds how fast he MAY turn, not how often he changes his
  // mind. So low-pass the intent itself and let the rate limit act on something smooth.
  // Avoidance gets a much shorter time constant, because a wall is not a preference.
  let wantS = a0;
  // Somewhere known-good to aim at if he is ever found outside the walkable region.
  const home = { x: start.x, z: start.z };
  let lastClear = 99;
  let gait = 'walk';              // which locomotion clip the scene should be showing
  let fanFired = false;           // did the avoidance fan deviate him this frame?

  // Candidate deviations, in radians, smallest first: he should prefer to keep going.
  // ★ SIGNED, AND THE SIGN IS CHOSEN PER FRAME. An unsigned fan tried in a fixed
  // [+, -, +, -] order always breaks ties to the same side, and in a corner that is a
  // stable orbit — measured a 20 s loop in one before this. Ask which way round is
  // actually more open first, then try that side at each deviation.
  const FAN = [0.35, 0.7, 1.15, 1.7, 2.4];

  // ── going somewhere on purpose ─────────────────────────────────────────────
  // Wander is what he does with no errand. An errand — walk back to the nap spot, cross
  // to the mouse hole, follow the belt — is a POINT, and it steers exactly like the
  // avoidance does: it biases the DESIRED heading and then the same rate limit and the
  // same constant speed carry it out. It is not a second movement system, and that is
  // deliberate: a target that assigned the heading would pivot, and every gate this
  // module is measured against is a statement about pivots.
  let target = null;              // {x, z, radius, onArrive}

  let contacts = 0;

  function update(dt) {
    const px0 = vehicle.position.x, pz0 = vehicle.position.z;

    // Pace first: approach the commanded speed at a finite acceleration, then re-derive
    // the arc and the caps from it. A step change in speed would read as a teleport in
    // gait, and the whole point of the ladder is that you can SEE him change his mind.
    if (speed !== speedTarget) {
      const d = speedTarget - speed;
      const step = accel * dt;
      speed = Math.abs(d) <= step ? speedTarget : speed + Math.sign(d) * step;
      applyTurn();
    }
    entityManager.update(dt);
    vehicle.position.y = floorY;          // wander steers on a sphere; pin the ground animal

    // ★ THE OUTPOST IS NOT THE FACTORY, AND AVOIDANCE ALONE CANNOT HOLD IT (DP-W6).
    // The factory's walkable floor was open, so a 1.4 m lookahead always had a clear
    // heading to offer. This room is 17 m2 of walkable floor threaded between desks,
    // and its blocked bands are routinely ONE cell (0.3 m) thick — thinner than he
    // crosses in a fifth of a second. Avoidance is a heading PREFERENCE; when every
    // heading is bad it returns the least-bad one and he walks into the wall anyway.
    // Measured over ten simulated minutes before this: he left the room and spent
    // 86% of frames inside a blocked cell, visiting 700 half-metre cells of a room
    // that has about 70 — the documented "650 m away" escape, in a small room.
    //
    // So containment stops being a preference and becomes a CONSTRAINT: take the step,
    // and if it lands in a blocked cell, refuse it and slide along whichever single
    // axis is still clear. He then cannot occupy a blocked cell at all, which is what
    // "no wall clips" has to mean. The steering above is unchanged and still does all
    // the actual work; this only catches what it could not.
    //
    // ★ AND NOTE THE DIAGNOSTIC THAT CAME WITH IT: the peak turn rate read EXACTLY 2x
    // the cap in every configuration (93.8 against 46.9, 128.9 against 64.5, 171.9
    // against 85.9). That is not a second bug in the turn limiter. It is the recovery
    // block below applying a second rate-limited turn in the same frame as the normal
    // one — every frame, because he was inside a wall every frame. One cause, two
    // alarming numbers.
    if (isBlocked(vehicle.position.x, vehicle.position.z)) {
      if (!isBlocked(vehicle.position.x, pz0)) vehicle.position.z = pz0;
      else if (!isBlocked(px0, vehicle.position.z)) vehicle.position.x = px0;
      else { vehicle.position.x = px0; vehicle.position.z = pz0; }
      contacts++;
    }

    const v = vehicle.velocity;
    v.y = 0;

    // The ambient intent: hold a heading, then pick a new one. `wanderTurnDeg` is how far
    // he may reconsider at once and `wanderHoldSec` is how long he commits — together they
    // set both how smooth he looks and how much of the room he uses.
    wanderHold -= dt;
    if (wanderHold <= 0) {
      wanderHold = rnd(wanderHoldSec[0], wanderHoldSec[1]);
      const spread = wanderTurnDeg * Math.PI / 180;
      wanderGoal = travelDir + rnd(-spread, spread);
    }
    let want = wanderGoal;

    // An errand overrides the wander's intent, but NOT the avoidance below it — the fan
    // still gets to refuse a heading that walks him into a desk, so a target on the far
    // side of the room is approached around the furniture rather than through it.
    if (target) {
      const dx = target.x - vehicle.position.x, dz = target.z - vehicle.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= target.radius * target.radius) {
        const done = target.onArrive;
        target = null;
        if (done) done();
      } else {
        want = Math.atan2(dx, dz);
      }
    }

    // ★ Lookahead is derived, not typed: he cannot turn tighter than the arc, so anything
    // closer than the turning circle is already unavoidable. 2.5x gives him room to commit
    // to a curve rather than a swerve.
    // ★ Lookahead is derived, not typed, and 2.5x was fitted against a cat whose heading
    // was noise — one that never drove at anything long enough to need much warning. A cat
    // that COMMITS to a line needs to see far enough to turn off it: at 0.45 m/s and a
    // 64.5 deg/s cap a 90 degree change takes 1.4 s, which is 0.63 m of travel, so 1.0 m
    // of warning leaves almost nothing in hand. Swept below.
    const look = Math.max(arcAt(speed) * lookMult, 0.9);
    const px = vehicle.position.x, pz = vehicle.position.z;

    // Take the least-deviant heading that is clear. Measuring from `want` rather than from
    // `travelDir` keeps the wander's intent when the room allows it.
    lastClear = clearAhead(px, pz, want, look);
    if (lastClear < look) {
      // Which way round is more open? One probe each side, at the widest deviation.
      const wide = FAN[FAN.length - 1];
      const openL = clearAhead(px, pz, want + wide, look);
      const openR = clearAhead(px, pz, want - wide, look);
      const first = openL >= openR ? 1 : -1;
      let best = { ang: want, clear: lastClear };
      outer:
      for (const dev of FAN) {
        for (const sign of [first, -first]) {
          const a = want + dev * sign;
          const c = clearAhead(px, pz, a, look);
          if (c > best.clear) best = { ang: a, clear: c };
          if (c >= look) break outer;          // least deviation that is fully clear
        }
      }
      want = best.ang;
      lastClear = best.clear;
      // ★ ONLY A REAL AVOIDANCE CHANGES HIS MIND. Writing the heading back on ANY change
      // sounds equivalent and is not: the probe ring below nudges every single frame, so
      // the intent was being rewritten continuously, the ambient timer never fired a fresh
      // choice, and he followed the ring's bias round in circles — median sweep 215
      // degrees, which is the documented "driving in circles" failure arriving by a new
      // route. The fan is a DECISION (go round the left of the desk); the ring is a
      // CONTINUOUS BIAS (do not scrape). Only the decision persists — and it is written
      // back BELOW, after the ring has had its say.
      fanFired = true;
    }

    // ★ "CLEAR AHEAD" IS NOT THE SAME AS "NOT SCRAPING A WALL", and the difference is a cat
    // who paces the skirting board. Travelling PARALLEL to a wall reads as fully clear at
    // every lookahead, so nothing above objects while wander curves him back into it and out
    // again — measured two episodes of ~17 s spent inside 0.3 m of a wall, both with
    // clearance reading the full 1.38 m. So give him personal space as well as a path: a
    // short probe ring, and a nudge directly away from whatever is inside it. It is a bias
    // on the desired heading, not a force, so the constant-speed rule above still holds.
    let rx = 0, rz = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const sx = Math.sin(a), sz = Math.cos(a);
      if (isBlocked(px + sx * personal, pz + sz * personal)) { rx -= sx; rz -= sz; }
    }
    if (rx || rz) {
      const away = Math.atan2(rx, rz);
      let d = away - want;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      // ★ AND THE RING HAS TO BE ABLE TO WIN. As a fixed offset re-applied from the goal
      // every frame it biased him without ever turning him off the obstacle, so he
      // committed to a heading and ground along the furniture: measured 6.5% of frames
      // needing a containment correction against NPC-001's 0.22%. Deepening the nudge
      // with how long he has been in the ring makes it a decision when it needs to be one
      // and a whisper when it does not — a cat does walk near walls, it just does not sand
      // them down.
      // ★ THE RING MUST STAY A WHISPER, AND TRYING TO PROMOTE IT IS A DEAD END. In 18.6 m2
      // of walkable floor threaded between desks, being inside a 0.55 m ring is the NORMAL
      // state, not an exception — NPC-001 measured 4.3% of an hour within 30 cm and called
      // it correctly: "in a room this size being within 30 cm of furniture is where a cat
      // lives". Letting sustained contact rewrite his intent therefore rewrites it almost
      // continuously, and he circles: measured p90 sweep 562 degrees over 24 half-metre
      // cells. It is a bias, and the fan below is the thing that gets to decide.
      want += d * ringWeight;
    }

    // ★ AND THE WRITE-BACK HAPPENS HERE, NOT AT THE FAN — BECAUSE THE FAN'S ANSWER RUNS
    // ALONG THE OBSTACLE. It returns the least-deviant CLEAR heading, and beside a desk
    // that is the heading parallel to it; storing that as his intent makes him commit to
    // following the furniture, which is the documented "travelling parallel to a wall
    // reads as fully clear at every lookahead" trap arriving through the intent rather
    // than through the steering. Measured with the write-back at the fan: 46.5% of an hour
    // spent within 30 cm of something, against NPC-001's 4.3%. Folding the ring's push in
    // first means what he commits to is "round it AND off it".
    if (fanFired) {
      wanderGoal = want;
      if (wanderHold < avoidCommitSec) wanderHold = avoidCommitSec;
      fanFired = false;
    }

    // ★ DAMP THE INTENT BEFORE RATE-LIMITING IT. See the note by `wantS`. `want` at this
    // point is the raw sum of a per-frame wander roll, a discrete avoidance deviation and a
    // binary probe ring — it is a step function, and rate-limiting a step function gives a
    // cat that changes its mind twice a second. Avoidance shortens the time constant so a
    // wall still gets answered immediately; a preference does not.
    {
      const tau = lastClear < look ? intentTauAvoid : intentTau;
      let dw = want - wantS;
      while (dw > Math.PI) dw -= 2 * Math.PI;
      while (dw < -Math.PI) dw += 2 * Math.PI;
      wantS += dw * (1 - Math.exp(-dt / Math.max(tau, 1e-3)));
      if (wantS > Math.PI) wantS -= 2 * Math.PI;
      else if (wantS < -Math.PI) wantS += 2 * Math.PI;
      want = wantS;
    }

    // ★ Direction only, rate limited. This is the whole trick.
    let da = want - travelDir;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    travelDir += THREE.MathUtils.clamp(da, -vehicle.maxTurnRate * dt, vehicle.maxTurnRate * dt);
    // Wrap. sin/cos do not care, but this loop is meant to run FOREVER in a browser tab and
    // an angle that only ever accumulates is a slow precision leak — after a day of turning
    // it is a six-figure number of radians, and every heading it produces is that bit
    // coarser. Costs nothing to keep it in range.
    if (travelDir > Math.PI) travelDir -= 2 * Math.PI;
    else if (travelDir < -Math.PI) travelDir += 2 * Math.PI;
    v.set(Math.sin(travelDir) * speed, 0, Math.cos(travelDir) * speed);

    // Belt and braces: if a frame still lands him inside a blocked cell — a dt spike, or a
    // gap the grid could not see — push him back out rather than letting him walk on
    // through. Never happens in normal running; when it does, the alternative is a cat
    // inside a wall for the rest of the session.
    if (isBlocked(vehicle.position.x, vehicle.position.z)) {
      // Back out along the way he came, and AIM him home. Backing out alone is not a
      // recovery: outside the reachable region every heading reads blocked, so the fan has
      // nothing to offer and he keeps walking. That is how he ended up 650 m away.
      vehicle.position.x -= Math.sin(travelDir) * speed * dt * 2;
      vehicle.position.z -= Math.cos(travelDir) * speed * dt * 2;
      // Turn him home at the SAME rate limit as everything else. Assigning the heading
      // outright here is a pivot, and the safety net is not exempt from the one rule this
      // whole module exists to keep — measured a single 1040 deg/s frame in an hour, which
      // is one visible snap in an hour, which is one too many for a loop that plays forever.
      let hd = Math.atan2(home.x - vehicle.position.x, home.z - vehicle.position.z) - travelDir;
      while (hd > Math.PI) hd -= 2 * Math.PI;
      while (hd < -Math.PI) hd += 2 * Math.PI;
      travelDir += THREE.MathUtils.clamp(hd, -vehicle.maxTurnRate * dt, vehicle.maxTurnRate * dt);
      v.set(Math.sin(travelDir) * speed, 0, Math.cos(travelDir) * speed);
    }

    // ── the one place the two systems touch ───────────────────────────────────
    // MEASURED travel drives the clip, so a paw stays planted on a floorboard as it passes
    // AND the feet stop when the body does. Smoothed over ~0.15 s: raw per-frame
    // displacement is noisy enough to make the legs stutter, and a single blocked frame is
    // not a stop.
    const moved = Math.hypot(vehicle.position.x - px0, vehicle.position.z - pz0) / Math.max(dt, 1e-4);
    measured += (moved - measured) * (1 - Math.exp(-dt / 0.15));

    // The gait ladder. Each clip is authored for its own travel speed, so the rate is
    // always `measured / that clip's stride` — the crossover is simply whichever clip is
    // closer to what he is actually doing, with a band so a speed hovering on the boundary
    // does not flicker between the two.
    const hi = (trotStride + stride) * 0.5;
    if (gait === 'walk' && measured > hi * 1.15) gait = 'trot';
    else if (gait === 'trot' && measured < hi * 0.85) gait = 'walk';
    const clipStride = gait === 'trot' ? trotStride : stride;
    // Floor of 0, not 0.35: a stationary cat's feet must be able to STOP. The old floor is
    // why they ran on the spot through every refused step.
    onClip(gait, THREE.MathUtils.clamp(measured / clipStride, 0, 2.5));
  }

  return {
    update,
    vehicle,
    /** Debug: the grid, for drawing or for a test to assert against. */
    grid: { nx, nz, cell, min: bounds.min.clone(), blocked },
    stats: () => ({
      blockers, cells: nx * nz, reachable, stride, contacts, stepOver,
      blockedCells: blocked.reduce((a, b) => a + b, 0),
      clearAhead: +lastClear.toFixed(2),
      pos: [+vehicle.position.x.toFixed(2), +vehicle.position.z.toFixed(2)],
      headingDeg: +(travelDir * 180 / Math.PI).toFixed(1),
    }),
    setSpeed: (v) => { speed = v; speedTarget = v; applyTurn(); },
    setTurnRadius: (v) => { turnRadius = v; applyTurn(); },
    setStride: (v) => { stride = v; },
    /** The trot clip's authored travel speed. MEASURED at load, never typed — same rule
     *  as `stride`, and a re-export that changes the clip must not leave a stale number. */
    setTrotStride: (v) => { if (v > 0.05 && isFinite(v)) trotStride = v; },
    /**
     * Ask him to change pace. `walk` is the ambient default; `trot` is the pursuit gait.
     * He ACCELERATES into it — the change is visible, which is the point of having it.
     */
    setPace(v) { speedTarget = Math.max(0.05, v); },
    walkPace() { speedTarget = baseSpeed; },
    trotPace() { speedTarget = trotSpeed; },
    get pace() { return speed; },
    get paceTarget() { return speedTarget; },
    get travelSpeed() { return measured; },
    get gait() { return gait; },
    setAvoidCommit: (v) => { if (v >= 0) avoidCommitSec = v; },
    setRingWeight: (v) => { if (v >= 0) ringWeight = v; },
    setLookMult: (v) => { if (v > 0) lookMult = v; },
    /** Ambient restlessness: how long a heading is held, and how far it may jump. */
    setWander: (holdLo, holdHi, turnDeg) => {
      if (holdLo > 0 && holdHi >= holdLo) wanderHoldSec = [holdLo, holdHi];
      if (turnDeg > 0) wanderTurnDeg = turnDeg;
    },
    /** The heading-intent time constants, in seconds. Swept, not guessed — a long tau
     *  buys committed arcs and costs room coverage, because he stops changing his mind
     *  often enough to leave the loop he is in. */
    setIntentTau: (v, avoid) => {
      if (v > 0) intentTau = v;
      if (avoid > 0) intentTauAvoid = avoid;
    },
    get intentTau() { return intentTau; },

    /**
     * Walk to a point and call back on arrival. `radius` is how close counts as there —
     * it must be at least a cell or so, because he travels in arcs and cannot converge
     * on a point the way a seek behaviour pretends to.
     */
    goTo(x, z, { radius = cell * 1.5, onArrive = null } = {}) {
      target = { x, z, radius, onArrive };
    },
    clearTarget() { target = null; },
    get hasTarget() { return target !== null; },
    get position() { return vehicle.position; },
    /** Is a point somewhere he could stand? Used to validate a nap spot or a hole mouth. */
    walkable: (x, z) => !isBlocked(x, z),

    /**
     * ★ RUN THE HOUR WITHOUT DRAWING IT. The gate on this module is a statement about an
     * hour of walking — 0 pivot frames, no wall clips — and an hour is not something you
     * can watch, nor something a browser pane will render (a hidden pane stops rAF
     * entirely: 8 frames in 3 seconds, measured). So step the same `update()` on a fixed
     * dt in a tight loop and count. Nothing here is a separate implementation of the
     * movement: it is the shipped update, run fast.
     *
     * A pivot frame is one whose turn exceeded the configured cap — the cap is what the
     * rate limiter enforces, so any excess means something assigned a heading instead of
     * approaching one. A wall frame is one that ended inside a blocked cell.
     */
    sim(seconds = 3600, dt = 1 / 30) {
      const steps = Math.round(seconds / dt);
      // The cap follows the CURRENT arc, exactly as applyTurn does — with the arc scaling
      // with pace this is constant across gaits, but deriving it twice by hand is how the
      // gate and the limiter drift apart.
      const cap = speed / arcAt(speed);
      let pivots = 0, wall = 0, peakTurn = 0, prev = travelDir, near = 0;
      const contacts0 = contacts;
      const visited = new Set();
      for (let i = 0; i < steps; i++) {
        update(dt);
        let d = travelDir - prev;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        const rate = Math.abs(d) / dt;
        // A hair of slack: the limiter clamps to exactly cap*dt, and comparing a float
        // against itself is how a correct run reports a pivot on the first frame.
        if (rate > cap * 1.001) pivots++;
        if (rate > peakTurn) peakTurn = rate;
        prev = travelDir;
        const x = vehicle.position.x, z = vehicle.position.z;
        if (isBlocked(x, z)) wall++;
        // Time spent scraping: the failure the personal-space ring exists to stop.
        let touching = false;
        for (let k = 0; k < 8 && !touching; k++) {
          const a = (k / 8) * Math.PI * 2;
          if (isBlocked(x + Math.sin(a) * 0.3, z + Math.cos(a) * 0.3)) touching = true;
        }
        if (touching) near++;
        visited.add(`${Math.round(x * 2)},${Math.round(z * 2)}`);
      }
      return {
        seconds, steps,
        pivotFrames: pivots,
        wallFrames: wall,
        peakTurnRateDeg: +(peakTurn * 180 / Math.PI).toFixed(1),
        capDeg: +(cap * 180 / Math.PI).toFixed(1),
        withinThirtyCmPct: +(100 * near / steps).toFixed(1),
        halfMetreCellsVisited: visited.size,
        contactFrames: contacts - contacts0,
      };
    },
  };
}
