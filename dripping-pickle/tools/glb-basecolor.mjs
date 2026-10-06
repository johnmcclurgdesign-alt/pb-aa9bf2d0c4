// Patch pbrMetallicRoughness.baseColorFactor on named materials inside a .glb.
//
//   node tools/glb-basecolor.mjs assets/factory/factory_60.glb \
//        --set "modular_factory_facade_windows_60=0.0575,0.0857,0.045"
//
// ★ WHY THIS EXISTS, AND WHY IT MUST BE RE-RUN AFTER EVERY EXPORT.
// Blender's glTF exporter DROPS a colour Multiply sitting behind Base Color and writes
// baseColorFactor [1,1,1,1] regardless. Verified with both the new ShaderNodeMix and the
// legacy ShaderNodeMixRGB, and a no-op Hue/Saturation node in the chain is not the cause.
// The window trim/cornices tint their diffuse by (0.0575, 0.0857, 0.045) — the green — so
// without this patch that trim ships WHITE.
//
// ★ DO NOT "FIX" IT BY BAKING THE TINT INTO THE TEXTURE. At a ~0.06 multiply the result
// lands in the near-black end of 8-bit sRGB and comes back about 20% too dark. glTF has
// baseColorFactor for exactly this and it is a float, so the patch is exact.
//
// ★ THE CONTAINER HAS TO BE REWRITTEN, NOT EDITED IN PLACE. The JSON chunk length changes
// when the numbers change, so both chunk headers and the 12-byte file header have to be
// recomputed. glTF requires 4-byte alignment: the JSON chunk pads with SPACES (0x20) and
// the BIN chunk pads with NULs (0x00). Get the padding byte wrong and some loaders accept
// it while others reject the file — three.js is one of the tolerant ones, which is exactly
// what makes it a bug you ship rather than one you catch.

import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const IN = args[0];
const OUT = args[1] && !args[1].startsWith('--') ? args[1] : IN;
const sets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--set') {
    const [name, csv] = args[i + 1].split('=');
    const nums = csv.split(',').map(Number);
    if (nums.length < 3 || nums.some(Number.isNaN)) {
      console.error(`bad --set value: ${args[i + 1]}`); process.exit(1);
    }
    sets.push({ name, factor: [nums[0], nums[1], nums[2], nums[3] ?? 1] });
  }
}
if (!IN || !sets.length) {
  console.error('usage: node tools/glb-basecolor.mjs in.glb [out.glb] --set "MatName=r,g,b[,a]" ...');
  process.exit(1);
}

const buf = await readFile(IN);
if (buf.readUInt32LE(0) !== 0x46546c67) { console.error('not a glb'); process.exit(1); }

// walk the chunk table rather than assuming JSON-then-BIN order
let off = 12, json = null, jsonRange = null, bin = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  const start = off + 8;
  if (type === 0x4e4f534a) { json = JSON.parse(buf.slice(start, start + len).toString('utf8')); jsonRange = [start, len]; }
  else if (type === 0x004e4942) { bin = buf.slice(start, start + len); }
  off = start + len;
}
if (!json) { console.error('no JSON chunk'); process.exit(1); }

let hits = 0;
const missing = [];
for (const { name, factor } of sets) {
  const m = (json.materials || []).find((x) => x.name === name);
  if (!m) { missing.push(name); continue; }
  m.pbrMetallicRoughness = m.pbrMetallicRoughness || {};
  const before = m.pbrMetallicRoughness.baseColorFactor || [1, 1, 1, 1];
  m.pbrMetallicRoughness.baseColorFactor = factor;
  hits++;
  console.log(`  ${name}: [${before.map((v) => +v.toFixed(4))}] -> [${factor}]`);
}
if (missing.length) {
  console.error(`NOT FOUND in glb: ${missing.join(', ')}`);
  console.error(`materials present: ${(json.materials || []).map((m) => m.name).join(', ')}`);
  process.exit(1);                       // loud, or the trim silently ships white again
}

const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
const binPad  = bin ? (4 - (bin.length % 4)) % 4 : 0;
const jsonLen = jsonBuf.length + jsonPad;
const binLen  = bin ? bin.length + binPad : 0;
const total   = 12 + 8 + jsonLen + (bin ? 8 + binLen : 0);

const out = Buffer.alloc(total);
let p = 0;
out.writeUInt32LE(0x46546c67, p); p += 4;   // 'glTF'
out.writeUInt32LE(2, p); p += 4;            // version
out.writeUInt32LE(total, p); p += 4;
out.writeUInt32LE(jsonLen, p); p += 4;
out.writeUInt32LE(0x4e4f534a, p); p += 4;   // 'JSON'
jsonBuf.copy(out, p); p += jsonBuf.length;
out.fill(0x20, p, p + jsonPad); p += jsonPad;          // JSON pads with SPACES
if (bin) {
  out.writeUInt32LE(binLen, p); p += 4;
  out.writeUInt32LE(0x004e4942, p); p += 4;            // 'BIN\0'
  bin.copy(out, p); p += bin.length;
  out.fill(0x00, p, p + binPad); p += binPad;          // BIN pads with NULs
}
await writeFile(OUT, out);
console.log(`patched ${hits} material(s) -> ${OUT} (${(total / 1048576).toFixed(2)} MB)`);
