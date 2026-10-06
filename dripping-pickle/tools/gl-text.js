// tools/gl-text.js — the Loop's ONE text path at runtime: a baked glyph atlas and quads laid out
// in JS (TV1, 2026-10-06).
//
// The Apple TV binding has no Canvas 2D, so runtime text cannot be rasterised on the device
// (loops-docs web/05-apple-tv §6, PROGRAM decision 18). Every glyph the Loop draws at runtime
// comes from assets/dripping-pickle/text/phosphor-sdf.ktx2 — "Outpost Phosphor", the original
// single-stroke face in tools/phosphor-face.mjs, baked as the DISTANCE TO EACH GLYPH'S SKELETON by
// tools/bake-text.mjs. A string becomes one quad per glyph in a batch, and the batch is one draw.
//
// ★ THIS FILE IS THE MECHANISM, NOT THE LAYOUT. It knows how to measure a string and where each
//   glyph of it goes for a given font size, alignment and tracking — never what text goes where.
//   Sizes, positions and weights belong to the caller (tools/screen-content.js createPage, the
//   chalkboard), which is where UX1 (#148, #149) changes them without touching this.
//
// ★ A FONT IS A SIZE THE CALLER ALREADY KNEW. `{ face: 'mono' | 'sans', px }` means what the
//   canvas's `22px monospace` meant: the cap height is px x capPerEm (Courier New's and
//   Helvetica's own ratios, FACE in phosphor-face.mjs), and the terminal setting advances
//   px x 0.6 per character, Courier's pitch. So a caller ported from canvas keeps its numbers
//   and draws text the same size it did. `weight` is the stroke's half-width in face units
//   (a capital is 10 tall): the atlas stores distance to the skeleton, so weight is chosen here.
//
// Coordinates are a page's: x right, y DOWN, in pixels — a 2D canvas's convention, so a ported
// layout reads the way it was written. The batch emits colour as sRGB-coded values, unconverted,
// for a target that is decoded where it is sampled (tools/gl-page.js says why).

import { PHOSPHOR } from './text-assets.js';

const A = PHOSPHOR;
/** The weights the ported callers ask for, in face units (half the stroke width). */
export const WEIGHT = { regular: 0.7, semibold: 0.95, bold: 1.15 };

/** Per-glyph cell in the atlas, the terminal variant first when the face is mono. */
function cellOf(ch, mono) {
  return (mono && A.monoGlyphs[ch]) || A.glyphs[ch] || null;
}

const capPx = (font) => font.px * (font.face === 'mono' ? A.mono.capPerEm : A.sans.capPerEm);

/** Advance of one character in px, tracking excluded. Unknown characters advance like a space. */
function advance(ch, font, k) {
  if (font.face === 'mono') return font.px * A.mono.advancePerEm;
  if (ch === ' ') return A.sans.space * k;
  const c = cellOf(ch, false);
  return c ? (c[2] + 2 * A.sans.side) * k : A.sans.space * k;
}

/** Width of `text` in px, the way canvas measureText().width reported it (tracking included). */
export function measureText(text, font) {
  const k = capPx(font) / A.cap;
  let w = 0;
  const s = String(text);
  for (const ch of s) w += advance(ch, font, k) + (font.tracking ?? 0);
  return s.length ? w - (font.tracking ?? 0) : 0;
}

/**
 * Lay a string out as glyph quads. `baseline` is the canvas's word: 'alphabetic' puts the baseline
 * at y; 'middle' centres the capitals on y. Returns quads in page px with their atlas uvs.
 */
export function layoutText(text, font, x, y, { align = 'left', baseline = 'alphabetic' } = {}) {
  const k = capPx(font) / A.cap;
  const w = measureText(text, font);
  let pen = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  const base = baseline === 'middle' ? y + capPx(font) / 2 : y;
  const mono = font.face === 'mono';
  const quads = [];
  const left = -A.originX / A.pxPerUnit, right = (A.cellW - A.originX) / A.pxPerUnit;
  const above = (A.cellH - A.baseFromBottom) / A.pxPerUnit, below = A.baseFromBottom / A.pxPerUnit;
  for (const ch of String(text)) {
    const adv = advance(ch, font, k);
    const c = ch === ' ' ? null : cellOf(ch, mono);
    if (c) {
      // mono centres the glyph in its pitch; sans starts it one side-bearing in
      const ox = pen + (mono ? (adv - c[2] * k) / 2 : A.sans.side * k);
      // the atlas is stored bottom-up: row 0's top edge is v = 1
      const u0 = (c[0] * A.cellW) / A.atlasW, u1 = ((c[0] + 1) * A.cellW) / A.atlasW;
      const vTop = 1 - (c[1] * A.cellH) / A.atlasH, vBot = 1 - ((c[1] + 1) * A.cellH) / A.atlasH;
      quads.push({
        x0: ox + left * k, x1: ox + right * k, y0: base - above * k, y1: base + below * k,
        u0, u1, v0: vTop, v1: vBot, k,
      });
    }
    pen += adv + (font.tracking ?? 0);
  }
  return quads;
}

/**
 * The glyph material. One program for every batch; `chalk` adds the board's grain and a soft
 * dust edge (a define, so the page text pays nothing for it).
 */
export function createTextMaterial(THREE, atlasUniform, { chalk = false } = {}) {
  return new THREE.ShaderMaterial({
    name: chalk ? 'GLText_Chalk' : 'GLText',
    defines: chalk ? { GLTEXT_CHALK: '' } : {},
    uniforms: { uAtlas: atlasUniform, uRange: { value: A.range } },
    vertexShader: /* glsl */`
      attribute vec4 aColor;     // sRGB-coded rgb + alpha
      attribute vec2 aStyle;     // half-width in face units, dust softness in face units
      varying vec2 vUv;
      varying vec4 vColor;
      varying vec2 vStyle;
      varying vec2 vPage;
      void main() {
        vUv = uv;
        vColor = aColor;
        vStyle = aStyle;
        vPage = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uAtlas;
      uniform float uRange;
      varying vec2 vUv;
      varying vec4 vColor;
      varying vec2 vStyle;
      varying vec2 vPage;
      float glHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        // distance to the skeleton, in face units
        float d = (1.0 - texture2D(uAtlas, vUv).r) * uRange;
        float aa = max(fwidth(d), 1e-4) * 0.75;
        float cov = 1.0 - smoothstep(vStyle.x - aa, vStyle.x + aa, d);
        #ifdef GLTEXT_CHALK
          // chalk: the stroke breaks up where the stick skipped over the slate's grain, and a
          // faint dust sits just outside it — the canvas drew that as a blurred second pass
          float grain = glHash(floor(vPage * 0.9));
          cov *= 0.72 + 0.28 * step(0.22, grain);
          float dust = 1.0 - smoothstep(vStyle.x, vStyle.x + vStyle.y, d);
          cov = max(cov, dust * 0.30);
        #endif
        gl_FragColor = vec4(vColor.rgb, vColor.a * cov);
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/**
 * A batch of glyph quads: add() strings, then commit() writes one geometry. The mesh is a
 * plain THREE.Mesh, so it goes into whatever scene the caller renders.
 */
export function createTextBatch(THREE, material, maxGlyphs = 512) {
  const pos = new Float32Array(maxGlyphs * 4 * 3);
  const uv = new Float32Array(maxGlyphs * 4 * 2);
  const col = new Float32Array(maxGlyphs * 4 * 4);
  const sty = new Float32Array(maxGlyphs * 4 * 2);
  const idx = new Uint32Array(maxGlyphs * 6);
  for (let i = 0; i < maxGlyphs; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 4));
  geo.setAttribute('aStyle', new THREE.BufferAttribute(sty, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.setDrawRange(0, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  let n = 0;
  return {
    mesh,
    clear() { n = 0; geo.setDrawRange(0, 0); },
    /**
     * @param {string} text
     * @param {{face:'mono'|'sans', px:number, tracking?:number}} font
     * @param {number[]} rgba  sRGB-coded 0..1, alpha last
     * @param {object} [o]  align, baseline, weight (face units), dust (face units, chalk only),
     *                      jitter(i, quad) => {dx, dy} per glyph, in px (the chalk hand)
     */
    add(text, font, x, y, rgba, o = {}) {
      const quads = layoutText(text, font, x, y, o);
      const w = o.weight ?? WEIGHT.regular, dust = o.dust ?? 0;
      quads.forEach((q, gi) => {
        if (n >= maxGlyphs) return;
        const j = o.jitter ? o.jitter(gi, q) : null;
        const dx = j ? j.dx : 0, dy = j ? j.dy : 0;
        pos.set([q.x0 + dx, q.y0 + dy, 0, q.x1 + dx, q.y0 + dy, 0, q.x1 + dx, q.y1 + dy, 0, q.x0 + dx, q.y1 + dy, 0], n * 12);
        uv.set([q.u0, q.v0, q.u1, q.v0, q.u1, q.v1, q.u0, q.v1], n * 8);
        for (let v = 0; v < 4; v++) { col.set(rgba, n * 16 + v * 4); sty.set([w, dust], n * 8 + v * 2); }
        n++;
      });
      return quads.length;
    },
    commit() {
      for (const k of ['position', 'uv', 'aColor', 'aStyle']) geo.getAttribute(k).needsUpdate = true;
      geo.setDrawRange(0, n * 6);
      return n;
    },
    get count() { return n; },
  };
}
