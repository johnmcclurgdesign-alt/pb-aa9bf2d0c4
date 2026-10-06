#!/usr/bin/env node
/**
 * glb-ktx2 — cook every texture in a glb (or one loose .ktx2) to the KTX2 the faces can decode.
 *
 *   node tools/glb-ktx2.mjs in.glb out.glb [--max N] [--keep-material "<name>" ...]   # → Basis UASTC + zstd
 *   node tools/glb-ktx2.mjs in.glb out.glb --target etc2                              # → ETC2/EAC, scheme 0 (Apple TV)
 *   node tools/glb-ktx2.mjs in.ktx2 out.ktx2 [--target etc2]                          # a loose texture, same rules
 *   node tools/glb-ktx2.mjs --selftest                                                # the decode check, watched failing
 *   [--worst N] prints the N lowest-PSNR textures; [--decode-tolerance L] [--psnr-floor dB] override the gate
 *
 * ★ THIS WAS glb-astc.mjs, AND THE COOK IT WROTE IS REFUSED (TEX1, 2026-09-23). BUD1 cooked every
 *   texture to hard ASTC 6x6 at supercompressionScheme 0, reading tvOS's "no WebAssembly" as ruling
 *   Basis out everywhere. The Mac face that SHIPS (Designed for iPad) has no
 *   WEBGL_compressed_texture_astc: its 1,808 uploads were refused silently and the Outpost drew
 *   UNLIT there (#145). Since loops-docs 2026-09-18 the intake refuses any ASTC vkFormat, per image.
 *   The contract now (loops-docs 30-engines/web/10-conditioning-assets.md §3, "KTX2 formats and the
 *   faces"):
 *     - iPhone, iPad, the Mac and the web: Basis Universal. It transcodes at load to what the live
 *       context has — ASTC 4x4 on iOS, ETC on the Mac face, BC7 on a desktop.
 *     - Apple TV: ETC2/EAC at supercompressionScheme 0 — the binding has no transcoder. That is a
 *       SEPARATE cook (`-tvos-` zip, loops-docs 40-delivery §1a), made from the UASTC files.
 *
 * ★ UASTC, NOT ETC1S — MEASURED. Four shipped textures, PSNR against the shipped decode:
 *   UASTC 44.2–57.4 dB, ETC1S 31.9–42.7. ETC1S's 31.9 on the brick base colour is a visible loss.
 *   zstd is lossless over UASTC (identical PSNR) and takes a 768² diffuse 786,944 → 70,613 bytes.
 *
 * ★ AN ASTC INPUT IS DECODED, THEN RE-ENCODED (Josh, TEX1's interview: "today's shipped textures").
 *   `ktx extract --level 0` gives back exactly the pixels the shipped cook draws, and the UASTC is
 *   encoded from those — so geometry, names, the phone cut and the GI stay byte-identical and "the
 *   picture unchanged" is measured against what shipped. Mips are regenerated from level 0.
 *
 * ★ COLOUR SPACE COMES FROM THE glTF SLOT, NOT THE IMAGE. Base colour and emissive are sRGB; normal,
 *   metallic-roughness and occlusion are linear. For an ASTC input the slot must AGREE with the
 *   file's own SRGB/UNORM variant, and a disagreement is refused: one of the two is wrong and
 *   somebody has to look. A loose .ktx2 has no slot, so its own variant decides.
 *
 * ★ THE DECODE CHECK RUNS ON EVERY TEXTURE AND IS A GATE (exit 5). A transfer-function fault passes
 *   every numeric check — format, scheme, mips, the stored transfer tag, even PSNR — and moves a flat
 *   normal's means 128,127 → 55,54 (docs/lessons/a-transfer-function-fault-passes-every-numeric-check.md).
 *   So each output is decoded back (UASTC through `ktx extract`; ETC2 through tools/etc2-decode.mjs,
 *   because `ktx extract` cannot decode ETC2) and its channel means compared to what went in,
 *   tolerance 2.0/255. PSNR is printed beside it and floored, so a wholesale-broken encode also stops.
 *   `--selftest` plants the `--assign-tf` omission and must see the check fail on both targets.
 *
 * ★ `--max N` CAPS THE LONG EDGE OF A PNG/JPEG INPUT, AND IT IS NOT OPTIONAL ON A BLENDER EXPORT.
 *   The glb out of Blender carries SOURCE-resolution textures; without the cap the cook landed at
 *   547 MB instead of 76 with every check green. Shipped caps: props 768, structure 1024. An ASTC
 *   input is never resized — it is already the shipped size.
 *
 * ★ `--keep-material "<name>"` LEAVES ONE MATERIAL'S BASE COLOUR A PNG — for anything that reads a
 *   texture's pixels (a compressed texture has no bitmap). NOTHING NEEDS IT SINCE TV1 (2026-10-06):
 *   the chalkboard, the one reader, draws in GL now, and props.glb carries zero PNGs. Kept as a flag
 *   so the next reader is a decision, not a broken room (docs/lessons/the-props-cook-keeps-one-material-uncompressed.md).
 *
 * ★ EVERY SIDE IS ROUNDED TO A MULTIPLE OF 4 — see the comment at the resize below. Five textures
 *   here were not (495x768, 593x768, 768x501, 768x430, 1024x575) and the BC faces dropped four.
 *
 * Requires `ktx` (KTX-Software 4.4.2) and `ffmpeg` on PATH.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeEtc2Ktx2 } from './etc2-decode.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const TARGET = opt('target', 'uastc');                     // uastc | etc2
const MAX = Number(opt('max', '0')) || 0;
const ZSTD = opt('zstd', '18');
const UASTC_QUALITY = opt('uastc-quality', '2');
// ★ THE TOLERANCE IS PER TARGET, AND BOTH SIT FAR BELOW THE FAULT'S SIGNATURE (a 73-level move).
//   UASTC: ±2/255 — measured worst 0.49 over 183 textures. ETC2: ±10 — the UASTC→ETC1 transcode
//   (`ktx transcode --target etc-rgb` is ETC1-mode blocks) cannot hold independent extremes in one
//   block, so a packed metallic-roughness map at (254, 114, 5) decodes near (248, 115, 12): measured
//   worst 9.6 on props, 7.52 on structure, 0.27 on the mural AO — compression, not a transfer
//   function, which leaves mid-tones where they were. The PSNR floor is a gate for UASTC (≥ 30,
//   measured min 32.4) and only a scrambled-decode floor for ETC2 (≥ 15, measured min 18.8):
//   ETC2's quality is printed for the television's own device leg to judge (TV2), not gated here.
const MEAN_TOLERANCE = Number(opt('decode-tolerance', TARGET === 'etc2' ? '10' : '2.0'));
const PSNR_FLOOR = Number(opt('psnr-floor', TARGET === 'etc2' ? '15' : '30'));
const WORST = Number(opt('worst', '0'));                   // print the N lowest-PSNR textures
const KEEP_MATERIALS = args.reduce((acc, a, i) => (a === '--keep-material' ? [...acc, args[i + 1]] : acc), []);
// ⚠ For --selftest only: encode WITHOUT --assign-tf, the fault the decode check exists to catch.
let PLANT_OMIT_TF = false;

const ASTC = (vk) => vk >= 157 && vk <= 184;
const ETC2 = (vk) => vk >= 147 && vk <= 156;
const header = (b) => { const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { vk: d.getUint32(12, true), w: d.getUint32(20, true), h: d.getUint32(24, true),
           levels: d.getUint32(40, true), scheme: d.getUint32(44, true), dfd: d.getUint32(48, true) }; };
/** DFD basic block: colour model (166 UASTC, 163 ETC1S), transfer (1 linear, 2 sRGB), sample 0's channel. */
function dfd(b) {
  const o = header(b).dfd;
  return { model: b[o + 12], transfer: b[o + 14], channel0: b[o + 4 + 24 + 3] & 0x0f };
}
const tfOfKtx2 = (b) => { const h = header(b);
  if (ASTC(h.vk)) return h.vk % 2 === 0 ? 'srgb' : 'linear';   // 157 UNORM, 158 SRGB, … 165/166 6x6
  return dfd(b).transfer === 2 ? 'srgb' : 'linear'; };

/** RGBA8 of a PNG/JPEG file, via ffmpeg, plus its size. */
function rgbaOf(file) {
  const [width, height] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number);
  const rgba = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 30 });
  return { width, height, rgba: new Uint8Array(rgba) };
}
/** Level 0 of any KTX2 this tool writes or reads → RGBA8 (stored values, as `ktx extract` gives them). */
function decodeKtx2(bytes, dir) {
  if (ETC2(header(bytes).vk)) return decodeEtc2Ktx2(bytes);
  const f = join(dir, 'dec.ktx2'), p = join(dir, 'dec.png');
  writeFileSync(f, bytes);
  execFileSync('ktx', ['extract', '--level', '0', f, p], { stdio: ['ignore', 'ignore', 'pipe'] });
  const out = rgbaOf(p);
  rmSync(f, { force: true }); rmSync(p, { force: true });
  return out;
}
/** Channel means and PSNR (RGB) of a decode against what went in. */
function compare(src, dec) {
  if (src.width !== dec.width || src.height !== dec.height) {
    return { source: [src.width, src.height], decoded: [dec.width, dec.height], delta: [99, 99, 99], worst: 99, psnr: 0 };
  }
  const n = src.width * src.height, s = [0, 0, 0], d = [0, 0, 0];
  let se = 0;
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
    const a = src.rgba[i * 4 + c], b = dec.rgba[i * 4 + c];
    s[c] += a; d[c] += b; se += (a - b) * (a - b);
  }
  const sm = s.map((v) => +(v / n).toFixed(2)), dm = d.map((v) => +(v / n).toFixed(2));
  const delta = dm.map((v, i) => +(v - sm[i]).toFixed(2));
  const mse = se / (3 * n);
  return { source: sm, decoded: dm, delta, worst: Math.max(...delta.map(Math.abs)), psnr: mse ? 10 * Math.log10(65025 / mse) : 99 };
}
const hasAlpha = (img) => { for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] !== 255) return true; return false; };

/** PNG/JPEG file → UASTC + zstd KTX2 bytes. RGB unless the image really uses its alpha. */
function encodeUastc(srcFile, tf, alpha, resize, dir) {
  const dst = join(dir, 'enc.ktx2');
  const fmt = `R8G8B8${alpha ? 'A8' : ''}_${tf === 'srgb' ? 'SRGB' : 'UNORM'}`;
  execFileSync('ktx', ['create', '--format', fmt, ...(PLANT_OMIT_TF ? [] : ['--assign-tf', tf]),
    '--generate-mipmap', '--encode', 'uastc', '--uastc-quality', UASTC_QUALITY, '--zstd', ZSTD,
    ...resize, srcFile, dst], { stdio: ['ignore', 'ignore', 'pipe'] });
  const out = new Uint8Array(readFileSync(dst)); rmSync(dst, { force: true });
  return out;
}
/** UASTC KTX2 bytes → ETC2/EAC, scheme 0: RGB8 (0.5 B/texel) unless the UASTC carries alpha (RGBA8, 1). */
function transcodeEtc2(bytes, dir) {
  const d = dfd(bytes);
  if (d.model !== 166) throw new Error(`--target etc2 needs a UASTC input (DFD colour model ${d.model})`);
  const alpha = d.channel0 === 3;                           // KHR_DF_CHANNEL_UASTC_RGBA
  const f = join(dir, 'in.ktx2'), o = join(dir, 'etc.ktx2');
  writeFileSync(f, bytes);
  // --testrun: deterministic output, so the TV cook built at package time is reproducible.
  execFileSync('ktx', ['transcode', '--testrun', '--target', alpha ? 'etc-rgba' : 'etc-rgb', f, o], { stdio: ['ignore', 'ignore', 'pipe'] });
  const out = new Uint8Array(readFileSync(o));
  rmSync(f, { force: true }); rmSync(o, { force: true });
  return out;
}

/**
 * Cook one image. `bytes` is what the glb/file holds now; `slotTf` is the transfer the glTF slot
 * wants (null for a loose file or a two-slot texture). Returns { bytes, row }, or null to skip.
 */
function cookOne(name, mime, bytes, slotTf, dir) {
  const row = { name, from: '', to: '', tf: '', bytesIn: bytes.length, bytesOut: 0 };
  if (TARGET === 'uastc') {
    let src, resize = [], tf = slotTf;
    if (mime === 'image/ktx2') {
      const h = header(bytes);
      if (h.vk === 0) return null;                          // already Basis
      if (!ASTC(h.vk)) throw new Error(`${name}: vkFormat ${h.vk} is neither ASTC nor Basis — refusing to guess`);
      const fileTf = tfOfKtx2(bytes);
      if (tf && tf !== fileTf) throw new Error(`${name}: the glTF slot wants ${tf} and the shipped file is ${fileTf} — one of them is wrong`);
      tf = fileTf;
      const k = join(dir, 'astc.ktx2'); src = join(dir, 'src.png');
      writeFileSync(k, bytes);
      execFileSync('ktx', ['extract', '--level', '0', k, src], { stdio: ['ignore', 'ignore', 'pipe'] });
      rmSync(k, { force: true });
      row.from = `ASTC vk${h.vk}`;
    } else if (mime === 'image/png' || mime === 'image/jpeg') {
      src = join(dir, mime === 'image/png' ? 'src.png' : 'src.jpg');
      writeFileSync(src, bytes);
      tf = tf || 'srgb';
      row.from = mime;
    } else {
      throw new Error(`${name} is ${mime}. ktx create reads PNG/JPEG only — run \`gltf-transform png --formats "*"\` first (condition-glb.sh does).`);
    }
    const srcImg = rgbaOf(src);
    let w = srcImg.width, h = srcImg.height;
    if (MAX && mime !== 'image/ktx2' && Math.max(w, h) > MAX) {
      const k = MAX / Math.max(w, h);
      w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
    }
    // ★ BOTH SIDES A MULTIPLE OF 4, OR THE BC FACES DROP THE TEXTURE. UASTC transcodes to BC7 on a
    //   desktop (and on any Mac face that exposes BPTC), and WebGL refuses texStorage2D for a BC base
    //   level whose sides are not multiples of 4 — measured TEX1: the rug's 495x768 and three others
    //   failed, 41 sub-uploads followed into levels that never existed, and the rug vanished with
    //   every numeric check green. ASTC 6x6 had hidden it (ASTC takes any size). Rounding moves a
    //   side by at most 2 px; the UVs are unaffected.
    const r4 = (v) => Math.max(4, Math.round(v / 4) * 4);
    if (w % 4 || h % 4) { w = r4(w); h = r4(h); row.rounded = `${srcImg.width}x${srcImg.height} → ${w}x${h}`; }
    if (w !== srcImg.width || h !== srcImg.height) resize = ['--width', String(w), '--height', String(h)];
    const alpha = hasAlpha(srcImg);
    const out = encodeUastc(src, tf, alpha, resize, dir);
    // A resized encode is compared with the source resized the same way.
    let ref = srcImg;
    if (resize.length) {
      const r = join(dir, 'ref.png');
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vf', `scale=${resize[1]}:${resize[3]}:flags=lanczos`, r]);
      ref = rgbaOf(r); rmSync(r, { force: true });
    }
    Object.assign(row, { to: `UASTC${alpha ? ' RGBA' : ''} zstd${ZSTD}`, tf, bytesOut: out.length,
                         check: compare(ref, decodeKtx2(out, dir)) });
    rmSync(src, { force: true });
    return { bytes: out, row };
  }
  // TARGET === 'etc2'
  if (mime !== 'image/ktx2') return null;                  // a kept PNG stays a PNG
  const h = header(bytes);
  if (ETC2(h.vk) && h.scheme === 0) return null;
  if (h.vk !== 0) throw new Error(`${name}: --target etc2 cooks from UASTC; this is vkFormat ${h.vk}`);
  const tf = tfOfKtx2(bytes);
  if (slotTf && slotTf !== tf) throw new Error(`${name}: the glTF slot wants ${slotTf} and the UASTC file is ${tf}`);
  const srcImg = decodeKtx2(bytes, dir);
  const out = transcodeEtc2(bytes, dir);
  const oh = header(out);
  if (!ETC2(oh.vk) || oh.scheme !== 0) throw new Error(`${name}: transcode wrote vkFormat ${oh.vk} scheme ${oh.scheme}`);
  const dec = decodeKtx2(out, dir);
  Object.assign(row, { from: 'UASTC', to: `ETC2 vk${oh.vk}`, tf, bytesOut: out.length, check: compare(srcImg, dec), modes: dec.modes });
  return { bytes: out, row };
}

function report(rows) {
  const bad = rows.filter((r) => r.check.worst > MEAN_TOLERANCE || r.check.psnr < PSNR_FLOOR);
  const ps = rows.map((r) => r.check.psnr).sort((a, b) => a - b);
  const worst = [...rows].sort((a, b) => b.check.worst - a.check.worst)[0];
  const modes = rows.reduce((m, r) => { for (const [k, v] of Object.entries(r.modes || {})) m[k] = (m[k] || 0) + v; return m; }, {});
  const tfs = rows.reduce((m, r) => { m[r.tf] = (m[r.tf] || 0) + 1; return m; }, {});
  console.log(`\ndecode check — every texture decoded back and compared to what went in (means ±${MEAN_TOLERANCE}/255, PSNR ≥ ${PSNR_FLOOR} dB):`);
  console.log(`  ${rows.length} textures (${Object.entries(tfs).map(([k, v]) => `${v} ${k}`).join(', ')}) · PSNR min ${ps[0].toFixed(2)} · median ${ps[ps.length >> 1].toFixed(2)} dB · worst mean shift ${worst.check.worst} (${worst.name})`);
  if (Object.keys(modes).length) {
    console.log(`  ETC2 blocks by mode: ${JSON.stringify(modes)}`);
    if (modes.T || modes.H || modes.planar) console.log('  ⚠ T/H/planar blocks present — tools/etc2-decode.mjs has not been verified on those paths');
  }
  for (const r of rows.filter((x) => x.rounded)) console.log(`  rounded to a multiple of 4: ${r.name} ${r.rounded}`);
  for (const r of [...rows].sort((a, b) => a.check.psnr - b.check.psnr).slice(0, WORST)) console.log(`  [low] ${r.tf.padEnd(6)} ${r.check.psnr.toFixed(2)} dB shift ${r.check.worst}  ${r.name}`);
  for (const r of bad) {
    console.log(`  [FAIL] ${r.tf.padEnd(6)} ${r.name}: source ${r.check.source} decoded ${r.check.decoded} delta ${r.check.delta} psnr ${r.check.psnr.toFixed(2)}`);
  }
  return bad;
}

async function cookGlb(IN, OUT) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
  const doc = await io.read(IN);
  const root = doc.getRoot();
  const srgb = new Set(), linear = new Set();
  for (const m of root.listMaterials()) {
    [m.getBaseColorTexture(), m.getEmissiveTexture()].forEach((t) => t && srgb.add(t));
    [m.getNormalTexture(), m.getMetallicRoughnessTexture(), m.getOcclusionTexture()].forEach((t) => t && linear.add(t));
  }
  const both = [...srgb].filter((t) => linear.has(t));
  if (both.length) {
    console.log(`⚠ ${both.length} texture(s) are used as BOTH colour and data; the file's own variant decides:`);
    both.forEach((t) => console.log(`    ${t.getName() || '(unnamed)'}`));
  }
  const keep = new Set();
  for (const name of KEEP_MATERIALS) {
    const mats = root.listMaterials().filter((m) => m.getName() === name);
    if (!mats.length) { console.error(`glb-ktx2: --keep-material "${name}" matches no material in this glb — refusing.`); process.exit(5); }
    for (const m of mats) { const t = m.getBaseColorTexture(); if (t) keep.add(t); }
  }
  const tmp = mkdtempSync(join(tmpdir(), 'glb-ktx2-'));
  const rows = [];
  let skipped = 0, kept = 0;
  try {
    for (const tex of root.listTextures()) {
      const img = tex.getImage();
      if (!img) { skipped++; continue; }
      if (keep.has(tex)) { kept++; continue; }
      const slotTf = both.includes(tex) ? null : srgb.has(tex) ? 'srgb' : linear.has(tex) ? 'linear' : null;
      const res = cookOne(tex.getName() || '(unnamed)', tex.getMimeType(), new Uint8Array(img), slotTf, tmp);
      if (!res) { skipped++; continue; }
      tex.setImage(res.bytes).setMimeType('image/ktx2');
      rows.push(res.row);
      if (process.stdout.isTTY) process.stdout.write(`\r  ${rows.length} cooked`);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  if (rows.length) doc.createExtension(KHRTextureBasisu).setRequired(true);
  await io.write(OUT, doc);

  // ⚠ ASSERT THE OUTPUT, read back from disk: every failure in this pipeline exits 0 and writes a file.
  const check = await io.read(OUT);
  const keptNames = new Set([...keep].map((t) => t.getName()));
  const wrong = [];
  for (const t of check.getRoot().listTextures()) {
    if (!t.getImage() || keptNames.has(t.getName())) continue;
    const b = t.getImage();
    // The TV pass transcodes what the UASTC pass cooked; a PNG the UASTC pass kept stays a PNG.
    if (TARGET === 'etc2' && t.getMimeType() !== 'image/ktx2') continue;
    if (t.getMimeType() !== 'image/ktx2') { wrong.push(`${t.getName()} is ${t.getMimeType()}`); continue; }
    const h = header(b);
    if (TARGET === 'uastc' && !(h.vk === 0 && dfd(b).model === 166)) wrong.push(`${t.getName()} is vkFormat ${h.vk}, not UASTC`);
    if (TARGET === 'etc2' && !(ETC2(h.vk) && h.scheme === 0)) wrong.push(`${t.getName()} is vkFormat ${h.vk} scheme ${h.scheme}, not ETC2 scheme 0`);
  }
  if (wrong.length) { console.error(`\nFAILED: ${wrong.length} texture(s) are not the target — first: ${wrong[0]}`); process.exit(4); }
  return { rows, skipped, kept };
}

async function cookLoose(IN, OUT) {
  const tmp = mkdtempSync(join(tmpdir(), 'glb-ktx2-'));
  try {
    const res = cookOne(IN, 'image/ktx2', new Uint8Array(readFileSync(IN)), null, tmp);
    if (!res) { console.log(`${IN}: already the target, copied`); writeFileSync(OUT, readFileSync(IN)); return { rows: [], skipped: 1, kept: 0 }; }
    writeFileSync(OUT, res.bytes);
    return { rows: [res.row], skipped: 0, kept: 0 };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ── --selftest: the decode check must FAIL on a planted --assign-tf omission, on both targets ──
async function selftest() {
  const dir = mkdtempSync(join(tmpdir(), 'glb-ktx2-selftest-'));
  const results = [];
  const expect = (label, ok) => { results.push(ok); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`); };
  try {
    // A flat normal (0x8080FF — the value Vibes' curtain map had) and an sRGB colour with alpha 192.
    const nrm = join(dir, 'nrm.png'), rgba = join(dir, 'rgba.png');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x8080FF:s=64x64', '-frames:v', '1', nrm]);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x9A6B3CC0:s=64x64,format=rgba', '-frames:v', '1', '-pix_fmt', 'rgba', rgba]);
    const original = rgbaOf(nrm);
    const pair = (plant) => {
      PLANT_OMIT_TF = plant;
      const u = cookOne('flat-normal', 'image/png', new Uint8Array(readFileSync(nrm)), 'linear', dir);
      PLANT_OMIT_TF = false;
      // End to end: the TV's ETC2, made from that UASTC, against the ORIGINAL source.
      return { u: u.row.check, e: compare(original, decodeKtx2(transcodeEtc2(u.bytes, dir), dir)) };
    };
    const good = pair(false), bad = pair(true);
    expect(`UASTC, --assign-tf linear: decoded ${good.u.decoded} (shift ${good.u.worst}) passes`, good.u.worst <= MEAN_TOLERANCE);
    expect(`UASTC, --assign-tf OMITTED: decoded ${bad.u.decoded} (shift ${bad.u.worst}) is caught`, bad.u.worst > MEAN_TOLERANCE);
    // The ETC2 half is judged at the ETC2 target's own, wider tolerance — the fault must clear it too.
    const ETC2_TOL = Number(opt('decode-tolerance', '10'));
    expect(`ETC2 from the good UASTC vs the original: decoded ${good.e.decoded} (shift ${good.e.worst}) passes at ±${ETC2_TOL}`, good.e.worst <= ETC2_TOL);
    expect(`ETC2 from the planted UASTC vs the original: decoded ${bad.e.decoded} (shift ${bad.e.worst}) is caught at ±${ETC2_TOL}`, bad.e.worst > ETC2_TOL);
    // Alpha survives both hops (UASTC RGBA → ETC2 RGBA8/EAC), and an sRGB texture keeps its means.
    const a = cookOne('rgba', 'image/png', new Uint8Array(readFileSync(rgba)), 'srgb', dir);
    const aEtc = transcodeEtc2(a.bytes, dir), aDec = decodeKtx2(aEtc, dir);
    let aSum = 0; for (let i = 3; i < aDec.rgba.length; i += 4) aSum += aDec.rgba[i];
    const aMean = aSum / (aDec.width * aDec.height);
    expect(`UASTC RGBA sRGB shift ${a.row.check.worst}; ETC2 vk${header(aEtc).vk}, alpha mean ${aMean.toFixed(1)} (source 192)`,
      a.row.check.worst <= MEAN_TOLERANCE && header(aEtc).vk === 152 && Math.abs(aMean - 192) <= 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const failed = results.filter((ok) => !ok).length;
  console.log(failed ? `\nSELFTEST FAILED: ${failed} of ${results.length}` : `\nSELFTEST PASS: ${results.length} checks — the omission is caught on both targets`);
  process.exit(failed ? 1 : 0);
}

if (args.includes('--selftest')) {
  await selftest();
} else {
  const IN = args[0], OUT = args[1];
  if (!IN || !OUT || IN.startsWith('--')) {
    console.error('usage: glb-ktx2.mjs <in.glb|in.ktx2> <out> [--target uastc|etc2] [--max N] [--keep-material "<name>"] | --selftest');
    process.exit(2);
  }
  if (!['uastc', 'etc2'].includes(TARGET)) { console.error(`glb-ktx2: --target ${TARGET}? uastc or etc2`); process.exit(2); }
  const { rows, skipped, kept } = IN.endsWith('.ktx2') ? await cookLoose(IN, OUT) : await cookGlb(IN, OUT);
  const bad = rows.length ? report(rows) : [];
  const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
  console.log(`\nglb-ktx2 → ${TARGET}: ${rows.length} cooked, ${kept} kept uncompressed, ${skipped} skipped · images ${mb(rows.reduce((s, r) => s + r.bytesIn, 0))} → ${mb(rows.reduce((s, r) => s + r.bytesOut, 0))}`);
  if (bad.length) {
    console.error(`\nFAILED: ${bad.length} texture(s) decode to different pixels than went in. A mean that moves is a transfer-function mistake, not compression loss (loops-docs web §6).`);
    process.exit(5);
  }
}
