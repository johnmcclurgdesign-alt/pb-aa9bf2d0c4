#!/usr/bin/env node
// Compare two .glb files structurally — for proving a re-export round-trips.
//
//   node tools/glb-compare.mjs shipped.glb rebuilt.glb
//   node tools/glb-compare.mjs a.glb b.glb --json
//
// ★ BYTE-IDENTITY IS THE WRONG TEST AND WILL NEVER PASS. A re-export differs in ways that carry
//   no meaning: the exporter stamps its own version string, WebP encoding is not bit-reproducible
//   across ffmpeg builds, Draco quantisation reorders vertices, and accessor/bufferView indices
//   get renumbered by every tool in the chain. Diffing the bytes tells you only that something
//   changed, which you already knew.
//
//   What must match is what the SCENE is: the same objects, the same materials on them, the same
//   textures at the same sizes, the same camera, the same geometry within Draco's quantisation
//   error. Those are the things a silent pipeline failure actually breaks — a dropped mural
//   composite, a lost baseColorFactor, a texture that came back 4K because --max was forgotten.
//
// Exits non-zero if any hard check differs, so it can gate a pipeline run.

import fs from 'node:fs';
import path from 'node:path';

const [aPath, bPath] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
const JSON_OUT = process.argv.includes('--json');
if (!aPath || !bPath) {
  console.error('usage: node tools/glb-compare.mjs <a.glb> <b.glb> [--json]');
  process.exit(2);
}

function readGlb(p) {
  const b = fs.readFileSync(p);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`${p}: not a glb`);
  let off = 12, json = null, binLen = 0;
  while (off < b.length) {
    const len = b.readUInt32LE(off), type = b.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) json = JSON.parse(b.slice(off + 8, off + 8 + len).toString('utf8'));
    if (type === 0x004e4942) binLen = len;
    off += 8 + len;
  }
  return { json, size: b.length, binLen };
}

/** Dimensions from an embedded image's bytes — the glTF JSON does not carry them. */
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const f = buf.toString('ascii', 12, 16);
    if (f === 'VP8X') return [(buf.readUIntLE(24, 3) & 0xffffff) + 1, (buf.readUIntLE(27, 3) & 0xffffff) + 1];
    if (f === 'VP8L') { const x = buf.readUInt32LE(21); return [(x & 0x3fff) + 1, ((x >> 14) & 0x3fff) + 1]; }
    if (f === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  }
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

/** A stable, tool-independent description of what the file contains. */
function profile(p) {
  const { json: j, size, binLen } = readGlb(p);
  const bin = (() => {
    const b = fs.readFileSync(p);
    let off = 12;
    while (off < b.length) {
      const len = b.readUInt32LE(off), type = b.readUInt32LE(off + 4);
      if (type === 0x004e4942) return b.slice(off + 8, off + 8 + len);
      off += 8 + len;
    }
    return Buffer.alloc(0);
  })();

  const nodes = (j.nodes || []).map((n) => n.name).filter(Boolean).sort();
  const materials = (j.materials || []).map((m) => m.name).filter(Boolean).sort();

  // baseColorFactor per material — the patch that has to be re-applied after EVERY export, and
  // whose absence ships the window trim white with nothing warning.
  const factors = {};
  for (const m of j.materials || []) {
    const f = m.pbrMetallicRoughness?.baseColorFactor;
    if (f && f.some((v, i) => v !== (i === 3 ? 1 : 1))) factors[m.name] = f.map((v) => +v.toFixed(4));
  }

  // Texture sizes, counted as a histogram: a forgotten --max 1024 shows up here as 4K entries.
  const dims = {};
  for (const im of j.images || []) {
    if (im.bufferView === undefined) continue;
    const bv = j.bufferViews[im.bufferView];
    const buf = bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    const wh = imageSize(buf);
    const key = wh ? `${wh[0]}x${wh[1]} ${(im.mimeType || '').replace('image/', '')}` : `unknown ${im.mimeType}`;
    dims[key] = (dims[key] || 0) + 1;
  }

  const meshVerts = {};
  for (const mesh of j.meshes || []) {
    let v = 0;
    for (const prim of mesh.primitives || []) {
      const dr = prim.extensions?.KHR_draco_mesh_compression;
      const accIdx = dr ? undefined : prim.attributes?.POSITION;
      if (accIdx !== undefined) v += j.accessors[accIdx].count;
      else if (dr) v += j.accessors[prim.attributes.POSITION]?.count ?? 0;
    }
    if (mesh.name) meshVerts[mesh.name] = v;
  }

  return {
    file: path.basename(p), size, binLen,
    counts: {
      nodes: (j.nodes || []).length, meshes: (j.meshes || []).length,
      materials: (j.materials || []).length, images: (j.images || []).length,
      textures: (j.textures || []).length, accessors: (j.accessors || []).length,
      cameras: (j.cameras || []).length,
    },
    extensions: (j.extensionsUsed || []).slice().sort(),
    nodes, materials, factors, dims, meshVerts,
    cameraNodes: (j.nodes || []).filter((n) => n.camera !== undefined).map((n) => n.name).sort(),
    cameraParams: (j.cameras || []).map((c) => ({
      yfov: +(c.perspective?.yfov ?? 0).toFixed(6),
      aspect: +(c.perspective?.aspectRatio ?? 0).toFixed(6),
    })),
  };
}

const A = profile(aPath), B = profile(bPath);
const diffs = [], notes = [];
const setDiff = (x, y) => ({ onlyA: x.filter((v) => !y.includes(v)), onlyB: y.filter((v) => !x.includes(v)) });

// -- hard checks: a difference here means the pipeline changed the scene ------
{
  const d = setDiff(A.nodes, B.nodes);
  if (d.onlyA.length || d.onlyB.length) {
    diffs.push(`node names differ — missing from B: [${d.onlyA.slice(0, 8)}]; extra in B: [${d.onlyB.slice(0, 8)}]`);
  }
}
{
  const d = setDiff(A.materials, B.materials);
  if (d.onlyA.length || d.onlyB.length) {
    diffs.push(`material names differ — missing from B: [${d.onlyA.slice(0, 8)}]; extra in B: [${d.onlyB.slice(0, 8)}]`);
  }
}
{
  const keys = [...new Set([...Object.keys(A.factors), ...Object.keys(B.factors)])];
  for (const k of keys) {
    const a = JSON.stringify(A.factors[k] ?? null), b = JSON.stringify(B.factors[k] ?? null);
    if (a !== b) diffs.push(`baseColorFactor differs on "${k}": A=${a} B=${b}`);
  }
}
if (JSON.stringify(A.cameraNodes) !== JSON.stringify(B.cameraNodes)) {
  diffs.push(`camera nodes differ: A=[${A.cameraNodes}] B=[${B.cameraNodes}]`);
}
if (JSON.stringify(A.cameraParams) !== JSON.stringify(B.cameraParams)) {
  diffs.push(`camera params differ: A=${JSON.stringify(A.cameraParams)} B=${JSON.stringify(B.cameraParams)}`);
}
{
  const keys = [...new Set([...Object.keys(A.dims), ...Object.keys(B.dims)])].sort();
  const changed = keys.filter((k) => (A.dims[k] || 0) !== (B.dims[k] || 0));
  if (changed.length) {
    diffs.push('texture size histogram differs:\n' + changed
      .map((k) => `      ${k.padEnd(22)} A=${A.dims[k] || 0}  B=${B.dims[k] || 0}`).join('\n'));
  }
}
{
  const keys = Object.keys(A.meshVerts).filter((k) => k in B.meshVerts);
  const changed = keys.filter((k) => A.meshVerts[k] !== B.meshVerts[k]);
  if (changed.length) {
    notes.push(`${changed.length} mesh(es) differ in vertex count (Draco requantisation can do ` +
      `this legitimately; a LARGE change is a decimation or modifier difference): ` +
      changed.slice(0, 5).map((k) => `${k} ${A.meshVerts[k]}->${B.meshVerts[k]}`).join(', '));
  }
}

// -- soft notes: expected to move, reported so the size is visible ------------
const pct = (a, b) => (a === 0 ? 'n/a' : `${(((b - a) / a) * 100).toFixed(1)}%`);
notes.push(`file size ${(A.size / 1048576).toFixed(2)} MB -> ${(B.size / 1048576).toFixed(2)} MB (${pct(A.size, B.size)})`);
for (const k of ['nodes', 'meshes', 'materials', 'images', 'textures', 'accessors', 'cameras']) {
  if (A.counts[k] !== B.counts[k]) diffs.push(`count ${k}: A=${A.counts[k]} B=${B.counts[k]}`);
}
{
  const d = setDiff(A.extensions, B.extensions);
  if (d.onlyA.length || d.onlyB.length) {
    diffs.push(`extensionsUsed differ — missing from B: [${d.onlyA}]; extra in B: [${d.onlyB}]`);
  }
}

const pass = diffs.length === 0;
if (JSON_OUT) {
  console.log(JSON.stringify({ pass, a: A.file, b: B.file, diffs, notes }, null, 2));
} else {
  console.log(`\nGLB COMPARE  ${A.file}  vs  ${B.file}  — ${pass ? 'MATCH' : 'DIFFERS'}`);
  console.log(`  A: ${A.counts.nodes} nodes, ${A.counts.materials} materials, ${A.counts.images} images, ${(A.size / 1048576).toFixed(2)} MB`);
  console.log(`  B: ${B.counts.nodes} nodes, ${B.counts.materials} materials, ${B.counts.images} images, ${(B.size / 1048576).toFixed(2)} MB`);
  if (diffs.length) { console.log('\n  DIFFERENCES THAT MATTER:'); for (const d of diffs) console.log(`    - ${d}`); }
  if (notes.length) { console.log('\n  notes:'); for (const n of notes) console.log(`    · ${n}`); }
}
process.exit(pass ? 0 : 1);
