#!/usr/bin/env bash
# Build the Collectivus app payload: a web-archive zip with loop.json at its ROOT.
#
# The rules live in collectivus-loops-docs/30-engines/web/ — read those for why. This script only
# implements them:
#   - the file set is budget-check.mjs --manifest, so the archive and the budget rig agree;
#   - loop.json names the entry (loops/dripping-pickle/index.html — the tree keeps its shape, the
#     scene's ../../ paths resolve from the archive root the same way they do from the repo root);
#   - zip -X from INSIDE the staging tree, no .DS_Store, so loop.json is at the root and the hash is
#     stable across machines;
#   - the archive is ASSERTED, not assumed: loop.json and the entry present, every staged file
#     non-empty, and the sha256 + content digest printed (loops-docs web rule 11 — hand over the FILE).
#
# Usage: tools/build-payload.sh [output-dir] [--with-tvos]   (default: build/)
#   --with-tvos  ALSO builds the Apple TV cook: `<id>-tvos-<date>-<sha8>.zip`, the same tree with every
#   Basis texture transcoded to ETC2/EAC at supercompressionScheme 0 (loops-docs 40-delivery §1a, app
#   row COOK2). The TV binding has no Basis transcoder, so the default cook draws nothing there. Both
#   zips go in one SHA256SUMS.txt. ⚠ Opt-in: the release lane takes a second cook only after the
#   monorepo push carrying `ace73383`, and the TV is `unavailable` until TV1-TV3 (DQ20). ⚠ And no
#   loader in this tree can read ETC2 yet — three r169's KTX2Loader maps no ETC2 vkFormat (TV2).
#   CLV_VALIDATION_BUILD=1  lets the build proceed when `npm run budget` is red. ⚠ That is for the
#   app program's validation builds only — a red budget is a publish blocker on the Collectivus side
#   whatever this script does (issues #29 / #4 / #72 / #73 / #75).
#   CLV_PERF_WALK=1..6  bakes BUD3's walk (3-6: BUD4's fixed-cost walks) into the STAGED entry and names the zip
#   `-perfwalk`. ⚠ A MEASUREMENT BUILD, NEVER PUBLISHABLE. It exists because a device leg has no
#   URL — the app entry draws no chrome and the payload URL carries no query string — so a switch
#   that cannot be flipped from outside has to be baked in. The repo tree is never modified: the
#   line is injected into the copy under build/stage/.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="build"; WITH_TVOS=0
for a in "$@"; do case "$a" in --with-tvos) WITH_TVOS=1 ;; -*) echo "unknown flag $a"; exit 2 ;; *) OUT="$a" ;; esac; done
LOOP="dripping-pickle"                 # the TREE name: loops/<LOOP>/ inside the repo and the archive
# ⚠ THE CATALOG ID IS NOT THE TREE NAME, AND GUESSING IT WRONG MISNAMES EVERY RELEASE.
# `dripping-pickle` is already taken in the catalog origin by the GODOT build (three .pck files
# under loops/dripping-pickle/). This Loop was namespaced `dripping-pickle-webgl` when its first
# payload was placed on 2026-09-01 — same shape as pirate-beach / pirate-beach-webgl — and an `id`
# is IMMUTABLE after first publish because it is the cache namespace on every device.
# Verify rather than assume: ls ~/Code/collectivus/collectivus-catalog/loops/
CATALOG_ID="dripping-pickle-webgl"
ENTRY="loops/$LOOP/index.html"
# ⚠ The RELEASE name cannot be known until the file exists: loops-docs
# 40-delivery/10-delivering-a-release.md §1 names a payload `<loop-id>-<YYYYMMDD>-<sha8>.<ext>`
# where sha8 is the first 8 hex of the file's OWN sha256, computed AFTER it is written. So the zip
# is built under a working name and renamed below. `dripping-pickle` is the CATALOG id (PLAN §1) —
# not the repo name, which carries a `-webgl-v1` the catalog never sees.
BUILD_DATE="$(date +%Y%m%d)"
NAME="$CATALOG_ID-$BUILD_DATE-building.zip"
STAGE="$OUT/stage"

# ── the on-disk budget half is the pre-flight ────────────────────────────────
if ! node tools/budget-check.mjs; then
  if [ "${CLV_VALIDATION_BUILD:-0}" = "1" ]; then
    echo "⚠ budget check is RED — continuing because CLV_VALIDATION_BUILD=1 (validation build, not publishable)"
  else
    echo "budget check is RED — refusing to build a payload. Set CLV_VALIDATION_BUILD=1 for a validation build."
    exit 1
  fi
fi

# ── stage exactly the manifest ───────────────────────────────────────────────
rm -rf "$STAGE"
mkdir -p "$STAGE"
manifest="$(node tools/budget-check.mjs --manifest)"
count=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  mkdir -p "$STAGE/$(dirname "$f")"
  cp -p "$f" "$STAGE/$f"
  # ⚠ Assert the OUTPUT. A silently-empty copy is the defect this line exists to catch.
  [ -s "$STAGE/$f" ] || { echo "staged file is empty: $f"; exit 1; }
  count=$((count + 1))
done <<< "$manifest"
[ -s "$STAGE/$ENTRY" ] || { echo "entry not staged: $ENTRY"; exit 1; }

# ── the measurement build ────────────────────────────────────────────────────
PERFWALK_SUFFIX=""
if [ "${CLV_PERF_WALK:-0}" = "1" ] || [ "${CLV_PERF_WALK:-0}" = "2" ] || [ "${CLV_PERF_WALK:-0}" = "3" ] || [ "${CLV_PERF_WALK:-0}" = "4" ] || [ "${CLV_PERF_WALK:-0}" = "5" ] || [ "${CLV_PERF_WALK:-0}" = "6" ]; then
  # Injected before the module script so the flag exists when the module runs. Asserted rather
  # than assumed: a silent miss here produces a payload that looks like the walk build, runs the
  # shipping build, reports nothing, and costs an attended device window to discover.
  python3 - "$STAGE/$ENTRY" "$CLV_PERF_WALK" <<'PYEOF'
import sys
p = sys.argv[1]
mode = sys.argv[2]
s = open(p, encoding='utf-8').read()
needle = '<script type="module">'
assert s.count(needle) >= 1, 'no module script in the entry — cannot inject the perf-walk flag'
s = s.replace(needle, '<script>window.__CLV_PERF_WALK=%s;</script>\n' % mode + needle, 1)
open(p, 'w', encoding='utf-8').write(s)
PYEOF
  grep -q "window.__CLV_PERF_WALK=$CLV_PERF_WALK" "$STAGE/$ENTRY" || { echo "perf-walk flag was not injected"; exit 1; }
  # And the thing it switches on must actually be in the file, or the flag is decoration.
  grep -q '__CLV_PERF_WALK' "$STAGE/$ENTRY" && grep -q 'createPerfWalk' "$STAGE/$ENTRY" \
    || { echo "the entry does not read the perf-walk flag"; exit 1; }
  PERFWALK_SUFFIX="-perfwalk$CLV_PERF_WALK"
  echo "⚠ CLV_PERF_WALK=$CLV_PERF_WALK — this is a MEASUREMENT payload and must never be published"
fi

# ★ `tiers` IS A MAP OF EACH TIER TO THE FILES IT LOADS (loops-docs web 20 §2, TIER2), so the
# pre-flight and the intake measure resident texture memory PER TIER — phone and tablet against
# ~370 MB; laptop and desktop are printed, not judged. Every tier of this cook loads the same files:
# the tier ladder (tools/perf-tier.js) moves resolution and passes, never textures. The TV is not a
# tier of THIS cook — it reads its own `-tvos-` zip (--with-tvos). A glob that matches nothing is a
# FAIL at the gate, so these name only what the manifest ships.
TIER_ASSETS='["assets/**/*.glb", "assets/**/*.ktx2", "assets/**/*.jpg"]'

# ⚠ `cameras` MUST AGREE WITH what the Loop declares at `collectivus.ready()` — the shell logs a
# disagreement rather than picking a winner — and the shell needs the list from this file BEFORE
# any of the Loop's code runs, because it restores the viewer's remembered camera at entry.
# ★ THE IDS ARE PERMANENT. The shell remembers a viewer's choice by id and, when an id no longer
# exists, restores nothing rather than guessing at the nearest label — so renaming one silently
# drops every viewer back to the opening shot. `room` is first, so it IS the opening shot.
cat > "$STAGE/loop.json" <<JSON
{
  "manifestVersion": 1,
  "entry": "$ENTRY",
  "title": "Dripping Pickle",
  "cameras": [
    { "id": "room", "title": "The Outpost", "order": 0 },
    { "id": "screens", "title": "The Screens", "order": 1 }
  ],
  "tiers": {
    "phone":   { "assets": $TIER_ASSETS },
    "tablet":  { "assets": $TIER_ASSETS },
    "laptop":  { "assets": $TIER_ASSETS },
    "desktop": { "assets": $TIER_ASSETS }
  }
}
JSON

# The scene is the other half of that agreement, so assert it here rather than discovering the
# mismatch in a device log: both ids must appear in the entry document.
for camid in room screens; do
  grep -q "id: '$camid'" "$STAGE/$ENTRY" \
    || { echo "loop.json declares camera '$camid' and $ENTRY does not"; exit 1; }
done

# ── zip from INSIDE the stage, so loop.json is at the archive root ───────────
mkdir -p "$OUT"
rm -f "$OUT/$NAME"
# -D: no directory entries, so the member count below is a count of FILES and can be asserted.
( cd "$STAGE" && find . -name '.DS_Store' -delete && zip -X -D -r -q "../$NAME" . -x '.*' -x '__MACOSX/*' )

# ⚠ CAPTURE FIRST, then grep. `unzip -Z1 … | grep -q` exits at the first match, unzip takes SIGPIPE,
# and `pipefail` reports failure precisely BECAUSE the check succeeded (loops-docs manifest §1).
names="$(unzip -Z1 "$OUT/$NAME")"
printf '%s\n' "$names" | grep -qx 'loop.json' || { echo "loop.json is not at the archive root"; exit 1; }
printf '%s\n' "$names" | grep -qx "$ENTRY"    || { echo "entry is not in the archive: $ENTRY"; exit 1; }
members="$(printf '%s\n' "$names" | grep -c .)"
[ "$members" -eq $((count + 1)) ] || { echo "archive has $members members, expected $((count + 1))"; exit 1; }

# ── name it as a release, and write the sums beside it ──────────────────────
# ⚠ NEVER REBUILD BETWEEN THE GATE YOU RAN AND THE FILE YOU HAND OVER. A zip embeds per-entry
# timestamps, so rebuilding identical source yields a different sha256 (measured six times on
# Vibes: Collectivus) — a rebuild is a NEW release, not the same one. Renaming touches no byte,
# which is why the name is applied here rather than the archive being built twice.
sha8="$(shasum -a 256 "$OUT/$NAME" | cut -c1-8)"
RELEASE="$CATALOG_ID-$BUILD_DATE-$sha8$PERFWALK_SUFFIX.zip"
mv "$OUT/$NAME" "$OUT/$RELEASE"
NAME="$RELEASE"
# One line per payload IN THIS RELEASE — a glob would sweep in every older zip still sitting in
# build/ and hand the catalog side files that were never gated.
( cd "$OUT" && shasum -a 256 "$RELEASE" > SHA256SUMS.txt && shasum -a 256 -c SHA256SUMS.txt )

echo "$members members, $count from the manifest + loop.json"
ls -l "$OUT/$NAME" | awk '{print $5 " bytes  " $9}'
shasum -a 256 "$OUT/$NAME"
# The content digest (loops-docs web rule 11): survives a rebuild where the container hash does not.
python3 - "$OUT/$NAME" <<'PY'
import hashlib, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    rows = sorted((i.filename, hashlib.sha256(z.read(i)).hexdigest())
                  for i in z.infolist() if not i.is_dir())
print("content digest", hashlib.sha256("".join(f"{h}  {n}\n" for n, h in rows).encode()).hexdigest(),
      f"({len(rows)} members)")
PY

# ── the Apple TV cook (--with-tvos) ──────────────────────────────────────────────────────────────
if [ "$WITH_TVOS" = "1" ]; then
  TVSTAGE="$OUT/stage-tvos"
  rm -rf "$TVSTAGE"; cp -Rp "$STAGE" "$TVSTAGE"
  # Every file carrying a Basis image, found by reading the bytes rather than by a list that can go
  # stale. Each is transcoded with the same decode check the default cook passed (tools/glb-ktx2.mjs).
  basis_files="$(python3 - "$TVSTAGE" <<'PY'
import os, struct, sys, json
root = sys.argv[1]; KTX = b'\xabKTX 20\xbb\r\n\x1a\n'
def vk(b): return struct.unpack('<I', b[12:16])[0]
for d, _, fs in os.walk(root):
    for f in fs:
        p = os.path.join(d, f); rel = os.path.relpath(p, root)
        b = open(p, 'rb').read()
        if f.endswith('.ktx2') and b[:12] == KTX and vk(b) == 0: print(rel)
        elif f.endswith('.glb') and b[:4] == b'glTF':
            jl = struct.unpack('<I', b[12:16])[0]; j = json.loads(b[20:20 + jl]); bin0 = 20 + jl + 8
            for im in j.get('images', []):
                bv = j['bufferViews'][im['bufferView']] if 'bufferView' in im else None
                if bv and b[bin0 + bv.get('byteOffset', 0):][:12] == KTX and vk(b[bin0 + bv.get('byteOffset', 0):]) == 0:
                    print(rel); break
PY
)"
  [ -n "$basis_files" ] || { echo "tvos cook: no Basis image found in the stage — nothing to transcode, refusing"; exit 1; }
  while IFS= read -r f; do
    echo "── tvos: $f"
    # ⚠ Capture, then read: a pipe into grep would let pipefail and `|| true` hide the exit code.
    log="$OUT/tvos-cook.log"
    node tools/glb-ktx2.mjs "$STAGE/$f" "$TVSTAGE/$f" --target etc2 > "$log" 2>&1 \
      || { cat "$log"; echo "tvos cook: glb-ktx2 failed on $f"; exit 1; }
    grep -E 'textures \(|ETC2 blocks|glb-ktx2' "$log" || true
  done <<< "$basis_files"
  cat > "$TVSTAGE/loop.json" <<JSON
{
  "manifestVersion": 1,
  "entry": "$ENTRY",
  "title": "Dripping Pickle",
  "cameras": [
    { "id": "room", "title": "The Outpost", "order": 0 },
    { "id": "screens", "title": "The Screens", "order": 1 }
  ],
  "tiers": {
    "tv": { "assets": $TIER_ASSETS }
  }
}
JSON
  # ⚠ Assert the OUTPUT: the TV cook must carry no Basis image (no transcoder there) and no ASTC.
  python3 - "$TVSTAGE" <<'PY'
import os, struct, sys, json
root = sys.argv[1]; KTX = b'\xabKTX 20\xbb\r\n\x1a\n'; bad = []
def check(rel, b):
    v, sc = struct.unpack('<I', b[12:16])[0], struct.unpack('<I', b[44:48])[0]
    if not (147 <= v <= 156 and sc == 0): bad.append(f'{rel}: vkFormat {v} scheme {sc}')
for d, _, fs in os.walk(root):
    for f in fs:
        p = os.path.join(d, f); rel = os.path.relpath(p, root); b = open(p, 'rb').read()
        if f.endswith('.ktx2') and b[:12] == KTX: check(rel, b)
        elif f.endswith('.glb') and b[:4] == b'glTF':
            jl = struct.unpack('<I', b[12:16])[0]; j = json.loads(b[20:20 + jl]); bin0 = 20 + jl + 8
            for im in j.get('images', []):
                if 'bufferView' in im:
                    o = bin0 + j['bufferViews'][im['bufferView']].get('byteOffset', 0)
                    if b[o:o + 12] == KTX: check(rel, b[o:])
if bad: print('tvos cook: not ETC2 at scheme 0 —', bad[0], f'(+{len(bad) - 1} more)'); sys.exit(1)
print('tvos cook: every KTX2 image is ETC2/EAC at supercompressionScheme 0')
PY
  TVNAME="$CATALOG_ID-tvos-$BUILD_DATE-building.zip"
  rm -f "$OUT/$TVNAME"
  ( cd "$TVSTAGE" && find . -name '.DS_Store' -delete && zip -X -D -r -q "../$TVNAME" . -x '.*' -x '__MACOSX/*' )
  tvnames="$(unzip -Z1 "$OUT/$TVNAME")"
  printf '%s\n' "$tvnames" | grep -qx 'loop.json' || { echo "tvos: loop.json is not at the archive root"; exit 1; }
  [ "$(printf '%s\n' "$tvnames" | grep -c .)" -eq "$members" ] || { echo "tvos: member count differs from the default cook"; exit 1; }
  tvsha8="$(shasum -a 256 "$OUT/$TVNAME" | cut -c1-8)"
  TVRELEASE="$CATALOG_ID-tvos-$BUILD_DATE-$tvsha8.zip"
  mv "$OUT/$TVNAME" "$OUT/$TVRELEASE"
  ( cd "$OUT" && shasum -a 256 "$RELEASE" "$TVRELEASE" > SHA256SUMS.txt && shasum -a 256 -c SHA256SUMS.txt )
  ls -l "$OUT/$TVRELEASE" | awk '{print $5 " bytes  " $9}'
fi
