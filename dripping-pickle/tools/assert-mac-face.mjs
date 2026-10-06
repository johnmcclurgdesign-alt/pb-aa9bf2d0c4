#!/usr/bin/env node
/**
 * assert-mac-face — does the Loop draw LIT on a face with no ASTC? The Mac face that ships.
 *
 *   node tools/assert-mac-face.mjs [--url http://127.0.0.1:5181/]   # default: spawns the dev server
 *   node tools/assert-mac-face.mjs --url http://127.0.0.1:5182/      # the pre-TEX1 tree: must go RED
 *
 * WHY (TEX1, 2026-09-23, #145). The Mac face a viewer sees — Designed for iPad — exposes 33 WebGL
 * extensions to native macOS's 36, and the missing three are WEBGL_compressed_texture_astc and the
 * two PVRTC names (loops-docs 30-engines/web/10-conditioning-assets.md §3). This Loop cooked every
 * texture to hard ASTC, so on that face all 1,808 uploads were refused and the Outpost drew UNLIT —
 * and NO instrument on either side saw it: the pane, the budget rig and the app program's own Mac
 * checks all run on faces that HAVE ASTC. `renderer.info.memory.textures` read healthy throughout,
 * because it counts Texture objects, not landed uploads. The refusal is a console.warn, and the
 * picture is the only other witness.
 *
 * So this rig removes those extensions BEFORE the page runs (an init script over
 * WebGL2RenderingContext.prototype) and asks the questions that would have caught it:
 *   1. zero "unsupported compressed texture format" warnings — no refused upload;
 *   2. the compressed formats that actually LANDED, counted at texStorage2D — none of them ASTC;
 *   3. the budget rig's pixel floor on the resulting frame: lit %, mean luma.
 * Two cells: `dfi` (ASTC and PVRTC gone, everything else as the host has it) and `etc-only` (only
 * WEBGL_compressed_texture_etc left — the transcoder's last resort, and the Apple TV's family).
 *
 * ⚠ This emulates the capability set, not the face. The real Designed-for-iPad face is a device leg
 *   (TEX1's Mac leg through Xcode). What this rig proves is that nothing in the payload depends on
 *   a family that face lacks.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const url = (() => { const i = args.indexOf('--url'); return i >= 0 ? args[i + 1] : null; })();
const LIT_FLOOR = 45, LUMA_FLOOR = 0.07;   // budgets.json's pixel floor, the same numbers the rig asserts

const CELLS = [
  { name: 'dfi', hide: ['WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_pvrtc', 'WEBKIT_WEBGL_compressed_texture_pvrtc'] },
  { name: 'etc-only', keepOnly: 'WEBGL_compressed_texture_etc' },
];

// Runs in the page before any of its scripts.
function installFace(cell) {
  const P = WebGL2RenderingContext.prototype;
  const compressed = (n) => /compressed_texture|texture_compression/i.test(n);
  const gone = (n) => (cell.hide ? cell.hide.includes(n) : compressed(n) && n !== cell.keepOnly);
  const getExt = P.getExtension, getSup = P.getSupportedExtensions;
  P.getExtension = function (n) { return gone(n) ? null : getExt.call(this, n); };
  P.getSupportedExtensions = function () { return (getSup.call(this) || []).filter((n) => !gone(n)); };
  // What LANDED: three allocates every compressed 2D texture with texStorage2D(internalformat).
  const landed = window.__macFace = { formats: {} };
  const ts = P.texStorage2D;
  P.texStorage2D = function (t, l, fmt, w, h) {
    const k = '0x' + fmt.toString(16).toUpperCase(); landed.formats[k] = (landed.formats[k] || 0) + 1;
    return ts.apply(this, arguments);
  };
}

const NAMES = { '0x93B0': 'ASTC 4x4', '0x93D0': 'ASTC 4x4 sRGB', '0x93B4': 'ASTC 6x6', '0x93D4': 'ASTC 6x6 sRGB',
  '0x8E8C': 'BC7', '0x8E8D': 'BC7 sRGB', '0x83F0': 'BC1', '0x83F3': 'BC3', '0x8C4C': 'BC1 sRGB', '0x8C4F': 'BC3 sRGB',
  '0x9274': 'ETC2 RGB8', '0x9275': 'ETC2 sRGB8', '0x9278': 'ETC2 RGBA8', '0x9279': 'ETC2 sRGB8 A8', '0x8D64': 'ETC1' };
const isAstc = (k) => /^0x93[BD]/.test(k);

async function runCell(browser, origin, cell) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const warnings = [], errors = [];
  page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(installFace, cell);
  await page.goto(origin + 'loops/dripping-pickle/?budget=1', { waitUntil: 'domcontentloaded' });
  // The rig arms once the room is built; autorun() counts frames, so it self-synchronises.
  const armed = await page.waitForFunction(() => !!window.__budget, null, { timeout: 120000 }).then(() => true, () => false);
  let result = null;
  if (armed) {
    await page.waitForTimeout(4000);
    await page.evaluate(() => window.__budget.autorun());
    result = await page.waitForFunction(() => window.__budget.result, null, { timeout: 120000 }).then((h) => h.jsonValue(), () => null);
  }
  const face = await page.evaluate(() => window.__macFace).catch(() => null);
  await page.close();
  const floor = result?.checks.find((c) => c.name === 'pixel colour floor');
  const m = /([\d.]+)% of the frame above luma [\d.]+, mean luma ([\d.]+)/.exec(floor?.detail || '');
  const lit = m ? Number(m[1]) : NaN, luma = m ? Number(m[2]) : NaN;
  const refused = warnings.filter((w) => /unsupported compressed texture format/i.test(w)).length;
  // ⚠ A LANDED format can still fail to upload. BC7/S3TC refuse a base level whose sides are not
  //   multiples of 4 (measured TEX1: 4 textures, then 41 sub-uploads into levels that never existed —
  //   the rug vanished). Chromium reports it only as a console warning, so count those too.
  const glErrors = warnings.filter((w) => /GL_INVALID|GL_OUT_OF/i.test(w));
  const formats = Object.entries(face?.formats || {}).map(([k, n]) => `${NAMES[k] || k} ×${n}`).join(', ') || 'none';
  const astcLanded = Object.keys(face?.formats || {}).some(isAstc);
  const checks = [
    [`${cell.name}: the budget rig ran`, !!result, result ? 'autorun() returned' : 'no result within 120 s'],
    [`${cell.name}: zero refused uploads`, refused === 0, `${refused} "unsupported compressed texture format" warning(s)`],
    [`${cell.name}: no ASTC landed`, !astcLanded, formats],
    [`${cell.name}: zero GL errors`, glErrors.length === 0, glErrors.length ? `${glErrors.length}: ${glErrors[0].slice(0, 160)}` : 'none'],
    [`${cell.name}: the room is LIT`, lit >= LIT_FLOOR && luma >= LUMA_FLOOR, `${lit}% lit, mean luma ${luma} (floor ${LIT_FLOOR}% / ${LUMA_FLOOR})`],
    [`${cell.name}: zero page errors`, errors.length === 0, errors[0]?.split('\n')[0].slice(0, 160) || 'none'],
  ];
  for (const [label, ok, detail] of checks) console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label} — ${detail}`);
  return checks.every(([, ok]) => ok);
}

async function withServer(fn) {
  if (url) return fn(url.replace(/\/?$/, '/'));
  const port = 5300 + Math.floor(Math.random() * 400);
  const server = spawn(process.execPath, [path.join(ROOT, 'tools/dev-server.mjs'), String(port)], { cwd: ROOT, stdio: 'ignore' });
  const origin = `http://127.0.0.1:${port}/`;
  for (let t = Date.now(); Date.now() - t < 15000;) {
    try { if ((await fetch(origin + 'budgets.json')).ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  try { return await fn(origin); } finally { server.kill(); }
}

const ok = await withServer(async (origin) => {
  console.log(`assert-mac-face — ${origin}`);
  // Same GPU path the tvOS shape rig uses on this Mac.
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
  try {
    let all = true;
    for (const cell of CELLS) all = (await runCell(browser, origin, cell)) && all;
    return all;
  } finally { await browser.close(); }
});
console.log(ok ? '\nPASS — the room draws lit with no ASTC on the face' : '\nFAIL — see above');
process.exit(ok ? 0 : 1);
