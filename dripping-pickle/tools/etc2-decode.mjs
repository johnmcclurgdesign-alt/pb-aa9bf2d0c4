/**
 * etc2-decode — decode level 0 of an ETC2/EAC KTX2 (vkFormat 147–156, supercompressionScheme 0)
 * to RGBA8, in plain JavaScript.
 *
 *   import { decodeEtc2Ktx2 } from './etc2-decode.mjs';
 *   const { width, height, rgba, modes } = decodeEtc2Ktx2(bytes);
 *
 * WHY THIS EXISTS (TEX1, 2026-09-23). The Apple TV cook is ETC2/EAC, and the decode check that
 * catches a transfer-function fault needs the pixels back. `ktx extract` (KTX-Software 4.4.2)
 * refuses: "Requested format conversion from VK_FORMAT_ETC2_R8G8B8_SRGB_BLOCK is not supported".
 * Nothing else on this machine decodes ETC2, so this does — ~150 lines of the Khronos Data Format
 * spec §21 (ETC2) and §22 (EAC).
 *
 * ⚠ It returns the STORED values: an sRGB file decodes to sRGB-encoded bytes, exactly as a PNG
 *   out of `ktx extract` does, so the two can be compared channel for channel.
 * ⚠ `modes` counts the blocks per mode. A cook transcoded from UASTC by `ktx transcode` emits the
 *   ETC1 modes only (individual / differential), so the T, H and planar paths are exercised by
 *   nothing this Loop ships — the self-test in tools/glb-ktx2.mjs says which modes it saw.
 */

// vkFormat → { alpha: EAC RGBA8 block in front of the colour block, srgb }
const FORMATS = {
  147: { alpha: false, srgb: false }, 148: { alpha: false, srgb: true },   // ETC2 R8G8B8
  149: { alpha: 'punch', srgb: false }, 150: { alpha: 'punch', srgb: true }, // ETC2 R8G8B8A1
  151: { alpha: true, srgb: false }, 152: { alpha: true, srgb: true },     // ETC2 R8G8B8A8 (EAC alpha)
};

const MOD = [[2, 8, -2, -8], [5, 17, -5, -17], [9, 29, -9, -29], [13, 42, -13, -42],
             [18, 60, -18, -60], [24, 80, -24, -80], [33, 106, -33, -106], [47, 183, -47, -183]];
const DIST = [3, 6, 11, 16, 23, 32, 41, 64];
const EAC = [[-3, -6, -9, -15, 2, 5, 8, 14], [-3, -7, -10, -13, 2, 6, 9, 12], [-2, -5, -8, -13, 1, 4, 7, 12],
             [-2, -4, -6, -13, 1, 3, 5, 12], [-3, -6, -8, -12, 2, 5, 7, 11], [-3, -7, -9, -11, 2, 6, 8, 10],
             [-4, -7, -8, -11, 3, 6, 7, 10], [-3, -5, -8, -11, 2, 4, 7, 10], [-2, -6, -8, -10, 1, 5, 7, 9],
             [-2, -5, -8, -10, 1, 4, 7, 9], [-2, -4, -8, -10, 1, 3, 7, 9], [-2, -5, -7, -10, 1, 4, 6, 9],
             [-3, -4, -7, -10, 2, 3, 6, 9], [-1, -2, -3, -10, 0, 1, 2, 9], [-4, -6, -8, -9, 3, 5, 7, 8],
             [-3, -5, -7, -9, 2, 4, 6, 8]];

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const x4 = (c) => (c << 4) | c;
const x5 = (c) => (c << 3) | (c >> 2);
const x6 = (c) => (c << 2) | (c >> 4);
const x7 = (c) => (c << 1) | (c >> 6);
const s3 = (v) => (v & 4 ? v - 8 : v);   // 3-bit two's complement

/** Pixel (x, y) of a 4x4 block → its 2-bit index. Bit i = x*4 + y; MSB plane in b[4..5], LSB in b[6..7]. */
function pix(b, o, x, y) {
  const i = x * 4 + y;
  const msb = (((b[o + 4] << 8) | b[o + 5]) >> i) & 1;
  const lsb = (((b[o + 6] << 8) | b[o + 7]) >> i) & 1;
  return (msb << 1) | lsb;
}

/** One 64-bit ETC2 RGB block at b[o..o+7] → out[16][3], row-major within the block. */
function colourBlock(b, o, out, modes, punch) {
  const b0 = b[o], b1 = b[o + 1], b2 = b[o + 2], b3 = b[o + 3];
  const diff = (b3 >> 1) & 1, flip = b3 & 1;
  const put = (x, y, r, g, bl) => { const k = (y * 4 + x) * 3; out[k] = clamp(r); out[k + 1] = clamp(g); out[k + 2] = clamp(bl); };

  // ⚠ Punch-through (RGB8A1) reuses the diff bit as "opaque"; this Loop never cooks it, so refuse.
  if (punch) throw new Error('etc2-decode: R8G8B8A1 (punch-through) is not implemented — nothing here cooks it');

  if (!diff) {                                             // ETC1 individual mode
    const c1 = [x4(b0 >> 4), x4(b1 >> 4), x4(b2 >> 4)], c2 = [x4(b0 & 15), x4(b1 & 15), x4(b2 & 15)];
    return etc1(b, o, c1, c2, (b3 >> 5) & 7, (b3 >> 2) & 7, flip, put, modes, 'individual');
  }
  const r = b0 >> 3, g = b1 >> 3, bl = b2 >> 3;
  const r2 = r + s3(b0 & 7), g2 = g + s3(b1 & 7), bl2 = bl + s3(b2 & 7);
  if (r2 < 0 || r2 > 31) {                                 // T mode
    modes.T++;
    const R1 = (((b0 >> 3) & 3) << 2) | (b0 & 3), G1 = b1 >> 4, B1 = b1 & 15;
    const R2 = b2 >> 4, G2 = b2 & 15, B2 = b3 >> 4;
    const d = DIST[(((b3 >> 2) & 3) << 1) | (b3 & 1)];
    const c1 = [x4(R1), x4(G1), x4(B1)], c2 = [x4(R2), x4(G2), x4(B2)];
    const paint = [c1, c2.map((v) => v + d), c2, c2.map((v) => v - d)];
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) { const p = paint[pix(b, o, x, y)]; put(x, y, p[0], p[1], p[2]); }
    return;
  }
  if (g2 < 0 || g2 > 31) {                                 // H mode
    modes.H++;
    const R1 = (b0 >> 3) & 15, G1 = ((b0 & 7) << 1) | ((b1 >> 4) & 1);
    const B1 = (b1 & 8) | ((b1 & 3) << 1) | (b2 >> 7);
    const R2 = (b2 >> 3) & 15, G2 = ((b2 & 7) << 1) | (b3 >> 7), B2 = (b3 >> 3) & 15;
    const ord = ((R1 << 8) | (G1 << 4) | B1) >= ((R2 << 8) | (G2 << 4) | B2) ? 1 : 0;
    const d = DIST[(((b3 >> 2) & 1) << 2) | ((b3 & 1) << 1) | ord];
    const c1 = [x4(R1), x4(G1), x4(B1)], c2 = [x4(R2), x4(G2), x4(B2)];
    const paint = [c1.map((v) => v + d), c1.map((v) => v - d), c2.map((v) => v + d), c2.map((v) => v - d)];
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) { const p = paint[pix(b, o, x, y)]; put(x, y, p[0], p[1], p[2]); }
    return;
  }
  if (bl2 < 0 || bl2 > 31) {                               // planar mode
    modes.planar++;
    const b4 = b[o + 4], b5 = b[o + 5], b6 = b[o + 6], b7 = b[o + 7];
    const RO = x6((b0 >> 1) & 63), GO = x7(((b0 & 1) << 6) | ((b1 >> 1) & 63));
    const BO = x6(((b1 & 1) << 5) | (((b2 >> 3) & 3) << 3) | ((b2 & 3) << 1) | (b3 >> 7));
    const RH = x6((((b3 >> 2) & 31) << 1) | (b3 & 1)), GH = x7(b4 >> 1), BH = x6(((b4 & 1) << 5) | (b5 >> 3));
    const RV = x6(((b5 & 7) << 3) | (b6 >> 5)), GV = x7(((b6 & 31) << 2) | (b7 >> 6)), BV = x6(b7 & 63);
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
      put(x, y, (x * (RH - RO) + y * (RV - RO) + 4 * RO + 2) >> 2,
                (x * (GH - GO) + y * (GV - GO) + 4 * GO + 2) >> 2,
                (x * (BH - BO) + y * (BV - BO) + 4 * BO + 2) >> 2);
    }
    return;
  }
  const c1 = [x5(r), x5(g), x5(bl)], c2 = [x5(r2), x5(g2), x5(bl2)];   // ETC1 differential mode
  return etc1(b, o, c1, c2, (b3 >> 5) & 7, (b3 >> 2) & 7, flip, put, modes, 'differential');
}

function etc1(b, o, c1, c2, t1, t2, flip, put, modes, name) {
  modes[name]++;
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
    const second = flip ? y >= 2 : x >= 2;
    const base = second ? c2 : c1, m = MOD[second ? t2 : t1][pix(b, o, x, y)];
    put(x, y, base[0] + m, base[1] + m, base[2] + m);
  }
}

/** One 64-bit EAC alpha block at b[o..o+7] → a[16], row-major within the block. */
function alphaBlock(b, o, a) {
  const base = b[o], mult = b[o + 1] >> 4, table = EAC[b[o + 1] & 15];
  // 48 index bits, big-endian, pixel i = x*4 + y from the most significant end.
  let hi = (b[o + 2] << 16) | (b[o + 3] << 8) | b[o + 4], lo = (b[o + 5] << 16) | (b[o + 6] << 8) | b[o + 7];
  for (let i = 0; i < 16; i++) {
    const idx = i < 8 ? (hi >> (21 - 3 * i)) & 7 : (lo >> (21 - 3 * (i - 8))) & 7;
    const x = i >> 2, y = i & 3;
    a[y * 4 + x] = clamp(base + table[idx] * mult);
  }
}

/** Level 0 of an ETC2/EAC KTX2 → { width, height, vkFormat, srgb, rgba: Uint8Array, modes }. */
export function decodeEtc2Ktx2(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const vk = dv.getUint32(12, true), width = dv.getUint32(20, true), height = dv.getUint32(24, true);
  const scheme = dv.getUint32(44, true);
  const f = FORMATS[vk];
  if (!f) throw new Error(`etc2-decode: vkFormat ${vk} is not an ETC2 RGB/RGBA format`);
  if (scheme !== 0) throw new Error(`etc2-decode: supercompressionScheme ${scheme} — only 0 is decoded`);
  const off = Number(dv.getBigUint64(80, true));            // level index entry 0: byteOffset
  const bw = Math.ceil(width / 4), bh = Math.ceil(height / 4), blk = f.alpha === true ? 16 : 8;
  const rgba = new Uint8Array(width * height * 4);
  const modes = { individual: 0, differential: 0, T: 0, H: 0, planar: 0 };
  const col = new Uint8Array(48), alp = new Uint8Array(16).fill(255);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const o = off + (by * bw + bx) * blk;
    if (f.alpha === true) alphaBlock(b, o, alp);
    colourBlock(b, f.alpha === true ? o + 8 : o, col, modes, f.alpha === 'punch');
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const px = bx * 4 + x, py = by * 4 + y;
      if (px >= width || py >= height) continue;
      const k = (py * width + px) * 4, s = (y * 4 + x) * 3;
      rgba[k] = col[s]; rgba[k + 1] = col[s + 1]; rgba[k + 2] = col[s + 2]; rgba[k + 3] = alp[y * 4 + x];
    }
  }
  return { width, height, vkFormat: vk, srgb: f.srgb, rgba, modes };
}
