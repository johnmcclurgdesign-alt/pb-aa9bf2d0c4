// tools/chalkboard.js — the break-room chalkboard, writing itself.
//
// Josh, 2026-09-03: "Can we write on chalk board - like programmatically have
// messages update?" Ambient flavour text, not mission content — it does not
// touch tools/events/vocabulary.json (that gate belongs to NPC-004, and two
// unrelated systems sharing it is exactly the kind of collision the DP-W6
// handoff flagged) and it is not gated by the event engine at all. A plain
// wall-clock timer in the render loop, same as the return affordance and the
// conveyor stall: durations here are wall clock, motion is dt, and this has
// no motion.
//
// The board ships with a baked photo texture (smudges, dust, the aluminium
// frame reflection) — replacing it outright would look like a whiteboard.
// The writing is drawn OVER it in the board's own shader instead, so the wear
// stays and only the writing changes.
//
// ★ SINCE TV1 (2026-10-06) THE WRITING IS GL, AND THE PHOTO IS NEVER READ. The board used to copy
//   its photo into a 2D canvas and write chalk over the copy; the Apple TV binding has no Canvas
//   2D, and reading the photo's pixels is what forced the props cook to leave this one texture
//   uncompressed (docs/lessons/the-props-cook-keeps-one-material-uncompressed.md). Now the message
//   is drawn through the one GL text path (tools/gl-page.js + tools/gl-text.js) into a small target
//   laid out in BOARD space, and the board's material composites it over its map at shading time.
//   The photo stays whatever texture the cook made it — compressed like the other 140.

import * as THREE from 'three';

const MESSAGES = [
  'BRINE LEVELS: LOW.\nSOMEONE REFILL TANK 4.',
  'CAT: DO NOT FEED.\n(HE LIES.)',
  'MISSING: ONE (1) LADLE.\nREWARD: RESPECT.',
  'CONVEYOR #3 STICKS.\nHIT IT ONCE, NOT TWICE.',
  'PICKLE OF THE MONTH:\nSTILL DILL.',
  'MOUSE SIGHTED AGAIN.\nCAT: UNBOTHERED, AS USUAL.',
  'NIGHT SHIFT — LIGHTS\nOUT BY 2. — MGMT',
  'DELIVERY WINDOW:\nDON’T ASK.',
  'JAR #4,417 WOBBLED.\nNOBODY SAW ANYTHING.',
  'INVENTORY: FINE.\nDO NOT RECOUNT.',
  'YOU ARE ALL\nDISAPPOINTMENTS!',
  'GO\nTIGER BAND!',
];

// A deterministic little wobble per character so the hand-writing does not
// look machine-set — same trick as the jar labels, just per-glyph instead of
// per-variant. Seeded from the string so a redraw of the same message (there
// isn't one, back-to-back, but future-proof) looks identical.
function hash(str)
{
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a)
{
  return () =>
  {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── where the writing actually goes (#99) ──────────────────────────────────
// ★ "DRAW IT ON THE BOARD" IS A CLAIM ABOUT A UV PATCH AND TWO AXES, AND ALL THREE WERE WRONG.
// Reported as text upside-down, backward, and not fitting the board — three symptoms of one
// mistake, which is that the writing was composited over the WHOLE texture in canvas axes and
// hoped for the best. Measured on the shipped mesh:
//
//   the board is a BOX; its writing face is the largest one on the viewer's side (normal +z,
//   1.08 m² against 0.006 m² for the edges — picking "the face most square-on to the camera"
//   instead returns the 5 mm SIDE EDGE, because the loop camera sees this wall at a slant)
//   its UV patch is u 0.125–0.375, v 0.25–0.5 — 192 x 192 px of a 768² map, one sixteenth of
//   the texture, so text drawn across the whole canvas showed as an off-centre crop
//   +u runs along world −x and +v along world +y, so text advancing along canvas +x ran
//   RIGHT-TO-LEFT across the board, and with flipY=false it also ran bottom-to-top
//
// The old code carried a hand-rolled horizontal mirror with a comment saying the UVs mirror
// horizontally — half-right by accident, and it could only ever be right for this one mesh.
// Solve the basis instead, the way `screenFaceBasis` solves the screens (SCR-008, the same
// defect class one prop over): find the face, read where its uv axes point in the world, and
// build the affine that takes BOARD space — x rightwards as a reader sees it, y downwards —
// to canvas pixels. Every flip and rotation then falls out of the measurement.
function solveFaceBasis(mesh, THREE, camera, texW, texH) {
  mesh.updateWorldMatrix(true, false);
  const g = mesh.geometry, pa = g.attributes.position, ua = g.attributes.uv, idx = g.index;
  if (!pa || !ua) return null;
  const P = (i) => new THREE.Vector3().fromBufferAttribute(pa, i).applyMatrix4(mesh.matrixWorld);
  const count = idx ? idx.count : pa.count;
  const groups = new Map();
  for (let t = 0; t < count; t += 3) {
    const a = idx ? idx.getX(t) : t, b = idx ? idx.getX(t + 1) : t + 1, c = idx ? idx.getX(t + 2) : t + 2;
    const pA = P(a), pB = P(b), pC = P(c);
    const cr = new THREE.Vector3().subVectors(pB, pA).cross(new THREE.Vector3().subVectors(pC, pA));
    const area = cr.length() / 2;
    if (area < 1e-9) continue;
    const n = cr.clone().normalize();
    const key = n.toArray().map((x) => x.toFixed(3)).join(',');
    const gr = groups.get(key) ?? { area: 0, verts: new Set(), n };
    gr.area += area; for (const i of [a, b, c]) gr.verts.add(i);
    groups.set(key, gr);
  }
  const centre = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
  const toEye = new THREE.Vector3().subVectors(camera.position, centre).normalize();
  // ⚠ Largest face ON THE VIEWER'S SIDE, not the one most square-on: at this camera the board's
  // 5 mm edge scores a higher dot (0.837) than its face (0.537), and the back face has the same
  // area as the front.
  const face = [...groups.values()].filter((gr) => gr.n.dot(toEye) > 0)
                                   .sort((a, b) => b.area - a.area)[0];
  if (!face) return null;
  // world "right" for somebody reading the face, and world up projected into it
  const worldUp = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(worldUp, face.n).normalize();
  if (right.lengthSq() < 0.5) return null;                     // a floor or a ceiling: no reading
  const up = new THREE.Vector3().crossVectors(face.n, right).normalize();
  const verts = [...face.verts].map((i) => ({ u: ua.getX(i), v: ua.getY(i), w: P(i) }));
  const r = verts.map((p) => p.w.dot(right)), s = verts.map((p) => p.w.dot(up));
  const r0 = Math.min(...r), r1 = Math.max(...r), s0 = Math.min(...s), s1 = Math.max(...s);
  if (r1 - r0 < 1e-6 || s1 - s0 < 1e-6) return null;
  // Each vertex in BOARD space (x right, y DOWN as a 2D canvas has it) and in canvas pixels.
  // flipY is false on this map — GLTFLoader set it and the redraw keeps it — so v maps
  // straight to the canvas row, with no flip anywhere in this function.
  const pts = verts.map((p, i) => ({
    bx: (r[i] - r0) / (r1 - r0), by: 1 - (s[i] - s0) / (s1 - s0),
    cx: p.u * texW, cy: p.v * texH,
  }));
  // Exact affine from three non-collinear corners: canvas = O + bx*X + by*Y.
  const o = pts.find((p) => p.bx < 0.5 && p.by < 0.5);
  const px = pts.find((p) => p.bx > 0.5 && p.by < 0.5);
  const py = pts.find((p) => p.bx < 0.5 && p.by > 0.5);
  if (!o || !px || !py) return null;
  return {
    normal: face.n, widthM: r1 - r0, heightM: s1 - s0,
    ox: o.cx, oy: o.cy,
    xx: px.cx - o.cx, xy: px.cy - o.cy,
    yx: py.cx - o.cx, yy: py.cy - o.cy,
    // the patch's size in canvas pixels, along the board's own axes
    pw: Math.hypot(px.cx - o.cx, px.cy - o.cy),
    ph: Math.hypot(py.cx - o.cx, py.cy - o.cy),
  };
}

// mesh: the board's writable face (the one whose material carries the baked
// photo texture, e.g. Cube065 under the Chalkboard group — not the frame or
// the chalk-stick submeshes, which have no map to preserve).
// opts.painter: tools/gl-page.js's painter (the scene's one, sharing the glyph atlas).
export function createChalkboard(mesh, opts = {})
{
  const camera = opts.camera, painter = opts.painter;
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const map = mat?.map;
  const w = map?.image?.width, h = map?.image?.height;
  if (!w || !h || !painter)
  {
    console.warn('chalkboard: no base texture or no painter on', mesh.name, '— skipping');
    return { tick() { }, next() { } };
  }

  // ★ THE BOARD SAMPLES ITS PHOTO THROUGH uv, NOT uv1, AS IT HAS SINCE #99. The glb maps the photo
  //   on TEXCOORD_1 (channel 1), which spreads the WHOLE photo — wipe marks and all — across the
  //   face. The canvas version replaced the map with a CanvasTexture, whose channel defaults to 0,
  //   so the board has been showing the 192 x 192 px patch that TEXCOORD_0 gives the face: a 4x
  //   crop, darker and cleaner, with the chalk drawn into that same patch. That is the board every
  //   signed picture shows, so it is kept, explicitly. (Found by TV1, 2026-10-06; whether the board
  //   should show its whole photo is a look question for #149, not a side effect of this port.)
  map.channel = 0;
  // Where on this texture the writing face actually lives, and which way round it is.
  const basis = camera ? solveFaceBasis(mesh, THREE, camera, w, h) : null;
  if (!basis)
  {
    // The canvas version wrote to the whole texture here, which is what #99 looked like. With
    // no face to put it on there is nothing honest to draw.
    console.warn('chalkboard: could not solve a face basis for', mesh.name, '— no writing');
    return { tick() { }, next() { } };
  }
  // Writable area, inset from the FACE — the aluminium frame and a border of scuffed-but-blank
  // board live outside it. A fraction of the face, not of the texture: the face is a sixteenth
  // of this map, so a pad measured against the texture is most of the board.
  const INSET_X = 0.09, INSET_Y = 0.11;
  const faceW = basis.pw, faceH = basis.ph;
  const boxW = faceW * (1 - INSET_X * 2), boxH = faceH * (1 - INSET_Y * 2);

  // The writing's own target, in BOARD space and in the face's own pixel units (so every size
  // below is the number the canvas used), rendered finer than the photo — 512 texels across the
  // face where the photo has ~192 — and mipmapped, because at the ROOM pose the board is small.
  const surf = painter.createSurface(faceW, faceH, { scale: 512 / faceW, mipmaps: true, chalk: true });
  const g = surf.g;

  // texture uv -> board space. The basis says canvas px = O + bx*X + by*Y with canvas px =
  // uv * (w, h) (flipY is false on this map, so v is the row); invert that 2x2 once.
  const { ox, oy, xx, xy, yx, yy } = basis;
  const det = xx * yy - yx * xy;
  const fromUv = new THREE.Matrix3().set(
    (yy * w) / det, (-yx * h) / det, (yx * oy - yy * ox) / det,
    (-xy * w) / det, (xx * h) / det, (xy * ox - xx * oy) / det,
    0, 0, 1);
  // A uniform bag on the material, the way the screens carry __scr: the shader reads it, and so
  // does the budget rig, which counts the target as resident.
  mat.__chalk = { uChalk: { value: surf.texture }, uChalkFromUv: { value: fromUv } };
  const prevCompile = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) =>
  {
    if (prevCompile) prevCompile(shader, renderer);
    Object.assign(shader.uniforms, mat.__chalk);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_pars_fragment>', `#include <map_pars_fragment>
        uniform sampler2D uChalk;
        uniform mat3 uChalkFromUv;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        #ifdef USE_MAP
        {
          // the writing, composited over the photo: board space from the map's own uv
          vec2 cb = (uChalkFromUv * vec3(vMapUv, 1.0)).xy;
          if (cb.x >= 0.0 && cb.x <= 1.0 && cb.y >= 0.0 && cb.y <= 1.0) {
            vec4 ch = texture2D(uChalk, cb);
            // stored premultiplied and sRGB-coded (tools/gl-page.js): unpremultiply, decode
            vec3 c = ch.rgb / max(ch.a, 1e-3);
            c = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
            diffuseColor.rgb = mix(diffuseColor.rgb, c, ch.a);
          }
        }
        #endif`);
  };
  const prevKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () => (prevKey ? prevKey.call(mat) : '') + '|chalk-gl';
  mat.needsUpdate = true;

  let currentIdx = -1;
  const pick = () =>
  {
    if (MESSAGES.length === 1) return 0;
    let i;
    do { i = Math.floor(Math.random() * MESSAGES.length); } while (i === currentIdx);
    return i;
  };

  // Chalk, through the GL text path: the canvas's sizes, its centring and its per-line tilt,
  // with a small per-letter wobble so the hand does not look machine-set (the canvas got that from
  // a handwriting font; Outpost Phosphor is engineered, so the wobble is the hand).
  const CHALK = [0.941, 0.929, 0.878, 0.92];   // '#f0ede0' at 0.92, the canvas's core pass
  const write = (msg) =>
  {
    surf.begin();
    const lines = msg.split('\n');
    const rng = mulberry32(hash(msg));
    // Sized against the FACE, so a long line fits the board rather than the atlas.
    const longest = lines.reduce((a, l) => Math.max(a, l.length), 1);
    const size = Math.min(boxW / (longest * 0.62), boxH / (lines.length * 1.55));
    const lineH = size * 1.35;
    const cx = faceW / 2;
    const top = faceH / 2 - ((lines.length - 1) * lineH) / 2;
    lines.forEach((line, i) =>
    {
      const tilt = (rng() - 0.5) * 0.05;
      const y = top + i * lineH;
      g.fillText(line, cx, y, { face: 'sans', px: size }, CHALK, {
        align: 'center', baseline: 'middle', weight: 1.0, dust: 1.1,
        jitter: (gi, q) => ({ dx: (rng() - 0.5) * size * 0.04,
                              dy: ((q.x0 + q.x1) / 2 - cx) * Math.tan(tilt) + (rng() - 0.5) * size * 0.06 }),
      });
    });
    surf.end();
  };

  const minS = opts.minIntervalSec ?? 45;
  const maxS = opts.maxIntervalSec ?? 90;
  let nextAt = performance.now() + 2000; // first message shortly after load, not instantly

  const advance = () =>
  {
    currentIdx = pick();
    write(MESSAGES[currentIdx]);
    nextAt = performance.now() + (minS + Math.random() * (maxS - minS)) * 1000;
  };

  return {
    tick()
    {
      if (performance.now() >= nextAt) advance();
    },
    // for scripted checks — force the next message now
    next: advance,
  };
}
