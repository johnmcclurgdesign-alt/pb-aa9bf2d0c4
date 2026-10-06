// Drop texture channels from a .glb and rebuild it clean.
//
// Why this exists: textures are almost all of a character glb's weight, and
// exporters emit maps the web build has no use for. The cat shipped a 1.1 MB
// metallic map, and a cat is not metal.
//
// Deleting an image is not a delete — every accessor and image indexes into a
// shared bufferView list, so removing one shifts everything after it. This
// rebuilds the BIN chunk from only the bufferViews still referenced and remaps
// each index, rather than leaving orphaned bytes in the file.
//
//   node tools/glb-strip.mjs in.glb out.glb --drop metallicRoughness,normal
//
// Channels: baseColor, metallicRoughness, normal, occlusion, emissive.
//
// Dropping baseColor is for when the SCENE supplies it instead — the cat's fur is
// picked from twelve variants at runtime, so baking one into the glb would both
// duplicate it and pin the default. The scene must then assign `material.map`
// itself, with `colorSpace = SRGBColorSpace` and `flipY = false` (glTF UVs).
// Dropping metallicRoughness also pins metallicFactor to 0 — with the texture
// gone the factor is what remains, and glTF defaults it to 1.0 (fully metal),
// so omitting this makes the model MORE wrong, not less.
//
// ★ ONE IMAGE IS OFTEN WIRED TO SEVERAL SLOTS. Unreal packs occlusion, roughness
// and metallic into a single ORM texture and points both metallicRoughnessTexture
// and occlusionTexture at it, so dropping only one slot changes nothing — the file
// comes back byte-identical and looks like the tool failed. Drop every slot that
// shares the image, or nothing happens. This warns when it spots that case.

import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, outPath, ...rest] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node tools/glb-strip.mjs in.glb out.glb --drop metallicRoughness[,normal,...]');
  process.exit(1);
}
const dropArg = rest.includes('--drop') ? rest[rest.indexOf('--drop') + 1] : '';
const drop = new Set(dropArg.split(',').map((s) => s.trim()).filter(Boolean));
if (!drop.size) { console.error('nothing to drop — pass --drop'); process.exit(1); }

// ── read ────────────────────────────────────────────────────────────
const buf = readFileSync(inPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb (bad magic)');

let off = 12, json = null, bin = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
  else if (type === 0x004e4942) bin = data;
  off += 8 + len;
}
if (!json) throw new Error('no JSON chunk');
if (!bin) throw new Error('no BIN chunk — this tool only handles self-contained glb');

const g = json;
const before = { images: g.images?.length ?? 0, textures: g.textures?.length ?? 0, bytes: buf.length };

// ── 1. unhook the dropped channels from every material ──────────────
const SLOTS = {
  baseColor:         (m) => m.pbrMetallicRoughness,
  metallicRoughness: (m) => m.pbrMetallicRoughness,
  normal:            (m) => m,
  occlusion:         (m) => m,
  emissive:          (m) => m,
};
const KEY = {
  baseColor: 'baseColorTexture',
  metallicRoughness: 'metallicRoughnessTexture',
  normal: 'normalTexture',
  occlusion: 'occlusionTexture',
  emissive: 'emissiveTexture',
};
const unhooked = new Set();          // texture indices we tried to let go of
for (const mat of g.materials ?? []) {
  for (const ch of drop) {
    const host = SLOTS[ch]?.(mat);
    if (host && host[KEY[ch]]) {
      unhooked.add(host[KEY[ch]].index);
      delete host[KEY[ch]];
    }
  }
  if (drop.has('metallicRoughness')) {
    mat.pbrMetallicRoughness = mat.pbrMetallicRoughness ?? {};
    // glTF defaults metallicFactor to 1.0. Leaving it implicit after removing
    // the texture would render the cat as chrome.
    mat.pbrMetallicRoughness.metallicFactor = 0;
    if (mat.pbrMetallicRoughness.roughnessFactor === undefined) {
      mat.pbrMetallicRoughness.roughnessFactor = 0.9;
    }
  }
}

// Anything else still pointing at a texture? Warn rather than silently break it.
const extTex = JSON.stringify(g.materials ?? []).match(/"index"/g)?.length ?? 0;

// ── 2. drop textures nothing references, and remap what is left ─────
const texRefs = [];
const walkTexRefs = (o) => {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) return o.forEach(walkTexRefs);
  for (const [k, v] of Object.entries(o)) {
    if (k.endsWith('Texture') && v && typeof v.index === 'number') texRefs.push(v);
    else walkTexRefs(v);
  }
};
walkTexRefs(g.materials ?? []);

const keptTex = [...new Set(texRefs.map((r) => r.index))].sort((a, b) => a - b);

// A packed ORM is wired to more than one slot, so unhooking one leaves the image
// exactly where it was. Say so loudly — silently rewriting an identical file is
// indistinguishable from the tool being broken.
const survivors = [...unhooked].filter((t) => keptTex.includes(t));
if (survivors.length) {
  const held = {};
  walkTexRefsNamed(g.materials ?? [], '', held);
  for (const t of survivors) {
    const name = (g.textures ?? [])[t]?.name ?? `#${t}`;
    console.warn(`WARNING: "${name}" survives — still referenced by ${(held[t] ?? []).join(', ')}.`);
    console.warn(`         It is a packed texture. Add those slots to --drop or nothing changes.`);
  }
}
function walkTexRefsNamed(o, path, acc) {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) return o.forEach((v, i) => walkTexRefsNamed(v, path, acc));
  for (const [k, v] of Object.entries(o)) {
    if (k.endsWith('Texture') && v && typeof v.index === 'number') (acc[v.index] ??= []).push(k);
    else walkTexRefsNamed(v, `${path}.${k}`, acc);
  }
}
const texMap = new Map(keptTex.map((t, i) => [t, i]));
for (const r of texRefs) r.index = texMap.get(r.index);
const oldTextures = g.textures ?? [];
g.textures = keptTex.map((i) => oldTextures[i]);

// ── 3. drop images no surviving texture points at ───────────────────
// ★ A TEXTURE MAY NAME ITS IMAGE THROUGH AN EXTENSION, NOT `source`.
// glb-webp.mjs rewrites this repo's textures as EXT_texture_webp, which carries its
// own `source` and leaves `t.source` undefined. Reading only `t.source` here therefore
// found ZERO images on any WebP glb and dropped EVERY texture — while reporting a
// plausible "212 -> 85 textures" and a large size win. The two tools in this folder
// were silently incompatible: run glb-webp first and glb-strip returned an untextured
// model that still loaded. Resolve through whichever slot the texture actually uses.
const imgRefOf = (t) => {
  if (!t) return null;
  if (t.source != null) return { get: () => t.source, set: (v) => { t.source = v; } };
  const e = t.extensions?.EXT_texture_webp;
  if (e && e.source != null) return { get: () => e.source, set: (v) => { e.source = v; } };
  return null;
};
const imgRefs = g.textures.map(imgRefOf).filter(Boolean);
const keptImg = [...new Set(imgRefs.map((r) => r.get()))].sort((a, b) => a - b);
// ⚠ Surviving textures that resolve to no image at all is the signature of the bug
// above, not a legitimate result. Refuse rather than write an untextured file.
if (g.textures.length > 0 && keptImg.length === 0) {
  throw new Error(`${g.textures.length} textures survived but none resolved to an image — ` +
    `unrecognised texture-source extension (${JSON.stringify(Object.keys(g.textures[0].extensions ?? {}))}). ` +
    `Writing this would silently strip every texture.`);
}
const imgMap = new Map(keptImg.map((s, i) => [s, i]));
for (const r of imgRefs) r.set(imgMap.get(r.get()));
const oldImages = g.images ?? [];
g.images = keptImg.map((i) => oldImages[i]);

// ── 4. rebuild the BIN from only the bufferViews still in use ───────
// accessors and images both index bufferViews, so both need remapping.
const used = new Set();
for (const a of g.accessors ?? []) {
  if (a.bufferView != null) used.add(a.bufferView);
  if (a.sparse) {
    if (a.sparse.indices?.bufferView != null) used.add(a.sparse.indices.bufferView);
    if (a.sparse.values?.bufferView != null) used.add(a.sparse.values.bufferView);
  }
}
for (const im of g.images) if (im.bufferView != null) used.add(im.bufferView);
// ★ DRACO GEOMETRY DOES NOT GO THROUGH AN ACCESSOR'S bufferView.
// A KHR_draco_mesh_compression primitive keeps its compressed buffer on the
// EXTENSION, and its accessors carry no bufferView at all. Collecting only
// accessor and image views therefore marked every geometry view unused and
// dropped it — 113 of 113 primitives in props.glb, 220 of 220 in structure.glb,
// leaving a file that still PARSES (sizes right, no dangling texture refs) and
// contains no geometry. It loaded to an empty scene at a healthy 60 FPS.
const dracoViews = (prim) => prim?.extensions?.KHR_draco_mesh_compression;
for (const m of g.meshes ?? []) {
  for (const prim of m.primitives ?? []) {
    const d = dracoViews(prim);
    if (d?.bufferView != null) used.add(d.bufferView);
  }
}

const order = [...used].sort((a, b) => a - b);
const bvMap = new Map(order.map((v, i) => [v, i]));
const chunks = [];
let cursor = 0;
const newViews = order.map((i) => {
  const v = g.bufferViews[i];
  const slice = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
  // Keep 4-byte alignment: accessors read typed arrays straight out of this.
  const pad = (4 - (cursor % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); cursor += pad; }
  const out = { ...v, byteOffset: cursor };
  chunks.push(slice);
  cursor += slice.length;
  return out;
});
g.bufferViews = newViews;
for (const a of g.accessors ?? []) {
  if (a.bufferView != null) a.bufferView = bvMap.get(a.bufferView);
  if (a.sparse?.indices?.bufferView != null) a.sparse.indices.bufferView = bvMap.get(a.sparse.indices.bufferView);
  if (a.sparse?.values?.bufferView != null) a.sparse.values.bufferView = bvMap.get(a.sparse.values.bufferView);
}
for (const im of g.images) if (im.bufferView != null) im.bufferView = bvMap.get(im.bufferView);
for (const m of g.meshes ?? []) {
  for (const prim of m.primitives ?? []) {
    const d = dracoViews(prim);
    if (d?.bufferView != null) d.bufferView = bvMap.get(d.bufferView);
  }
}

// ⚠ PROVE THE OUTPUT IS SELF-CONSISTENT BEFORE WRITING IT.
// Both bugs this tool has shipped produced a file that parsed cleanly and was
// wrong: one stripped every texture, one stripped every mesh. A structural check
// costs nothing and is the only thing that distinguishes them from a good run.
{
  const n = g.bufferViews.length;
  const danglers = [];
  const chk = (v, what) => { if (v != null && !(v >= 0 && v < n)) danglers.push(what); };
  for (const [i, a] of (g.accessors ?? []).entries()) chk(a.bufferView, `accessor[${i}]`);
  for (const [i, im] of (g.images ?? []).entries()) chk(im.bufferView, `image[${i}]`);
  let dracoCount = 0;
  for (const [mi, m] of (g.meshes ?? []).entries())
    for (const [pi, prim] of (m.primitives ?? []).entries()) {
      const d = dracoViews(prim);
      if (d) { dracoCount++; chk(d.bufferView, `mesh[${mi}].prim[${pi}].draco`); }
    }
  if (danglers.length) {
    throw new Error(`${danglers.length} bufferView reference(s) out of range after rebuild ` +
      `(${danglers.slice(0, 5).join(', ')}${danglers.length > 5 ? ', …' : ''}). Refusing to write.`);
  }
  console.log(`checked    ${g.accessors?.length ?? 0} accessors, ${g.images?.length ?? 0} images, ` +
              `${dracoCount} draco primitives — all bufferView refs in range`);
}

const newBin = Buffer.concat(chunks);
g.buffers = [{ byteLength: newBin.length }];

// ── 5. write ────────────────────────────────────────────────────────
// JSON chunk pads with spaces, BIN pads with zeroes. Both must be 4-aligned or
// the file is rejected by strict loaders.
const jsonBuf = Buffer.from(JSON.stringify(g), 'utf8');
const jsonPad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20);
const binPad = Buffer.alloc((4 - (newBin.length % 4)) % 4, 0x00);
const jsonLen = jsonBuf.length + jsonPad.length;
const binLen = newBin.length + binPad.length;

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonLen + 8 + binLen, 8);
const jsonHdr = Buffer.alloc(8);
jsonHdr.writeUInt32LE(jsonLen, 0); jsonHdr.writeUInt32LE(0x4e4f534a, 4);
const binHdr = Buffer.alloc(8);
binHdr.writeUInt32LE(binLen, 0); binHdr.writeUInt32LE(0x004e4942, 4);

const out = Buffer.concat([header, jsonHdr, jsonBuf, jsonPad, binHdr, newBin, binPad]);
writeFileSync(outPath, out);

console.log(`dropped   ${[...drop].join(', ')}`);
console.log(`images    ${before.images} -> ${g.images.length}`);
console.log(`textures  ${before.textures} -> ${g.textures.length}`);
console.log(`size      ${(before.bytes / 1e6).toFixed(2)} MB -> ${(out.length / 1e6).toFixed(2)} MB`);
console.log(`remaining ${g.images.map((i) => i.name ?? i.mimeType).join(', ') || '(none)'}`);
if (extTex && g.textures.length === 0) console.log('note: material texture refs remain but no textures survived — check extensions');
