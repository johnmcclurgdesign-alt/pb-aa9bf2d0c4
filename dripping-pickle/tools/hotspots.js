// tools/hotspots.js — the one place a press is resolved (INT-001, DP-W8).
//
// Everything a viewer can aim at in this Loop registers here, and this module owns the pointer.
// That is not tidiness: loops-docs 10-platform/00-input.md opens with "which control consumed
// that press?" having produced ten separate bugs in the shell, and this scene was on its way to
// the same place — the screen array's travel handler, the jar tap and the feedback panel each ran
// their own listener, their own 4 px click-not-drag test, and their own idea of what a stray press
// means. Three handlers cannot agree about a press none of them claimed.
//
// ── the contract with the shell (read the docs, not this file, for WHY) ──────────────────────
//
// ★ HOTSPOTS ARE A LIVE QUERY, NOT A REGISTRATION. 10-platform/10-hotspots.md is explicit that
//   the shell asks every frame the cursor moves, because the thing worth aiming at in a Loop is a
//   cat walking across a room, not a menu. `aim()` therefore recomputes from the live scene every
//   call and a spot that is not aimable RIGHT NOW is simply absent from the list.
//
// ★ POSITIONS ARE UNIT SPACE, 0…1, ORIGIN TOP-LEFT — never pixels, and the radius is measured on
//   the SHORTER axis, because the shell corrects for aspect so a declared radius means the same
//   physical size on screen whichever way the surface is stretched.
//
// ★ AT MOST 16, IDS AT MOST 31 CHARACTERS. Both are asserted here rather than trusted: the shell
//   truncates and this Loop already has more nameable objects than that, so the cap has to be a
//   decision (nearest to the cursor wins) rather than whatever order a Map happened to iterate.
//
// ★ THE SHELL HAS NO HOTSPOT CHANNEL YET. Bridge v1 carries lifecycle, input and cameras and
//   nothing else — "on Apple TV the bridge (v1) has no hotspot channel". So `aim()` is wired
//   defensively and, until a v2 exists, is read by our own aim feedback and by scripted checks.
//   Building it now costs nothing and means the declaration is measured against a real scene
//   rather than invented on the day the channel lands.
//
// ★ `primary` ACTS ON `up`, AND `cancelled` MEANS THE PRESS DID NOT HAPPEN. A long press on a
//   touchscreen BEGINS as an ordinary press, so the shell retracts the down it already sent. A
//   handler that acts on the down edge fires its tap action every single time somebody holds.
//   Here that maps onto pointerdown/pointerup with a pointercancel that clears feedback and runs
//   nothing — and the DP1 bridge already synthesises exactly those three.
//
// ★ AIM ASSIST IS OURS TO DO TOO, AND THE SHELL ALREADY SPECIFIED IT. 10-hotspots.md tunes the
//   television cursor at "a capture radius of 1.8x your declared radius and magnetism 0.55",
//   signed off on both Siri Remote generations. A press that lands inside that capture disc is
//   treated as aimed at that spot. This is not a convenience: measured at 720p, the jar is an
//   18 px radius target pushed in and a 10 px one at the room pose, against a 44 pt minimum
//   anywhere else in this industry — and until this landed, every near miss on a jar ALSO threw
//   the camera out of the pose the viewer was in (Josh, 2026-09-08). Reusing the shell's own
//   number rather than inventing one means the two agree when a bridge v2 turns magnetism on.
//
// ★ A SPOT MAY BE A SCREEN-SPACE CONTROL RATHER THAN AN OBJECT. The return affordance is drawn
//   in the lens pass (so it is in every feedback screenshot), which means it has no geometry to
//   raycast. Such a spot declares `screen()` in unit space instead of `objects()`, and it is
//   tested BEFORE the world: a control painted over the room is in front of it.
//
// ★ AND A PRESS THAT ISN'T AIMED DOES NOTHING, VISIBLY (PLAN DP-W8). "Visibly" is the whole row:
//   a press that silently does nothing is indistinguishable from a Loop that has stopped
//   responding, which on a television with a synthesised cursor is the single most likely thing a
//   viewer concludes. The answer here is to pulse what IS aimable — the question behind a stray
//   press is "what can I touch?", and the honest answer is to show them, once, and let it fade.

/**
 * @param {object} o
 * @param {import('three')} o.THREE
 * @param {HTMLCanvasElement} o.canvas   the renderer's canvas
 * @param {object|(() => object)} o.camera  the live camera, or a getter for it. ★ PASS THE
 *                                      GETTER when the scene swaps its camera on load: this is
 *                                      the GTAOPass/BokehPass trap in the repo log — an extra
 *                                      pass that captured the PLACEHOLDER camera at construction
 *                                      computed everything from a camera that never moved.
 * @param {() => boolean} [o.blocked]    true while something else owns the pointer (a gizmo drag)
 */
export function createHotspots({ THREE, canvas, camera, blocked = () => false }) {
  const cam = typeof camera === 'function' ? camera : () => camera;
  const spots = [];
  const ray = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  const _v = new THREE.Vector3();

  const MAX_SPOTS = 16;          // 10-platform/10-hotspots.md
  const MAX_ID = 31;             // …plus a terminator, and they appear in diagnostics
  const DRAG_PX = 4;             // the same click-not-drag test the panel uses
  const PULSE_MS = 420;          // the "nothing here" beat

  let hovered = null;            // the spot under the cursor, or null
  let down = null;               // { x, y, spot } — the press in flight
  let pulseAt = 0;               // when the last unaimed press asked for the aim pulse
  let lastMoveAt = 0;

  /**
   * @param {object} s
   * @param {string} s.id                greppable, ≤31 chars — it goes in shell diagnostics
   * @param {() => object[]} [s.objects] what to raycast, live (an InstancedMesh is fine)
   * @param {() => {x,y,halfW,halfH}|null} [s.screen]  a screen-space control instead, unit space
   * @param {() => boolean} [s.live]     is this aimable RIGHT NOW? default: yes
   * @param {(hit) => void} s.press      run the action. `hit` is the raycast intersection.
   * @param {(hit) => boolean} [s.accept] refuse a hit that is geometrically in range but is not
   *                                     this spot — ★ THE ONLY WAY TWO SPOTS CAN SHARE MESHES.
   *                                     The CRT's cabinet is both "the array" and "the dial
   *                                     under the tube", and nearest-hit cannot separate them
   *                                     because it is the same triangle at the same distance;
   *                                     the dial takes hits below the glass and the array takes
   *                                     the rest. Without it whichever registered first wins
   *                                     every press, which is the ordering bug this module was
   *                                     built to make impossible.
   * @param {(on: boolean) => void} [s.hover]  aim feedback, both directions
   * @param {() => void} [s.pulse]       the "you could press this" beat; defaults to hover on/off
   * @param {() => {centre: object, radius: number}} [s.extent]  world centre + radius for aim(),
   *                                     defaulting to the bounding sphere of `objects()`
   */
  function register(s) {
    if (typeof s.id !== 'string' || !s.id) throw new Error('hotspot: an id is required');
    if (s.id.length > MAX_ID) throw new Error(`hotspot id "${s.id}" is ${s.id.length} chars, over the shell's ${MAX_ID}`);
    if (spots.some((x) => x.id === s.id)) throw new Error(`hotspot id "${s.id}" is already registered`);
    if (!s.objects && !s.screen) throw new Error(`hotspot "${s.id}" declares neither objects() nor screen()`);
    // `assist: false` — the spot takes a DIRECT hit only and never claims a near miss (W9). A spot
    // whose extent is most of the frame (the whole screen array) otherwise pulls every miss to itself.
    spots.push({ live: () => true, hover: null, pulse: null, extent: null, accept: null, objects: null, screen: null, assist: true, hint: false, ...s });
    return () => { const i = spots.indexOf(spots.find((x) => x.id === s.id)); if (i >= 0) spots.splice(i, 1); };
  }

  const liveSpots = () => spots.filter((s) => { try { return s.live() !== false; } catch { return false; } });

  /** Resolve a client-space point to a spot. Nearest hit wins, so a jar in front of the belt
   *  claims the press rather than whatever is registered first. */
  const CAPTURE = 1.8;      // 10-platform/10-hotspots.md, the shell's own tuning

  // ★ AND THE CAPTURE DISC NEEDS A FLOOR, BECAUSE 1.8x OF NOTHING IS STILL NOTHING. Measured on
  //   the iPhone 12 Pro at BUD2's device leg: the shell hands the Loop a 750x370 frame, where the
  //   jar's true projected radius is about 9 px — a 2 mm target, with no hover to say what a press
  //   will hit. Josh: "tapping anything just toggles the camera back and forth". 1.8x of 9 px is
  //   16 px, which no finger can land inside.
  //
  //   ⚠ THE FLOOR DOES NOT GO IN `aim()`. 10-hotspots.md is explicit — "Declare how big the thing
  //   is. How far away the cursor starts being pulled is our taste knob" — so the list handed to
  //   the shell keeps reporting each target's REAL size and the shell keeps owning its magnetism.
  //   This floor is ours, applied to our own press resolution only; the two cannot fight, because
  //   nearest-inside-the-disc wins either way.
  //
  //   22 CSS px is the radius of Apple's 44 pt minimum touch target, and it is a PHYSICAL number
  //   rather than a fraction of the frame on purpose: the shell sizes the web view in the device's
  //   own points (750x370 inside that phone's 844x390 screen), so a CSS px here is a CSS px there,
  //   while a fraction would mean 20 px on the phone and 50 px in a Mac window for one constant.
  const MIN_CAPTURE_PX = 22;
  const captureRadiusPx = (r, minAxis) => Math.max(r * minAxis * CAPTURE, MIN_CAPTURE_PX);

  function pick(clientX, clientY, { assist = true } = {}) {
    const live = liveSpots();
    const ux = clientX / innerWidth, uy = clientY / innerHeight;

    // 1. screen-space controls. They are painted over the room, so they win outright.
    for (const s of live) {
      if (!s.screen) continue;
      let r = null;
      try { r = s.screen(); } catch { continue; }
      if (!r) continue;
      if (Math.abs(ux - r.x) <= r.halfW && Math.abs(uy - r.y) <= r.halfH) {
        return { spot: s, hit: null, assisted: false };
      }
    }

    // 2. the world, by raycast. Nearest hit wins, so a jar in front of the belt claims the press.
    ptr.set(ux * 2 - 1, -(uy * 2) + 1);
    ray.setFromCamera(ptr, cam());
    let best = null;
    for (const s of live) {
      if (!s.objects) continue;
      let objs;
      try { objs = s.objects() || []; } catch { continue; }
      if (!objs.length) continue;
      const hit = ray.intersectObjects(objs, false)[0];
      if (!hit) continue;
      if (s.accept && !s.accept(hit)) continue;
      if (!best || hit.distance < best.hit.distance) best = { spot: s, hit, assisted: false };
    }
    if (best || !assist) return best;

    // 3. nothing under the press — assist. Nearest declared target whose capture disc contains
    //    it, measured on the SHORTER axis, because that is how the radius was declared.
    const list = aim();
    const minAxis = Math.min(innerWidth, innerHeight);
    let pulled = null, pulledD = Infinity;
    for (const a of list) {
      if (spots.find((x) => x.id === a.id)?.assist === false) continue;
      const dx = (ux - a.x) * innerWidth, dy = (uy - a.y) * innerHeight;
      const d = Math.hypot(dx, dy);
      if (d > captureRadiusPx(a.r, minAxis)) continue;
      if (d < pulledD) { pulledD = d; pulled = a; }
    }
    if (!pulled) return null;
    const spot = spots.find((x) => x.id === pulled.id);
    if (!spot) return null;
    // ★ RE-RAYCAST AT THE TARGET'S OWN CENTRE, don't fabricate a hit. A press handler wants a
    //   REAL intersection — the jar's needs `instanceId` to know which jar was tapped — and the
    //   centre is a point that is genuinely on the object. If even that misses (something moved
    //   in front of it between the aim and the press) the spot is handed a null hit and may
    //   refuse, which now shows the viewer the same beat an empty press does.
    let hit = null;
    if (spot.objects) {
      ptr.set(pulled.x * 2 - 1, -(pulled.y * 2) + 1);
      ray.setFromCamera(ptr, cam());
      try { hit = ray.intersectObjects(spot.objects() || [], false)[0] ?? null; } catch { hit = null; }
      if (hit && spot.accept && !spot.accept(hit)) hit = null;
    }
    return { spot, hit, assisted: true };
  }

  // ★ NO DISCOVERY CLUES IN THE SCENE (Josh, W9 device leg, 2026-09-24): "a 'glow clue' for what
  //   is interactive spoils discovery … No glows on any surface." So nothing in the room answers a
  //   pointer that is merely OVER it — no glow, no aim ring, no pointer cursor — and an empty press
  //   pulses nothing. A correct press still gets its reaction (the spot's own press()). Only a spot
  //   declared `hint: true` keeps hover feedback: the drawn ZOOM control, which is chrome, not
  //   scene. `hovered` is still tracked, because the press path and the scripted checks read it.
  function setHover(next) {
    const spot = next ? next.spot : null;
    if (spot === hovered) return;
    if (hovered && hovered.hint && hovered.hover) hovered.hover(false, null);
    hovered = spot;
    if (hovered && hovered.hint && hovered.hover) hovered.hover(true, next.hit);
    canvas.style.cursor = hovered && hovered.hint ? 'pointer' : '';
  }

  // ── the shell's question, answered live ─────────────────────────────────────────────────────
  /**
   * Every aimable thing right now, in the shell's own terms: unit space, origin top-left, radius
   * on the shorter axis. Off-screen spots are dropped (magnetism must never invent a target) and
   * the list is capped at 16 nearest the screen centre — a cap that has to be a decision, because
   * "the first 16 registered" would silently drop the cat the moment the jars outnumbered him.
   */
  function aim() {
    const out = [];
    const aspect = innerWidth / innerHeight;
    for (const s of liveSpots()) {
      if (s.screen) {
        let r = null;
        try { r = s.screen(); } catch { continue; }
        if (!r) continue;
        // a rect declared as a disc: the shell only speaks radii, and the SHORTER axis is the one
        // it measures on, so the control's half-height is what carries.
        const rr = Math.max(r.halfH, r.halfW * (innerWidth / Math.min(innerWidth, innerHeight)) * 0.5);
        out.push({ id: s.id, x: r.x, y: r.y, r: rr, _d: Math.hypot((r.x - 0.5) * aspect, r.y - 0.5) });
        continue;
      }
      let e = null;
      try { e = s.extent ? s.extent() : boundsOf(s); } catch { continue; }
      if (!e || !e.centre) continue;
      _v.copy(e.centre).project(cam());
      if (_v.z > 1) continue;                                  // behind the eye
      const x = (_v.x + 1) / 2, y = (1 - _v.y) / 2;
      if (x < -0.25 || x > 1.25 || y < -0.25 || y > 1.25) continue;
      // A world radius becomes a screen radius through the projection, and the shell measures it
      // on the SHORTER axis — so it is the VERTICAL half-extent that carries, whatever the aspect.
      const centreDist = cam().position.distanceTo(e.centre);
      const halfH = Math.tan((cam().fov * Math.PI) / 180 / 2) * centreDist;
      const r = Math.max(0.01, (e.radius || 0.01) / (halfH * 2));
      out.push({ id: s.id, x, y, r, _d: Math.hypot((x - 0.5) * aspect, y - 0.5) });
    }
    out.sort((a, b) => a._d - b._d);
    return out.slice(0, MAX_SPOTS).map(({ _d, ...rest }) => rest);
  }

  /** A spot's declared extent in WORLD space — the same centre and radius `aim()` projects.
   *  Exposed so aim feedback can be drawn on exactly what the assist will capture, instead of
   *  every spot inventing its own idea of where it is. Null for a screen-space control, which
   *  has no world position, and for a spot that is not live. */
  function extentOf(id) {
    const s = spots.find((x) => x.id === id);
    if (!s || s.screen) return null;
    try { if (s.live() === false) return null; } catch { return null; }
    try { return s.extent ? s.extent() : boundsOf(s); } catch { return null; }
  }

  const _box = new THREE.Box3(), _sph = new THREE.Sphere();
  function boundsOf(s) {
    if (!s.objects) return null;
    const objs = s.objects() || [];
    if (!objs.length) return null;
    _box.makeEmpty();
    for (const o of objs) _box.expandByObject(o);
    if (_box.isEmpty()) return null;
    _box.getBoundingSphere(_sph);
    return { centre: _sph.center.clone(), radius: _sph.radius };
  }

  // ── the pointer ─────────────────────────────────────────────────────────────────────────────
  // Registered at WINDOW CAPTURE for the same reason the flycam's right-button grab is: the
  // feedback panel and OrbitControls are both already listening on the canvas, and a handler that
  // runs after them is a handler arguing with a drag that has already started.
  addEventListener('pointermove', (e) => {
    if (e.target !== canvas) { setHover(null); return; }
    lastMoveAt = performance.now();
    if (down) return;                       // a press in flight owns its own feedback
    setHover(pick(e.clientX, e.clientY));
  }, true);

  addEventListener('pointerleave', () => setHover(null), true);

  addEventListener('pointerdown', (e) => {
    // Shift-click belongs to the reviewer's feedback panel, and always has.
    if (e.button !== 0 || e.shiftKey || e.target !== canvas || blocked()) { down = null; return; }
    // A press is pointer ACTIVITY as much as a move is, and on a touchscreen it is the only
    // activity there is — nothing hovers. Anything reading `lastMoveAt` to decide whether the
    // viewer is still there (the view toggle's dim) would otherwise fade out under a finger.
    lastMoveAt = performance.now();
    const found = pick(e.clientX, e.clientY);
    down = { x: e.clientX, y: e.clientY, spot: found };
    setHover(found);
  }, true);

  // ★ A CANCEL IS NOT AN UP. The shell retracts a press the moment a long press matures, and the
  //   docs are blunt about what that means: undo any feedback the down started, run no action.
  addEventListener('pointercancel', () => { down = null; }, true);

  addEventListener('pointerup', (e) => {
    if (!down || e.button !== 0) return;
    const press = down;
    down = null;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_PX) return;
    if (blocked()) return;
    // Re-pick at the release point rather than trusting the press: on a touchscreen the finger
    // has moved a little and the world has moved a lot — a jar travels 4 cm in the time a
    // comfortable tap takes, and acting on the down-frame's answer taps the jar's old neighbour.
    const found = pick(e.clientX, e.clientY);
    e.stopPropagation();          // no second consumer: the panel must not also select it
    // ★ Swallowing the up STRANDS OrbitControls mid-drag — it armed a rotate on the down and now
    //   never hears the release, so the camera stays glued to the bare mouse. A synthetic cancel
    //   is the clean way out; the controls treat it as a release and the panel never sees it.
    canvas.dispatchEvent(new PointerEvent('pointercancel', { pointerId: e.pointerId }));
    // ★ AN AIMED PRESS THAT DOES NOTHING IS STILL A PRESS THAT DID NOTHING. A spot may refuse —
    // the event behind it is exclusive-blocked, the character is mid-something — and if that were
    // silent it would be exactly the failure this module exists to prevent, only harder to spot,
    // because the viewer aimed correctly. `press` returning false falls through to the same
    // visible beat as an empty press.
    if (found) {
      let ran = true;
      try { ran = found.spot.press(found.hit); } catch (err) { console.warn(`hotspot ${found.spot.id}:`, err); }
      if (ran !== false) return;
    }
    // Nothing under the press. Say so.
    miss(e.clientX, e.clientY);
  }, true);

  const missHandlers = [];
  /** Something to run when a press lands on nothing. It is handed the press in UNIT space, and
   *  returning true claims it (the aim pulse is then skipped) — the SCREEN state's return is one
   *  of these, and it needs the position to tell "a miss beside the jar" from "the far wall". */
  function onMiss(fn) { missHandlers.push(fn); }

  function miss(clientX = -1, clientY = -1) {
    const ux = clientX >= 0 ? clientX / innerWidth : -1;
    const uy = clientY >= 0 ? clientY / innerHeight : -1;
    for (const fn of missHandlers) { if (fn(ux, uy) === true) return; }
    // No pulse: an empty press says nothing about what else is pressable (see setHover).
  }

  /** Distance in pixels from a press to the nearest live aim target, or Infinity if there is
   *  none on screen. The scene uses it to decide what an empty press MEANS. */
  function clearanceAt(clientX, clientY) {
    const minAxis = Math.min(innerWidth, innerHeight);
    let best = Infinity;
    for (const a of aim()) {
      const d = Math.hypot((a.x * innerWidth) - clientX, (a.y * innerHeight) - clientY)
              - captureRadiusPx(a.r, minAxis);
      if (d < best) best = d;
    }
    return best;
  }

  /** Per frame. Drives the unaimed-press pulse; hover feedback is edge-driven and needs no tick. */
  function tick() {
    if (!pulseAt) return;
    const f = (performance.now() - pulseAt) / PULSE_MS;
    if (f >= 1) {
      pulseAt = 0;
      for (const s of liveSpots()) if (s !== hovered) (s.pulse ?? s.hover)?.(false, null);
      return;
    }
    for (const s of liveSpots()) if (s !== hovered) (s.pulse ?? s.hover)?.(true);
  }

  return {
    register, aim, pick, tick, onMiss, clearanceAt, extentOf,
    CAPTURE, MIN_CAPTURE_PX, captureRadiusPx,
    /** for scripted checks and the HUD */
    get ids() { return spots.map((s) => s.id); },
    get liveIds() { return liveSpots().map((s) => s.id); },
    get hovered() { return hovered ? hovered.id : null; },
    get pulsing() { return pulseAt > 0; },
    get lastMoveAt() { return lastMoveAt; },
    /** the shell's press, without a mouse — how a scripted check and the device harness press */
    pressAt(clientX, clientY) {
      const found = pick(clientX, clientY);
      if (found && found.spot.press(found.hit) !== false) return found.spot.id;
      miss(clientX, clientY);
      return null;
    },
    pressId(id, hit = null) {
      const s = spots.find((x) => x.id === id);
      if (!s || s.live() === false) return false;
      return s.press(hit) !== false;
    },
  };
}
