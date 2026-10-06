// flycam.js — Unreal-Engine-style WASD/QE flight layered on top of OrbitControls.
//
// Orbit alone is painful in an interior: you can only circle a fixed point, so
// getting behind a wall or up to a beam means dollying out, re-targeting, and
// dollying back. This adds the fly half without replacing orbit — with no button
// held, drag still orbits and the wheel still dollies.
//
// It copies the level viewport, so the muscle memory transfers:
//
//   HOLD RIGHT MOUSE            everything below only applies while it is held.
//                               This is the whole of UE's model — WASD is not a
//                               camera control until you grab the viewport.
//   mouse                       look (yaw + pitch, never roll)
//   W / S                       forward / back along the camera's true view axis
//   A / D                       strafe left / right
//   Q / E                       down / up along WORLD up, never the camera's —
//                               otherwise "up" tilts with the look direction and
//                               you drift off the level you're inspecting
//   mouse wheel                 camera speed, 5 notches, each double the last
//
//   Shift x4 / Alt x0.25 are OURS, not UE's — the engine has no boost modifier,
//   it expects you to use the wheel. Kept because they were here first.
//
// Movement is physics-based like the engine's (FEditorCameraController): a key
// press is an acceleration, not a velocity, so the camera ramps in over ~150 ms
// and coasts to a stop rather than snapping on and off.
//
// The integration trick is that every move translates the camera AND
// controls.target by the same vector, and every LOOK re-plants the target down
// the new view axis at the same distance. OrbitControls derives its spherical
// from (position - target) and ends update() with lookAt(target), so keeping
// those two in agreement means it never fights us or snaps back, and you carry
// on orbiting around whatever you flew to.

import * as THREE from 'three';

const DEG = Math.PI / 180;

const DEFAULTS = {
  // UE's camera-speed ladder: notches that each double the last, 4 by default.
  // The engine offers eight, but this building is 35 m across — notch 8 would be
  // 96 m/s, which crosses it in a third of a second. Capped at 5 (12 m/s).
  speedSetting: 4,
  minSetting: 1,
  maxSetting: 5,
  // Metres/second at notch 4. The engine's own constant is in unreal units against
  // a level of unknown size, so the ladder is anchored to the speed already fitted
  // to this building (~35 m across in ~6 s) instead of to a raw engine number.
  baseSpeed: 6,
  speedScalar: 1,          // UE's "Camera Speed Scalar" viewport option
  // MovementVelocityDampingAmount, the engine's default. 20/s reaches ~95% of top
  // speed in 150 ms and coasts down over about the same — the acceleration is then
  // derived from it (accel = speed * damping) so the dial still means m/s.
  damping: 20,
  lookSensitivity: 0.15,   // degrees of rotation per pixel of mouse travel
  maxPitch: 89.9,          // straight up/down would flip the horizon
  requireRightMouse: true, // false = the old always-on behaviour
  pointerLock: true,       // hide + trap the cursor while looking, as UE does
  speedReadout: true,      // wheel-to-change-speed is invisible without it
  fastMul: 4,
  slowMul: 0.25,
  maxStep: 0.1,            // clamp dt: after a tab-switch the first frame can be seconds long
};

// Positional codes, not e.key — 'KeyW' is the same physical key on AZERTY/QWERTZ,
// where e.key would be 'z' and the controls would be nonsense.
const AXES = {
  KeyW: ['fwd',   1], KeyS: ['fwd',  -1],
  KeyD: ['right', 1], KeyA: ['right',-1],
  KeyE: ['up',    1], KeyQ: ['up',  -1],
};

const isTyping = (el) =>
  !!el && (el.isContentEditable ||
           /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''));

export function createFlyCam({ camera, controls, domElement, opts = {} } = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const el = domElement || (controls && controls.domElement) || document;

  const held = new Set();
  const mods = { shift: false, alt: false };
  let enabled = true;
  let flying = false;          // right mouse down over the canvas
  let wantLock = false;        // we asked for pointer lock and should give it back
  let prevControls = null;     // controls.enabled as we found it

  const fwd   = new THREE.Vector3();
  const right = new THREE.Vector3();
  const dir   = new THREE.Vector3();
  const cmd   = new THREE.Vector3();
  const vel   = new THREE.Vector3();
  const step  = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const WORLD_UP = new THREE.Vector3(0, 1, 0);

  // ── speed ladder ──────────────────────────────────────────────────────────
  const settingSpeed = () =>
    cfg.baseSpeed * Math.pow(2, cfg.speedSetting - 4) * cfg.speedScalar;

  function speedNow() {
    let s = settingSpeed();
    if (mods.shift) s *= cfg.fastMul;
    if (mods.alt)   s *= cfg.slowMul;
    return s;
  }

  function setSetting(n) {
    const clamped = Math.max(cfg.minSetting, Math.min(cfg.maxSetting, Math.round(n)));
    if (clamped === cfg.speedSetting) return;
    cfg.speedSetting = clamped;
    flashSpeed();
  }

  // A wheel notch that changes nothing you can see reads as a broken wheel, and
  // UE puts the number in the viewport toolbar for the same reason.
  let readout = null, readoutTimer = 0;
  function flashSpeed() {
    if (!cfg.speedReadout || typeof document === 'undefined') return;
    if (!readout) {
      readout = document.createElement('div');
      readout.style.cssText =
        'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);padding:6px 12px;' +
        'border-radius:6px;background:rgba(12,14,18,.82);color:#e8ecf4;pointer-events:none;' +
        'font:12px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.04em;' +
        'z-index:99999;opacity:0;transition:opacity .18s;';
      document.body.appendChild(readout);
    }
    readout.textContent =
      `camera speed ${cfg.speedSetting}/${cfg.maxSetting}  ·  ${settingSpeed().toFixed(1)} m/s`;
    readout.style.opacity = '1';
    clearTimeout(readoutTimer);
    readoutTimer = setTimeout(() => { if (readout) readout.style.opacity = '0'; }, 900);
  }

  // ── the right-mouse session ───────────────────────────────────────────────
  function startFlight() {
    if (flying || !enabled) return;
    flying = true;
    // OrbitControls has RIGHT bound to pan and would fight every mouse move.
    // It early-returns from its own listeners while disabled, which also hands us
    // the wheel; update() still runs, so damping and lookAt(target) keep working.
    if (controls) { prevControls = controls.enabled; controls.enabled = false; }
  }

  function endFlight() {
    if (!flying) return;
    flying = false;
    held.clear();                 // keys can't be "down" for a session that ended
    if (controls && prevControls !== null) { controls.enabled = prevControls; prevControls = null; }
    if (wantLock) {
      wantLock = false;
      if (document.pointerLockElement) document.exitPointerLock();
    }
  }

  // Locking on button-down would flash the browser's "press Esc" toast at anyone
  // who merely right-clicks. Wait until the drag is real.
  function maybeLock(travel) {
    if (!cfg.pointerLock || wantLock || travel < 3) return;
    if (!el.requestPointerLock || document.pointerLockElement) return;
    wantLock = true;
    try { const p = el.requestPointerLock(); if (p && p.catch) p.catch(() => {}); }
    catch { /* movementX/Y still works unlocked — the cursor just isn't trapped */ }
  }

  // ── look ──────────────────────────────────────────────────────────────────
  function reanchorTarget() {
    if (!controls) return;
    const dist = camera.position.distanceTo(controls.target) || 1;
    camera.getWorldDirection(fwd);
    controls.target.copy(camera.position).addScaledVector(fwd, dist);
  }

  function look(dx, dy) {
    const s = cfg.lookSensitivity * DEG;
    euler.setFromQuaternion(camera.quaternion, 'YXZ');
    euler.y -= dx * s;
    euler.x -= dy * s;
    euler.z = 0;                                   // the level viewport never rolls
    const lim = cfg.maxPitch * DEG;
    euler.x = Math.max(-lim, Math.min(lim, euler.x));
    camera.quaternion.setFromEuler(euler);
    reanchorTarget();
  }

  // ── input ─────────────────────────────────────────────────────────────────
  // Both of these run at WINDOW CAPTURE, not on the canvas. OrbitControls listens on
  // the canvas and is constructed first, and at the target element listeners fire in
  // registration order regardless of the capture flag — so a canvas-level listener
  // here would run second, after OrbitControls had already captured the pointer and
  // started a right-button PAN. Capturing at the window and stopping propagation is
  // the only ordering that keeps the right button ours.
  const inEl = (t) => el === document || el === t || (el.contains && el.contains(t));

  const onPointerDown = (e) => {
    if (!enabled || e.button !== 2 || !inEl(e.target)) return;
    e.stopPropagation();
    startFlight();
  };
  const onPointerMove = (e) => {
    if (!flying || !camera) return;
    const dx = e.movementX || 0, dy = e.movementY || 0;
    if (!dx && !dy) return;
    maybeLock(Math.abs(dx) + Math.abs(dy));
    look(dx, dy);
  };
  const onPointerUp = (e) => { if (e.button === 2) endFlight(); };
  const onContextMenu = (e) => { if (enabled) e.preventDefault(); };

  const onWheel = (e) => {
    if (!flying || !inEl(e.target)) return;
    // passive:false is explicit because wheel listeners on the window are passive by
    // default in Chrome, and a passive listener cannot preventDefault.
    e.preventDefault();
    e.stopPropagation();                     // ...so OrbitControls never dollies
    setSetting(cfg.speedSetting + (e.deltaY < 0 ? 1 : -1));   // wheel up = faster
  };

  const onKeyDown = (e) => {
    mods.shift = e.shiftKey; mods.alt = e.altKey;
    // Ctrl/Cmd combos belong to the browser and to the feedback panel's undo.
    if (e.ctrlKey || e.metaKey) return;
    if (isTyping(e.target)) return;          // writing a review note, not flying
    if (!AXES[e.code]) return;
    // Recorded even when not flying, so grabbing the mouse with W already down
    // moves — the engine polls key state rather than latching it on press.
    held.add(e.code);
    if (flying || !cfg.requireRightMouse) e.preventDefault();
  };
  const onKeyUp = (e) => {
    mods.shift = e.shiftKey; mods.alt = e.altKey;
    held.delete(e.code);
  };

  // Keys stick down if the window loses focus mid-press — you alt-tab back and
  // the camera is drifting with nothing held. Same for the mouse button.
  const release = () => { held.clear(); mods.shift = mods.alt = false; endFlight(); };
  // Esc drops pointer lock without a pointerup, which would otherwise leave us
  // capturing the mouse forever.
  const onLockChange = () => { if (wantLock && !document.pointerLockElement) endFlight(); };

  addEventListener('pointerdown', onPointerDown, true);
  addEventListener('wheel', onWheel, { capture: true, passive: false });
  el.addEventListener('contextmenu', onContextMenu);
  addEventListener('pointermove', onPointerMove);
  addEventListener('pointerup', onPointerUp);
  addEventListener('keydown', onKeyDown);
  addEventListener('keyup', onKeyUp);
  addEventListener('blur', release);
  document.addEventListener('visibilitychange', release);
  document.addEventListener('pointerlockchange', onLockChange);

  // ── movement ──────────────────────────────────────────────────────────────
  function update(dt) {
    if (!camera) return false;
    dt = Math.min(Math.max(dt || 0, 0), cfg.maxStep);
    if (dt <= 0) return false;

    let f = 0, r = 0, u = 0;
    if (enabled && (flying || !cfg.requireRightMouse)) {
      for (const code of held) {
        const [axis, sign] = AXES[code];
        if (axis === 'fwd') f += sign; else if (axis === 'right') r += sign; else u += sign;
      }
    }

    // What the keys are asking for: the dialled speed in the pressed direction,
    // and a flat zero with nothing held.
    cmd.set(0, 0, 0);
    if (f || r || u) {
      camera.getWorldDirection(fwd);
      right.crossVectors(fwd, WORLD_UP);
      // Looking dead up or down leaves no cross product to normalise.
      if (right.lengthSq() < 1e-8) right.setFromMatrixColumn(camera.matrixWorld, 0);
      right.normalize();

      dir.set(0, 0, 0)
         .addScaledVector(fwd, f)
         .addScaledVector(right, r)
         .addScaledVector(WORLD_UP, u);
      // Normalise so diagonals aren't ~1.7x faster than a straight line.
      if (dir.lengthSq() > 0) dir.normalize();
      cmd.copy(dir).multiplyScalar(speedNow());
    }

    if (vel.lengthSq() < 1e-10 && cmd.lengthSq() === 0) return false;

    // Exact solution of "accelerate toward cmd, damp at `damping`", rather than the
    // engine's one-step Euler version of it. Stepping it by hand undershoots by a
    // factor that depends on dt — measured 5.06 m/s against a dialled 6 at 60 fps —
    // so the speed dial would have meant something different on every machine.
    // Displacement uses the average velocity over the step for the same reason.
    const k = Math.exp(-cfg.damping * dt);
    step.copy(vel).sub(cmd).multiplyScalar((1 - k) / cfg.damping).addScaledVector(cmd, dt);
    vel.sub(cmd).multiplyScalar(k).add(cmd);
    if (vel.lengthSq() < 1e-10) vel.set(0, 0, 0);
    if (step.lengthSq() === 0) return false;

    camera.position.add(step);
    if (controls) controls.target.add(step);   // constant offset => orbit stays sane
    return true;
  }

  return {
    update,
    get enabled() { return enabled; },
    set enabled(v) { enabled = !!v; if (!v) release(); },
    get flying() { return flying; },
    /** UE's 1–8 notch. Wheel-while-flying moves it; this is the same dial. */
    get speedSetting() { return cfg.speedSetting; },
    set speedSetting(v) { setSetting(+v); },
    /** Metres per second at the current notch. */
    get speed() { return settingSpeed(); },
    set speed(v) {
      const want = Math.max(0.01, +v || 0);
      cfg.baseSpeed = want / (Math.pow(2, cfg.speedSetting - 4) * cfg.speedScalar);
    },
    get held() { return [...held]; },
    // Exposed so a scripted check can measure what the camera actually did —
    // ramp, top speed and the target re-anchor are not things you can eyeball.
    get camera() { return camera; },
    get controls() { return controls; },
    hint: 'hold RMB to fly · WASD move · QE down/up · wheel speed · Shift fast · Alt slow',
    dispose() {
      release();
      removeEventListener('pointerdown', onPointerDown, true);
      removeEventListener('wheel', onWheel, { capture: true });
      el.removeEventListener('contextmenu', onContextMenu);
      removeEventListener('pointermove', onPointerMove);
      removeEventListener('pointerup', onPointerUp);
      removeEventListener('keydown', onKeyDown);
      removeEventListener('keyup', onKeyUp);
      removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', release);
      document.removeEventListener('pointerlockchange', onLockChange);
      clearTimeout(readoutTimer);
      if (readout && readout.parentNode) readout.parentNode.removeChild(readout);
      readout = null;
    },
  };
}
