#!/usr/bin/env bash
# Package a release the way the catalog side receives it — loops-docs 40-delivery/10-delivering-a-release.md.
#
#   tools/release.sh vX.Y.Z      # build-payload.sh, name the file from its bytes, write + verify SHA256SUMS.txt
#
# Refuses a dirty tree, a catalog-entry.md whose version.content is not X.Y.Z, and a missing master.
# ⚠ Nothing rebuilds after the sums are written — the sha256 identifies THAT file (zip embeds mtimes).
# ⚠ It does NOT tag or push. Those are a person's acts; it prints the commands.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
LOOP_ID="dripping-pickle-webgl"   # the CATALOG id (#135) — `dripping-pickle` is the Godot build in the origin
VERSION="${1:-}"
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: tools/release.sh vX.Y.Z"; exit 2; }
BARE="${VERSION#v}"
[ -z "$(git status --porcelain)" ] || { echo "FAIL: the working tree is not clean — a release is built from a commit"; exit 1; }
ENTRY_VERSION="$(sed -n 's/^  content: "\([^"]*\)".*/\1/p' catalog-assets/catalog-entry.md | head -1)"
[ "$ENTRY_VERSION" = "$BARE" ] || { echo "FAIL: catalog-assets/catalog-entry.md says version.content \"$ENTRY_VERSION\", the release is $VERSION"; exit 1; }
for m in catalog-assets/$LOOP_ID-poster.png catalog-assets/$LOOP_ID-wide.png; do
  [ -s "$m" ] || { echo "FAIL: $m is missing — both masters ship with the release (catalog-assets/README.md)"; exit 1; }
done
OUT="release/$VERSION"; rm -rf "$OUT"; mkdir -p "$OUT"
tools/build-payload.sh "$OUT/build" >/dev/null
ZIP="$(ls "$OUT"/build/*.zip | head -1)"
[ -s "$ZIP" ] || { echo "FAIL: build-payload.sh produced no zip in $OUT/build"; exit 1; }
SHA="$(shasum -a 256 "$ZIP" | cut -c1-8)"
NAME="$LOOP_ID-$(date +%Y%m%d)-$SHA.zip"
mv "$ZIP" "$OUT/$NAME"; rm -rf "$OUT/build"
( cd "$OUT" && shasum -a 256 "$NAME" > SHA256SUMS.txt && shasum -a 256 -c SHA256SUMS.txt )
cat <<MSG

release $VERSION packaged in $OUT/ — $NAME + SHA256SUMS.txt
Next, a person's acts:
  git tag $VERSION && git push origin $VERSION
  gh release create $VERSION $OUT/$NAME $OUT/SHA256SUMS.txt --title "$VERSION" --notes "<what changed>"
Then file "Loop release ready" on CollectivusWorlds/collectivus.
MSG
