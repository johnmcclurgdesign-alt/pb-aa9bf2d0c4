#!/usr/bin/env node
// tools/bake-text.mjs — every piece of text the Loop shows, baked OFFLINE (TV1, 2026-10-06).
//
// The Apple TV binding has no Canvas 2D (loops-docs web/05-apple-tv §6, PROGRAM decision 18: zero
// getContext('2d') in the shipping graph), so nothing in the payload may rasterise a glyph at
// runtime. This script does it once, at authoring time, and writes what the runtime reads:
//
//   assets/dripping-pickle/text/phosphor-sdf.ktx2   the glyph atlas for runtime text (tools/gl-text.js):
//                                                   the distance to each glyph's SKELETON, so weight
//                                                   is chosen at draw time (tools/phosphor-face.mjs)
//   assets/dripping-pickle/text/zoom-labels.ktx2    ZOOM IN ► and ◄ ZOOM OUT, the lens pass's control
//   assets/dripping-pickle/text/jar-labels.ktx2     the eight jar labels (assets/dripping-pickle/jar-contents.json)
//   tools/text-assets.js                            GENERATED: the atlas metrics, the label rects, and
//                                                   the hash of the label data the jar atlas was baked from
//
// A browser canvas is used here, at authoring time, for the two label sheets — the rule binds the
// payload's runtime, not the tools (TV1's prompt). The glyph atlas needs no canvas at all: it is
// computed from the skeleton in plain JS.
//
// ★ IMAGES ARE STORED BOTTOM-UP. three uploads a KTX2 without flipping it (and the Apple TV binding
//   ignores UNPACK_FLIP_Y anyway — TVB13), while the canvases these replace were uploaded with
//   flipY = true. Writing each sheet bottom-up keeps every sampler's uv convention exactly what it
//   was, so the conveyor's label UVs and the lens shader did not have to learn a new one.
//
// ★ ENCODED THE WAY THE COOK ENCODES (Basis UASTC + zstd, mipmapped): the default payload ships these
//   as they are, and build-payload.sh --with-tvos finds them by their bytes and transcodes them to
//   ETC2 like every other Basis image.
//
//   node tools/bake-text.mjs            bake all three and the metrics module
//   node tools/bake-text.mjs --check    exit 1 if tools/text-assets.js is stale against the face or the label data
//   node tools/bake-text.mjs --preview .work/face.png   also write a proof sheet of the face (not shipped)
//
// Needs `ktx` (KTX-Software) on PATH and Playwright's Chromium (the rigs' own devDependency).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { FACE, GLYPHS, glyph } from './phosphor-face.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'assets/dripping-pickle/text');
const META = path.join(ROOT, 'tools/text-assets.js');
const JAR_DATA = path.join(ROOT, 'assets/dripping-pickle/jar-contents.json');
const args = process.argv.slice(2);
const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

// ── the atlas geometry ──────────────────────────────────────────────────────────────────────────
// 4 texels per unit: a 10-unit capital is 40 texels tall, so the page (12.6 px capitals) and the
// board both MINIFY it, which is the direction a distance field and its mips handle cleanly.
const PX = 4;
const RANGE = 3;                         // distance stored, in units, beyond the skeleton
const CELL_W = 64, CELL_H = 80;          // 16 x 20 units: the widest glyph (9.4) + RANGE either side
const ORIGIN_X = 3 * PX;                 // the glyph's x = 0, in cell texels from the left
const BASE_Y = CELL_H - 6 * PX;          // the baseline, in cell texels from the TOP (6 units of descent room)
const COLS = 16;

/** Every atlas entry: proportional glyphs first, then the terminal variants. */
function entries() {
  const list = [];
  for (const ch of Object.keys(GLYPHS)) list.push({ key: ch, ch, ...glyph(ch) });
  for (const [ch, g] of Object.entries(GLYPHS)) if (g[2]) list.push({ key: ch + '\u0000mono', ch, mono: true, ...glyph(ch, true) });
  return list;
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function bakeAtlas() {
  const list = entries();
  const rows = Math.ceil(list.length / COLS);
  const W = COLS * CELL_W, H = rows * CELL_H;
  const img = new Uint8Array(W * H);
  const glyphs = {};
  list.forEach((e, i) => {
    const col = i % COLS, row = Math.floor(i / COLS);
    const segs = [];
    for (const s of e.strokes) {
      if (s.length === 1) segs.push([s[0][0], s[0][1], s[0][0], s[0][1]]);
      for (let k = 1; k < s.length; k++) segs.push([s[k - 1][0], s[k - 1][1], s[k][0], s[k][1]]);
    }
    for (let y = 0; y < CELL_H; y++) {
      // texel centre, in glyph units (y up from the baseline)
      const gy = (BASE_Y - (y + 0.5)) / PX;
      for (let x = 0; x < CELL_W; x++) {
        const gx = (x + 0.5 - ORIGIN_X) / PX;
        let d = RANGE;
        for (const s of segs) { const v = segDist(gx, gy, s[0], s[1], s[2], s[3]); if (v < d) d = v; }
        // stored bottom-up: atlas row 0 is the image's BOTTOM row (see the header)
        const iy = H - 1 - (row * CELL_H + y);
        img[iy * W + col * CELL_W + x] = Math.round(255 * (1 - d / RANGE));
      }
    }
    glyphs[e.key] = [col, row, e.width];
  });
  return { W, H, img, glyphs, rows };
}

// ── PNG, written by hand (zlib is in node; nothing to install) ─────────────────────────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePng(file, w, h, channels, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = { 1: 0, 3: 2, 4: 6 }[channels]; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * channels + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * channels + 1)] = 0; Buffer.from(px.buffer, px.byteOffset + y * w * channels, w * channels).copy(raw, y * (w * channels + 1) + 1); }
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
}

function encodeUastc(png, out, fmt, tf) {
  execFileSync('ktx', ['create', '--format', fmt, '--assign-tf', tf, '--generate-mipmap',
    '--encode', 'uastc', '--uastc-quality', '2', '--zstd', '18', png, out], { stdio: ['ignore', 'ignore', 'pipe'] });
}

// ── the label sheets, drawn in a browser canvas at authoring time ──────────────────────────────
// The face's strokes are computed here and handed to the page as polylines, so the ZOOM label is
// set in the same face as everything the runtime draws.
const PROMPT = { h: 46, padX: 34, scale: 2, ink: '#8ef0a8', labels: ['ZOOM IN ►', '◄ ZOOM OUT'] };
// '600 17px monospace' was the canvas's font: the terminal setting at 17 px
const PROMPT_PX = 17;

function faceForPage() {
  const g = {};
  for (const ch of Object.keys(GLYPHS)) { const v = glyph(ch, true); g[ch] = { w: v.width, s: v.strokes }; }
  return g;
}

async function drawSheets(labels) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><body></body>');
    return await page.evaluate(async ({ face, FACEm, PROMPT, PROMPT_PX, labels }) => {
      const ADV = FACEm.mono.advancePerEm, CAP = FACEm.mono.capPerEm;
      // ── the ZOOM labels: brackets, the label in the terminal face, a phosphor bloom ──
      const S = PROMPT.scale;
      const advPx = PROMPT_PX * ADV;
      const rects = [];
      const boxes = PROMPT.labels.map((l) => Math.max(120, Math.round(l.length * advPx) + PROMPT.padX * 2));
      const GUT = 16;                      // texels between labels, so a mip never borrows a neighbour
      const sheetW = Math.ceil((Math.max(...boxes) * S) / 4) * 4;
      const rowH = PROMPT.h * S + GUT;
      const sheetH = Math.ceil((rowH * PROMPT.labels.length) / 4) * 4;
      const cv = document.createElement('canvas'); cv.width = sheetW; cv.height = sheetH;
      const g = cv.getContext('2d');
      PROMPT.labels.forEach((label, i) => {
        const W = boxes[i];
        g.save();
        g.translate(0, i * rowH);
        g.scale(S, S);
        g.strokeStyle = PROMPT.ink; g.fillStyle = PROMPT.ink;
        g.lineWidth = 1.5; g.lineCap = 'square';
        const x0 = 3, y0 = 3, x1 = W - 3, y1 = PROMPT.h - 3, arm = 11;
        g.globalAlpha = 0.85;
        for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
          g.beginPath(); g.moveTo(cx + sx * arm, cy); g.lineTo(cx, cy); g.lineTo(cx, cy + sy * arm); g.stroke();
        }
        g.globalAlpha = 1;
        g.shadowColor = PROMPT.ink; g.shadowBlur = 10;
        // the label, centred, in the terminal setting of the face: k CSS px per unit
        const k = (PROMPT_PX * CAP) / FACEm.cap;
        let x = W / 2 - (label.length * advPx) / 2;
        const base = PROMPT.h / 2 + 1 + (FACEm.cap * k) / 2;   // caps centred on the canvas's middle
        g.lineWidth = 2 * 1.15 * k; g.lineCap = 'round'; g.lineJoin = 'round';   // the canvas's '600' weight
        for (const ch of label) {
          if (ch === '►' || ch === '◄') {
            // the arrows were the system font's filled triangles; drawn as one here
            const h = FACEm.cap * k * 0.9, w = h * 0.86, cx = x + advPx / 2, cy = base - (FACEm.cap * k) / 2;
            const dir = ch === '►' ? 1 : -1;
            g.beginPath(); g.moveTo(cx - dir * w / 2, cy - h / 2); g.lineTo(cx + dir * w / 2, cy); g.lineTo(cx - dir * w / 2, cy + h / 2);
            g.closePath(); g.fill();
          } else if (face[ch]) {
            const gl = face[ch], off = x + (advPx - gl.w * k) / 2;
            for (const s of gl.s) {
              g.beginPath();
              s.forEach(([px, py], j) => { const X = off + px * k, Y = base - py * k; if (j) g.lineTo(X, Y); else g.moveTo(X, Y); });
              if (s.length === 1) g.lineTo(off + s[0][0] * k + 0.01, base - s[0][1] * k);
              g.stroke();
            }
          }
          x += advPx;
        }
        g.restore();
        rects.push({ label, wCss: W, hCss: PROMPT.h, x: 0, y: i * rowH, w: W * S, h: PROMPT.h * S });
      });
      // One ink, so every texel's colour IS the ink and only alpha varies: the mips and the
      // bilinear fringe then never darken toward the transparent black around the glyphs.
      const id = g.getImageData(0, 0, sheetW, sheetH);
      const ink = [0x8e, 0xf0, 0xa8];
      for (let i = 0; i < id.data.length; i += 4) { id.data[i] = ink[0]; id.data[i + 1] = ink[1]; id.data[i + 2] = ink[2]; }
      g.putImageData(id, 0, 0);
      const prompt = { url: cv.toDataURL('image/png'), w: sheetW, h: sheetH, rects };

      // ── the jar labels: the conveyor's own drawing, moved here verbatim (DP-W3) ──
      const cols = 4, rowsN = 2, cell = 256;
      const jc = document.createElement('canvas'); jc.width = cols * cell; jc.height = rowsN * cell;
      const ctx = jc.getContext('2d');
      const slab = '"Rockwell", "Roboto Slab", Georgia, "Times New Roman", serif';
      labels.variants.forEach((v, i) => {
        const x = (i % cols) * cell, y = Math.floor(i / cols) * cell;
        const tint = 226 - (i % 3) * 7;
        ctx.fillStyle = `rgb(${tint}, ${tint - 12}, ${tint - 34})`;
        ctx.fillRect(x, y, cell, cell);
        ctx.strokeStyle = 'rgba(60,40,26,0.55)';
        ctx.lineWidth = 4;
        ctx.strokeRect(x + 10, y + 10, cell - 20, cell - 20);
        ctx.fillStyle = '#2f4a22';
        ctx.textAlign = 'center';
        ctx.font = `600 30px ${slab}`;
        ctx.fillText(labels.brand.split(' ')[0], x + cell / 2, y + 56);
        ctx.font = `700 40px ${slab}`;
        ctx.fillText(labels.brand.split(' ').slice(1).join(' '), x + cell / 2, y + 100);
        ctx.fillStyle = '#7a2a1e';
        ctx.fillRect(x + 34, y + 118, cell - 68, 5);
        ctx.fillStyle = '#3a3226';
        ctx.font = `600 34px ${slab}`;
        ctx.fillText(v.product, x + cell / 2, y + 168);
        ctx.font = `400 24px ${slab}`;
        ctx.fillText(v.size, x + cell / 2, y + 202);
        ctx.font = `400 19px ${slab}`;
        ctx.fillStyle = '#6b5a44';
        ctx.fillText(`${v.lot}  ·  ${v.year}`, x + cell / 2, y + 232);
      });
      // which face the canvas actually set, so the provenance row can say it rather than guess it
      await document.fonts.ready;
      const usedRockwell = document.fonts.check('600 30px "Rockwell"');
      const jar = { url: jc.toDataURL('image/png'), w: jc.width, h: jc.height, cols, rows: rowsN, usedRockwell };
      return { prompt, jar };
    }, { face: faceForPage(), FACEm: FACE, PROMPT, PROMPT_PX, labels });
  } finally { await browser.close(); }
}

/** A data-URL PNG → the same image flipped bottom-up, as a PNG file (through ffmpeg, already a tool dep). */
function writeFlipped(dataUrl, file) {
  const tmp = file + '.src.png';
  fs.writeFileSync(tmp, Buffer.from(dataUrl.split(',')[1], 'base64'));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', tmp, '-vf', 'vflip', file]);
  fs.rmSync(tmp);
}

const hashOf = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// ── main ────────────────────────────────────────────────────────────────────────────────────────
const faceSrc = fs.readFileSync(path.join(ROOT, 'tools/phosphor-face.mjs'), 'utf8');
const jarLabels = JSON.parse(fs.readFileSync(JAR_DATA, 'utf8')).labels;
const faceHash = hashOf(faceSrc);
const jarHash = hashOf(JSON.stringify({ brand: jarLabels.brand, variants: jarLabels.variants }));

if (args.includes('--check')) {
  const meta = fs.existsSync(META) ? fs.readFileSync(META, 'utf8') : '';
  const stale = [];
  if (!meta.includes(`faceHash: '${faceHash}'`)) stale.push('the face (tools/phosphor-face.mjs) changed since the atlas was baked');
  if (!meta.includes(`jarHash: '${jarHash}'`)) stale.push('the jar label data (jar-contents.json) changed since the label sheet was baked');
  for (const f of ['phosphor-sdf.ktx2', 'zoom-labels.ktx2', 'jar-labels.ktx2']) if (!fs.existsSync(path.join(OUT_DIR, f))) stale.push(`missing ${f}`);
  if (stale.length) { console.log('text bake STALE:\n  ' + stale.join('\n  ') + '\n  re-run: node tools/bake-text.mjs'); process.exit(1); }
  console.log('text bake current (face ' + faceHash + ', jar labels ' + jarHash + ')');
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const work = fs.mkdtempSync(path.join(ROOT, '.work-text-'));
try {
  const atlas = bakeAtlas();
  const rgb = new Uint8Array(atlas.W * atlas.H * 3);
  for (let i = 0; i < atlas.img.length; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = atlas.img[i];
  writePng(path.join(work, 'sdf.png'), atlas.W, atlas.H, 3, rgb);
  encodeUastc(path.join(work, 'sdf.png'), path.join(OUT_DIR, 'phosphor-sdf.ktx2'), 'R8G8B8_UNORM', 'linear');

  if (flag('--preview')) {
    // a proof sheet: every glyph, thresholded at the body weight, top-down for a human
    const pv = new Uint8Array(atlas.W * atlas.H);
    for (let y = 0; y < atlas.H; y++) for (let x = 0; x < atlas.W; x++) {
      const v = atlas.img[(atlas.H - 1 - y) * atlas.W + x];
      const d = (1 - v / 255) * RANGE;
      pv[y * atlas.W + x] = Math.round(255 * Math.max(0, Math.min(1, (0.75 - d) * PX + 0.5)));
    }
    writePng(path.resolve(flag('--preview')), atlas.W, atlas.H, 1, pv);
  }

  const sheets = await drawSheets(jarLabels);
  writeFlipped(sheets.prompt.url, path.join(work, 'zoom.png'));
  encodeUastc(path.join(work, 'zoom.png'), path.join(OUT_DIR, 'zoom-labels.ktx2'), 'R8G8B8A8_SRGB', 'srgb');
  writeFlipped(sheets.jar.url, path.join(work, 'jar.png'));
  encodeUastc(path.join(work, 'jar.png'), path.join(OUT_DIR, 'jar-labels.ktx2'), 'R8G8B8_SRGB', 'srgb');
  if (!sheets.jar.usedRockwell) console.warn('⚠ the jar labels were NOT set in Rockwell on this machine — check the provenance row before shipping');

  // the rects, in the FLIPPED sheet's uv (v up from the bottom), as the lens shader samples them
  const P = sheets.prompt;
  const promptRects = Object.fromEntries(P.rects.map((r) => [r.label, {
    uv: [r.x / P.w, (P.h - (r.y + r.h)) / P.h, r.w / P.w, r.h / P.h].map((v) => +v.toFixed(6)),
    wCss: r.wCss, hCss: r.hCss,
  }]));
  const mono = {}; const prop = {};
  for (const [k, v] of Object.entries(atlas.glyphs)) { if (k.endsWith('\u0000mono')) mono[k.slice(0, -5)] = v; else prop[k] = v; }
  const meta = `// GENERATED by tools/bake-text.mjs — do not edit. Re-bake: node tools/bake-text.mjs
// (TV1, 2026-10-06). What the runtime needs to use the three baked text textures in
// assets/dripping-pickle/text/: the glyph atlas's geometry and per-glyph cells, the ZOOM label rects,
// and the hashes of the inputs, so \`node tools/bake-text.mjs --check\` can say when a bake is stale.
export const TEXT_BAKE = { faceHash: '${faceHash}', jarHash: '${jarHash}' };

/** The glyph atlas (phosphor-sdf.ktx2). Distances to the skeleton, stored as 1 - d / range. */
export const PHOSPHOR = ${JSON.stringify({
    name: FACE.name, atlasW: atlas.W, atlasH: atlas.H, cellW: CELL_W, cellH: CELL_H, pxPerUnit: PX, range: RANGE,
    originX: ORIGIN_X, baseFromBottom: CELL_H - BASE_Y, cap: FACE.cap, xh: FACE.xh, desc: FACE.desc,
    mono: FACE.mono, sans: FACE.sans, glyphs: prop, monoGlyphs: mono,
  })};

/** The ZOOM control's two labels (zoom-labels.ktx2): uv = [u0, v0, du, dv], v up; size in CSS px at dpr 1. */
export const PROMPT_LABELS = ${JSON.stringify(promptRects)};

/** The jar label sheet (jar-labels.ktx2): the conveyor's cell grid, unchanged from the canvas it replaces. */
export const JAR_LABELS = { cols: ${sheets.jar.cols}, rows: ${sheets.jar.rows}, count: ${jarLabels.variants.length} };
`;
  fs.writeFileSync(META, meta);
  for (const f of ['phosphor-sdf.ktx2', 'zoom-labels.ktx2', 'jar-labels.ktx2']) {
    console.log(`${f}: ${fs.statSync(path.join(OUT_DIR, f)).size} B`);
  }
  console.log(`atlas ${atlas.W}x${atlas.H}, ${Object.keys(atlas.glyphs).length} entries · zoom sheet ${P.w}x${P.h} · jar sheet ${sheets.jar.w}x${sheets.jar.h} (Rockwell: ${sheets.jar.usedRockwell})`);
  console.log(`face ${faceHash} · jar labels ${jarHash} → ${path.relative(ROOT, META)}`);
} finally { fs.rmSync(work, { recursive: true, force: true }); }
