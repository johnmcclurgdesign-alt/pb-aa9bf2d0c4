// Copy material FACTORS from a reference .glb onto another, matching by material name.
//
//   node tools/glb-match-pbr.mjs in.glb out.glb --ref assets/factory/factory.glb --suffix _60
//
// WHY. A second export of the same building is only a fair comparison if the two agree on
// everything except the thing being compared. They did not: `factory.glb` ships base colour
// ONLY (the strip described in CLAUDE.md), while a plain re-export also carries normal and
// metallicRoughness maps. glTF defaults `metallicFactor` to 1.0, so the moment a
// metallicRoughness texture is present the exporter stops writing the constant — and 14 of
// 29 materials came back as metal. Concrete at metallic 1 with nothing to reflect renders
// near-black, which reads as "the whole scene got darker" rather than as a material bug.
//
// ★ THIS IS THE SECOND HALF OF `glb-strip.mjs`, NOT AN ALTERNATIVE TO IT. Strip removes the
// texture slots and rebuilds the BIN; this puts the constants back. Run strip FIRST, then
// this. Dropping metallicRoughness without restoring metallicFactor = 0 is worse than doing
// nothing — it is the chrome-cat failure from CLAUDE.md, applied to a whole building.
//
// Only factors are copied, never texture indices: the two files have different image tables
// and an index copied across them points at whatever happens to sit there.

import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const IN = args[0];
const OUT = args[1] && !args[1].startsWith('--') ? args[1] : IN;
const ref = args.includes('--ref') ? args[args.indexOf('--ref') + 1] : null;
const suffix = args.includes('--suffix') ? args[args.indexOf('--suffix') + 1] : '_60';
if (!IN || !ref) {
  console.error('usage: node tools/glb-match-pbr.mjs in.glb [out.glb] --ref ref.glb [--suffix _60]');
  process.exit(1);
}

const parse = (buf) => {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb');
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4), s = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(buf.slice(s, s + len).toString('utf8'));
    else if (type === 0x004e4942) bin = buf.slice(s, s + len);
    off = s + len;
  }
  return { json, bin };
};

const { json, bin } = parse(await readFile(IN));
const { json: rj } = parse(await readFile(ref));
const refMats = new Map((rj.materials || []).map((m) => [m.name, m]));

let changed = 0;
const unmatched = [];
for (const m of json.materials || []) {
  const base = m.name.endsWith(suffix) ? m.name.slice(0, -suffix.length) : m.name;
  const r = refMats.get(base);
  if (!r) { unmatched.push(m.name); continue; }
  const rp = r.pbrMetallicRoughness || {};
  const p = (m.pbrMetallicRoughness = m.pbrMetallicRoughness || {});
  const before = {
    met: p.metallicFactor ?? 1, rgh: p.roughnessFactor ?? 1,
    bc: p.baseColorFactor || [1, 1, 1, 1],
  };
  // glTF omits a factor when it equals the default, so read the DEFAULT, not undefined
  p.metallicFactor  = rp.metallicFactor  ?? 1;
  p.roughnessFactor = rp.roughnessFactor ?? 1;
  p.baseColorFactor = rp.baseColorFactor || [1, 1, 1, 1];
  if (r.emissiveFactor) m.emissiveFactor = r.emissiveFactor; else delete m.emissiveFactor;
  if (r.alphaMode) m.alphaMode = r.alphaMode; else delete m.alphaMode;
  if (r.alphaCutoff !== undefined) m.alphaCutoff = r.alphaCutoff;
  m.doubleSided = !!r.doubleSided;

  const after = { met: p.metallicFactor, rgh: p.roughnessFactor, bc: p.baseColorFactor };
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    changed++;
    console.log(`  ${m.name}: met ${before.met}->${after.met}  rgh ${before.rgh}->${after.rgh}`);
  }
}
if (unmatched.length) console.warn(`  no reference for: ${unmatched.join(', ')}`);

const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
const jPad = (4 - (jsonBuf.length % 4)) % 4;
const bPad = bin ? (4 - (bin.length % 4)) % 4 : 0;
const jLen = jsonBuf.length + jPad, bLen = bin ? bin.length + bPad : 0;
const total = 12 + 8 + jLen + (bin ? 8 + bLen : 0);
const out = Buffer.alloc(total);
let p = 0;
out.writeUInt32LE(0x46546c67, p); p += 4;
out.writeUInt32LE(2, p); p += 4;
out.writeUInt32LE(total, p); p += 4;
out.writeUInt32LE(jLen, p); p += 4;
out.writeUInt32LE(0x4e4f534a, p); p += 4;
jsonBuf.copy(out, p); p += jsonBuf.length;
out.fill(0x20, p, p + jPad); p += jPad;              // JSON pads with spaces
if (bin) {
  out.writeUInt32LE(bLen, p); p += 4;
  out.writeUInt32LE(0x004e4942, p); p += 4;
  bin.copy(out, p); p += bin.length;
  out.fill(0x00, p, p + bPad); p += bPad;            // BIN pads with NULs
}
await writeFile(OUT, out);
console.log(`matched ${changed} material(s) against ${ref} -> ${OUT} (${(total / 1048576).toFixed(2)} MB)`);
