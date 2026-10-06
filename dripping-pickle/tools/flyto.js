// Camera travel — an eased flight from wherever the camera is to a pose, and back.
//
// ★ THIS LIVED INSIDE feedback.js, AND THAT IS WHY THE DEV PANEL SHIPPED TO VISITORS.
//   The warehouse tellies travel with `window.__fbk.flyTo`, so the app entry could not
//   drop the feedback module without losing a SHIPPING interaction — presentation mode
//   hid the panel with CSS and loaded the whole 1,295-line reviewer tool anyway (with
//   TransformControls behind it). A camera tween is not review machinery; it belongs to
//   whoever owns the camera. Extracted here so the panel is genuinely optional (PLT-002).
//
// Ownership matters more than it looks: two tweens writing camera.position on the same
// frame fight, and the loser wins on alternate frames. Construct ONE per scene and pass
// it to anything that needs to move the camera — `initFeedback({ flyer })` takes it.

/**
 * @param {object}   o
 * @param {THREE.Camera} o.camera
 * @param {object}   [o.controls]  OrbitControls, if the scene has them
 * @param {Function} [o.onLand]    called once, after a flight lands and controls resync
 */
export function createFlyTo({ camera, controls = null, onLand = null }) {
  let flight = 0;                     // rAF handle, non-zero while a flight is running
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function flyTo(position, target, ms = 650) {
    // No controls: there is nothing to resync, so a hard cut is the honest answer.
    if (!controls) { camera.position.copy(position); camera.lookAt(target); return; }
    if (flight) cancelAnimationFrame(flight);
    const from = { position: camera.position.clone(), target: controls.target.clone() };
    // Damping keeps applying the user's last drag; hand the camera over cleanly and
    // resync the controls' internal spherical once at the end.
    controls.enabled = false;
    const t0 = performance.now();
    const step = () => {
      const k = easeInOut(Math.min(1, (performance.now() - t0) / ms));
      camera.position.lerpVectors(from.position, position, k);
      controls.target.lerpVectors(from.target, target, k);
      camera.lookAt(controls.target);
      if (k < 1) { flight = requestAnimationFrame(step); return; }
      flight = 0;
      // ★ This unconditional re-enable is why a caller that LOCKS the camera has to
      //   lock the individual gates (enableRotate/enablePan/enableZoom) rather than
      //   controls.enabled — this line owns that flag and hands it back on landing.
      controls.enabled = true;
      controls.update();
      onLand?.();
    };
    flight = requestAnimationFrame(step);
  }

  return {
    flyTo,
    cancel() { if (flight) { cancelAnimationFrame(flight); flight = 0; if (controls) controls.enabled = true; } },
    get flying() { return flight !== 0; },
  };
}
