#!/usr/bin/env node
/**
 * glb-vram — report RESIDENT GPU texture memory for a Loop's assets.
 *
 * Why this exists: every tool in the pipeline reports FILE SIZE. None reports
 * what the texture costs once the GPU holds it. Those two numbers are unrelated
 * — WebP and PNG both decode to raw RGBA — and 18.4 MB of WebP on disk was
 * 802 MB resident, which is what stopped an iPhone rendering this Loop at all.
 *
 * Budget what you measure.
 *
 *   node tools/glb-vram.mjs assets/dripping-pickle/*.glb assets/dripping-pickle/*.png
 *
 * The model, stated so the number can be argued with:
 *   uncompressed (PNG/JPEG/WebP)  →  w * h * 4 bytes   (decoded to RGBA8)
 *   KTX2 / ASTC                   →  w * h * 16/(bw*bh) bytes — ONE 16-byte block per
 *                                    bw x bh texels, READ FROM THE FILE'S vkFormat
 *   KTX2 / ETC1S -> ASTC 4x4      →  w * h * 1 byte    (the transcode target)
 *   mipmaps                       →  x 4/3
 *
 * ★ THE BLOCK SIZE IS READ, NEVER ASSUMED (BUD1, 2026-09-10). This tool used to
 *   return a flat 1 byte/pixel for every `image/ktx2`, which is ASTC 4x4. The Loop
 *   ships ASTC 6x6 (0.444 bytes/pixel), so that assumption over-reported the whole
 *   texture budget by 2.25x — and it over-reports in the SAFE direction, which is
 *   why it would have survived: the number is merely pessimistic, never alarming.
 *   It read 104.0 MB for a props.glb whose textures are 46.3 MB. There is an
 *   independent check available and it is exact: with `supercompressionScheme` 0 a
 *   KTX2 is uncompressed, so resident bytes and bytes on disk are the SAME NUMBER.
 *   If those two columns disagree for an ASTC file, this model is wrong.
 *
 * ⚠ The mip factor is applied to every texture. three.js generates mipmaps for
 * any texture whose minFilter is mipmapped, which is the default for glTF
 * material textures. A texture used without mips is over-counted by 33%; that is
 * the safe direction for a budget.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const MIP = 4 / 3;

// vkFormat -> [blockWidth, blockHeight] for the compressed families a Loop can ship.
// Names and numbers from the Vulkan spec; 16 bytes per block for every ASTC format and
// for ETC2 RGBA8, 8 bytes for ETC2 RGB8/RGB8A1 and EAC R11.
const VK_BLOCK = {
  157: [4, 4], 158: [4, 4],       // ASTC_4x4_UNORM / _SRGB
  159: [5, 4], 160: [5, 4],
  161: [5, 5], 162: [5, 5],
  163: [6, 5], 164: [6, 5],
  165: [6, 6], 166: [6, 6],       // ASTC_6x6_UNORM / _SRGB  ← what this Loop shipped until TEX1 (refused since 2026-09-18)
  167: [8, 5], 168: [8, 5],
  169: [8, 6], 170: [8, 6],
  171: [8, 8], 172: [8, 8],
  173: [10, 5], 174: [10, 5],
  175: [10, 6], 176: [10, 6],
  177: [10, 8], 178: [10, 8],
  179: [10, 10], 180: [10, 10],
  181: [12, 10], 182: [12, 10],
  183: [12, 12], 184: [12, 12],
};
const VK_BLOCK_BYTES = { 147: 8, 148: 8, 149: 8, 150: 8, 151: 16, 152: 16 };   // ETC2 / EAC

/** vkFormat + a rough block-bytes read from a KTX2 header (bytes 12..16 is vkFormat, LE). */
function ktx2Format(buf) {
  const KTX2_ID = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < KTX2_ID.length; i++) if (buf[i] !== KTX2_ID[i]) return null;
  const vkFormat = buf.readUInt32LE(12);
  const supercompression = buf.readUInt32LE(28);
  return { vkFormat, supercompression };
}

/** Bytes per pixel once the texture is resident on the GPU. */
function bytesPerPixel(mimeType, ktx) {
  if (mimeType !== 'image/ktx2') return 4;       // PNG, JPEG, WebP — all decode to RGBA8
  if (!ktx) return 1;                            // unreadable header: assume 4x4, the pessimistic case
  // Basis (ETC1S/UASTC) carries supercompression and transcodes to 4x4-class blocks.
  if (ktx.supercompression !== 0) return 1;
  const blk = VK_BLOCK[ktx.vkFormat];
  if (blk) return 16 / (blk[0] * blk[1]);
  const bytes = VK_BLOCK_BYTES[ktx.vkFormat];
  if (bytes) return bytes / 16;                  // ETC2/EAC are all 4x4 blocks
  return 1;                                      // unknown compressed format: pessimistic
}

function fmt(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1000 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

/** Read the dimensions of a standalone image file (PNG/JPEG/WebP), header only. */
function imageSize(buf, name) {
  // PNG: IHDR at byte 16
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), mime: 'image/png' };
  }
  // WebP: RIFF....WEBP
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8X') return { w: (buf.readUIntLE(24, 3) & 0xffffff) + 1, h: (buf.readUIntLE(27, 3) & 0xffffff) + 1, mime: 'image/webp' };
    if (fourcc === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, mime: 'image/webp' };
    }
    if (fourcc === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, mime: 'image/webp' };
  }
  // JPEG: walk the SOF marker
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5), mime: 'image/jpeg' };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  // KTX2: pixelWidth at byte 20, pixelHeight at 24 (both LE), after the 12-byte identifier.
  if (buf.length > 32 && buf[0] === 0xab && buf[1] === 0x4b && buf[2] === 0x54 && buf[3] === 0x58) {
    return { w: buf.readUInt32LE(20), h: buf.readUInt32LE(24) || 1, mime: 'image/ktx2' };
  }
  throw new Error(`cannot read dimensions of ${name} — unsupported container`);
}

async function measureFile(path) {
  const rows = [];
  if (/\.(glb|gltf)$/i.test(path)) {
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
    });
    const doc = await io.read(path);
    for (const tex of doc.getRoot().listTextures()) {
      const size = tex.getSize();
      if (!size) throw new Error(`${basename(path)}: texture "${tex.getName()}" has unreadable dimensions (mime ${tex.getMimeType()})`);
      const img = Buffer.from(tex.getImage());
      rows.push({ name: tex.getName() || '(unnamed)', w: size[0], h: size[1], mime: tex.getMimeType(),
                  disk: img.byteLength, ktx: tex.getMimeType() === 'image/ktx2' ? ktx2Format(img) : null });
    }
  } else {
    const buf = await readFile(path);
    const { w, h, mime } = imageSize(buf, basename(path));
    rows.push({ name: basename(path), w, h, mime, disk: buf.byteLength, ktx: mime === 'image/ktx2' ? ktx2Format(buf) : null });
  }
  return rows;
}

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error('usage: node tools/glb-vram.mjs <file.glb|image.png> ...');
  process.exit(2);
}

let totalDisk = 0, totalBase = 0, totalMip = 0, totalTex = 0;
const byDim = new Map();

for (const path of paths) {
  const rows = await measureFile(path);
  let fileBase = 0, fileDisk = 0;
  for (const r of rows) {
    const base = r.w * r.h * bytesPerPixel(r.mime, r.ktx);
    fileBase += base;
    fileDisk += r.disk;
    const key = `${r.w}x${r.h} ${r.mime.replace('image/', '')}`;
    byDim.set(key, (byDim.get(key) || 0) + 1);
  }
  totalDisk += fileDisk;
  totalBase += fileBase;
  totalMip += fileBase * MIP;
  totalTex += rows.length;
  console.log(
    `${basename(path).padEnd(30)} ${String(rows.length).padStart(4)} tex   ` +
    `disk ${fmt(fileDisk).padStart(9)}   resident ${fmt(fileBase).padStart(9)}   +mips ${fmt(fileBase * MIP).padStart(9)}`
  );
}

console.log('\n  texture sizes present');
for (const [k, n] of [...byDim.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(4)} x  ${k}`);
}

console.log(
  `\n  TOTAL  ${totalTex} textures` +
  `\n    on disk                ${fmt(totalDisk)}` +
  `\n    resident, no mips      ${fmt(totalBase)}` +
  `\n    resident, with mips    ${fmt(totalMip)}   <- the number that decides whether a phone renders` +
  `\n    expansion disk->GPU    ${(totalMip / totalDisk).toFixed(1)}x`
);
