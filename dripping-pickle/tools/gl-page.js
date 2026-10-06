// tools/gl-page.js — a page drawn in GL and rendered once into a texture (TV1, 2026-10-06).
//
// The screens' mission pages and the chalkboard's message were 2D canvases, drawn once per change
// and uploaded. The Apple TV binding has no Canvas 2D, so this is the same idea in WebGL: a page is
// recorded as a short list of layers — flat fills, vertical gradients, paths, the print screen, and
// text through tools/gl-text.js — and rendered ONCE into a render target when it changes. Nothing
// is drawn per frame: the screen and board shaders sample the target exactly as they sampled the
// canvas texture, so "everything that moves is procedural GLSL; text is drawn once per change"
// (Gate A §7.2, lesson everything-that-moves-is-procedural-glsl) holds unchanged.
//
// The API is deliberately a canvas's, cut down to what the pages use — fillRect, a path with
// moveTo / lineTo / quadraticCurveTo / ellipse, fill, stroke, globalAlpha, translate — so the
// drawings ported from canvas read line for line like the originals.
//
// ★ COLOUR IS sRGB-CODED AND STAYS THAT WAY UNTIL IT IS SAMPLED. A 2D canvas blends in sRGB, and the
//   pages' colours are hex sRGB. The target is plain RGBA8 holding those coded values (blended the
//   canvas's way), and the shader that samples it decodes — the CanvasTexture it replaces was
//   SRGBColorSpace and the GPU decoded it. A linear RGBA8 target would have banded the near-black
//   page backgrounds (#04120a is 0.0012 linear: 0.3 of an 8-bit step).
// ★ THE TARGET IS TOP-DOWN, LIKE THE CANVAS. The camera maps page y = 0 to the target's v = 0, the
//   way the canvas texture (flipY = false) was laid out, so the samplers did not change.

import { createTextBatch, createTextMaterial, measureText } from './gl-text.js';

/** '#rrggbb', '#rgb' or 'rgba(r,g,b,a)' / 'rgb(r,g,b)' → [r, g, b, a], sRGB-coded 0..1. */
export function parseColour(c) {
  if (Array.isArray(c)) return c.length === 4 ? c : [...c, 1];
  const s = String(c).trim();
  if (s[0] === '#') {
    const h = s.length === 4 ? s.slice(1).split('').map((x) => x + x).join('') : s.slice(1);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).concat(1);
  }
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (m) { const p = m[1].split(',').map(Number); return [p[0] / 255, p[1] / 255, p[2] / 255, p[3] ?? 1]; }
  return [1, 0, 1, 1];   // a loud magenta, so a colour this parser does not know is never subtle
}

const SOLID_VERT = /* glsl */`
  attribute vec4 aColor;
  varying vec4 vColor;
  varying vec2 vPage;
  void main() {
    vColor = aColor;
    vPage = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const SOLID_FRAG = /* glsl */`
  varying vec4 vColor;
  varying vec2 vPage;
  void main() {
    #ifdef GLPAGE_SCREEN
      // the print screen: a 6 px cell, black except a 3 x 3 window at (1..3, 1..3) — the canvas
      // pattern it replaces, anchored at the page origin the same way
      vec2 c = mod(floor(vPage), 6.0);
      float hole = step(1.0, c.x) * step(c.x, 3.0) * step(1.0, c.y) * step(c.y, 3.0);
      gl_FragColor = vec4(vColor.rgb, vColor.a * (1.0 - hole));
    #else
      gl_FragColor = vColor;
    #endif
  }`;

/**
 * @param {object} o
 * @param {typeof import('three')} o.THREE
 * @param {import('three').WebGLRenderer} o.renderer
 * @param {{value: import('three').Texture}} o.atlas  the glyph atlas uniform, shared by every page
 */
export function createGLPainter({ THREE, renderer, atlas }) {
  const solidMat = new THREE.ShaderMaterial({
    name: 'GLPage_Solid', vertexShader: SOLID_VERT, fragmentShader: SOLID_FRAG,
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  });
  const screenMat = solidMat.clone();
  screenMat.name = 'GLPage_Screen';
  screenMat.defines = { GLPAGE_SCREEN: '' };
  const textMats = { plain: createTextMaterial(THREE, atlas), chalk: createTextMaterial(THREE, atlas, { chalk: true }) };
  const surfaces = new Set();

  /** One solid layer: triangles with per-vertex colour. Grows as needed. */
  function solidLayer(mat) {
    let pos = new Float32Array(3 * 256), col = new Float32Array(4 * 256), n = 0;
    const geo = new THREE.BufferGeometry();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    const grow = (k) => {
      if (n + k <= pos.length / 3) return;
      const cap = Math.max(pos.length / 3 * 2, n + k);
      const p2 = new Float32Array(cap * 3); p2.set(pos); pos = p2;
      const c2 = new Float32Array(cap * 4); c2.set(col); col = c2;
    };
    return {
      kind: mat === screenMat ? 'screen' : 'solid', mesh,
      tri(ax, ay, bx, by, cx, cy, rgba, rgbaB = rgba, rgbaC = rgba) {
        grow(3);
        pos.set([ax, ay, 0, bx, by, 0, cx, cy, 0], n * 3);
        col.set(rgba, n * 4); col.set(rgbaB, n * 4 + 4); col.set(rgbaC, n * 4 + 8);
        n += 3;
      },
      commit() {
        geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, n * 3), 3));
        geo.setAttribute('aColor', new THREE.BufferAttribute(col.subarray(0, n * 4), 4));
        geo.setDrawRange(0, n);
      },
      dispose() { geo.dispose(); },
    };
  }

  /**
   * A surface: one page, one target. Draw calls record; end() renders the target.
   * @param {number} w  page width in page px (the layout's units)
   * @param {number} h
   * @param {object} [o]  scale: target texels per page px (the board renders finer than it lays out)
   *                      mipmaps: for a surface seen minified (the board); the pages had none
   */
  function createSurface(w, h, { scale = 1, mipmaps = false, chalk = false } = {}) {
    const W = Math.round(w * scale), H = Math.round(h * scale);
    const rt = new THREE.WebGLRenderTarget(W, H, {
      depthBuffer: false, stencilBuffer: false, type: THREE.UnsignedByteType,
      generateMipmaps: mipmaps,
      minFilter: mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    rt.texture.name = chalk ? 'GLPage_Board' : 'GLPage';
    const scene = new THREE.Scene();
    // page y-down → target v-down (top row is v = 0): top = h, bottom = 0 flips the y axis
    const cam = new THREE.OrthographicCamera(0, w, h, 0, -1, 1);
    let layers = [], cur = null, alpha = 1, tx = 0, ty = 0;
    const stack = [];

    const layer = (kind) => {
      if (cur && cur.kind === kind) return cur;
      if (kind === 'text') {
        cur = { kind, batch: createTextBatch(THREE, chalk ? textMats.chalk : textMats.plain, 512) };
        cur.mesh = cur.batch.mesh;
      } else {
        cur = solidLayer(kind === 'screen' ? screenMat : solidMat);
      }
      cur.mesh.renderOrder = layers.length;
      layers.push(cur);
      return cur;
    };
    const rgbaOf = (c) => { const v = parseColour(c); return [v[0], v[1], v[2], v[3] * alpha]; };

    // ── paths, flattened at draw time ──
    let subpaths = [], sp = null;
    const QUAD_STEPS = 12, ELLIPSE_STEPS = 48;
    const P = (x, y) => [x + tx, y + ty];

    const g = {
      get globalAlpha() { return alpha; },
      set globalAlpha(v) { alpha = v; },
      save() { stack.push([alpha, tx, ty]); },
      restore() { const s = stack.pop(); if (s) [alpha, tx, ty] = s; },
      translate(x, y) { tx += x; ty += y; },

      fillRect(x, y, rw, rh, c) {
        const L = layer('solid'), k = rgbaOf(c);
        const [x0, y0] = P(x, y), [x1, y1] = P(x + rw, y + rh);
        L.tri(x0, y0, x1, y0, x1, y1, k); L.tri(x0, y0, x1, y1, x0, y1, k);
      },
      /** A vertical gradient over a rect: stops as [[t, colour], ...], t in 0..1 down the rect. */
      fillRectGradient(x, y, rw, rh, stops) {
        const L = layer('solid');
        for (let i = 0; i + 1 < stops.length; i++) {
          const [t0, c0] = stops[i], [t1, c1] = stops[i + 1];
          const a = rgbaOf(c0), b = rgbaOf(c1);
          const [x0, y0] = P(x, y + rh * t0), [x1, y1] = P(x + rw, y + rh * t1);
          L.tri(x0, y0, x1, y0, x1, y1, a, a, b); L.tri(x0, y0, x1, y1, x0, y1, a, b, b);
        }
      },
      /** The print screen over a rect, in colour c at the current alpha. */
      fillRectScreen(x, y, rw, rh, c) {
        const L = layer('screen'), k = rgbaOf(c);
        const [x0, y0] = P(x, y), [x1, y1] = P(x + rw, y + rh);
        L.tri(x0, y0, x1, y0, x1, y1, k); L.tri(x0, y0, x1, y1, x0, y1, k);
      },

      beginPath() { subpaths = []; sp = null; },
      moveTo(x, y) { sp = [P(x, y)]; subpaths.push(sp); },
      lineTo(x, y) { if (!sp) g.moveTo(x, y); else sp.push(P(x, y)); },
      quadraticCurveTo(cx, cy, x, y) {
        const [x0, y0] = sp[sp.length - 1], [qx, qy] = P(cx, cy), [x1, y1] = P(x, y);
        for (let i = 1; i <= QUAD_STEPS; i++) {
          const t = i / QUAD_STEPS, u = 1 - t;
          sp.push([u * u * x0 + 2 * u * t * qx + t * t * x1, u * u * y0 + 2 * u * t * qy + t * t * y1]);
        }
      },
      /** canvas ellipse(x, y, rx, ry, rotation = 0, start, end) — clockwise in y-down, as canvas draws it. */
      ellipse(x, y, rx, ry, rot, a0, a1) {
        let span = a1 - a0;
        if (span <= 0) span += Math.PI * 2;                // canvas wraps a reversed range clockwise
        if (Math.abs(a1 - a0) >= Math.PI * 2 - 1e-6) span = Math.PI * 2;
        const steps = Math.max(4, Math.ceil(ELLIPSE_STEPS * span / (Math.PI * 2)));
        const pts = [];
        for (let i = 0; i <= steps; i++) { const a = a0 + span * i / steps; pts.push(P(x + rx * Math.cos(a), y + ry * Math.sin(a))); }
        if (sp) sp.push(...pts); else { sp = pts; subpaths.push(sp); }
      },
      closePath() { if (sp && sp.length) sp.push(sp[0].slice()); sp = null; },
      fill(c) {
        const L = layer('solid'), k = rgbaOf(c);
        for (const s of subpaths) {
          if (s.length < 3) continue;
          const contour = s.map(([x, y]) => new THREE.Vector2(x, y));
          if (contour[0].distanceTo(contour[contour.length - 1]) < 1e-6) contour.pop();
          const tris = THREE.ShapeUtils.triangulateShape(contour, []);
          for (const [a, b, d] of tris) L.tri(contour[a].x, contour[a].y, contour[b].x, contour[b].y, contour[d].x, contour[d].y, k);
        }
      },
      /** Stroke every subpath as quads, with a round-ish joint (a short fan) so arcs stay solid. */
      stroke(c, lineWidth = 1) {
        const L = layer('solid'), k = rgbaOf(c), r = lineWidth / 2;
        for (const s of subpaths) {
          for (let i = 1; i < s.length; i++) {
            const [ax, ay] = s[i - 1], [bx, by] = s[i];
            const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
            if (len < 1e-6) continue;
            const nx = (-dy / len) * r, ny = (dx / len) * r, ex = (dx / len) * r * 0.5, ey = (dy / len) * r * 0.5;
            const p = [ax - ex + nx, ay - ey + ny], q = [bx + ex + nx, by + ey + ny], s2 = [bx + ex - nx, by + ey - ny], t = [ax - ex - nx, ay - ey - ny];
            L.tri(p[0], p[1], q[0], q[1], s2[0], s2[1], k); L.tri(p[0], p[1], s2[0], s2[1], t[0], t[1], k);
          }
        }
      },

      /** Text through the one GL text path. `font` = {face, px, tracking}; o = align, baseline, weight, dust, jitter. */
      fillText(text, x, y, font, c, o = {}) {
        const L = layer('text');
        const [px, py] = P(x, y);
        return L.batch.add(text, font, px, py, rgbaOf(c), o);
      },
      measureText(text, font) { return measureText(text, font); },
    };

    const surf = {
      g,
      texture: rt.texture,
      width: w, height: h,
      /** Start a page: drop the last one's layers. */
      begin() {
        for (const L of layers) { scene.remove(L.mesh); L.dispose?.(); L.mesh.geometry.dispose(); }
        layers = []; cur = null; alpha = 1; tx = 0; ty = 0; stack.length = 0;
      },
      /** Render the recorded page into the target. Once per change, never per frame. */
      end() {
        for (const L of layers) { if (L.batch) L.batch.commit(); else L.commit(); scene.add(L.mesh); }
        surf.render();
      },
      render() {
        const prevRT = renderer.getRenderTarget();
        const prevAuto = renderer.autoClear;
        const prevColour = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
        renderer.setRenderTarget(rt);
        renderer.setClearColor(0x000000, 0);
        renderer.autoClear = true;
        renderer.render(scene, cam);
        renderer.setRenderTarget(prevRT);
        renderer.setClearColor(prevColour, prevAlpha);
        renderer.autoClear = prevAuto;
      },
      dispose() { surf.begin(); rt.dispose(); surfaces.delete(surf); },
    };
    surfaces.add(surf);
    return surf;
  }

  return {
    createSurface,
    /** The atlas arrived (or changed): every page that has text draws again, once. */
    redrawAll() { for (const s of surfaces) s.render(); },
  };
}
