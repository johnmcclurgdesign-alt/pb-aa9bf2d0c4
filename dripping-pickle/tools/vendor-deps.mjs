#!/usr/bin/env node
// Vendor every RUNTIME dependency into vendor/, so the Loop imports nothing over the network.
//
//   node tools/vendor-deps.mjs          # build vendor/ from node_modules
//   node tools/vendor-deps.mjs --check  # verify vendor/ matches node_modules, exit 1 on drift
//
// ★ WHY THIS IS A GRAPH WALK AND NOT A DIRECTORY COPY. three's examples/jsm is ~25 MB and we
//   use sixteen files out of it — but those sixteen import others (GLTFLoader pulls in the
//   whole KHR extension surface), so a hand-picked list under-copies and the loop dies at the
//   first missing module. Copying the whole tree over-ships into a payload with a 200 MB
//   ceiling. So: start at the modules the loops actually name, follow every relative import,
//   copy exactly the closure. Re-run it after any new addon import or a three version bump.
//
// ★ AND THE VERSION IS ASSERTED AGAINST THE IMPORTMAPS. The CDN urls carried the pin
//   (three@0.169.0); vendoring moves the pin into node_modules, where nothing stops an
//   `npm install three` from silently shipping a different renderer. checkPins() reads the
//   version back out of every loop's importmap comment and refuses a mismatch.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const NM = path.join(REPO, 'node_modules');
const VENDOR = path.join(REPO, 'vendor');
const CHECK = process.argv.includes('--check');

const PINS = { three: '0.169.0', n8ao: '1.9.4', yuka: '0.7.8' };

// Entry modules, by the specifier the loops import them as. Everything reachable from these
// comes along automatically.
const THREE_ADDON_ENTRIES = [
  'controls/OrbitControls.js',
  'controls/TransformControls.js',
  'lights/LightProbeGenerator.js',
  'lights/RectAreaLightUniformsLib.js',
  'loaders/DRACOLoader.js',
  'loaders/GLTFLoader.js',
  'loaders/KTX2Loader.js',
  'loaders/RGBELoader.js',
  'postprocessing/BokehPass.js',
  'postprocessing/EffectComposer.js',
  'postprocessing/GTAOPass.js',
  'postprocessing/OutputPass.js',
  'postprocessing/Pass.js',
  'postprocessing/RenderPass.js',
  'postprocessing/SMAAPass.js',
  'postprocessing/ShaderPass.js',
];

// Binary decoders loaded at RUNTIME by url, not by import — DRACOLoader and KTX2Loader fetch
// these themselves, so the import walk cannot see them. They are the classic vendoring miss:
// the page loads, three is local, and the first .glb still hits the network.
// `skip` is not tidiness — draco_encoder.js is 954 KB, DRACOLoader never names it (grep the
// loader: zero references), and it would ship in every payload as pure weight.
const BINARY_DIRS = [
  { src: 'three/examples/jsm/libs/draco/gltf', dst: 'three/examples/jsm/libs/draco/gltf',
    skip: ['draco_encoder.js'] },
  { src: 'three/examples/jsm/libs/basis', dst: 'three/examples/jsm/libs/basis', skip: [] },
];

const files = new Map(); // vendor-relative path -> absolute source path

/** Resolve a relative import from `fromAbs`, tolerating an extensionless specifier. */
function resolveRel(fromAbs, spec) {
  const base = path.resolve(path.dirname(fromAbs), spec);
  for (const cand of [base, base + '.js', path.join(base, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  throw new Error(`unresolved import ${spec} from ${fromAbs}`);
}

/** Every module specifier in a source file: static imports, re-exports, and dynamic import(). */
function specifiersOf(src) {
  const out = [];
  const re = /(?:\bfrom\s*|\bimport\s*)(['"])([^'"]+)\1|\bimport\s*\(\s*(['"])([^'"]+)\3\s*\)/g;
  let m;
  while ((m = re.exec(src))) out.push(m[2] ?? m[4]);
  return out;
}

/** Walk the import closure, recording each reachable file under its vendor-relative path. */
function walk(absPath, vendorRel, rootAbs, vendorRoot) {
  if (files.has(vendorRel)) return;
  files.set(vendorRel, absPath);
  const src = fs.readFileSync(absPath, 'utf8');
  for (const spec of specifiersOf(src)) {
    if (!spec.startsWith('.')) continue; // bare specifiers stay bare; the importmap answers them
    const childAbs = resolveRel(absPath, spec);
    const childRel = path.join(vendorRoot, path.relative(rootAbs, childAbs));
    walk(childAbs, childRel, rootAbs, vendorRoot);
  }
}

function collect() {
  // three: the build, plus the addon closure. Addons import 'three' bare, which the importmap
  // answers — so the walk never leaves examples/jsm.
  const threeRoot = path.join(NM, 'three');
  files.set('three/build/three.module.js', path.join(threeRoot, 'build/three.module.js'));
  for (const entry of THREE_ADDON_ENTRIES) {
    const abs = path.join(threeRoot, 'examples/jsm', entry);
    if (!fs.existsSync(abs)) throw new Error(`missing three addon entry: ${entry}`);
    walk(abs, path.join('three/examples/jsm', entry), path.join(threeRoot, 'examples/jsm'),
      'three/examples/jsm');
  }

  // n8ao ships a single prebuilt dist file; it imports 'postprocessing' bare for a flavour we
  // do not use, and the importmap already sends that to tools/stub-postprocessing.js.
  files.set('n8ao/N8AO.js', path.join(NM, 'n8ao/dist/N8AO.js'));

  // yuka: the factory/cat loops steer with it.
  files.set('yuka/yuka.module.js', path.join(NM, 'yuka/build/yuka.module.js'));

  // Decoder binaries the loaders fetch by url.
  for (const { src: srcRel, dst: dstRel, skip } of BINARY_DIRS) {
    const srcDir = path.join(NM, srcRel);
    if (!fs.existsSync(srcDir)) throw new Error(`missing binary dir: ${srcRel}`);
    for (const name of fs.readdirSync(srcDir)) {
      if (skip.includes(name)) continue;
      const abs = path.join(srcDir, name);
      if (fs.statSync(abs).isFile()) files.set(path.join(dstRel, name), abs);
    }
  }
}

/** The pins in node_modules must equal the pins the loops were written against. */
function checkPins() {
  const bad = [];
  for (const [pkg, want] of Object.entries(PINS)) {
    const pj = path.join(NM, pkg, 'package.json');
    if (!fs.existsSync(pj)) { bad.push(`${pkg}: not installed`); continue; }
    const got = JSON.parse(fs.readFileSync(pj, 'utf8')).version;
    if (got !== want) bad.push(`${pkg}: node_modules has ${got}, loops are pinned to ${want}`);
  }
  if (bad.length) {
    console.error('VERSION PIN MISMATCH:\n  ' + bad.join('\n  '));
    console.error(`\nInstall the pinned set:\n  npm install --no-save ` +
      Object.entries(PINS).map(([k, v]) => `${k}@${v}`).join(' '));
    process.exit(1);
  }
}

checkPins();
collect();

let written = 0, drift = [];
for (const [rel, abs] of [...files].sort()) {
  const dst = path.join(VENDOR, rel);
  const src = fs.readFileSync(abs);
  if (CHECK) {
    if (!fs.existsSync(dst)) { drift.push(`missing: vendor/${rel}`); continue; }
    if (!fs.readFileSync(dst).equals(src)) drift.push(`differs: vendor/${rel}`);
    continue;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, src);
  written++;
}

// A stale file left behind in vendor/ is the same defect as a missing one: it means vendor/ is
// no longer a function of node_modules, so nobody can trust it was rebuilt.
const onDisk = [];
(function scan(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) scan(abs);
    else onDisk.push(path.relative(VENDOR, abs));
  }
})(VENDOR);
const stale = onDisk.filter(r => !files.has(r) && path.basename(r) !== 'README.md');

// ---------------------------------------------------------------------------------------
// THE MODULE-SCOPE `new URL(` GUARD (#121, CMP2 2026-09-13).
//
// three.js's own DRACOLoader.js and KTX2Loader.js evaluate `new URL('../libs/…',
// import.meta.url)` AT MODULE SCOPE from r0.185. On the Apple TV binding before app row TVB1
// there is no `URL`, so a Loop that merely IMPORTS either of them statically died during
// module evaluation — before its entry module ran, whether or not it ever loaded a Draco or
// KTX2 file. That is the whole of Vibes VC-058: a black television, one ReferenceError.
//
// Measured at CMP1 (2026-09-12): the vendored r169 set has none — `grep -rn "import.meta.url"
// vendor/` is empty. That is a property of the PIN, not of this Loop, and a bump reintroduces
// it with nothing to notice. `PINS` asserts the version; this asserts the PROPERTY.
//
// Module scope in an ES module is brace depth 0. Comments and string bodies are blanked first
// (length-preserving, so line numbers stay true) or a `new URL(` inside a comment would count.
function moduleScopeNewURL(src) {
  const masked = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (m) => m[0] + ' '.repeat(m.length - 2) + m[0]);
  const hits = [];
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && masked.startsWith('new URL(', i)) {
      hits.push(src.slice(0, i).split('\n').length);
    }
  }
  return hits;
}

if (CHECK) {
  for (const rel of files.keys()) {
    if (!rel.includes('examples/jsm/')) continue;
    const dst = path.join(VENDOR, rel);
    if (!fs.existsSync(dst)) continue;
    for (const line of moduleScopeNewURL(fs.readFileSync(dst, 'utf8'))) {
      drift.push(`module-scope \`new URL(\` at vendor/${rel}:${line} — it evaluates before the entry module and there is no URL on the Apple TV binding before TVB1 (#121)`);
    }
  }
}

if (CHECK) {
  for (const s of stale) drift.push(`stale: vendor/${s}`);
  if (drift.length) {
    console.error(`vendor/ is out of date (${drift.length}):\n  ` + drift.join('\n  '));
    console.error('\nRebuild it:  node tools/vendor-deps.mjs');
    process.exit(1);
  }
  console.log(`vendor/ OK — ${files.size} files match node_modules`);
} else {
  for (const s of stale) fs.rmSync(path.join(VENDOR, s));
  const bytes = [...files.values()].reduce((a, f) => a + fs.statSync(f).size, 0);
  console.log(`vendored ${written} files, ${(bytes / 1048576).toFixed(2)} MB, into vendor/`);
  if (stale.length) console.log(`removed ${stale.length} stale file(s)`);
  console.log(Object.entries(PINS).map(([k, v]) => `  ${k}@${v}`).join('\n'));
}
