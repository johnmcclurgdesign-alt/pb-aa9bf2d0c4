// Slow camera drift — the shot breathes instead of standing on a tripod.
//
// The offset is applied to the camera JUST before render and REMOVED right
// after, so OrbitControls and the fly camera never see it. Both derive their
// state from camera.position / controls.target every frame; letting the drift
// leak into that loop turns a closed sway into a slow random walk away from
// the framing (same family of bug as the flycam's "translate position AND
// target" rule — anything that moves the camera behind OrbitControls' back
// either restores itself or desyncs the controls).
//
// The motion is a Lissajous sway: each axis is two sines at incommensurate
// periods (20-40 s), so the path never visibly repeats and never reads as a
// pendulum. Offsets are in CAMERA space — right/up/forward — so the drift
// feels the same whichever way the shot faces. On top of the translation
// there is a smaller rotational sway (yaw/pitch), which is what actually
// reads as "handheld" — a pure translation at this amplitude is almost
// invisible at room distances.
//
// At amount 1.0 the camera roams ~12 cm and sways ~0.5°. The default 0.3 is
// a breath, not a wander — reviewers still click on what they aimed at (the
// feedback panel picks with the RESTORED camera, so a big drift would make
// the click land beside the thing the reviewer saw; keep the dial modest).

import * as THREE from 'three';

const TAU = Math.PI * 2;

export function createDriftCam({ getCamera, amount = 0.3 } = {}) {
  const savedPos = new THREE.Vector3();
  const savedQuat = new THREE.Quaternion();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const sway = new THREE.Quaternion();
  const eul = new THREE.Euler();

  // Translation dominates and rotation is a whisper ON PURPOSE (first cut was
  // 0.0085 rad and read as "the camera is pointed down and left now" on the
  // warehouse's locked shot — an aim change parks the composition off-centre
  // for ~10 s at these periods, which the eye reads as a knocked tripod, not a
  // breath). Parallax from the translation is what sells the life.
  const POS = 0.12;    // metres at amount 1
  const ROT = 0.002;   // radians at amount 1 (~0.11°)

  let amt = amount;
  let applied = false;

  function apply(t) {
    const cam = getCamera();
    if (!cam || amt <= 0) return;
    savedPos.copy(cam.position);
    savedQuat.copy(cam.quaternion);

    // two sines per axis, all periods incommensurate
    const ox = Math.sin(t * TAU / 29.0) * 0.7 + Math.sin(t * TAU / 8.7 + 1.7) * 0.3;
    const oy = Math.sin(t * TAU / 37.0 + 0.6) * 0.7 + Math.sin(t * TAU / 11.3) * 0.3;
    const oz = Math.sin(t * TAU / 43.0 + 2.1) * 0.8;

    right.set(1, 0, 0).applyQuaternion(savedQuat);
    up.set(0, 1, 0).applyQuaternion(savedQuat);
    fwd.set(0, 0, -1).applyQuaternion(savedQuat);
    cam.position
      .addScaledVector(right, POS * amt * ox)
      .addScaledVector(up, POS * amt * 0.5 * oy)   // vertical reads strongest; keep it smaller
      .addScaledVector(fwd, POS * amt * 0.4 * oz);

    const yaw = ROT * amt * Math.sin(t * TAU / 31.0 + 0.8);
    const pitch = ROT * amt * 0.6 * Math.sin(t * TAU / 23.0);
    eul.set(pitch, yaw, 0, 'YXZ');
    cam.quaternion.multiply(sway.setFromEuler(eul));

    cam.updateMatrixWorld(true);
    applied = true;
  }

  function restore() {
    if (!applied) return;
    const cam = getCamera();
    cam.position.copy(savedPos);
    cam.quaternion.copy(savedQuat);
    cam.updateMatrixWorld(true);
    applied = false;
  }

  return {
    apply, restore,
    setAmount: (v) => { amt = Math.max(0, v); },
    get amount() { return amt; },
  };
}
