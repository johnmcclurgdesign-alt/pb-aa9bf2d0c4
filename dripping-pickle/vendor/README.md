# vendor/ — generated, do not hand-edit

Every runtime dependency the Loops import, copied out of `node_modules` so the payload
imports **nothing over the network**. The app program refuses any runtime `https://` import
at publish-checks (PLAN §3, WG2), so a CDN url here is a shipping blocker, not a style note.

Rebuild / verify:

```bash
npm install --no-save three@0.169.0 n8ao@1.9.4 yuka@0.7.8
node tools/vendor-deps.mjs           # rebuild
node tools/vendor-deps.mjs --check   # verify, exit 1 on drift
```

`tools/vendor-deps.mjs` walks the import graph from the modules the loops actually name, so
the tree holds exactly the reachable closure — 38 files, 3.9 MB, against ~25 MB for all of
three's `examples/jsm`. **Re-run it after adding any new `three/addons/…` import**, or the
new module resolves to nothing and the loop dies at load.

Two things the import walk cannot see, and which are therefore listed explicitly in the tool:

- **`libs/draco/gltf/` and `libs/basis/`** are fetched by url at runtime by `DRACOLoader` and
  `KTX2Loader`. This is the classic vendoring miss — three is local, the page loads, and the
  first `.glb` still hits the CDN.
- **`draco_encoder.js` is deliberately excluded** (954 KB, zero references in `DRACOLoader`).

Versions are pinned in `PINS` in the tool and asserted on every run: the CDN url used to carry
the pin, and vendoring moves it into `node_modules`, where an `npm install three` would
otherwise swap the renderer silently.
