// Which objects' shadows can you actually SEE?
//
// A shadow-casting light draws every caster in the room into its map, every frame. Two
// lights and 121 visible casters is 242 draw calls, and at the Outpost's room pose that
// was half the frame's budget. The question this answers is not "which objects look like
// they should cast" — it is the only question that can be checked: turn one object's
// castShadow off, render the LIT frame again, and count the pixels that moved.
//
// ★ IT MUST GO THROUGH THE SCENE'S OWN renderFrame(), NOT THE COMPOSER. With the AO on,
//   RenderPass is disabled and the composer reuses a cached beauty target, so a grab taken
//   through looks.render() reports ZERO for everything — including a control that is
//   plainly in frame. BUD1 lost a round to exactly that and the fix is two controls, which
//   this runs every time and refuses to report without.
//
// ★ AND IT RENDERS AT A FIXED `t`. The grain, the lens flare and the screens are all
//   driven by time, so on a live clock every frame differs from every other and the noise
//   buries a small shadow. Freezing t makes the null control read EXACTLY zero, which is
//   what lets a 200-pixel shadow count as a finding.
//
// The output is an opt-OUT list: names whose shadow moved nothing. A prop added later
// casts by default — it costs two draws and can never look wrong — where an opt-in list
// would silently lose its shadow at the next re-dress.

const CONTROL_MIN = 500;      // a caster that IS in the picture must move at least this many pixels
// Subtrees that build and hide their own meshes frame by frame (the belt, the jar that
// falls off it). Their static parts simply keep casting — two draws is the right price
// for never having to reason about what a re-dress moved.
const DYNAMIC = /^Conveyor$/;

export function createShadowAudit({ three, renderer, scene, rt, camera }) {
  const gl = renderer.getContext();

  function grab(t) {
    rt.renderFrame(t);
    const w = renderer.domElement.width, h = renderer.domElement.height;
    const buf = new Uint8Array(w * h * 4);
    // Read inside the same task as the render: with preserveDrawingBuffer false the
    // drawing buffer is valid until the browser composites, not until the call returns.
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { buf, w, h };
  }

  const moved = (a, b, thr) => {
    let n = 0;
    for (let i = 0; i < a.buf.length; i += 4) {
      if (Math.abs(a.buf[i] - b.buf[i]) >= thr ||
          Math.abs(a.buf[i + 1] - b.buf[i + 1]) >= thr ||
          Math.abs(a.buf[i + 2] - b.buf[i + 2]) >= thr) n++;
    }
    return n;
  };

  /**
   * @param {object} [o]
   * @param {number} [o.t]     the frozen frame time
   * @param {number} [o.thr]   per-channel threshold, in 8-bit levels
   * @param {number} [o.keep]  a caster is kept if its shadow moves at least this many pixels
   * @param {boolean} [o.includeMovers] leave the cat, the mouse and the jars in frame,
   *        FROZEN where they stand. They cannot be measured (they move between renders),
   *        but a beam whose shadow only ever lands ON one of them reads zero without them.
   *        Run it both ways and keep the union — one sample of their positions is not a
   *        proof, but it is the difference between "no surface under it" and "no surface
   *        under it right now".
   */
  function run({ t = 7.5, thr = 2, keep = 1, includeMovers = false } = {}) {
    // No need to stop the animation loop: everything below runs in ONE synchronous task,
    // and rAF cannot interleave with it. (Which also means this works with the browser
    // pane hidden, where anything waiting on a frame would simply never return.)
    // The movers move between renders, so they are not measurable this way and are not
    // candidates either: the cat, the mouse and the jars are the things whose shadow a
    // viewer is most likely to be looking at.
    const hidden = [];
    if (!includeMovers) scene.traverse((o) => {
      if ((o.isSkinnedMesh || o.isInstancedMesh) && o.visible) { o.visible = false; hidden.push(o); }
    });

    // ★ A MOVER IS NEVER A CANDIDATE, EVEN WHEN IT IS IN THE PICTURE. With
    //   includeMovers the cat is on screen and castShadow is true, so the first cut
    //   measured him — standing still, in a spot where his shadow happened to fall on
    //   nothing the camera could see — and put `Mesh_Cat_Simple` on the DROP list. His
    //   shadow is most of what makes him read as being in the room rather than pasted
    //   over it, and it would have gone, silently, at whatever position he was frozen in.
    //   Anything the scene drives is measured by where it is, and it is never only there.
    //   `noMove` alone is not the test: the render proxies carry it too (they are an
    //   output, not a thing to drag), and they are exactly what this measures.
    const isMover = (o) => {
      if (o.isSkinnedMesh || o.isInstancedMesh) return true;
      for (let a = o; a; a = a.parent) {
        if (a.userData?.renderProxy) return false;
        if (a.userData?.noMove || DYNAMIC.test(a.name || '')) return true;
      }
      return false;
    };
    const casters = [];
    scene.traverse((o) => {
      if ((o.isMesh || o.isInstancedMesh) && o.visible && o.castShadow && !isMover(o)) casters.push(o);
    });

    const base = grab(t);

    // Control 1: change nothing. Must read exactly 0, or every number below is noise.
    const nullControl = moved(base, grab(t), thr);

    // Control 2: kill EVERY shadow. Must move a lot, or the instrument is dead — this is
    // the control BUD1's differ failed while reporting a clean sweep of zeroes.
    casters.forEach((o) => { o.castShadow = false; });
    const allOff = moved(base, grab(t), thr);
    casters.forEach((o) => { o.castShadow = true; });

    const rows = [];
    for (const o of casters) {
      o.castShadow = false;
      const px = moved(base, grab(t), thr);
      o.castShadow = true;
      rows.push({ name: o.name || o.type, px,
                  merged: o.userData?.mergedFrom?.length ?? 0,
                  tris: o.geometry ? (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 : 0 });
    }

    hidden.forEach((o) => { o.visible = true; });

    rows.sort((a, b) => b.px - a.px);
    const drop = rows.filter((r) => r.px < keep);
    const ok = nullControl === 0 && allOff >= CONTROL_MIN;
    return {
      ok,
      controls: { nullControl, allOff, need: `null === 0 and allOff >= ${CONTROL_MIN}` },
      frame: base.w + 'x' + base.h, t, thr, keep, includeMovers,
      casters: rows.length, keepCount: rows.length - drop.length, dropCount: drop.length,
      savedDraws: drop.length * 2,
      rows, drop: drop.map((r) => r.name),
    };
  }

  return { run };
}
