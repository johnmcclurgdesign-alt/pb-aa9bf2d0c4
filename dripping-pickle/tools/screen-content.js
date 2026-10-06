// tools/screen-content.js — what the three screens actually SHOW, as a capability the event
// system can name. DP-W5 (SCR-001/003/004/005/006).
//
// The room already had screens that were DEVICES (SCR-002, DP-W2): curvature, corner mask,
// scanlines, grille, smear, bleed, phosphor tint. That treatment stays exactly where it is. This
// module supplies the *content* underneath it — the screensaver, the triangulating map, the
// briefing page, the asset plate — so every look still arrives through the same device treatment
// and "content must look like it is displayed by that device" (canon §9) holds for free.
//
// ★ GATE A §7.2 IS BINDING HERE AND IT IS NOT AN OPTIMISATION: "do not animate the static by
//   re-uploading a canvas — generate screen content in the fragment shader." Measured in DP-W2:
//   p95 34.7 ms with a TV in view against p95 14.0 ms frozen, and the tell is "fps drops only
//   when the TVs are on screen". So:
//
//     - everything that MOVES is procedural GLSL (screensaver, map, warm-up) — zero uploads;
//     - everything that is TEXT is a page drawn ONCE when a line lands, and the typewriter
//       reveal is a uniform the shader masks against. A stacking briefing therefore costs one
//       page render per line (≈ six per takeover), never one per frame. Since TV1 (2026-10-06)
//       the page is drawn in GL into a render target (tools/gl-page.js, text through
//       tools/gl-text.js) — it was a 2D canvas, and the Apple TV binding has no Canvas 2D.
//
// The modes, and why there are only four:
//
//   0 passthrough  the material's own emissiveMap (the pickles video, or the antenna static)
//   1 screensaver  flying pickles + brine drip, procedural, always-on baseline
//   2 map          triangulation converging on a location, procedural, seeded per fire
//   3 page         the page: briefing text (with reveal) or an asset plate
//   4 wake         the warm-up — "lines of code blur by" (S01-E00 outline), procedural
//
// A crossfade between two content modes would mean evaluating both. A device switching source
// BLANKS instead, which is both cheaper and what the hardware in this room would actually do:
// `uScrDim` rides 1 → 0 → 1 across a change and costs one multiply.

// ── page geometry, shared between the canvas and the shader ──────────────────────────────────
// One source of truth: the page draws the lines here and the GLSL masks the reveal against the
// same numbers. Drifting them apart puts the cursor in the wrong place, which reads as the
// typewriter being broken rather than as two constants disagreeing.
export const PAGE = {
  w: 512, h: 384,
  headerH: 0.175,          // letterhead band, fraction of page height
  bodyTop: 0.235,          // first line's band starts here
  lineH: 0.108,            // one line band
  lines: 6,                // Gate A §7.1: six lines maximum on the centre LCD, ever
  marginL: 0.055,
};

// ── the GLSL ─────────────────────────────────────────────────────────────────────────────────
// ★ NO BACKTICKS ANYWHERE IN HERE, COMMENTS INCLUDED — one closes the template literal and the
//   SyntaxError points at an unrelated GLSL word several lines away. tools/check-shaders.mjs
//   guards this and is worth running after any edit.
//
// Injected by the scene right after SCREEN_TREAT_GLSL, so it can use scrHash/scrSample and is
// itself used by screenTreat's sampling taps — which is what makes the smear, the chroma bleed
// and the scanlines apply to generated content exactly as they apply to the video.
export const SCREEN_CONTENT_GLSL = `
  #ifdef USE_EMISSIVEMAP
  uniform int       uScrMode;     // 0 passthrough, 1 screensaver, 2 map, 3 page, 4 wake
  uniform float     uScrSeed;     // per-fire seed: which map, which pickle field
  uniform float     uScrT0;       // content start time, so an envelope can run from the fire
  uniform float     uScrDim;      // blank across a source change (1 = lit)
  uniform sampler2D uScrPage;     // the page (text / plate): a render target holding sRGB-coded colour
  uniform vec4      uScrBody;     // page geometry: bodyTop, lineH, marginL, revealRight
  uniform float     uScrReveal;   // lines fully revealed + fraction of the one typing; <0 = no mask

  float scrVnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = scrHash(i), b = scrHash(i + vec2(1.0, 0.0));
    float c = scrHash(i + vec2(0.0, 1.0)), d = scrHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  // ── 1: the screensaver ──────────────────────────────────────────────────────────────────
  // Flying Toasters, but the DP logo's engraved pickle: a field tracking diagonally, each one
  // rotating back and forth through a half-arc, and a percentage chance that one tilting DOWN
  // sheds a drip of brine off the bottom edge (Gate A §7.3, Scope Doc).
  //
  // Signed-distance ovoid with a warty edge, sampled over a 2x2 cell neighbourhood. Cells are
  // wider than a pickle so two never overlap, which is what lets the gather stop at four.
  float scrPickle(vec2 p, float rot) {
    float c = cos(rot), s = sin(rot);
    p = mat2(c, -s, s, c) * p;
    float taper = 1.0 - 0.16 * p.x;                 // one end a little fatter
    vec2 q = vec2(p.x / 1.00, p.y / (0.40 * taper));
    float d = length(q) - 1.0;
    d += 0.075 * sin(p.x * 11.0) * sin(p.y * 9.0 + 1.3);   // warts
    return d;
  }

  vec3 scrScreensaver(vec2 w) {
    float t = uScrTime * 0.5 + uScrSeed * 37.0;
    // Cells are wider than a pickle, so a 2x2 gather is the whole field and nothing overlaps.
    // The face is not square (16:9 centre, 4:3 flanks), so the x count is the larger one — a
    // uniform grid in UV would draw stretched pickles on the LCD.
    vec2 uv = vec2(w.x * 7.5, w.y * 5.0);
    vec2 g = uv + vec2(0.62, -0.40) * t * 0.30;     // the diagonal track
    vec2 base = floor(g);
    vec3 col = vec3(0.0);
    float body = 0.0, rim = 0.0, spec = 0.0, drip = 0.0;
    for (int j = 0; j < 2; j++) {
      for (int i = 0; i < 2; i++) {
        vec2 cell = base + vec2(float(i), float(j)) - 0.5;
        vec2 h = vec2(scrHash(cell), scrHash(cell + 19.7));
        vec2 c = cell + 0.5 + (h - 0.5) * 0.30;     // jitter so the grid never reads as a grid
        vec2 p = g - c;
        // The long axis lies along the track, and swings through a half-arc about it — each
        // pickle on its own phase, so the field never pulses in unison.
        float rot = -0.57 + 0.62 * sin(t * (0.55 + 0.30 * h.x) + h.y * 6.28);
        float d = scrPickle(p * 3.0, rot);
        float m = 1.0 - smoothstep(-0.04, 0.06, d);
        body = max(body, m);
        rim = max(rim, (1.0 - smoothstep(0.0, 0.18, abs(d + 0.06))));
        // a soft highlight along the upper flank: glass-jar produce, not a green blob
        spec = max(spec, m * (1.0 - smoothstep(-0.20, 0.30, d + 0.22 + 0.55 * p.y)));
        // ── the drip. Gated per cell, and it only sheds while that pickle is tilted DOWN.
        if (scrHash(cell + 5.3) < 0.34) {
          float phase = fract(t * (0.11 + 0.05 * h.x) + h.y);
          float fall = phase * 4.6;                  // travels well past the cell, off the edge
          vec2 dp = g - (c + vec2(0.20 * sin(rot), -0.14 - fall));
          float dd = length(dp * vec2(9.0, 2.6));    // a stretched bead
          drip = max(drip, (1.0 - smoothstep(0.25, 0.75, dd)) * step(0.02, phase) * (1.0 - phase * 0.35) * step(0.0, rot));
        }
      }
    }
    vec3 brine = vec3(0.22, 0.44, 0.10);             // canon palette: murky, aged, never fresh
    col += body * brine;
    col += rim * vec3(0.10, 0.26, 0.06) * 0.7;
    col += spec * vec3(0.44, 0.76, 0.30) * 0.40;
    col += drip * vec3(0.42, 0.72, 0.24);
    // the faintest field wash, so the tube is never truly black between pickles
    col += vec3(0.010, 0.026, 0.010);
    return col;
  }

  // ── 2: the map ──────────────────────────────────────────────────────────────────────────
  // Vector-drawn, high contrast, no type below headline size — because at the ROOM pose this
  // screen is 116 x 65 px and MOTION is the only thing that reads there (Gate A §7.1/7.3).
  // Three bearings sweep in from the edges and converge; then range rings and a lock.
  float scrLine(vec2 p, vec2 a, vec2 b, float r) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
    return 1.0 - smoothstep(0.0, r, length(pa - ba * h));
  }

  vec3 scrMap(vec2 w) {
    float t = max(uScrTime - uScrT0, 0.0);
    float sd = uScrSeed;
    vec2 tgt = vec2(0.46 + 0.20 * sin(sd * 7.31), 0.50 + 0.17 * cos(sd * 4.11));
    vec3 ink = vec3(0.30, 0.95, 0.42);
    vec3 col = vec3(0.008, 0.030, 0.012);

    // landmass: one noise isoline, so every seed is a different coast
    float n = scrVnoise(w * 3.1 + sd * 11.0) * 0.65 + scrVnoise(w * 7.4 + sd * 3.0) * 0.35;
    float land = smoothstep(0.49, 0.51, n);
    col += ink * 0.10 * land;
    float coast = 1.0 - smoothstep(0.0, 0.030, abs(n - 0.50));
    col += ink * 0.55 * coast;

    // graticule
    vec2 grid = abs(fract(w * 6.0) - 0.5);
    col += ink * 0.16 * (1.0 - smoothstep(0.0, 0.035, min(grid.x, grid.y)));

    // three bearings, each from its own station, sweeping onto the target over ~5 s
    float lock = smoothstep(4.6, 5.4, t);
    for (int k = 0; k < 3; k++) {
      float fk = float(k);
      vec2 st = vec2(0.5 + 0.62 * cos(sd * 3.0 + fk * 2.094), 0.5 + 0.62 * sin(sd * 5.0 + fk * 2.094));
      float sweepA = atan(tgt.y - st.y, tgt.x - st.x);
      float wide = (1.0 - smoothstep(0.0, 4.8 + fk * 0.4, t)) * (1.6 - fk * 0.25);
      float a = sweepA + wide * sin(t * (1.7 + fk * 0.5) + fk * 2.0);
      vec2 dir = vec2(cos(a), sin(a));
      col += ink * 0.85 * scrLine(w, st, st + dir * 1.7, 0.006) * (0.35 + 0.65 * lock);
      col += ink * 1.4 * (1.0 - smoothstep(0.0, 0.020, length(w - st)));   // the station
    }

    // range rings expanding out of the fix, then the reticle
    float rd = length((w - tgt) * vec2(1.0, 0.82));
    for (int r = 0; r < 2; r++) {
      float ring = fract(t * 0.55 + float(r) * 0.5) * 0.34;
      col += ink * 0.9 * lock * (1.0 - smoothstep(0.0, 0.010, abs(rd - ring))) * (1.0 - ring / 0.34);
    }
    float cross = max(1.0 - smoothstep(0.0, 0.006, abs(w.x - tgt.x)) * step(rd, 0.075),
                      1.0 - smoothstep(0.0, 0.006, abs(w.y - tgt.y)) * step(rd, 0.075));
    col += ink * lock * step(rd, 0.075) * cross * 1.2;
    col += ink * lock * 1.3 * (1.0 - smoothstep(0.0, 0.008, abs(rd - 0.048)));
    return col;
  }

  // ── 4: the warm-up ──────────────────────────────────────────────────────────────────────
  // "The mismatched monitors stop displaying the screensaver and start warming up with a hum as
  // lines of code blur by" (S01-E00). Rows of ragged bars scrolling fast: at this size, glyphs
  // and bars are the same picture, and bars cost no atlas.
  vec3 scrWake(vec2 w) {
    float t = uScrTime - uScrT0;
    float rows = 22.0;
    float y = w.y * rows + t * 26.0;
    float row = floor(y);
    float rf = fract(y);
    float cols = 30.0;
    float cx = floor(w.x * cols);
    float on = step(scrHash(vec2(cx, row)), 0.42 + 0.30 * scrHash(vec2(row, 3.0)));
    float len = step(w.x, 0.15 + 0.85 * scrHash(vec2(row, 11.0)));
    float band = (1.0 - smoothstep(0.30, 0.62, abs(rf - 0.5)));
    float bright = 0.55 + 0.45 * scrHash(vec2(cx * 1.7, row * 2.3));
    return vec3(0.24, 0.90, 0.34) * on * len * band * bright * (0.35 + 0.65 * smoothstep(0.0, 0.5, t));
  }

  // ── 3: the page ─────────────────────────────────────────────────────────────────────────
  // The page, plus the typewriter mask. uScrReveal is "lines fully revealed + the fraction of
  // the line currently typing"; below zero it means a plate, which has no line structure.
  // The page holds sRGB-CODED colour (tools/gl-page.js: it blends the way the canvas did), so it
  // is decoded here — the canvas texture it replaced was SRGBColorSpace and the GPU decoded it.
  vec3 scrPageDecode(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }
  vec3 scrPage(vec2 w) {
    vec2 p = vec2(w.x, 1.0 - w.y);            // the page is top-down, the face is bottom-up
    vec4 tex = texture2D(uScrPage, p);
    vec3 col = scrPageDecode(tex.rgb);
    if (uScrReveal >= 0.0) {
      float idx = floor((p.y - uScrBody.x) / uScrBody.y);
      if (p.y >= uScrBody.x && idx >= 0.0) {
        float typed = uScrReveal - idx;
        if (typed <= 0.0) col = vec3(0.0);
        else if (typed < 1.0) {
          float edge = uScrBody.z + (uScrBody.w - uScrBody.z) * typed;
          if (p.x > edge) col = vec3(0.0);
          // the block cursor, blinking at the head of the line being typed
          float inRow = step(uScrBody.x + idx * uScrBody.y + uScrBody.y * 0.18, p.y)
                      * step(p.y, uScrBody.x + idx * uScrBody.y + uScrBody.y * 0.86);
          float atCur = step(edge, p.x) * step(p.x, edge + 0.026);
          col = mix(col, vec3(0.30, 0.95, 0.38), inRow * atCur * step(0.5, fract(uScrTime * 1.6)));
        }
      }
    }
    return col;
  }

  vec3 scrContent(vec2 w) {
    vec3 col;
    if      (uScrMode == 1) col = scrScreensaver(w);
    else if (uScrMode == 2) col = scrMap(w);
    else if (uScrMode == 3) col = scrPage(w);
    else if (uScrMode == 4) col = scrWake(w);
    else                    col = scrSample(w);
    return col * uScrDim;
  }
  #endif
`;

// ── the page ─────────────────────────────────────────────────────────────────────────────────
// Text and asset plates. Drawn once per change into the device's page target (tools/gl-page.js,
// whose `g` is a canvas-shaped API so these drawings read the way they were written for canvas).
// Everything here is ORIGINAL procedural artwork — no image ships and nothing is traced from a
// source (see asset-provenance.csv). Typography per canon §9: the institutional sans for Grocery
// Dispatch operational headers, the phosphor terminal setting for terminal content — both are
// Outpost Phosphor (tools/phosphor-face.mjs), set proportionally and on a fixed pitch — and the
// Dripping Pickle slab serif NEVER on an operational screen.
//
// ★ THE SIZES BELOW ARE THE CANVAS'S, UNCHANGED. A font is { face, px } and px means what it meant
//   to the canvas (tools/gl-text.js): the cap height and the terminal pitch are matched to the
//   faces the canvas used, so 22px here is the size 22px was. Changing the size or the layout is
//   UX1's (#148), here, and never in gl-text.js.
const SANS = (px, tracking = 0) => ({ face: 'sans', px, tracking });
const MONO = (px) => ({ face: 'mono', px });
const W = { regular: 0.7, semibold: 0.95, bold: 1.15 };   // stroke half-widths, face units (gl-text WEIGHT)

/** Per-device ink. The right CRT is monochrome-leaning phosphor, the LCD is neutral (Gate A §7.2). */
const INK = {
  left:   { bg: '#04120a', ink: '#7ee39a', dim: '#2e6b45', head: '#0d2a19', headInk: '#a9f0bd' },
  center: { bg: '#080b0c', ink: '#d8e6dd', dim: '#5d6f65', head: '#12181a', headInk: '#eaf3ee' },
  right:  { bg: '#0d0a03', ink: '#f0b64e', dim: '#6d5220', head: '#1c1508', headInk: '#ffd58a' },
};

/** A stable 0..1 hash of a string — plates and maps are seeded from their own subject, so the
 *  same cargo always draws the same crate on every device without shipping a lookup table. */
export function strSeed(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return (h >>> 8) / 16777216;
}

/** One page for one device, drawn on `surf` (tools/gl-page.js). Returns the draws the executor needs. */
function createPage(side, surf) {
  const g = surf.g;
  const P = INK[side] ?? INK.center;

  function letterhead(title, right) {
    g.fillRect(0, 0, PAGE.w, PAGE.h * PAGE.headerH, P.head);
    // letter-spaced by hand, as the canvas did: an institutional letterhead without the tracking
    // reads as a website header instead of a form (+2.6 px a letter)
    g.fillText(title ?? 'GROCERY DISPATCH', PAGE.w * PAGE.marginL, PAGE.h * PAGE.headerH * 0.46,
      SANS(21, 2.6), P.headInk, { baseline: 'middle', weight: W.semibold });
    if (right) {
      g.fillText(String(right), PAGE.w * (1 - PAGE.marginL), PAGE.h * PAGE.headerH * 0.48,
        MONO(13), P.headInk, { baseline: 'middle', align: 'right' });
    }
    g.fillRect(0, PAGE.h * PAGE.headerH - 2, PAGE.w, 2, P.ink);
  }

  return {
    /** The briefing: letterhead plus stacked monospace lines. Returns the right edge of the LAST
     *  line in page-u units, which is what the shader reveals the typewriter against. */
    brief(title, tag, lines) {
      surf.begin();
      g.fillRect(0, 0, PAGE.w, PAGE.h, P.bg);
      letterhead(title, tag);
      // Fit the block, never truncate the copy: the pools are authored to Gate A §7.1's short
      // lines, and a line that still overruns is better a point smaller than cut off mid-word.
      const avail = PAGE.w * (1 - PAGE.marginL * 2);
      let px = 22;
      let widest = 0;
      for (const l of lines) widest = Math.max(widest, g.measureText(String(l), MONO(px)));
      if (widest > avail) px = Math.max(15, Math.floor(px * avail / widest));
      let last = PAGE.marginL;
      for (let i = 0; i < lines.length && i < PAGE.lines; i++) {
        const y = PAGE.h * (PAGE.bodyTop + i * PAGE.lineH + PAGE.lineH * 0.78);
        const text = String(lines[i]);
        g.fillText(text, PAGE.w * PAGE.marginL, y, MONO(px), i === lines.length - 1 ? P.ink : P.dim);
        if (i === lines.length - 1) last = PAGE.marginL + g.measureText(text, MONO(px)) / PAGE.w;
      }
      surf.end();
      return Math.min(last, 1 - PAGE.marginL * 0.5);
    },
    /** The asset plate: one object, one face or one place, full bleed, one caption.
     *  Gate A §7.1 — the flanking CRTs carry ONE thing and never text beyond a two-word caption. */
    plate(kind, subject, caption) {
      const s = strSeed(subject);
      surf.begin();
      g.fillRect(0, 0, PAGE.w, PAGE.h, P.bg);
      // a lit floor/backdrop so the subject sits in a space rather than floating
      g.globalAlpha = 0.55;
      g.fillRectGradient(0, 0, PAGE.w, PAGE.h, [[0, P.dim], [0.62, P.bg], [1, P.head]]);
      g.globalAlpha = 1;
      g.save();
      g.translate(PAGE.w / 2, PAGE.h * 0.50);
      if (kind === 'agent') drawFace(g, s, P);
      else if (kind === 'topic') drawSite(g, s, P);
      else drawCargo(g, s, P, subject);
      g.restore();
      // knock it back through the print screen
      g.globalAlpha = 0.42; g.fillRectScreen(0, 0, PAGE.w, PAGE.h, '#000000'); g.globalAlpha = 1;
      // caption strip
      g.fillRect(0, PAGE.h * 0.845, PAGE.w, PAGE.h * 0.155, P.head);
      g.fillRect(0, PAGE.h * 0.845, PAGE.w, 2, P.ink);
      let cap = String(caption ?? subject).toUpperCase();
      while (g.measureText(cap, MONO(20)) > PAGE.w * 0.90 && cap.length > 4) cap = cap.slice(0, -2);
      g.fillText(cap, PAGE.w * PAGE.marginL, PAGE.h * 0.923, MONO(20), P.headInk, { baseline: 'middle' });
      surf.end();
      return -1;   // a plate has no line structure: the shader must not mask it
    },
  };
}

// ── the three plate subjects, all procedural ────────────────────────────────────────────────
// Each is a silhouette family selected by the subject's own hash, so one cargo always draws the
// same object. They are deliberately blunt: at 116 px the flanking CRTs carry a shape, and a
// shape is all that survives (Gate A §7.1).

function drawCargo(g, s, P, subject) {
  const form = Math.floor(s * 4);
  const W_ = 190, H = 130;
  if (form === 0) {                                   // a crate
    g.fillRect(-W_ / 2, -H / 2, W_, H, P.ink);
    g.fillRect(-W_ / 2 + 10, -H / 2 + 10, W_ - 20, H - 20, P.head);
    for (let i = 0; i < 3; i++) g.fillRect(-W_ / 2, -H / 2 + 18 + i * 42, W_, 7, P.ink);
  } else if (form === 1) {                            // a canister
    g.beginPath();
    g.moveTo(-58, -H / 2 + 16);
    g.quadraticCurveTo(0, -H / 2 - 12, 58, -H / 2 + 16);
    g.lineTo(58, H / 2 - 16);
    g.quadraticCurveTo(0, H / 2 + 12, -58, H / 2 - 16);
    g.closePath(); g.fill(P.ink);
    for (let i = 0; i < 2; i++) g.fillRect(-58, -22 + i * 44, 116, 9, P.head);
    g.fillRect(-22, -H / 2 - 22, 44, 16, P.ink);
  } else if (form === 2) {                            // a flight case
    g.fillRect(-W_ / 2, -H / 2 + 8, W_, H - 16, P.ink);
    g.fillRect(-W_ / 2 + 14, -H / 2 + 22, W_ - 28, H - 44, P.head);
    for (const x of [-W_ / 2, W_ / 2 - 14]) g.fillRect(x, -H / 2 + 8, 14, H - 16, P.ink);
    g.fillRect(-16, H / 2 - 12, 32, 12, P.ink);
  } else {                                            // a drum
    g.beginPath(); g.ellipse(0, -H / 2 + 14, 62, 16, 0, 0, Math.PI * 2); g.fill(P.ink);
    g.fillRect(-62, -H / 2 + 14, 124, H - 28, P.ink);
    g.beginPath(); g.ellipse(0, H / 2 - 14, 62, 16, 0, 0, Math.PI * 2); g.fill(P.ink);
    for (let i = 0; i < 2; i++) g.fillRect(-62, -26 + i * 52, 124, 10, P.head);
  }
  // stencil: a lot mark, never the cargo's own name — the caption already carries that
  g.fillText(`LOT ${String(Math.floor(strSeed(subject + 'lot') * 8999) + 1000)}`, 0, 6,
    SANS(17), P.head, { align: 'center', baseline: 'middle', weight: W.bold });
}

function drawFace(g, s, P) {
  // An identikit, not a portrait: head, shoulders, one hair/hat variant, one eyewear variant.
  g.beginPath();
  g.moveTo(-96, 122); g.quadraticCurveTo(-92, 34, 0, 30); g.quadraticCurveTo(92, 34, 96, 122);
  g.closePath(); g.fill(P.ink);                              // shoulders
  g.beginPath(); g.ellipse(0, -22, 52, 66, 0, 0, Math.PI * 2); g.fill(P.ink);   // head
  const hair = Math.floor(s * 4);
  if (hair === 0) { g.beginPath(); g.ellipse(0, -66, 54, 30, 0, Math.PI, 0); g.closePath(); g.fill(P.head); }
  else if (hair === 1) { g.fillRect(-62, -96, 124, 26, P.head); g.fillRect(-40, -74, 80, 12, P.head); }  // a hat
  else if (hair === 2) { g.beginPath(); g.ellipse(0, -58, 56, 42, 0, Math.PI, 0); g.closePath(); g.fill(P.head); g.fillRect(-56, -58, 12, 46, P.head); g.fillRect(44, -58, 12, 46, P.head); }
  else { g.beginPath(); g.ellipse(0, -70, 48, 22, 0, Math.PI, 0); g.closePath(); g.fill(P.head); }
  if (strSeed(String(s) + 'g') > 0.55) {                      // spectacles
    g.beginPath(); g.ellipse(-20, -22, 15, 13, 0, 0, Math.PI * 2); g.stroke(P.head, 5);
    g.beginPath(); g.ellipse(20, -22, 15, 13, 0, 0, Math.PI * 2); g.stroke(P.head, 5);
    g.beginPath(); g.moveTo(-5, -22); g.lineTo(5, -22); g.stroke(P.head, 5);
  }
  // registry ticks down the left, the way a personnel card is punched
  for (let i = 0; i < 5; i++) if ((Math.floor(s * 32) >> i) & 1) g.fillRect(-150, -60 + i * 26, 22, 12, P.ink);
}

function drawSite(g, s, P) {
  // A place: a skyline of blocks with a mast or a tank, seeded so a topic always draws itself.
  const n = 5 + Math.floor(s * 3);
  for (let i = 0; i < n; i++) {
    const h = 40 + strSeed(`${s}b${i}`) * 130;
    const w = 34 + strSeed(`${s}w${i}`) * 40;
    const x = -190 + i * (380 / n) + 8;
    g.fillRect(x, 120 - h, w, h, P.ink);
    for (let r = 0; r < Math.floor(h / 26); r++)
      for (let c = 0; c < Math.floor(w / 18); c++) g.fillRect(x + 7 + c * 18, 128 - h + r * 26, 8, 12, P.head);
  }
  if (s > 0.5) { g.fillRect(-6, -140, 12, 260, P.ink); g.fillRect(-40, -120, 80, 9, P.ink); g.fillRect(-26, -92, 52, 7, P.ink); }
  else { g.beginPath(); g.ellipse(120, 60, 74, 60, 0, 0, Math.PI * 2); g.fill(P.ink); g.fillRect(46, 52, 148, 12, P.head); }
  g.fillRect(-200, 118, 400, 8, P.ink);
}

// ── the controller ───────────────────────────────────────────────────────────────────────────
// One state per device. The event system reaches it through the screens executor, so an event
// file names `show` / `line` / `restore` and never knows any of this exists.
//
// ★ EVERY TIMING IN HERE IS WALL CLOCK, NEVER ACCUMULATED FRAME dt. A typewriter driven from dt
//   stretches exactly when frames are scarce, and this Loop targets 30 FPS on a phone — the same
//   defect that made an 8 s conveyor stall hold for 14 s (DP-W3) and the return affordance's fade
//   take five times too long (DP-W2). And a track arrives with ctx.late, so a device joining
//   mid-takeover lands on the line everyone else is on instead of typing the whole briefing again.
export const MODE = { PASSTHROUGH: 0, SCREENSAVER: 1, MAP: 2, PAGE: 3, WAKE: 4 };
const BLANK_OUT = 0.10, BLANK_IN = 0.20, TYPE_SEC = 0.85;

/**
 * @param {object} o
 * @param {{side: string, mats: object[]}[]} o.units       the three devices (mats carry __scr)
 * @param {() => object} o.makeSurface  scene-supplied page surface (tools/gl-page.js) — keeps three out of here
 * @param {number} [o.baseMode]  what a screen rests on. SCREENSAVER unless ?screensaver=0.
 * @param {() => number} [o.nowMs]
 */
export function createScreenContent({ units, makeSurface, baseMode = MODE.SCREENSAVER, nowMs = () => performance.now() }) {
  const states = units.map((u) => {
    const surf = makeSurface();
    const page = createPage(u.side, surf);
    const tex = surf.texture;
    const st = {
      side: u.side, mats: u.mats, page, tex,
      mode: baseMode, want: baseMode, seed: strSeed(u.side), t0: nowMs() / 1000,
      dim: 1, phase: null, phaseStart: 0,   // the source-change blank, on wall clock
      lines: [], reveal: -1, revealFrom: -1, revealTo: -1, typeStart: 0, typeSec: TYPE_SEC,
      body: [PAGE.bodyTop, PAGE.lineH, PAGE.marginL, 1 - PAGE.marginL],
    };
    for (const m of u.mats) if (m.__scr && m.__scr.uScrPage) m.__scr.uScrPage.value = tex;
    write(st);
    return st;
  });

  function write(st) {
    for (const m of st.mats) {
      const u = m.__scr;
      if (!u || !u.uScrMode) continue;
      u.uScrMode.value = st.mode;
      u.uScrSeed.value = st.seed;
      u.uScrT0.value = st.t0;
      u.uScrDim.value = st.dim;
      u.uScrReveal.value = st.reveal;
      u.uScrBody.value.set(st.body[0], st.body[1], st.body[2], st.body[3]);
    }
  }

  const pick = (target) => target === 'all' ? states : states.filter((s) => s.side === target);

  /** Change what a device is showing. `draw` repaints the page; it runs at the blank, not now,
   *  so the old content is never seen changing under the viewer. */
  function switchTo(st, mode, draw, late = 0) {
    st.want = mode;
    st.pendingDraw = draw ?? null;
    if (late > BLANK_OUT + BLANK_IN) { commit(st); st.dim = 1; st.phase = null; return; }
    st.phase = 'out'; st.phaseStart = nowMs();
  }
  function commit(st) {
    st.mode = st.want;
    st.t0 = nowMs() / 1000;
    if (st.pendingDraw) st.pendingDraw();
    st.pendingDraw = null;
  }

  // ── what a screen RESTS on (INT-003, DP-W8) ─────────────────────────────────────────────────
  // `baseMode` is what `restore` goes back to and what a device shows when nothing is happening.
  // The CRT dial makes it a control: tapping it takes the array off the screensaver and back to
  // the raw feed, the way a dial on a real set does.
  //
  // ★ AND THE NEXT TIMED EVENT TAKES IT BACK, which is the half that keeps this from being a
  // setting. Gate A's screens belong to the room, not to the viewer: a mission takeover arriving
  // to find the array parked in whatever mode somebody left it in is a takeover playing against
  // a different set for the rest of the session. A LOCAL fire (a tap) leaves the override alone;
  // anything from the shared schedule clears it first.
  let shippedBase = baseMode;
  function setBase(mode) {
    baseMode = mode;
    for (const st of states) if (!st.lines.length) switchTo(st, mode, null, 0);
    return baseMode;
  }

  const api = {
    supports: (target, action) => ['all', 'left', 'center', 'right'].includes(target)
      && ['show', 'line', 'restore', 'base'].includes(action),

    apply(target, action, params, ctx = {}) {
      const list = pick(target);
      if (!list.length) return false;
      const late = ctx.late ?? 0;
      if (action === 'base') {
        const want = String(params.mode ?? 'screensaver').toLowerCase();
        setBase(want === 'passthrough' ? MODE.PASSTHROUGH
              : want === 'shipped' ? shippedBase : MODE.SCREENSAVER);
        return true;
      }
      // A scheduled event owns the array: clear a viewer's dial before it plays.
      if (!ctx.local && baseMode !== shippedBase) setBase(shippedBase);
      for (const st of list) {
        if (action === 'restore') {
          st.lines = []; st.reveal = -1;
          switchTo(st, baseMode, null, late);
          continue;
        }
        if (action === 'line') {
          // Stacking terminal: six visible, oldest scrolls off (Gate A §7.1 caps the LCD at six).
          st.lines.push(String(params.text ?? ''));
          while (st.lines.length > PAGE.lines) st.lines.shift();
          const idx = st.lines.length - 1;
          const right = st.page.brief(st.title, st.tag, st.lines);
          st.body = [PAGE.bodyTop, PAGE.lineH, PAGE.marginL, right];
          if (st.mode !== MODE.PAGE) { st.want = MODE.PAGE; st.mode = MODE.PAGE; st.dim = 1; st.phase = null; }
          // late: the line is already typed for everyone else, so land on it
          st.revealFrom = late > 0 ? idx + 1 : idx;
          st.revealTo = idx + 1;
          st.typeStart = nowMs() - late * 1000;
          st.reveal = st.revealFrom;
          continue;
        }
        // show
        const widget = String(params.widget ?? 'screensaver');
        if (widget === 'map') {
          st.seed = strSeed(String(params.subject ?? params.title ?? st.side));
          switchTo(st, MODE.MAP, null, late);
        } else if (widget === 'wake') {
          switchTo(st, MODE.WAKE, null, late);
        } else if (widget === 'plate') {
          const kind = String(params.kind ?? 'cargo'), subject = String(params.subject ?? '');
          switchTo(st, MODE.PAGE, () => {
            st.reveal = st.page.plate(kind, subject, params.caption ?? subject);
            st.body = [PAGE.bodyTop, PAGE.lineH, PAGE.marginL, 1 - PAGE.marginL];
          }, late);
        } else if (widget === 'brief') {
          st.title = params.title ? String(params.title) : 'GROCERY DISPATCH';
          st.tag = params.tag ? String(params.tag) : '';
          st.lines = [];
          switchTo(st, MODE.PAGE, () => {
            st.page.brief(st.title, st.tag, []);
            st.reveal = 0;
            st.body = [PAGE.bodyTop, PAGE.lineH, PAGE.marginL, 1 - PAGE.marginL];
          }, late);
        } else {
          switchTo(st, baseMode, null, late);
        }
      }
      return true;
    },

    /** Once per frame. Only writes uniforms — nothing here draws a page. */
    tick() {
      const now = nowMs();
      for (const st of states) {
        if (st.phase === 'out') {
          const f = Math.min(1, (now - st.phaseStart) / (BLANK_OUT * 1000));
          st.dim = 1 - f;
          if (f >= 1) { commit(st); st.phase = 'in'; st.phaseStart = now; }
        } else if (st.phase === 'in') {
          const f = Math.min(1, (now - st.phaseStart) / (BLANK_IN * 1000));
          st.dim = f;
          if (f >= 1) { st.phase = null; st.dim = 1; }
        }
        if (st.revealTo >= 0 && st.reveal < st.revealTo) {
          const f = Math.min(1, (now - st.typeStart) / (st.typeSec * 1000));
          st.reveal = st.revealFrom + (st.revealTo - st.revealFrom) * f;
        }
        write(st);
      }
    },

    setBase,
    get baseMode() { return baseMode; },
    get baseOverridden() { return baseMode !== shippedBase; },
    /** For the HUD and for scripted checks. */
    get state() { return states.map((s) => ({ side: s.side, mode: s.mode, lines: s.lines.length, reveal: +s.reveal.toFixed(2) })); },
  };
  return api;
}
