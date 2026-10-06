// tools/conveyor.js — the overhead belt and the jars on it.
//
// ENV-006 / ENV-007 / ENV-008. Gate A §4.2 is the spec; canon and the top-down
// concept fix the path (in through the left wall, across four fifths of the room,
// a 90° turn to the right, out through the front wall).
//
// WHY THIS IS GEOMETRY BUILT HERE AND NOT A .glb (decision, Josh, 2026-09-01):
//   - The jars have to be ONE InstancedMesh regardless — Gate A §9.2 prices 14
//     jars at 1 draw, not 14 — so the jar was never going to arrive as a scene
//     node anyway.
//   - The path is a number that is expected to move ("provisional and expected to
//     move", Gate A §4.2). As geometry in the .blend, every nudge is a 45-second
//     export and a Draco pass; here it is a constant.
//   - ★ AND IT IS HOW THE CUT-OUTS DODGE THE WALL-MODULE UV TRAP. Every wall
//     module is unwrapped 0..1 on its own and the mural wall's islands overlap
//     (570 of 644 occupied cells claimed twice), so an aperture cut into the wall
//     needs the module re-unwrapped and the mural re-baked. Gate A's own escape
//     hatch is to build the aperture as separate geometry in front of an unbroken
//     wall, which is exactly what hoodAt() does. No wall is touched, so no bake.
//
// WHAT IS MEASURED RATHER THAN TYPED. Gate A puts the belt top at y = 2.62 m.
// It cannot go there: `Pipe_Overhead_02002` runs the length of the left wall at
// y 2.64–3.58 — through the very cut-out the belt enters by — and
// `Pipe_Straight_Long021` sits at y 2.78+ over the exit leg. A jar is 0.22 m
// tall, so 2.62 puts jar lids through both pipes. 2.32 clears them by 0.12 m and
// still sits well above the array's 1.86 m envelope. Gate A said the numbers are
// a starting fit and the rules bind; the rules all survive.
//
// THE THREE THINGS THE GODOT BUILD ALREADY PAID FOR, ported not re-derived:
//   - ★ the corner must be RADIUSED (R = 0.5 m centreline). Its own note: "a hard
//     90 doesn't read as a belt".
//   - ★ the rails are only 0.025 m proud. The camera is BELOW the belt looking
//     up; a normal guide rail hides the jars completely.
//   - jars wrap from the exit cut-out to the entry cut-out, both behind walls, so
//     the teleport is never visible.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { compileLadder, contentFor, labelFor, clinkFor } from './jar-contents.js';

// ── the path ───────────────────────────────────────────────────────────────
// World space: +X toward the front wall, +Z screen-right, floor at y = 0.01.
export const DEFAULTS = {
  beltY: 2.32,      // TOP surface. See the pipe-clearance note above.
  xA: 0.85,         // run A, 1.22 m clear of the front wall so it reads overhead
  zEntry: -2.37,    // left wall plane
  zB: 1.87,         // run B — 4/5 of the room by construction, see fourFifths()
  xExit: 2.07,      // front wall plane
  R: 0.5,           // ★ centreline turn radius
  width: 0.50,
  thickness: 0.06,
  railProud: 0.025, // ★ the camera is below
  railWidth: 0.022,
  pitch: 0.32,      // jar spacing
  speed: 0.10,      // m/s
  hoodDepth: 0.16,  // how far the cut-out housing stands into the room
  hangerPitch: 1.5,
  jar: { radius: 0.045, height: 0.16, lid: 0.018 },
  floorY: 0.02,     // where a knocked-off jar lands — the room floor the cat walks on
};

/**
 * Sample-able centreline. Straight → quarter arc → straight, in that order,
 * with the arc segmented finely enough that the belt reads as a curve rather
 * than as a chamfer.
 */
function buildPath(p, arcSegments = 8) {
  const pts = [];
  const push = (x, z) => pts.push(new THREE.Vector3(x, p.beltY, z));
  const cz = p.zB - p.R, cx = p.xA + p.R;   // arc centre
  push(p.xA, p.zEntry);
  push(p.xA, cz);
  for (let i = 1; i <= arcSegments; i++) {
    const a = Math.PI - (Math.PI / 2) * (i / arcSegments);  // 180° → 90°
    push(cx + p.R * Math.cos(a), cz + p.R * Math.sin(a));
  }
  push(p.xExit, p.zB);

  // Cumulative arc length, so a jar can be placed by distance travelled rather
  // than by segment index — the corner would otherwise speed up or slow down.
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const length = cum[cum.length - 1];

  const _pos = new THREE.Vector3(), _tan = new THREE.Vector3();
  function sample(s, outPos = _pos, outTan = _tan) {
    const d = Math.min(Math.max(s, 0), length);
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const t = (d - cum[i - 1]) / Math.max(cum[i] - cum[i - 1], 1e-6);
    outPos.lerpVectors(pts[i - 1], pts[i], t);
    outTan.subVectors(pts[i], pts[i - 1]).normalize();
    return outPos;
  }
  return { pts, cum, length, sample };
}

/**
 * Sweep a closed 2D profile along the path. `profile` is a list of
 * [lateral, vertical] pairs relative to the centreline at belt-top height,
 * wound consistently; the result is a closed tube with end caps.
 */
function sweepProfile(path, profile, from = 0, to = path.length, steps = 64) {
  const pos = [], idx = [], uv = [];
  const n = profile.length;
  const p = new THREE.Vector3(), tan = new THREE.Vector3(), lat = new THREE.Vector3();
  for (let s = 0; s <= steps; s++) {
    const d = from + (to - from) * (s / steps);
    path.sample(d, p, tan);
    lat.set(tan.z, 0, -tan.x).normalize();     // perpendicular in the floor plane
    for (const [u, v] of profile) {
      pos.push(p.x + lat.x * u, p.y + v, p.z + lat.z * u);
      uv.push(d, v);
    }
  }
  // ★ WINDING. The profile is listed clockwise in the (lateral, vertical) plane
  //   — top edge left→right, then down, then back — and that plane's positive
  //   orientation faces along travel, so winding the quads the "obvious" way
  //   (a,b,e / a,e,c) gives every face an INVERTED normal. It does not render as
  //   a hole, which is what makes it expensive: the belt still draws, but its
  //   top surface is shaded as though it faced the floor, so it picks up the
  //   warm bounce off the boards and reads as a TAN WOODEN SHELF instead of
  //   black rubber. Diagnosed from the picture, not the console — nothing warns.
  for (let s = 0; s < steps; s++) {
    for (let k = 0; k < n; k++) {
      const a = s * n + k, b = s * n + ((k + 1) % n);
      const c = a + n, e = b + n;
      idx.push(a, e, b, a, c, e);
    }
  }
  // Caps — a belt seen from below with open ends reads as a shell, not a slab.
  const cap = (ring, flip) => {
    const base = ring * n;
    for (let k = 1; k < n - 1; k++) {
      if (flip) idx.push(base, base + k, base + k + 1);
      else idx.push(base, base + k + 1, base + k);
    }
  };
  cap(0, true); cap(steps, false);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const box = (w, h, d, x, y, z) => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
};

/**
 * The cut-out housing: a sleeve standing proud of the wall with a dark back
 * panel. ★ No wall is modified — see the UV-trap note at the top of the file.
 * `axis` is 'z' (left wall) or 'x' (front wall); `dir` points from the wall
 * into the room.
 */
function hoodAt(p, axis, wallCoord, dir, openW, openH, centreY, other) {
  const parts = [];
  const t = 0.035;                        // plate thickness
  const d = p.hoodDepth;
  const flange = 0.07;                    // how far the face plate laps the wall
  const mid = wallCoord + dir * d / 2;
  const oW = openW / 2 + t / 2, oH = openH / 2 + t / 2;
  if (axis === 'z') {
    parts.push(box(openW + 2 * t, t, d, other, centreY + oH, mid));   // top
    parts.push(box(openW + 2 * t, t, d, other, centreY - oH, mid));   // bottom
    parts.push(box(t, openH, d, other - oW, centreY, mid));           // sides
    parts.push(box(t, openH, d, other + oW, centreY, mid));
    // face plate: four bars lapping the wall around the opening
    const fz = wallCoord + dir * (t / 2 + 0.004);
    parts.push(box(openW + 2 * t + 2 * flange, flange, t, other, centreY + oH + flange / 2, fz));
    parts.push(box(openW + 2 * t + 2 * flange, flange, t, other, centreY - oH - flange / 2, fz));
    parts.push(box(flange, openH + 2 * t, t, other - oW - flange / 2, centreY, fz));
    parts.push(box(flange, openH + 2 * t, t, other + oW + flange / 2, centreY, fz));
  } else {
    parts.push(box(d, t, openW + 2 * t, mid, centreY + oH, other));
    parts.push(box(d, t, openW + 2 * t, mid, centreY - oH, other));
    parts.push(box(d, openH, t, mid, centreY, other - oW));
    parts.push(box(d, openH, t, mid, centreY, other + oW));
    const fx = wallCoord + dir * (t / 2 + 0.004);
    parts.push(box(t, flange, openW + 2 * t + 2 * flange, fx, centreY + oH + flange / 2, other));
    parts.push(box(t, flange, openW + 2 * t + 2 * flange, fx, centreY - oH - flange / 2, other));
    parts.push(box(t, openH + 2 * t, flange, fx, centreY, other - oW - flange / 2));
    parts.push(box(t, openH + 2 * t, flange, fx, centreY, other + oW + flange / 2));
  }
  return parts;
}

// ── label atlas ────────────────────────────────────────────────────────────
// The eight labels are BAKED OFFLINE since TV1 (2026-10-06) by tools/bake-text.mjs, from
// `labels` in jar-contents.json, into assets/dripping-pickle/text/jar-labels.ktx2 — the same
// drawing this file used to do into a 2D canvas at load, moved verbatim, because the Apple TV
// binding has no Canvas 2D. The scene loads the sheet and passes it in as `labelMap`.
// ⚠ So the label TEXT is no longer live data: edit jar-contents.json's labels and re-run the
// bake (`node tools/bake-text.mjs --check` says when the sheet is stale against the data).
// The sheet keeps the canvas's 4 x 2 grid and is stored bottom-up the way that canvas was
// uploaded, so the per-instance cell offsets below did not change.
//
// Voice per canon §9: slab serif is reserved for Dripping Pickle artifacts, and
// a jar label is exactly that. Nothing here winks.
const LABEL_PAPER = 0xd8ccb2;   // the labels' cream, for the moments before (or without) the sheet

// ── odd-jar contents ───────────────────────────────────────────────────────
// Procedural originals (decision, Josh, 2026-09-01): at the ROOM pose a jar is
// about 30 px tall, so contents read as silhouette and colour, not as detail.
// They are original geometry, so there is no licence question and no texture
// memory — and John authors the ladder properly for Beta (filed as its own
// asset task). The shapes are deliberately crude; the SCREEN push-in is where
// that will show, which is what the Beta upgrade is for.
function chunkGeometry(shape) {
  switch (shape) {
    case 'sphere':     return new THREE.SphereGeometry(0.013, 8, 6);
    case 'cube':       return new THREE.BoxGeometry(0.014, 0.014, 0.014);
    case 'slab':       return new THREE.BoxGeometry(0.012, 0.075, 0.008);
    case 'stack':      return new THREE.BoxGeometry(0.055, 0.030, 0.026);
    case 'hand':       return new THREE.BoxGeometry(0.030, 0.070, 0.016);
    case 'fish':       return new THREE.ConeGeometry(0.014, 0.055, 6);
    case 'duck':       return new THREE.SphereGeometry(0.020, 8, 6);
    case 'roll':       return new THREE.CylinderGeometry(0.011, 0.011, 0.100, 8);
    case 'key':        return new THREE.BoxGeometry(0.006, 0.026, 0.002);
    case 'impossible': return new THREE.TorusKnotGeometry(0.026, 0.008, 48, 6);
    default:           return new THREE.CapsuleGeometry(0.010, 0.045, 3, 6);  // spear
  }
}

// ═══════════════════════════════════════════════════════════════════════════
export function createConveyor({
  scene, data, structure, params = {}, onClink = null, onKnockOff = null, jarsVisible = true,
  labelMap = null,
} = {}) {
  const p = { ...DEFAULTS, ...params, jar: { ...DEFAULTS.jar, ...(params.jar || {}) } };
  const group = new THREE.Group();
  group.name = 'Conveyor';
  // ★ The scene drives every jar on this belt, so the whole rig is locked
  //   against the feedback panel's gizmo (repo CLAUDE.md): it stays selectable
  //   and commentable — which is the point of the panel — but a dragged pose
  //   would be a value the tick() overwrites on the next frame.
  group.userData.noMove = true;

  const path = buildPath(p);

  // ── materials ────────────────────────────────────────────────────────────
  // Metalness is kept low on purpose: `envi` ships at 0.03, so a properly
  // metallic frame in this room has almost nothing to reflect and renders
  // near-black. The frame reads as painted galvanised steel instead.
  const matBelt = new THREE.MeshStandardMaterial({
    name: 'Conveyor_Belt', color: 0x1b1917, roughness: 0.88, metalness: 0.0,
  });
  const matFrame = new THREE.MeshStandardMaterial({
    name: 'Conveyor_Frame', color: 0x7c8083, roughness: 0.52, metalness: 0.35,
  });
  // DoubleSide: a single-sided plate that ends up facing the wrong way is
  // invisible, not black, and the wall behind shows through instead — which
  // is exactly what shipped at the exit (rotation.y sign put its normal
  // through the wall). Two tiny planes; the cost of getting this wrong again
  // is not worth saving.
  const matHole = new THREE.MeshBasicMaterial({ name: 'Conveyor_Hole', color: 0x000000, side: THREE.DoubleSide });
  // Glass is a highlight and a rim, not a body. At 0.20 opacity over a pale
  // tint the jars read as white pills at the ROOM pose — what has to carry the
  // read at 6 px is the CONTENTS, so the glass gets out of their way.
  const matGlass = new THREE.MeshStandardMaterial({
    name: 'Jar_Glass', color: 0xc2d8c8, roughness: 0.09, metalness: 0.0,
    transparent: true, opacity: 0.13, depthWrite: false,
  });
  const matLid = new THREE.MeshStandardMaterial({
    name: 'Jar_Lid', color: 0x8d7c54, roughness: 0.42, metalness: 0.55,
  });
  const matFill = new THREE.MeshStandardMaterial({
    name: 'Jar_Fill', color: 0xffffff, roughness: 0.55, metalness: 0.0,
  });
  const matChunk = new THREE.MeshStandardMaterial({
    name: 'Jar_Odd', color: 0xffffff, roughness: 0.6, metalness: 0.0,
  });
  if (labelMap) labelMap.anisotropy = 8;
  const matLabel = new THREE.MeshStandardMaterial({
    name: 'Jar_Label', map: labelMap, color: labelMap ? 0xffffff : LABEL_PAPER, roughness: 0.9, metalness: 0.0,
    side: THREE.DoubleSide,
  });

  // ── belt, rails, hangers, hoods ──────────────────────────────────────────
  const hw = p.width / 2;
  const belt = new THREE.Mesh(
    sweepProfile(path, [[-hw, 0], [hw, 0], [hw, -p.thickness], [-hw, -p.thickness]], 0, path.length, 96),
    matBelt);
  belt.name = 'Conveyor_Belt';
  belt.castShadow = true; belt.receiveShadow = true;
  group.add(belt);

  const frameParts = [];
  // ★ rails barely proud — the camera is below and a real guide rail would hide
  //   every jar on the belt.
  for (const side of [-1, 1]) {
    const u0 = side * (hw - p.railWidth), u1 = side * hw;
    const [a, b] = side < 0 ? [u0, u1] : [u1, u0];
    frameParts.push(sweepProfile(path,
      [[a, p.railProud], [b, p.railProud], [b, -0.012], [a, -0.012]], 0, path.length, 96));
  }

  // Hangers: rods from the belt's outer edge up to whatever is actually above.
  // ★ CAST THE RAY, DO NOT TYPE THE LENGTH — two pendants shipped hanging from
  //   nothing in DP-W2 for exactly this reason. And start the ray clear of the
  //   rig we just built, or it self-intersects and reports the ceiling 10 mm up.
  const ray = new THREE.Raycaster();
  const up = new THREE.Vector3(0, 1, 0);
  const targets = [];
  if (structure) structure.traverse((o) => { if (o.isMesh && o.visible) targets.push(o); });
  const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _lat = new THREE.Vector3();
  const hangers = [];
  for (let d = p.hangerPitch * 0.5; d < path.length - 0.4; d += p.hangerPitch) {
    path.sample(d, _p, _t);
    // The entry end runs under Pipe_Overhead_02002 (y 2.64) — a hanger there
    // would stand inside it.
    if (_p.z < -1.95) continue;
    _lat.set(_t.z, 0, -_t.x).normalize();
    for (const side of [-1, 1]) {
      const x = _p.x + _lat.x * hw * side, z = _p.z + _lat.z * hw * side;
      ray.set(new THREE.Vector3(x, p.beltY + 0.20, z), up);
      const hit = ray.intersectObjects(targets, true).find((h) => h.distance > 0.02);
      if (!hit) continue;
      const top = p.beltY + 0.20 + hit.distance;
      const h = top - p.beltY;
      if (h < 0.15 || h > 4) continue;
      frameParts.push(box(0.022, h, 0.022, x, p.beltY + h / 2, z));
      frameParts.push(box(0.10, 0.02, 0.10, x, top - 0.01, z));       // ceiling plate
      frameParts.push(box(0.09, 0.03, 0.09, x, p.beltY + 0.012, z));  // belt bracket
      hangers.push({ x, z, top });
    }
  }

  // Cut-outs. Opening is sized off the belt and the jar, not typed.
  const openW = p.width + 0.12;
  const openH = p.thickness + p.jar.height + p.jar.lid + 0.14;
  const centreY = p.beltY - p.thickness + openH / 2 - 0.045;
  frameParts.push(...hoodAt(p, 'z', p.zEntry, +1, openW, openH, centreY, p.xA));
  frameParts.push(...hoodAt(p, 'x', p.xExit, -1, openW, openH, centreY, p.zB));

  // Drive housing at the exit end — a belt that vanishes into a wall with no
  // machinery anywhere is a ribbon, not a conveyor.
  frameParts.push(box(0.34, 0.26, 0.30, p.xExit - 0.42, p.beltY - 0.18, p.zB + hw + 0.16));
  frameParts.push(box(0.10, 0.10, 0.22, p.xExit - 0.42, p.beltY - 0.10, p.zB + hw + 0.02));

  const frame = new THREE.Mesh(mergeGeometries(frameParts, false), matFrame);
  frame.name = 'Conveyor_Frame';
  frame.castShadow = true; frame.receiveShadow = true;
  group.add(frame);
  for (const g of frameParts) g.dispose();

  // The dark behind each opening. MeshBasic so it is genuinely black rather than
  // dimly lit brick — that is the whole read of "there is a hole in the wall".
  const holePlate = (w, h, x, y, z, ry) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), matHole);
    m.position.set(x, y, z); m.rotation.y = ry;
    m.name = 'Conveyor_Cutout_Dark';
    group.add(m);
  };
  holePlate(openW, openH, p.xA, centreY, p.zEntry + 0.006, 0);
  holePlate(openW, openH, p.xExit - 0.006, centreY, p.zB, Math.PI / 2);

  // ── jars ─────────────────────────────────────────────────────────────────
  // Geometry origin is the jar's BASE, so a wobble is a rotation about the
  // point the jar actually stands on.
  const JR = p.jar.radius, JH = p.jar.height;
  const jarProfile = [];
  // a body of revolution: shoulder in, short neck, so it reads as a jar and not
  // as a tin can at 30 px
  for (const [r, y] of [[0.0, 0], [JR * 0.92, 0], [JR, 0.018], [JR, JH * 0.72],
                        [JR * 0.86, JH * 0.90], [JR * 0.80, JH], [0, JH]]) {
    jarProfile.push(new THREE.Vector2(r, y));
  }
  const glassGeo = new THREE.LatheGeometry(jarProfile, 14);
  const lidGeo = new THREE.CylinderGeometry(JR * 0.82, JR * 0.82, p.jar.lid, 14);
  lidGeo.translate(0, JH + p.jar.lid / 2 - 0.004, 0);
  const fillGeo = new THREE.CylinderGeometry(JR * 0.93, JR * 0.93, JH * 0.87, 14);
  fillGeo.translate(0, JH * 0.87 / 2 + 0.006, 0);
  const labelGeo = new THREE.CylinderGeometry(JR * 1.01, JR * 1.01, JH * 0.46, 16, 1, true,
                                              -1.9, 3.8);
  labelGeo.translate(0, JH * 0.42, 0);

  // ★ Per-instance label variant without a second draw: an instanced attribute
  //   carrying the atlas cell, folded into vMapUv. Injected AFTER <uv_vertex>,
  //   which is what declares that varying — the same forward-declaration rule
  //   that made the screen treatment render a dead rectangle when it was hung
  //   off <common>. And onBeforeCompile is CHAINED, never assigned: gi-volume
  //   and pcss both patch this material too.
  const ATLAS = new THREE.Vector2(0.25, 0.5);
  const prevCompile = matLabel.onBeforeCompile;
  matLabel.onBeforeCompile = (shader, renderer) => {
    if (prevCompile) prevCompile(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aLabelUV;')
      .replace('#include <uv_vertex>',
        `#include <uv_vertex>
        #ifdef USE_MAP
          vMapUv = vMapUv * vec2(${ATLAS.x}, ${ATLAS.y}) + aLabelUV;
        #endif`);
  };
  const prevKey = matLabel.customProgramCacheKey;
  matLabel.customProgramCacheKey = () => `dpjarlabel|${prevKey ? prevKey.call(matLabel) : ''}`;

  // ── the jar that comes off (Gate A §8.4, INT-005) ────────────────────────
  // ★ ONE REUSABLE BODY, NOT A SPAWN. A knocked-off jar cannot be an instance —
  // it has left the belt, and the instanced matrices are rebuilt from the path
  // every frame — so it is four meshes standing outside the InstancedMesh. They
  // are built once and re-placed, because the alternative is allocating geometry
  // inside an interaction, and because this way the cost is a KNOWN four draws
  // that are only ever paid while a jar is actually on the floor (visible=false
  // otherwise, so the renderer skips them entirely).
  const fallen = new THREE.Group();
  fallen.name = 'Conveyor_Jar_Fallen';
  fallen.visible = false;
  // ★ THE SHARED MATERIALS, NOT CLONES — a clone made here would miss the GI and
  // PCSS patches the scene applies to `materials` afterwards (Material.clone()
  // drops onBeforeCompile), so the jar on the floor would be the one unlit object
  // in the room. And NO LABEL RING: matLabel's shader reads a per-instance
  // attribute (aLabelUV) that a plain Mesh does not carry, which is the same
  // forward-declaration class of failure as the screen treatment's dead rectangle.
  for (const [geo, mat] of [[glassGeo, matGlass], [fillGeo, matFill], [lidGeo, matLid]]) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = false;          // it is on the floor under a belt; nothing sees its shadow
    m.receiveShadow = true;
    fallen.add(m);
  }
  group.add(fallen);
  // its own physics, such as it is: a ballistic arc and a spin, then it settles
  const fall = { active: false, v: new THREE.Vector3(), spin: new THREE.Vector3(),
                 rest: 0, fadeAt: 0, jar: -1 };
  const gone = new Set();          // global jar indices that have left the belt

  // How many jars can be on the belt at once, plus a slot of slack so a jar
  // half in the hood is still drawn.
  const visibleSlots = Math.ceil(path.length / p.pitch) + 2;
  // The belt is a closed loop: the visible run plus a hidden return behind the
  // walls. Rounded to a whole number of pitches so the spacing does not jump at
  // the wrap.
  const slots = Math.round((path.length + 2.0) / p.pitch);
  const loopLength = slots * p.pitch;

  const mk = (geo, mat, name) => {
    const m = new THREE.InstancedMesh(geo, mat, visibleSlots);
    m.name = name;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;   // the instances move; the bounds do not follow
    m.castShadow = false;      // 16 jars in every shadow pass buys nothing here
    m.receiveShadow = true;
    m.count = 0;
    group.add(m);
    return m;
  };
  const iGlass = mk(glassGeo, matGlass, 'Jar_Glass');
  const iFill = mk(fillGeo, matFill, 'Jar_Fill');
  const iLid = mk(lidGeo, matLid, 'Jar_Lid');
  const iLabel = mk(labelGeo, matLabel, 'Jar_Label');
  iGlass.renderOrder = 2;      // glass last, over its own contents
  iLabel.geometry.setAttribute('aLabelUV',
    new THREE.InstancedBufferAttribute(new Float32Array(visibleSlots * 2), 2));
  const labelAttr = iLabel.geometry.getAttribute('aLabelUV');

  // Odd contents get one real mesh each, built on demand. Two slots: the ladder
  // makes a second odd jar on the belt a once-a-month event, and a third is not
  // worth a draw call that is idle the rest of the time.
  const oddSlots = [0, 1].map(() => {
    const m = new THREE.Mesh(new THREE.BufferGeometry(), matChunk.clone());
    m.name = 'Jar_Odd_Contents';
    m.visible = false;
    m.castShadow = false;
    group.add(m);
    return { mesh: m, shape: null };
  });
  const chunkCache = new Map();

  scene.add(group);

  // ── the ladder ───────────────────────────────────────────────────────────
  const jarsPerHour = 3600 * p.speed / p.pitch;
  const ladder = compileLadder(data, jarsPerHour);
  const colour = new THREE.Color();
  const oddTint = new THREE.Color();   // scratch — the tick loop allocates nothing

  // ── state ────────────────────────────────────────────────────────────────
  // ★ Distance is seeded from ABSOLUTE unix seconds, not from page-load time.
  //   The belt is shared world state (PLAN §3, canon §7): two viewers who open
  //   the Loop an hour apart must be looking at the same jars in the same
  //   places, and a jar's contents are a pure function of its global index, so
  //   the phase is the only thing that has to agree.
  // ★ DO NOT WRAP THIS. `distance` is TOTAL metres travelled since the epoch and
  //   it must keep growing: the jar's global index is derived from how many
  //   times the belt has gone round (floor(raw / loopLength) * slots + i), so
  //   taking the accumulator modulo the loop length silently throws the wrap
  //   counter away. Written that way it still runs, still moves, still shows a
  //   perfectly convincing belt — and every jar identity cycles through the same
  //   46 values forever, which means the odd-jar ladder REPEATS EVERY 2.5
  //   MINUTES and whether a given viewer ever sees an odd jar is fixed at page
  //   load. Nothing about the picture gives it away; it was caught by reading
  //   jarId out of the running scene and finding it was 5.
  //   The magnitude is fine: ~1.8e8 m at today's epoch, exact in a double to far
  //   better than a millimetre, and the derived index stays inside int32 for
  //   longer than this Loop will exist.
  const t0 = Date.now() / 1000;
  let distance = t0 * p.speed;
  let elapsed = 0, lastT = null;
  let speedScale = 1, targetScale = 1;
  let stallUntil = 0, trembleJar = -1;
  const state = { mode: 'run', jars: 0, odd: [], speedScale: 1 };
  // Jars knocked by a viewer (DP-W4 jar_knock, a LOCAL user event): jarId -> { until, strength }.
  // Instance slot -> jarId is recorded every tick so a raycast hit on the instanced mesh can be
  // turned back into the jar's global index.
  const wobbles = new Map();
  const slotJar = new Int32Array(visibleSlots).fill(-1);
  // The path distance each drawn slot is at, so "which jar is nearest the entry" is a
  // measurement rather than an assumption about fill order (it is not sorted: `raw` wraps).
  const slotS = new Float32Array(slotJar.length);

  // Seams: the joints a jar audibly crosses. Hanger brackets plus both ends of
  // the corner — the places a real belt has a discontinuity.
  const seams = hangers.map((h) => {
    // project the hanger back onto the path by nearest sample
    let best = 0, bd = Infinity;
    for (let d = 0; d <= path.length; d += 0.05) {
      path.sample(d, _p, _t);
      const dd = (_p.x - h.x) ** 2 + (_p.z - h.z) ** 2;
      if (dd < bd) { bd = dd; best = d; }
    }
    return best;
  });
  const cz = p.zB - p.R;
  seams.push(cz - p.zEntry, cz - p.zEntry + Math.PI / 2 * p.R);
  seams.sort((a, b) => a - b);

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1);
  const _pos = new THREE.Vector3(), _tan = new THREE.Vector3();
  const _axis = new THREE.Vector3();

  function tick(t) {
    if (lastT === null) lastT = t;
    const dt = Math.min(t - lastT, 0.1);
    lastT = t; elapsed += dt;
    const now = t0 + elapsed;

    // the jar on the floor, if there is one. Its MOTION is frame time (it is
    // animation); its clean-up deadline is wall clock, for the reason the stall
    // above spells out.
    if (fall.active) stepFallenJar(dt);

    // stall → tremble → restart (Gate A §8.1, the signed rare event). The ramp
    // is what sells it: a belt that stops in one frame reads as a dropped frame.
    // ★ THE STALL'S DURATION IS WALL CLOCK, NOT FRAME TIME. The belt's MOTION has
    //   to be integrated from `dt` — it is animation — but how long the stall
    //   LASTS is a scheduled interval, and driving a schedule from accumulated
    //   frame time makes it stretch exactly when frames are scarce. Measured on
    //   a throttled tab (frames at a fifth of real time) an 8-second stall was
    //   still holding after 14 seconds of wall clock. Same defect class as the
    //   return affordance's fade, and this Loop targets 30 FPS on a phone.
    if (state.mode === 'stalled' && performance.now() > stallUntil) {
      state.mode = 'run'; targetScale = 1;
    }
    speedScale += (targetScale - speedScale) * Math.min(1, dt * (targetScale > speedScale ? 1.6 : 3.2));
    // Published so the belt's audio bed can ride the same ramp the jars do (DP-W7): a motor that
    // keeps running at full pitch through a stall is the tell that the sound is a separate system.
    state.speedScale = speedScale;
    distance += p.speed * speedScale * dt;   // never wrapped — see the note at t0

    let n = 0;
    let oddUsed = 0;
    state.odd.length = 0;
    for (let i = 0; i < slots && n < visibleSlots; i++) {
      const raw = distance + i * p.pitch;
      const s = raw % loopLength;
      if (s < 0.03 || s > path.length - 0.03) continue;      // in the walls
      const jarId = Math.floor(raw / loopLength) * slots + i;
      if (gone.has(jarId)) continue;      // this one is on the floor

      path.sample(s, _pos, _tan);
      // Face the jar along travel. A jar is a body of revolution, so this only
      // matters for the label — which is exactly why it matters.
      const yaw = Math.atan2(_tan.x, _tan.z);

      // clink: a decaying wobble after the last seam this jar crossed, with a
      // per-jar strength off its own hash stream. Uniform pitch means the seam
      // crossings are a metronome, so the AMPLITUDE has to be what varies —
      // otherwise the belt taps out a fixed cadence, which is the naturalness
      // law's "fixed offsets" bug wearing a different hat.
      let tilt = 0;
      const ring = clinkFor(jarId, ladder);
      if (ring > 0.55) {
        let since = Infinity;
        for (const seam of seams) if (s >= seam && s - seam < since) since = s - seam;
        if (since < 0.5) {
          const tau = since / p.speed;            // seconds since the crossing
          const amp = 0.055 * (ring - 0.55) / 0.45;
          tilt = amp * Math.exp(-6.5 * tau) * Math.sin(38 * tau);
          if (onClink && since < p.speed * dt * 1.5) {
            onClink({ jarId, strength: (ring - 0.55) / 0.45, position: _pos.clone() });
          }
        }
      }
      if (jarId === trembleJar && state.mode === 'stalled') {
        tilt += 0.012 * Math.sin(now * 47);
      }
      const wob = wobbles.get(jarId);
      if (wob) {
        const left = (wob.until - performance.now()) / 1000;
        if (left <= 0) wobbles.delete(jarId);
        else {
          // a knocked jar rocks and settles: a decaying wobble, amplitude by the event's draw
          const tau = wob.seconds - left;
          tilt += 0.09 * wob.strength * Math.exp(-2.2 * tau) * Math.sin(21 * tau);
        }
      }
      slotJar[n] = jarId;
      slotS[n] = s;

      _q.setFromAxisAngle(up, yaw);
      if (tilt !== 0) {
        _axis.set(_tan.z, 0, -_tan.x).normalize();
        _q.premultiply(new THREE.Quaternion().setFromAxisAngle(_axis, tilt));
      }
      _m.compose(_pos, _q, _s);
      iGlass.setMatrixAt(n, _m);
      iFill.setMatrixAt(n, _m);
      iLid.setMatrixAt(n, _m);
      iLabel.setMatrixAt(n, _m);

      const content = contentFor(jarId, ladder);
      // The mass in the jar is brine for a pickle jar, and brine PULLED TOWARD
      // the contents for anything else. Without that pull an odd jar is the same
      // olive cylinder as its neighbours plus a 3 cm object hidden behind a
      // label, which at the ROOM pose is no read at all — the ladder would only
      // exist in the data. A third of the way is enough to notice and not enough
      // to announce itself, which is the deadpan the secrets layer asks for.
      colour.set(content.brine);
      if (content.tier !== 'baseline') colour.lerp(oddTint.set(content.fill), 0.35);
      colour.convertSRGBToLinear();
      iFill.setColorAt(n, colour);
      const lv = labelFor(jarId, ladder);
      labelAttr.setXY(n, (lv % 4) * 0.25, Math.floor(lv / 4) * 0.5);

      if (content.tier !== 'baseline' && oddUsed < oddSlots.length) {
        const slot = oddSlots[oddUsed++];
        if (slot.shape !== content.chunkShape) {
          if (!chunkCache.has(content.chunkShape)) {
            chunkCache.set(content.chunkShape, chunkGeometry(content.chunkShape));
          }
          slot.mesh.geometry = chunkCache.get(content.chunkShape);
          slot.shape = content.chunkShape;
        }
        slot.mesh.material.color.set(content.fill).convertSRGBToLinear();
        slot.mesh.position.copy(_pos).setY(_pos.y + JH * 0.42);
        slot.mesh.quaternion.copy(_q);
        slot.mesh.rotation.x += Math.sin(jarId) * 0.6;
        slot.mesh.visible = true;
        state.odd.push({ jarId, id: content.id, tier: content.tier });
      }
      n++;
    }
    for (let k = oddUsed; k < oddSlots.length; k++) oddSlots[k].mesh.visible = false;

    for (const m of [iGlass, iFill, iLid, iLabel]) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
    }
    if (iFill.instanceColor) iFill.instanceColor.needsUpdate = true;
    labelAttr.needsUpdate = true;
    state.jars = n;
  }

  // ── the knocked-off jar ────────────────────────────────────────────────────
  const _fq = new THREE.Quaternion(), _fe = new THREE.Euler();
  function stepFallenJar(dt) {
    const floor = p.floorY;
    if (fall.rest === 0) {
      fall.v.y -= 9.81 * dt;
      fallen.position.addScaledVector(fall.v, dt);
      _fe.set(fallen.rotation.x + fall.spin.x * dt,
              fallen.rotation.y + fall.spin.y * dt,
              fallen.rotation.z + fall.spin.z * dt);
      fallen.rotation.copy(_fe);
      if (fallen.position.y <= floor) {
        // It lands and it stays landed. A bouncing jar is a physics demo; this
        // one is a thing that fell over, so it comes to rest ON ITS SIDE — which
        // is also why the geometry origin being the BASE matters here.
        fallen.position.y = floor;
        fallen.rotation.set(Math.PI / 2, fallen.rotation.y, 0);
        fallen.position.y = floor + p.jar.radius;
        fall.rest = performance.now();
      }
    }
    // The clean-up is Gate A §8.4 option (a): the feed's own interference covers
    // the cut and the floor is clean on the other side. The BEAT is authored in
    // the event file (that is what fires the burst); this only refuses to sit on
    // the floor for ever if nobody ever calls clearFloor.
    if (fall.rest && performance.now() - fall.rest > 20000) clearFloor();
  }

  /** Take a jar off the belt (Gate A §8.4). `jar` is a global index. */
  function knockOff({ jar, strength = 1 } = {}) {
    if (!Number.isFinite(jar)) return false;
    if (fall.active) return false;        // one on the floor at a time, always
    const id = jar | 0;
    // Where is it right now? The instanced matrix is the single source of truth
    // for that — the same rule the mouse's jar ride follows — so read it back
    // rather than recomputing the belt maths a second time.
    const n = slotJar.indexOf(id);
    if (n < 0 || n >= iGlass.count) return false;
    iGlass.getMatrixAt(n, _m);
    _m.decompose(fallen.position, _fq, _s);
    fallen.rotation.setFromQuaternion(_fq);
    fallen.scale.set(1, 1, 1);
    // Give it the belt's own travel plus the push, so it leaves in the direction
    // it was already going rather than dropping straight down out of a moving line.
    path.sample(((distance + 0) % loopLength), _pos, _tan);
    fall.v.set(_tan.x * p.speed * 3 + (Math.random() - 0.5) * 0.15, 0.2,
               _tan.z * p.speed * 3 + (Math.random() - 0.5) * 0.15)
           .multiplyScalar(0.6 + 0.8 * strength);
    fall.spin.set(3.2 * strength, 1.1, 2.4 * strength);
    fall.rest = 0; fall.active = true; fall.jar = id;
    fallen.visible = true;
    gone.add(id);
    if (onKnockOff) onKnockOff({ jarId: id, position: fallen.position.clone() });
    return true;
  }

  /** The clean-up. Called by the event timeline under cover of the interference burst. */
  function clearFloor() {
    if (!fall.active) return false;
    fallen.visible = false;
    fall.active = false;
    // ★ The id stays in `gone` FOREVER, and it has to: a global index is a
    // function of the belt's total travel, so it is never reissued — but if it
    // were cleared, the same jar would reappear on the return run as though
    // nothing had happened. The set grows by one per knock-off, which at the
    // shipped rarity is a handful an hour and a few bytes a day.
    return true;
  }

  return {
    group, path, params: p, ladder, state,
    // Everything lit, for gi.patch() / PCSS.patch(). matHole is deliberately
    // absent — it is MeshBasic and must stay unlit.
    materials: [matBelt, matFrame, matGlass, matLid, matFill, matLabel, matChunk],
    tick,
    setVisible: (v) => { group.visible = v; },
    /** The signed rare event: belt stops, one jar left trembling, then restarts. `elapsed` is how
     *  long ago the event fired on the shared clock (a resumed or late-joined client), so the
     *  stall ends when everyone else's does rather than `seconds` from now. */
    stall({ seconds = 6, elapsed = 0 } = {}) {
      const left = seconds - elapsed;
      if (left <= 0) return performance.now();
      state.mode = 'stalled';
      targetScale = 0;
      stallUntil = performance.now() + left * 1000;
      // the jar a few places up the belt from the entry, by global index
      trembleJar = state.jars ? Math.floor(distance / loopLength) * slots + 3 : -1;
      return stallUntil;
    },
    /** A knocked jar rocks and settles (DP-W4 jar_knock). `jar` is a global index. */
    wobble({ jar, strength = 1, seconds = 2.4 } = {}) {
      if (!Number.isFinite(jar)) return false;
      wobbles.set(jar | 0, { until: performance.now() + seconds * 1000, strength, seconds });
      return true;
    },
    knockOff, clearFloor,
    /** After a pause (the app backgrounded, the frame loop stopped), travel the time that was missed,
     *  so a resumed device shows the jars a device that never slept shows (W9). Frame time is clamped
     *  to 0.1 s a tick, so without this the belt resumes where it stopped — behind the shared clock by
     *  the whole pause, and with it every jar identity and the odd-jar ladder. Full speed for the gap:
     *  a stall's length is wall clock, and one that ended while the app was away has ended.
     *  Returns the seconds caught up. */
    catchUp() {
      const lag = Date.now() / 1000 - (t0 + elapsed);
      if (!(lag > 0.25)) return 0;
      distance += p.speed * lag;
      elapsed += lag;
      return lag;
    },
    /** Is a jar on the floor right now? */
    get fallen() { return fall.active ? { jar: fall.jar, resting: fall.rest > 0 } : null; },
    /** The global jar index currently drawn by instance slot `n` (from a raycast's instanceId). */
    jarAtInstance(n) { return n >= 0 && n < slotJar.length ? slotJar[n] : -1; },
    /** The jar nearest the entry cut-out right now, by global index, or -1.
     *  ★ SLOT ORDER IS NOT PATH ORDER. Slots are filled by walking `raw = distance + i*pitch`
     *  and taking it modulo the loop length, so the sequence wraps somewhere in the middle and
     *  slot 0 is wherever that modulo happened to land — anything assuming "slot 0 is the one
     *  that just came through the hole" is picking a jar at random, which is how the riding
     *  mouse came to materialise halfway down the belt in full view. */
    jarNearestEntry() {
      let best = -1, bestS = Infinity;
      for (let i = 0; i < iGlass.count; i++) {
        if (slotS[i] < bestS) { bestS = slotS[i]; best = slotJar[i]; }
      }
      return best;
    },
    /** Which instance slot is drawing jar `id` right now, or -1 if it is no longer on the
     *  visible run (into the wall, or knocked off).
     *  ★ THE SLOT IS NOT THE JAR. Slots are refilled in path order every frame, so when the
     *  lead jar passes into the exit hood every remaining jar shifts DOWN one slot — anything
     *  holding a slot number is silently handed its neighbour. That is a 0.32 m jump per
     *  departure, which is exactly what the riding mouse was doing. Identity is the GLOBAL
     *  index; the slot is a per-frame detail and has to be looked up again every frame. */
    instanceOfJar(id) {
      const want = id | 0;
      for (let i = 0; i < iGlass.count; i++) if (slotJar[i] === want) return i;
      return -1;
    },
    /** A jar somewhere along the visible run, by fraction. How an event names a jar nobody
     *  tapped: the belt has moved by the time the track is dispatched, so an authored index
     *  would be a different jar on every client. A fraction of the LIVE run is not. */
    jarAtFraction(f) {
      const n = state.jars;
      if (!n) return -1;
      const i = Math.min(n - 1, Math.max(0, Math.floor((Number(f) || 0) * n)));
      return slotJar[i] ?? -1;
    },
    /** The jar instanced meshes, for a raycast. */
    jarMeshes: [iGlass, iLid, iLabel],
    /** 4/5 of the room, as a measurement rather than as an eyeball. */
    fourFifths(roomZmin, roomZmax) {
      return (p.zB - p.zEntry) / (roomZmax - roomZmin);
    },
    debug: { loopLength, slots, visibleSlots, jarsPerHour, seams, hangers, pathLength: path.length },
  };
}
