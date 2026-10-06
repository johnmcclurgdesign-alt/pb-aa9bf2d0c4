// Swap ONE embedded texture in a .glb for a file on disk, in place in the container.
//
//   node tools/glb-replace-image.mjs in.glb out.glb --image <name> --file <path.webp>
//
// WHY THIS EXISTS. glTF carries exactly one base-colour image per material, so any
// material whose Base Color is a NODE CHAIN — a Hue/Sat, a Brightness/Contrast, an RGB
// Curves grade — exports as the raw source texture with the whole grade silently thrown
// away. `glb-basecolor.mjs` rescues the subset of those that are a pure multiply (it can
// ship as baseColorFactor, a float, so it stays exact). Anything with a curve or a
// saturation change is not a multiply and has to be BAKED to a new image instead.
//
// When that grade is a per-pixel function of ONE source image — which it is whenever the
// chain has no second texture mixed in — the bake belongs in IMAGE space, not UV space:
// bake the 0..1 tile through the same nodes and the texture still TILES. A UV-space bake
// would flatten the whole roof into one atlas and destroy the repeat.
//
// ★ ZERO THE MAPPING NODE'S OFFSET BEFORE BAKING THE TILE. The glb keeps the offset as
// KHR_texture_transform, so a tile baked with the offset already in it gets shifted twice.
//
// ★ REPLACING AN IMAGE IS NOT DROPPING ONE. Every bufferView keeps its index here, so
// accessors, Draco payloads and other images still point where they did — but the new
// bytes are a different length, so the BIN chunk is rebuilt end to end and every offset
// after the swap moves. That is why this cannot be a patch in place. (Dropping a view is
// the harder case and lives in glb-strip.mjs.)
//
// Exits non-zero if the named image is not in the file — a silent skip is how a texture
// ships un-graded while the run still looks green.

import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const IN = args[0];
const OUT = args[1] && !args[1].startsWith('--') ? args[1] : null;
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const IMAGE = arg('--image');
const FILE = arg('--file');
const MIME = arg('--mime') || 'image/webp';

if (!IN || !OUT || !IMAGE || !FILE) {
  console.error('usage: node tools/glb-replace-image.mjs in.glb out.glb --image <name> --file <path> [--mime image/webp]');
  process.exit(1);
}

const MB = (n) => (n / 1048576).toFixed(2) + ' MB';
const align4 = (n) => (n + 3) & ~3;

const src = await readFile(IN);
if (src.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb (bad magic)');

const jsonLen = src.readUInt32LE(12);
const json = JSON.parse(src.slice(20, 20 + jsonLen).toString('utf8'));
const binStart = 20 + jsonLen + 8;
const bin = src.slice(binStart, binStart + src.readUInt32LE(20 + jsonLen));

const views = json.bufferViews || [];
const images = json.images || [];

const idx = images.findIndex((im) => im.name === IMAGE);
if (idx < 0) {
  console.error(`FAIL: no image named "${IMAGE}" in ${IN}`);
  console.error('      images present: ' + images.map((im) => im.name).join(', '));
  process.exit(1);
}
const im = images[idx];
if (im.bufferView === undefined) {
  console.error(`FAIL: image "${IMAGE}" is an external URI, not embedded — nothing to swap`);
  process.exit(1);
}

const oldLen = views[im.bufferView].byteLength;
const bytes = await readFile(FILE);
const replacement = new Map([[im.bufferView, bytes]]);
im.mimeType = MIME;

// A WebP image is not core glTF — it must be reached through EXT_texture_webp, and with no
// fallback source that extension is REQUIRED, not merely used.
if (MIME === 'image/webp') {
  for (const t of json.textures || []) {
    if (t.source !== idx) continue;
    t.extensions = { ...(t.extensions || {}), EXT_texture_webp: { source: idx } };
    delete t.source;
  }
  json.extensionsUsed = [...new Set([...(json.extensionsUsed || []), 'EXT_texture_webp'])];
  json.extensionsRequired = [...new Set([...(json.extensionsRequired || []), 'EXT_texture_webp'])];
}

// ── rebuild the BIN ───────────────────────────────────────────────────────────
const parts = [];
let offset = 0;
for (const [i, v] of views.entries()) {
  const b = replacement.get(i) ?? bin.slice(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength);
  const pad = align4(offset) - offset;
  if (pad) { parts.push(Buffer.alloc(pad)); offset += pad; }
  v.byteOffset = offset;
  v.byteLength = b.length;
  parts.push(b);
  offset += b.length;
}
const newBin = Buffer.concat(parts);
json.buffers = [{ byteLength: newBin.length }];

// JSON pads with spaces, BIN with zeroes; both chunks must be a multiple of four.
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

await writeFile(OUT, Buffer.concat([header, jsonHdr, jsonBuf, binHdr, binBuf]));

console.log(`  image[${idx}] "${IMAGE}"  ${MB(oldLen)} -> ${MB(bytes.length)}  (${MIME})`);
console.log(`${OUT}  ${MB(src.length)} -> ${MB(12 + 8 + jsonBuf.length + 8 + binBuf.length)}`);
