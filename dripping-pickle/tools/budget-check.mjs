#!/usr/bin/env node
// Budget rig, on-disk half — payload size, vendoring, and asset licensing.
//
//   node tools/budget-check.mjs                       # check loops/dripping-pickle
//   node tools/budget-check.mjs --loop factory-rt
//   node tools/budget-check.mjs --json                # machine-readable, for publish-checks
//   node tools/budget-check.mjs --manifest            # the payload file list, one relative path per line
//
// The other half runs in the page (tools/budget-rig.js): draw calls, resident texture bytes
// and the pixel floor cannot be answered from a file listing. Both read budgets.json.
//
// ★ EVERY THRESHOLD IS OVERRIDABLE FROM THE COMMAND LINE, so a violation can be PLANTED and
//   the red observed: --max-payload 1. A rig nobody has watched fail is a rig that reports
//   success when it is broken. Same reasoning as the in-page half's ?bmaxdraws=.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import zlib from 'node:zlib';

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const LOOP = arg('loop', 'dripping-pickle');
const JSON_OUT = argv.includes('--json');
// ★ --manifest PRINTS THE SET INSTEAD OF JUDGING IT. tools/build-payload.sh stages exactly these
//   files, so the archive the app receives and the number this rig reports are the same list —
//   a build script with its own idea of the payload is how the two drift.
const MANIFEST_OUT = argv.includes('--manifest');

const budgets = JSON.parse(fs.readFileSync(path.join(REPO, 'budgets.json'), 'utf8'));
const MAX_PAYLOAD = Number(arg('max-payload', budgets.payload.maxBytes));

const checks = [];
const add = (name, pass, detail, limit) => checks.push({ name, pass, detail, limit });
const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;

// ── which files a payload would actually carry ────────────────────────────────
// ★ "EVERYTHING IN THE REPO" IS NOT THE PAYLOAD, AND COUNTING IT THAT WAY IS A LIE IN BOTH
//   DIRECTIONS. assets/dripping-pickle/ holds 40 MB of bake SOURCES — brick_mural_wall.png,
//   sign_dripping_pickle_baked.png, roof_planks_graded.png — that the exporter folds INTO the
//   glb and the loop never fetches. Charging the payload for them inflates it by two thirds;
//   ignoring the rule entirely would let a genuinely shipped asset hide. So: start from what
//   the loop REFERENCES, sweep every asset directory that walk touches, and drop only what
//   budgets.json names explicitly. Exclusion is a reviewable list, never a heuristic.
const loopDir = path.join(REPO, 'loops', LOOP);
const entry = path.join(loopDir, 'index.html');
if (!fs.existsSync(entry)) {
  console.error(`no such loop: loops/${LOOP}/index.html`);
  process.exit(2);
}

const html = fs.readFileSync(entry, 'utf8');

/** Follow every relative reference out of a JS/HTML source, transitively. */
function referencedFrom(startAbs, startSrc) {
  const seen = new Set([startAbs]);
  const queue = [[startAbs, startSrc]];
  const out = new Set([startAbs]);
  // Import specifiers, fetch()/url string literals, and importmap targets all look the same
  // from here: a quoted relative or root-relative path with a file extension we ship.
  const RE = /['"`](\.{1,2}\/[^'"`\s)]+|\/(?:assets|vendor|tools)\/[^'"`\s)]+)['"`]/g;
  while (queue.length) {
    const [abs, src] = queue.shift();
    let m;
    while ((m = RE.exec(src))) {
      const spec = m[1];
      const target = spec.startsWith('/')
        ? path.join(REPO, spec)
        : path.resolve(path.dirname(abs), spec);
      if (seen.has(target) || !fs.existsSync(target)) continue;
      seen.add(target);
      // ★ A DIRECTORY REFERENCE IS THE DECODER TRAP FROM THE OTHER SIDE. DRACOLoader and
      //   KTX2Loader are handed a directory (`libs/draco/gltf/`, `libs/basis/`) and fetch files
      //   out of it by name at runtime; the walk used to skip anything that was not a file, so
      //   the payload list carried three.js but NOT its decoders — the exact vendoring miss
      //   loops-docs rule 1 warns about, reproduced by the tool meant to catch it. Sweep it.
      // Only under vendor/: a bare './' or '../' in some helper resolves to a repo directory
      // and sweeping that took node_modules and the .blend sources with it (6,464 files).
      if (fs.statSync(target).isDirectory()) {
        if (!path.relative(REPO, target).startsWith('vendor' + path.sep)) continue;
        const walk = (dir) => {
          for (const name of fs.readdirSync(dir)) {
            const abs = path.join(dir, name);
            if (fs.statSync(abs).isDirectory()) walk(abs); else out.add(abs);
          }
        };
        walk(target);
        continue;
      }
      out.add(target);
      if (/\.(js|mjs|html|json)$/.test(target)) {
        queue.push([target, fs.readFileSync(target, 'utf8')]);
      }
    }
  }
  return out;
}

const referenced = referencedFrom(entry, html);

// ★ THE REFERENCE WALK ALONE UNDER-COUNTS, AND THE FIRST RUN OF THIS TOOL PROVED IT: the cat's
//   21 animation clips and 6 fur jpegs are addressed as `anim_${f}.glb` and `fur/${CAT_FUR}.jpg`,
//   so no static scan can see them — 5 MB simply absent from the number. Any asset directory the
//   walk touches is therefore swept WHOLE, and anything found there counts unless it is named in
//   budgets.json's excludeFromPayload. Over-counting is the safe direction; a silent miss is not.
const EXCLUDE = new Set((budgets.payload.excludeFromPayload || [])
  .map((r) => path.join(REPO, r)));
const assetDirs = new Set();
for (const f of referenced) {
  const rel = path.relative(REPO, f);
  if (rel.startsWith('assets' + path.sep)) assetDirs.add(path.dirname(f));
}
const sweep = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) sweep(abs);
    else referenced.add(abs);
  }
};
for (const d of assetDirs) sweep(d);

const excluded = [...referenced].filter((f) => EXCLUDE.has(f));
const payloadFiles = [...referenced].filter((f) => !EXCLUDE.has(f)).sort();
if (MANIFEST_OUT) {
  for (const f of payloadFiles) console.log(path.relative(REPO, f));
  process.exit(0);
}
let payloadBytes = 0;
for (const f of payloadFiles) payloadBytes += fs.statSync(f).size;

// The ceiling is on the ZIP, so measure a zip, not the loose tree. deflate per file is a close
// and cheap stand-in — glbs and webp barely compress, so the estimate lands within a few percent.
let zippedBytes = 0;
for (const f of payloadFiles) zippedBytes += zlib.deflateSync(fs.readFileSync(f), { level: 9 }).length;

let excludedBytes = 0;
for (const f of excluded) excludedBytes += fs.statSync(f).size;

add('payload size', zippedBytes <= MAX_PAYLOAD,
  `${mb(zippedBytes)} compressed (${mb(payloadBytes)} loose) across ${payloadFiles.length} files` +
  (excluded.length ? `; ${excluded.length} authoring source(s) excluded, ${mb(excludedBytes)}` : ''),
  `≤ ${mb(MAX_PAYLOAD)}`);

// ── no runtime network ────────────────────────────────────────────────────────
const httpHits = [];

// ★ THE FIRST VERSION OF THIS CHECK WENT RED ON A COMMENT, AND THAT IS WORSE THAN USELESS —
//   a rig that cries wolf gets its one real finding waved through. three's three.module.js and
//   GLTFLoader carry `https://my-cnd-server.com/...` inside JSDoc examples, and every DOM helper
//   passes 'http://www.w3.org/1999/xhtml' to createElementNS. Neither is ever fetched. So:
//   strip comments before scanning, and allow the XML namespace identifiers by name.
const XML_NS = new Set([
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xlink',
]);
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')          // block comments, JSDoc included
  .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');

for (const f of payloadFiles) {
  if (!/\.(js|mjs|html|json)$/.test(f)) continue;
  const src = stripComments(fs.readFileSync(f, 'utf8'));
  const re = /['"`](https?:\/\/[^'"`\s]+)['"`]/g;
  let m;
  while ((m = re.exec(src))) {
    if (XML_NS.has(m[1])) continue;
    httpHits.push(`${path.relative(REPO, f)}: ${m[1]}`);
  }
}
add('no runtime network', budgets.network.allowRuntimeHttp || httpHits.length === 0,
  httpHits.length ? `${httpHits.length} absolute url(s): ${httpHits.slice(0, 3).join(' | ')}`
                  : 'no absolute urls in any shipped script',
  'none');

// ── vendored tree matches node_modules ────────────────────────────────────────
{
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(REPO, 'tools/vendor-deps.mjs'), '--check'],
    { encoding: 'utf8' });
  const ok = r.status === 0;
  add('vendor tree current', ok,
    (ok ? r.stdout : (r.stderr || r.stdout)).trim().split('\n')[0] || 'no output',
    'vendor-deps.mjs --check exits 0');
}

// ── asset licensing ───────────────────────────────────────────────────────────
// PLAN §3 and decision 8: royalty_free / cc_zero / original only, and every shipped prop
// accounted for. This keeps the removed CC-BY set from creeping back in on a re-export —
// deleting from the .blend does not change the payload.
//
// ★ THE FIRST VERSION READ ONLY props.glb, AND THAT IS EXACTLY HOW ONE GOT PAST IT. The loop
//   also loads assets/dripping-pickle/props_lamp.glb — a second, separately shipped file
//   holding Prop_Vintage_Floor_Lamp, which has NO row in asset-provenance.csv and which the
//   2026-08-24 audit's "60 props, all accounted for" never covered. A check scoped to one
//   filename is a check that only guards the assets you happened to think of.
//   So: every glb in the payload manifest, every node named Prop_*. Building parts are not
//   props (structure.glb has 0 Prop_* nodes) and the cat is its own licence question (NPC-002).
{
  const csvPath = path.join(REPO, 'asset-provenance.csv');
  const glbs = payloadFiles.filter((f) => /\.glb$/i.test(f));
  if (fs.existsSync(csvPath) && glbs.length) {
    const shipped = new Map();               // prop name -> the glb it ships in
    for (const g of glbs) {
      const b = fs.readFileSync(g);
      let off = 12, j = null;
      while (off < b.length) {
        const len = b.readUInt32LE(off), t = b.readUInt32LE(off + 4);
        if (t === 0x4E4F534A) j = JSON.parse(b.slice(off + 8, off + 8 + len).toString('utf8'));
        off += 8 + len;
      }
      for (const n of (j?.nodes || [])) {
        if (n.name && /^Prop_/.test(n.name)) shipped.set(n.name, path.basename(g));
      }
    }
    // ★ SPLITTING A CSV ON `,` SILENTLY EXEMPTS EVERY QUOTED ROW FROM THE LICENCE TEST. Five
    //   rows here carry a comma inside a quoted description, so a naive split put a fragment of
    //   the description in the licence column — never one of the approved words, never equal to
    //   a shipped prop name either, so the row simply fell out of both tests rather than failing
    //   one. Found by tallying the licence column and reading the tally: `cities`, `ears`,
    //   `freeze`, `graticule`, `patrol`. A check with a parser bug is a check with a hole in it.
    const splitCsv = (line) => {
      const out = []; let cur = '', q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { q = !q; continue; }
        if (c === ',' && !q) { out.push(cur); cur = ''; continue; }
        cur += c;
      }
      out.push(cur);
      return out;
    };
    const rows = fs.readFileSync(csvPath, 'utf8').trim().split('\n').slice(1).map(splitCsv);
    const APPROVED = ['royalty_free', 'cc_zero', 'original'];
    const known = new Set(rows.map((r) => r[0]));
    const unlisted = [...shipped.keys()].filter((n) => !known.has(n));
    const badLicence = rows.filter((r) => shipped.has(r[0]) && !APPROVED.includes(r[2]));
    // ★ DP-W3 SHIPS ASSETS THAT ARE IN NO .glb AT ALL. The conveyor, the jars and the
    //   corner dressing are procedural originals built by a module, so the node scan above
    //   cannot see them — the same blind spot, one step further out, that let the floor lamp
    //   through when this check read only props.glb. An `original` row therefore has to
    //   point at the source that builds it, and that source has to still be there: a row
    //   naming a deleted module is provenance for an asset nobody can inspect.
    //   Blender-authored originals (the LCD chrome, the radio) legitimately have no source
    //   PATH — they live in the .blend — so the rule is "a row that names a path must name a
    //   path that exists", not "every original must name one". Demanding a path from all of
    //   them turned 33 correct rows red on the first run of this check.
    const originalRows = rows.filter((r) => r[2] === 'original' && r[4] && !/^https?:/i.test(r[4]));
    const originalMissing = originalRows.filter((r) => !fs.existsSync(path.join(REPO, r[4])));
    const ok = unlisted.length === 0 && badLicence.length === 0 && originalMissing.length === 0;
    add('asset licensing', ok,
      ok ? `all ${shipped.size} shipped props across ${glbs.length} glb(s) are royalty_free/cc_zero/original`
           + (originalMissing.length ? ` — ⚠ ${originalMissing.length} original row(s) name a source file that is gone`
                                     : `; ${originalRows.length} code-built original(s) trace to a live source file`)
         : `${unlisted.length} prop(s) with no provenance row (` +
           unlisted.slice(0, 4).map((n) => `${n} in ${shipped.get(n)}`).join(', ') + `); ` +
           `${badLicence.length} with a non-approved licence (` +
           badLicence.slice(0, 3).map((r) => r[0] + '=' + r[2]).join(', ') + `); ` +
           `${originalMissing.length} original row(s) whose source is missing (` +
           originalMissing.slice(0, 3).map((r) => r[0] + '->' + (r[4] || 'no path')).join(', ') + ')',
      'every shipped Prop_* listed, licence in {royalty_free, cc_zero, original}');
  }
}

// ── audio licensing (DP-W7) ───────────────────────────────────────────────────
// ★ THE PROP SCAN CANNOT SEE A SOUND. It walks glTF nodes named Prop_*, so an audio file is
//   invisible to it — the same blind spot that let the floor lamp through when the check read one
//   glb, and that DP-W3's code-built assets needed the `original` source-path rule for. Audio is
//   the third step out: files in the payload that appear in no scene graph at all.
//   PLAN §3 binds them exactly as it binds a mesh, and this row exists because the audio the
//   prototype folder offered was NOT all usable — three of its files are CC-BY.
//   The row key is the FILENAME without its extension, so the binding is mechanical.
{
  const csvPath = path.join(REPO, 'asset-provenance.csv');
  const audioFiles = payloadFiles.filter((f) => /\.(m4a|mp3|ogg|wav|aac|opus|webm)$/i.test(f));
  if (fs.existsSync(csvPath) && audioFiles.length) {
    const splitCsv = (line) => {
      const out = []; let cur = '', q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { q = !q; continue; }
        if (c === ',' && !q) { out.push(cur); cur = ''; continue; }
        cur += c;
      }
      out.push(cur);
      return out;
    };
    const rows = fs.readFileSync(csvPath, 'utf8').trim().split('\n').slice(1).map(splitCsv);
    const byKey = new Map(rows.map((r) => [r[0], r]));
    const APPROVED = ['royalty_free', 'cc_zero', 'original'];
    const missing = [], bad = [], noSource = [];
    for (const f of audioFiles) {
      const key = path.basename(f).replace(/\.[^.]+$/, '');
      const row = byKey.get(key);
      if (!row) { missing.push(key); continue; }
      if (!APPROVED.includes(row[2])) { bad.push(`${key}=${row[2]}`); continue; }
      // A recording must name where it came from; an original must name a source that still
      // exists. Either way the row has to point at something a person can go and check.
      const src = row[4] || '';
      if (!src) noSource.push(key);
      else if (!/^https?:/i.test(src) && !fs.existsSync(path.join(REPO, src))) noSource.push(`${key}->${src}`);
    }
    const ok = !missing.length && !bad.length && !noSource.length;
    add('audio licensing', ok,
      ok ? `all ${audioFiles.length} shipped audio file(s) are royalty_free/cc_zero/original with a named source`
         : `${missing.length} with no provenance row (${missing.slice(0, 3).join(', ')}); `
           + `${bad.length} with a non-approved licence (${bad.slice(0, 3).join(', ')}); `
           + `${noSource.length} with no reachable source (${noSource.slice(0, 3).join(', ')})`,
      'every shipped audio file listed by filename, licence in {royalty_free, cc_zero, original}, source named');
  }
}

// ── report ────────────────────────────────────────────────────────────────────
const pass = checks.every((c) => c.pass);
if (JSON_OUT) {
  console.log(JSON.stringify({ loop: LOOP, pass, checks }, null, 2));
} else {
  console.log(`\nBUDGET CHECK (disk) — loops/${LOOP} — ${pass ? 'PASS' : 'FAIL'}`);
  for (const c of checks) {
    console.log(`  [${c.pass ? ' ok ' : 'FAIL'}] ${c.name.padEnd(22)} ${c.detail}\n${' '.repeat(31)}(${c.limit})`);
  }
  console.log(`\n  in-page half (draw calls, resident textures, pixel floor):`);
  console.log(`    node tools/dev-server.mjs 5173`);
  console.log(`    open http://localhost:5173/loops/${LOOP}/?budget=1  ->  await window.__budget.run()`);
}
process.exit(pass ? 0 : 1);
