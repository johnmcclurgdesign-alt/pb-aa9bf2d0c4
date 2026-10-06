#!/usr/bin/env bash
# condition-glb — put one glb through the production texture pipeline.
#
#   tools/condition-glb.sh <in.glb> <out.glb> [max-edge] [--keep-material "<name>" ...]
#
#   ⚠ `max-edge` is REQUIRED on anything straight out of Blender: the export carries
#     source-resolution textures. Shipped: props 768, structure 1024.
#
# ★ THIS RECIPE CHANGED TWICE, AND NEITHER OLD ONE CAN SHIP.
#   BUD1 (2026-09-10) replaced png -> etc1s -> draco with hard ASTC 6x6 at supercompressionScheme 0,
#   reading the Apple TV binding's missing Worker/Blob/WebAssembly as ruling Basis out everywhere.
#   TEX1 (2026-09-23) replaced THAT: the Mac face that ships (Designed for iPad) has no ASTC, so
#   every upload was refused and the room drew unlit (#145), and since 2026-09-18 the intake refuses
#   any ASTC KTX2. The cook now is Basis UASTC + zstd for every face but the TV (it transcodes at
#   load to ASTC / ETC / BC7), and the Apple TV gets its own ETC2 cook made from these files at
#   package time (tools/build-payload.sh --cook tvos). Draco stays out: the TV cannot decode it.
#
# The chain, and why each step is here:
#
#   1. png --formats "*"   Decode whatever the textures are into PNG.
#      ⚠ NOT optional, and NOT a size step. `ktx create` reads PNG/JPEG, never
#      WebP — and this Loop's textures are WebP. It also decodes Draco, which is
#      what we want now: nothing puts it back.
#      ⚠ `--formats "*"` is also not optional: the default is "png", which means
#      "only re-encode textures that are ALREADY png" — i.e. a no-op on this Loop.
#
#   2. glb-ktx2            Encode to KTX2 / Basis UASTC + zstd, every side a multiple of 4.
#      sRGB vs linear is chosen per texture from the glTF SLOT, not from the image,
#      and every texture is decoded back and checked (tools/glb-ktx2.mjs header).
#
#   3. (no Draco)          Deliberately absent. Geometry ships uncompressed.
#
# Requires `ktx` (KTX-Software) on PATH — see 30-engines/web/ in
# collectivus-loops-docs for how to get it without an admin password.
set -euo pipefail

IN="${1:?usage: condition-glb.sh <in.glb> <out.glb>}"
OUT="${2:?usage: condition-glb.sh <in.glb> <out.glb> [max-edge]}"
MAX="${3:-0}"
shift 3 2>/dev/null || shift $# ; KEEP=("$@")     # any remaining args pass to glb-ktx2 (e.g. --keep-material "X")
# ⚠ `"${KEEP[@]}"` on an EMPTY array is an unbound-variable error under `set -u` in the bash
#   3.2 macOS ships, so this script could only ever be run WITH a --keep-material. props.glb
#   needs none, and the failure lands after the (slow) PNG decode. `${KEEP[@]+...}` is the
#   bash-3.2-safe expansion; found at ART1, 2026-09-11.
HERE="$(cd "$(dirname "$0")" && pwd)"

command -v ktx >/dev/null || { echo "condition-glb: 'ktx' is not on PATH — the UASTC encode cannot run" >&2; exit 3; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "── 1/2  decoding textures to PNG (ktx create will not read WebP) and Draco to plain geometry"
npx gltf-transform png --formats "*" "$IN" "$TMP/png.glb" 2>&1 | grep -viE '^objc' || true

echo "── 2/2  encoding KTX2 / Basis UASTC + zstd (long edge capped at ${MAX})"
node "$HERE/glb-ktx2.mjs" "$TMP/png.glb" "$OUT" --max "$MAX" ${KEEP[@]+"${KEEP[@]}"}

# ⚠ Validate the OUTPUT, not the inputs. Every failure mode above is silent:
# a skipped encode exits 0 and writes a file. Refuse to leave one behind.
node "$HERE/glb-vram.mjs" "$OUT" | tail -8
# Materials deliberately left uncompressed (--keep-material) are legitimate PNG; everything
# else must be KTX2. Pass the list through so the check can tell one from the other.
KEEPNAMES="$(printf '%s\n' ${KEEP[@]+"${KEEP[@]}"} | grep -v '^--keep-material$' | tr '\n' '|')"
KEEPNAMES="$KEEPNAMES" node - "$OUT" <<'NODE'
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const keep = new Set(String(process.env.KEEPNAMES || '').split('|').filter(Boolean));
const keptTex = new Set();
for (const m of doc.getRoot().listMaterials()) {
  if (!keep.has(m.getName())) continue;
  const t = m.getBaseColorTexture(); if (t) keptTex.add(t);
}
const tex = doc.getRoot().listTextures().filter((t) => t.getImage());
const bad = tex.filter((t) => t.getMimeType() !== 'image/ktx2' && !keptTex.has(t));
if (bad.length) {
  console.error(`\nFAILED: ${bad.length}/${tex.length} textures are not KTX2 — first is ${bad[0].getName()} (${bad[0].getMimeType()})`);
  process.exit(4);
}
const ext = doc.getRoot().listExtensionsUsed().map((e) => e.extensionName);
// ⚠ The Draco assert is INVERTED from what it used to be. Shipping Draco is now the defect.
if (ext.includes('KHR_draco_mesh_compression')) {
  console.error('\nFAILED: geometry is Draco-compressed — the Apple TV binding cannot decode it (no WebAssembly)');
  process.exit(5);
}
console.log(`OK: ${tex.length - keptTex.size}/${tex.length} textures KTX2/UASTC, ${keptTex.size} kept uncompressed by name, geometry uncompressed`);
NODE
