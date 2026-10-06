// Re-encode every embedded texture in a .glb to WebP, in place in the container.
//
//   node tools/glb-webp.mjs assets/factory/factory.glb [out.glb] [--quality 85]
//
// WHY. Textures are two thirds of this file, and the set is a mixture of PNG and JPEG that
// came from different source packs and was never normalised. Measured on factory.glb: the
// single largest asset was a 2K base colour stored as PNG at 6.50 MB, and a 1K texture with
// alpha cost 2.02 MB for the same reason. WebP carries alpha, so nothing has to stay PNG to
// keep a cut-out, and the whole file drops from 52.9 MB to ~34.6 MB with no change in
// resolution and nothing re-sampled.
//
// ★ THE ENCODING IS DONE HERE, NOT IN BLENDER, AND THAT IS NOT A STYLE CHOICE.
// Blender's exporter writes LINEAR values into an sRGB-tagged file for both JPEG and WebP,
// so every texture comes back wrong — see the note in CLAUDE.md. The working recipe is to
// encode the bytes yourself and let the exporter pass them through untouched, which is
// exactly what this does: it never decodes or re-encodes anything Blender produced beyond
// the one format conversion, and it does that with ffmpeg rather than the exporter.
//
// ★ REPLACING AN IMAGE IS NOT THE SAME AS DROPPING ONE. Accessors and images share one
// bufferViews list, so removing a view shifts every index after it (that is what
// glb-strip.mjs has to deal with). Here every view keeps its index and only its bytes and
// offsets change — but the BIN chunk still has to be rebuilt end to end, because the new
// image payloads are a different length and everything downstream of them moves.

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

const args = process.argv.slice(2);
const IN = args[0];
const OUT = args[1] && !args[1].startsWith('--') ? args[1] : IN.replace(/\.glb$/, '.webp.glb');
const qi = args.indexOf('--quality');
const QUALITY = qi >= 0 ? args[qi + 1] : '85';
// ★ RESOLUTION IS THE BIGGER LEVER THAN QUALITY ON A PROP SET. Sixty-nine props
// arrived carrying 221 textures, nearly all 2K, on objects that are centimetres
// wide in frame — a 0.11 m paint can does not deserve 4 megapixels. Capping the
// long edge costs nothing visible at these screen sizes and is worth more than
// any quality setting. Downscale happens BEFORE the webp encode, in the same
// ffmpeg invocation, so nothing is decoded twice. Omit to leave sizes alone.
const mi = args.indexOf('--max');
const MAXPX = mi >= 0 ? parseInt(args[mi + 1], 10) : 0;
if (!IN) { console.error('usage: node tools/glb-webp.mjs in.glb [out.glb] [--quality 85] [--max 1024]'); process.exit(1); }

// ── which encoder ─────────────────────────────────────────────────────────────
// ★ HOMEBREW'S ffmpeg NO LONGER SHIPS libwebp, AND THE FAILURE IS A NODE STACK TRACE.
//   On this machine `ffmpeg 8.1.2_1` is built without it — `-c:v libwebp` dies with
//   "Unknown encoder 'libwebp'" buried in an execFile rejection, which reads as a broken tool
//   rather than a missing codec. So: check up front, and fall back to cwebp, which is the
//   reference encoder for the very library ffmpeg would have wrapped.
//
//   ffmpeg is still PREFERRED when it has libwebp, so a machine that produced the shipped
//   textures keeps producing byte-comparable ones. Bytes will not match across the two paths;
//   that is fine, because they never matched across ffmpeg versions either.
async function pickEncoder() {
  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-encoders']);
    if (/\blibwebp\b/.test(stdout)) return { kind: 'ffmpeg' };
  } catch { /* no ffmpeg at all — fall through to cwebp */ }
  for (const bin of ['/opt/homebrew/bin/cwebp', 'cwebp']) {
    try { await run(bin, ['-version']); return { kind: 'cwebp', bin }; } catch { /* keep looking */ }
  }
  console.error(
    'No WebP encoder found.\n' +
    "  ffmpeg is present but built without libwebp (check: ffmpeg -encoders | grep webp), and\n" +
    '  cwebp is not on PATH. Install either:\n' +
    '    brew install webp            # provides cwebp — smaller, and all this tool needs\n' +
    '    brew reinstall ffmpeg        # only helps if the formula enables libwebp');
  process.exit(3);
}

/** Read w/h from PNG or JPEG bytes — cwebp needs explicit dimensions to downscale. */
function srcSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** Target size under the long-edge cap, preserving aspect and staying even. */
function capped(w, h, cap) {
  if (!cap || Math.max(w, h) <= cap) return null;
  const k = cap / Math.max(w, h);
  const even = (n) => Math.max(2, Math.round(n * k / 2) * 2);
  return [even(w), even(h)];
}

const ENCODER = await pickEncoder();
console.log(`encoder: ${ENCODER.kind}${ENCODER.kind === 'cwebp' ? ` (${ENCODER.bin})` : ''}`);

const MB = (n) => (n / 1048576).toFixed(2) + ' MB';
const align4 = (n) => (n + 3) & ~3;

const src = await readFile(IN);
if (src.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb (bad magic)');

const jsonLen = src.readUInt32LE(12);
const json = JSON.parse(src.slice(20, 20 + jsonLen).toString('utf8'));
const binHeader = 20 + jsonLen;
const binLen = src.readUInt32LE(binHeader);
const binStart = binHeader + 8;
const bin = src.slice(binStart, binStart + binLen);

const views = json.bufferViews || [];
const images = json.images || [];
console.log(`${IN}  ${MB(src.length)}  ${images.length} images, ${views.length} bufferViews`);

// ── encode ────────────────────────────────────────────────────────────────────
const tmp = await mkdtemp(join(tmpdir(), 'glbwebp-'));
const replacement = new Map();          // bufferView index -> new Buffer
let before = 0, after = 0;

try {
  for (const [i, im] of images.entries()) {
    if (im.bufferView === undefined) continue;      // already an external URI; leave it
    const v = views[im.bufferView];
    const bytes = bin.slice(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength);
    const ext = im.mimeType === 'image/png' ? 'png' : 'jpg';
    const fin = join(tmp, `i${i}.${ext}`), fout = join(tmp, `i${i}.webp`);
    await writeFile(fin, bytes);
    // -lossless 0 with a quality target; compression_level 6 is the slow/small end.
    // libwebp keeps the alpha channel, which is the whole reason cut-outs can stop being PNG.
    // scale only when the long edge exceeds the cap; -1 keeps the aspect and
    // rounds to even, which libwebp needs
    if (ENCODER.kind === 'ffmpeg') {
      const scale = MAXPX
        ? ['-vf', `scale='if(gt(max(iw,ih),${MAXPX}),if(gte(iw,ih),${MAXPX},-2),iw)':'if(gt(max(iw,ih),${MAXPX}),if(gte(iw,ih),-2,${MAXPX}),ih)'`]
        : [];
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', fin, ...scale,
                           '-c:v', 'libwebp', '-lossless', '0',
                           '-quality', QUALITY, '-compression_level', '6', fout]);
    } else {
      // cwebp: -q is the same 0..100 quality, -m 6 the same slow/small compression method as
      // ffmpeg's compression_level 6. The resize is computed here rather than by a filter
      // graph, and only when the long edge actually exceeds the cap.
      const wh = srcSize(bytes);
      const target = wh ? capped(wh[0], wh[1], MAXPX) : null;
      if (MAXPX && !wh) console.log(`  note  ${(im.name || i)}  dimensions unreadable — not resized`);
      await run(ENCODER.bin, ['-quiet', '-q', String(QUALITY), '-m', '6',
                              ...(target ? ['-resize', String(target[0]), String(target[1])] : []),
                              fin, '-o', fout]);
    }
    const enc = await readFile(fout);
    before += bytes.length; after += enc.length;
    // Only take it if it actually helps — a small JPEG can beat WebP.
    if (enc.length < bytes.length) {
      replacement.set(im.bufferView, enc);
      im.mimeType = 'image/webp';
    } else {
      after += bytes.length - enc.length;          // we kept the original
      console.log(`  keep  ${(im.name || i)}  webp was larger`);
    }
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

// ── declare the extension ─────────────────────────────────────────────────────
// glTF core only allows PNG and JPEG, so a WebP image has to be reached through
// EXT_texture_webp. With no fallback source it is REQUIRED, not merely used — a viewer
// that does not understand it must refuse the file rather than render it untextured.
const usedWebp = [...replacement.keys()].length > 0;
if (usedWebp) {
  const webpImages = new Set(images.map((im, i) => im.mimeType === 'image/webp' ? i : -1));
  for (const t of json.textures || []) {
    if (t.source === undefined || !webpImages.has(t.source)) continue;
    t.extensions = t.extensions || {};
    t.extensions.EXT_texture_webp = { source: t.source };
    delete t.source;                                  // no fallback: the bytes are gone
  }
  json.extensionsUsed = [...new Set([...(json.extensionsUsed || []), 'EXT_texture_webp'])];
  json.extensionsRequired = [...new Set([...(json.extensionsRequired || []), 'EXT_texture_webp'])];
}

// ── rebuild the BIN ───────────────────────────────────────────────────────────
// Every view is copied in index order with a fresh offset. Nothing is reordered and no
// index changes, so accessors and images still point where they did — but each view's
// byteOffset moves, which is why this cannot be a patch in place.
const parts = [];
let offset = 0;
for (const [i, v] of views.entries()) {
  const bytes = replacement.get(i) ?? bin.slice(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength);
  const pad = align4(offset) - offset;
  if (pad) { parts.push(Buffer.alloc(pad)); offset += pad; }
  v.byteOffset = offset;
  v.byteLength = bytes.length;
  parts.push(bytes);
  offset += bytes.length;
}
const newBin = Buffer.concat(parts);
json.buffers = [{ byteLength: newBin.length }];

// ── write the container ───────────────────────────────────────────────────────
// JSON pads with spaces, BIN pads with zeroes; both chunks must be a multiple of four or
// the file is invalid and most loaders fail with something unhelpful about the header.
let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(align4(jsonBuf.length) - jsonBuf.length, 0x20)]);
const binBuf = Buffer.concat([newBin, Buffer.alloc(align4(newBin.length) - newBin.length, 0x00)]);

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
const jsonHdr = Buffer.alloc(8);
jsonHdr.writeUInt32LE(jsonBuf.length, 0); jsonHdr.writeUInt32LE(0x4e4f534a, 4);
const binHdr = Buffer.alloc(8);
binHdr.writeUInt32LE(binBuf.length, 0); binHdr.writeUInt32LE(0x004e4942, 4);

const out = Buffer.concat([header, jsonHdr, jsonBuf, binHdr, binBuf]);
await writeFile(OUT, out);

console.log(`  textures ${MB(before)} -> ${MB(after)}`);
console.log(`${OUT}  ${MB(src.length)} -> ${MB(out.length)}  (saved ${MB(src.length - out.length)})`);
