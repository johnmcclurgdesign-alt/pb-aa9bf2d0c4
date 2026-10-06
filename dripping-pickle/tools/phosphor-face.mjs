// tools/phosphor-face.mjs — "Outpost Phosphor", the Loop's own single-stroke face (TV1, 2026-10-06).
//
// AUTHORING DATA, NOT RUNTIME CODE. The shipping graph never imports this file: tools/bake-text.mjs
// reads it to bake the glyph atlas (assets/dripping-pickle/text/phosphor-sdf.ktx2) and the two ZOOM
// labels, and writes the metrics the runtime needs into tools/phosphor-metrics.js.
//
// WHY AN ORIGINAL FACE. The Apple TV binding has no Canvas 2D, so runtime text has to come from a
// baked atlas — and an atlas used to set arbitrary text IS a font, redistributed. The faces the
// canvas used (Courier New, Helvetica Neue, SF Mono) are licensed to the machine they are installed
// on, not to a payload, and the provenance rule takes royalty_free / cc_zero / original only. So the
// face is drawn here, as data: every glyph is a skeleton of lines and elliptical arcs on a grid, in
// the engineered-lettering tradition canon §9 asks for ("institutional mid-century sans" for
// Grocery Dispatch headers, "phosphor monospace" for terminal screens). One skeleton serves both:
// set proportionally it is the sans, set on a fixed advance it is the terminal face.
//
// ★ IT IS A CENTRELINE FACE, SO WEIGHT IS A NUMBER AT DRAW TIME. The atlas stores the distance to
//   the skeleton, not to an outline, so the same atlas draws a hairline, a bold letterhead and a
//   chalk stroke: the shader thresholds at whatever half-width the caller asks for.
//
// Units: cap height 10, x-height 7, ascender 10, descender -3, baseline y = 0, y up. A glyph's
// strokes sit in x = 0 .. width. Commands, space separated:
//   M x y            move
//   L x y            line to
//   E cx cy rx ry a0 a1   elliptical arc, angles in degrees CCW from +x; a1 < a0 runs clockwise.
//                    It starts a new stroke at its own start point unless the pen is already there.
//   D x y            a dot (a zero-length stroke: the round cap is the dot)

export const FACE = {
  name: 'Outpost Phosphor',
  cap: 10, xh: 7, asc: 10, desc: -3,
  // The two settings, as a canvas caller would ask for them. `em` is the cap height's share of
  // the font size, chosen to match the faces they replace (Courier New 0.571, Helvetica 0.717),
  // so a caller that asked the canvas for 22px gets the same cap height from this face.
  mono: { capPerEm: 0.571, advancePerEm: 0.6 },
  sans: { capPerEm: 0.717, side: 1.25, space: 3.6 },
};

const O7 = 'M7 3.5 L7 6.5 E3.5 6.5 3.5 3.5 0 180 L0 3.5 E3.5 3.5 3.5 3.5 180 360';
const O6 = 'E3 3.5 3 3.5 0 360';               // lowercase bowl, x-height 7

// [width, skeleton, monoSkeleton?] — the third entry, when present, is the terminal variant
// (serifed I/i/l/1, slashed zero): a fixed-advance face needs them to keep I, l and 1 apart.
export const GLYPHS = {
  ' ': [3.6, ''],
  // ── capitals ────────────────────────────────────────────────────────────
  A: [7, 'M0 0 L3.5 10 L7 0 M1.25 3.6 L5.75 3.6'],
  B: [6.8, 'M0 5.2 L4.3 5.2 E4.3 7.6 2.4 2.4 -90 90 L0 10 L0 0 L4.4 0 E4.4 2.6 2.4 2.6 -90 90'],
  C: [6.8, 'E3.5 6.5 3.5 3.5 28 180 L0 3.5 E3.5 3.5 3.5 3.5 180 332'],
  D: [7, 'M0 0 L0 10 L3.5 10 E3.5 6.5 3.5 3.5 90 0 L7 3.5 E3.5 3.5 3.5 3.5 0 -90 L0 0'],
  E: [6.2, 'M6.2 10 L0 10 L0 0 L6.2 0 M0 5.2 L5.2 5.2'],
  F: [6, 'M6 10 L0 10 L0 0 M0 5.2 L5 5.2'],
  G: [7, 'E3.5 6.5 3.5 3.5 28 180 L0 3.5 E3.5 3.5 3.5 3.5 180 360 L7 4.8 L4.2 4.8'],
  H: [7, 'M0 0 L0 10 M7 0 L7 10 M0 5.2 L7 5.2'],
  I: [0, 'M0 0 L0 10', 'M3.5 0 L3.5 10 M1.5 10 L5.5 10 M1.5 0 L5.5 0'],
  J: [6, 'M6 10 L6 3 E3 3 3 3 0 -158'],
  K: [6.8, 'M0 0 L0 10 M6.8 10 L0 3.4 M2.3 5.6 L6.8 0'],
  L: [6, 'M0 10 L0 0 L6 0'],
  M: [8, 'M0 0 L0 10 L4 3.4 L8 10 L8 0'],
  N: [7, 'M0 0 L0 10 L7 0 L7 10'],
  O: [7, O7],
  P: [6.8, 'M0 0 L0 10 L4.1 10 E4.1 7.3 2.7 2.7 90 -90 L0 4.6'],
  Q: [7, O7 + ' M4.3 2.2 L7.3 -0.6'],
  R: [6.8, 'M0 0 L0 10 L4.1 10 E4.1 7.3 2.7 2.7 90 -90 L0 4.6 M3.6 4.6 L6.8 0'],
  S: [6.6, 'E3.3 7.5 3.2 2.5 22 270 E3.3 2.5 3.3 2.5 90 -158'],
  T: [7, 'M0 10 L7 10 M3.5 10 L3.5 0'],
  U: [7, 'M0 10 L0 3.5 E3.5 3.5 3.5 3.5 180 360 L7 10'],
  V: [7, 'M0 10 L3.5 0 L7 10'],
  W: [9, 'M0 10 L2.25 0 L4.5 7.2 L6.75 0 L9 10'],
  X: [7, 'M0 10 L7 0 M0 0 L7 10'],
  Y: [7, 'M0 10 L3.5 5 L7 10 M3.5 5 L3.5 0'],
  Z: [7, 'M0 10 L7 10 L0 0 L7 0'],
  // ── figures ─────────────────────────────────────────────────────────────
  0: [6.6, 'M6.6 3.5 L6.6 6.5 E3.3 6.5 3.3 3.5 0 180 L0 3.5 E3.3 3.5 3.3 3.5 180 360',
     'M6.6 3.5 L6.6 6.5 E3.3 6.5 3.3 3.5 0 180 L0 3.5 E3.3 3.5 3.3 3.5 180 360 M1.3 2.2 L5.3 7.8'],
  1: [4, 'M0.6 7.6 L4 10 L4 0', 'M1.4 7.6 L4 10 L4 0 M1.4 0 L6.4 0'],
  2: [6.6, 'E3.3 6.7 3.3 3.3 160 -38 L0 0 L6.6 0'],
  3: [6.6, 'E3.2 7.55 3.1 2.45 152 -90 E3.2 2.55 3.4 2.55 90 -152'],
  4: [7, 'M5.2 0 L5.2 10 L0 2.8 L7 2.8'],
  5: [6.6, 'M6.3 10 L1 10 L0.85 5.51 E3.3 3.3 3.3 3.3 138 -150'],
  6: [6.6, 'E3.3 3.2 3.3 3.2 0 360 M0 3.2 L0 6.6 E3.3 6.6 3.3 3.4 180 48'],
  7: [6.6, 'M0 10 L6.6 10 L2.4 0'],
  8: [6.6, 'E3.3 7.6 2.9 2.4 -90 270 E3.3 2.6 3.3 2.6 90 450'],
  9: [6.6, 'E3.3 6.8 3.3 3.2 0 360 M6.6 6.8 L6.6 3.4 E3.3 3.4 3.3 3.4 0 -132'],
  // ── lower case ──────────────────────────────────────────────────────────
  a: [6, O6 + ' M6 7 L6 0'],
  b: [6, 'M0 10 L0 0 ' + O6],
  c: [5.8, 'E3 3.5 3 3.5 42 318'],
  d: [6, 'M6 10 L6 0 ' + O6],
  e: [6, 'M0 3.6 L6 3.6 E3 3.5 3 3.5 2 322'],
  f: [5, 'E3.9 8.1 1.7 1.9 30 180 L2.2 0 M0.2 7 L4.8 7'],
  g: [6, O6 + ' M6 7 L6 -0.8 E3 -0.8 3 2.2 0 -158'],
  h: [6, 'M0 10 L0 0 M0 4 E3 4 3 3 180 0 L6 0'],
  i: [0, 'M0 0 L0 7 D0 9.3', 'M1.2 7 L3.2 7 L3.2 0 M0.8 0 L5.6 0 D3.2 9.3'],
  j: [3.6, 'M3.6 7 L3.6 -0.8 E1.4 -0.8 2.2 2.2 0 -150 D3.6 9.3'],
  k: [5.8, 'M0 10 L0 0 M5.6 7 L0 2.4 M2.1 4.2 L5.8 0'],
  l: [0, 'M0 10 L0 0', 'M1.2 10 L3.2 10 L3.2 0 M0.8 0 L5.6 0'],
  m: [8.4, 'M0 0 L0 7 M0 4.6 E2.1 4.6 2.1 2.4 180 0 L4.2 0 M4.2 4.6 E6.3 4.6 2.1 2.4 180 0 L8.4 0'],
  n: [6, 'M0 0 L0 7 M0 4 E3 4 3 3 180 0 L6 0'],
  o: [6, O6],
  p: [6, 'M0 7 L0 -3 ' + O6],
  q: [6, 'M6 7 L6 -3 ' + O6],
  r: [4.4, 'M0 0 L0 7 M0 4 E3.4 4 3.4 3 180 72'],
  s: [5.6, 'E2.8 5.25 2.6 1.75 18 270 E2.8 1.75 2.8 1.75 90 -160'],
  t: [5, 'M2.2 10 L2.2 2 E4.2 2 2 2 180 270 L5 0 M0 7 L5 7'],
  u: [6, 'M0 7 L0 3 E3 3 3 3 180 360 M6 7 L6 0'],
  v: [6, 'M0 7 L3 0 L6 7'],
  w: [8.4, 'M0 7 L2.1 0 L4.2 5 L6.3 0 L8.4 7'],
  x: [6, 'M0 7 L6 0 M0 0 L6 7'],
  y: [6, 'M0 7 L3.1 0.2 M6 7 L1.9 -3'],
  z: [6, 'M0 7 L6 7 L0 0 L6 0'],
  // ── punctuation ─────────────────────────────────────────────────────────
  '.': [0, 'D0 0.6'],
  ',': [0.9, 'M0.9 1 L0 -1.6'],
  ':': [0, 'D0 0.6 D0 5.8'],
  ';': [0.9, 'D0.9 5.8 M0.9 1 L0 -1.6'],
  '!': [0, 'M0 10 L0 3.6 D0 0.6'],
  '?': [6, 'E3 7.3 3 2.7 160 -90 L3 3.4 D3 0.6'],
  "'": [0, 'M0 10 L0 7.4'],
  '"': [2.2, 'M0 10 L0 7.4 M2.2 10 L2.2 7.4'],
  '’': [0.9, 'M0.9 10 L0 7.4'],   // ’
  '‘': [0.9, 'M0 10 L0.9 7.4'],   // ‘
  '“': [2.6, 'M0 10 L0.9 7.4 M1.7 10 L2.6 7.4'],   // “
  '”': [2.6, 'M0.9 10 L0 7.4 M2.6 10 L1.7 7.4'],   // ”
  '-': [4, 'M0 4.2 L4 4.2'],
  '–': [6, 'M0 4.2 L6 4.2'],      // –
  '—': [9, 'M0 4.2 L9 4.2'],      // —
  _: [7, 'M0 -1.6 L7 -1.6'],
  '#': [7, 'M2 0 L2.8 10 M4.9 0 L5.7 10 M0 3.3 L7 3.3 M0 6.7 L7 6.7'],
  '&': [7.2, 'M7.2 0 L1.6 6.4 E3.3 8.1 1.8 1.9 214 -34 L0.9 3.1 E3.4 2.6 2.6 2.6 168 300 L6.8 3.6'],
  '(': [1.5, 'E6.4 4.7 6.4 8.4 140 220'],
  ')': [1.5, 'E-4.9 4.7 6.4 8.4 40 -40'],
  '[': [2.8, 'M2.8 11 L0 11 L0 -1.6 L2.8 -1.6'],
  ']': [2.8, 'M0 11 L2.8 11 L2.8 -1.6 L0 -1.6'],
  '{': [3.2, 'M3.2 11 L1.6 11 L1.6 5.6 L0 4.7 L1.6 3.8 L1.6 -1.6 L3.2 -1.6'],
  '}': [3.2, 'M0 11 L1.6 11 L1.6 5.6 L3.2 4.7 L1.6 3.8 L1.6 -1.6 L0 -1.6'],
  '/': [5, 'M0 -1 L5 11'],
  '\\': [5, 'M0 11 L5 -1'],
  '|': [0, 'M0 11 L0 -2.6'],
  '+': [6, 'M0 4.6 L6 4.6 M3 1.6 L3 7.6'],
  '=': [6, 'M0 3.1 L6 3.1 M0 6.1 L6 6.1'],
  '*': [5, 'M2.5 10 L2.5 5 M0.3 8.8 L4.7 6.2 M0.3 6.2 L4.7 8.8'],
  '%': [7, 'E1.6 8 1.6 2 0 360 E5.4 2 1.6 2 0 360 M0 0 L7 10'],
  '<': [6, 'M6 8.6 L0 4.6 L6 0.6'],
  '>': [6, 'M0 8.6 L6 4.6 L0 0.6'],
  '^': [6, 'M0 7 L3 10 L6 7'],
  '~': [6.4, 'E1.6 4.4 1.6 1.2 180 0 E4.8 4.4 1.6 1.2 180 360'],
  '`': [1.4, 'M0 10 L1.4 8.4'],
  '@': [9.4, 'E5.6 3.9 2.2 2.5 0 360 M7.8 6.4 L7.8 2.6 E8.4 2.6 0.6 1.2 180 300 M8.9 1.5 E4.7 4.5 4.7 5.5 2 330'],
  $: [6.6, 'E3.3 7.2 3.2 2.3 22 270 E3.3 2.8 3.3 2.3 90 -158 M3.3 11 L3.3 -1'],
  '·': [0, 'D0 4.6'],              // ·
  '°': [3, 'E1.5 8.5 1.5 1.5 0 360'],   // °
  '§': [5.6, 'E2.8 8.3 2.6 1.6 20 270 E2.8 5 2.8 1.7 90 -90 E2.8 1.7 2.6 1.6 90 -160'],   // §
};

// ── the skeleton, as polylines ──────────────────────────────────────────────────────────────────
// Arcs are flattened finely enough that the baked distance field cannot see the facets (0.04 units
// of sagitta at the largest radius, against an atlas texel of 0.25 units).
const STEP_DEG = 6;

/** A glyph's strokes as arrays of [x, y] points (a single point is a dot). */
export function strokes(spec) {
  const out = [];
  let cur = null;
  const t = spec.match(/[MLED]|-?\d*\.?\d+/g) ?? [];   // 'M0 0 L3.5 10' → M 0 0 L 3.5 10
  const pen = () => cur && cur[cur.length - 1];
  const near = (a, b) => a && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3;
  for (let i = 0; i < t.length;) {
    const c = t[i++];
    const n = () => Number(t[i++]);
    if (c === 'M') { cur = [[n(), n()]]; out.push(cur); }
    else if (c === 'L') { const p = [n(), n()]; if (!cur) { cur = [p]; out.push(cur); } else cur.push(p); }
    else if (c === 'D') { const p = [n(), n()]; out.push([p]); cur = null; }
    else if (c === 'E') {
      const cx = n(), cy = n(), rx = n(), ry = n(), a0 = n(), a1 = n();
      const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / STEP_DEG));
      const pts = [];
      for (let k = 0; k <= steps; k++) {
        const a = (a0 + (a1 - a0) * k / steps) * Math.PI / 180;
        pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
      }
      if (near(pen(), pts[0])) cur.push(...pts.slice(1));
      else { cur = pts; out.push(cur); }
    } else throw new Error(`phosphor-face: unknown command ${c} in "${spec}"`);
  }
  return out;
}

/** The glyph list the atlas carries, in atlas order. */
export const CHARS = Object.keys(GLYPHS);

/**
 * A glyph as the given setting draws it: { width, strokes }. The terminal variants (the third
 * entry) are drawn on their own extents, so they are re-based to x = 0 and measured — a serifed I
 * is 4 units wide where the plain stroke is 0, and centring it on the plain glyph's width put it
 * half a cell to the right.
 */
export function glyph(ch, mono = false) {
  const g = GLYPHS[ch];
  if (!g) return null;
  if (!(mono && g[2])) return { width: g[0], strokes: strokes(g[1]) };
  const st = strokes(g[2]);
  const xs = st.flat().map((p) => p[0]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  return { width: x1 - x0, strokes: st.map((s) => s.map(([x, y]) => [x - x0, y])) };
}
