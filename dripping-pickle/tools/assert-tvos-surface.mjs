// THE tvOS SURFACE ASSERT — Dripping Pickle's port of Vibes' tools/assert-tvos-surface.mjs
// (CMP1, 2026-09-12; the original is VC-058, 2026-09-09).
//
// Apple TV runs a web Loop through the app's own JavaScriptCore + WebGL2 binding, not WebKit
// (loops-docs 30-engines/web/00-status.md §6). That environment is a SUBSET of a browser on
// purpose, and the subset is documented: no Canvas 2D, no WebAssembly, no Worker/Blob, no
// ConvolverNode, no dynamic import(), a minimal document whose elements have no functioning
// `style` object. Vibes: Collectivus v1.1.1 passed every rig it owned and black-screened at
// entry on every Apple TV 4K because nothing in its repo had ever run under that shape. Nothing
// in THIS repo had either: every rig here runs in a browser, and a browser has everything.
//
// This is the enforcement: a Playwright page whose environment is stripped to the binding's
// documented shape BEFORE the Loop's first script runs, driven through the APP ENTRY (no query
// flags — `no-flag-means-the-app`) at both declared cameras, asserting `ready` and zero page
// errors — plus a STATIC sweep of the shipping module graph for `getContext(` (§6: "make the
// grep a gate, not an instruction").
//
// What is stripped (each line a documented or proven absence, never a guess):
//   URL, Worker, Blob, WebAssembly           — §6 items 1 and 4; Blob and Worker still absent
//   Path2D, OffscreenCanvas,
//   CanvasRenderingContext2D, getContext('2d') → null — §6: THERE IS NO CANVAS 2D
//   AudioContext.prototype.createConvolver   — §6 item 3 (collectivus#122)
//   dynamic import()                         — §6: "No dynamic import()" — not emulated; enforced
//                                              STATICALLY (every import() classified, below)
//   element.style methods (minimal document) — a separate cell, TW16's shape: plain property
//                                              writes land, setProperty & co. are absent
//
// ⚠ This is a SHAPE test, not the binding. The authority for "will it run on a television" is
// the app repo's host harness (`packages/tvos-webgl-kit`, `LoopSession` with the real shims) —
// run it on the archive before any release issue. This assert exists so the answer is known on
// every rig run rather than at delivery. It cannot see memory pressure, texture formats or the
// presentation drawable.
//
// ⚠ A CONTROL RUNS FIRST. The unstripped app entry must reach `ready` in the same harness, or
// every stripped result is unattributable (loops-docs §3 rule 12: "never readied" with zero
// errors is byte-identical for a broken Loop and a busy runner). No control → NO RESULT, not red.
//
// ⚠ EVERY CHECK HAS BEEN WATCHED FAILING. `--selftest` serves tools/fixtures/tvos-shape/, proves
// the clean fixture passes every cell, then plants five violations one at a time and requires
// each to fail on the NAMED check; the static sweep is proved on a temporary two-file graph.
// ⚠ Dynamic import() CANNOT be refused by an init script, so that rule is enforced statically
// (every import() in the graph must be classified shipping or dev-only) and never by the page.
// A rig nobody has watched fail reports success when it is broken.
//
// Usage:
//   node tools/assert-tvos-surface.mjs                 the gate: sweep + control + 3 cells on the app entry
//   node tools/assert-tvos-surface.mjs --selftest      the fixture, clean and planted
//   node tools/assert-tvos-surface.mjs --pre-tvb1      + an INFORMATIONAL cell where getExtension()
//                                                      returns null for every name (the binding
//                                                      before app row TVB1) — reports, never gates
//   --url http://host:port/   drive an already-running server instead of spawning tools/dev-server.mjs
//   --browser webkit|chromium (default chromium; webkit is the engine that ships on iPhone/iPad/Mac)
//   --timeout <ms>            ready timeout per cell (default 120000 — a real Loop's cold start is
//                             shader compilation, not download; Vibes measured 25.9 s at 63 MB)
//
// Needs `npm install --no-save playwright@1.62.1` (⚠ in the SAME command as the pinned trio —
// a second --no-save install prunes the first; measured here 2026-09-12) and its browsers.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENTRY = 'loops/dripping-pickle/index.html';
// Dynamic imports the app entry takes with no flag set — they ARE the shipping graph.
// ⚠ EMPTY SINCE CMP2 (2026-09-13, #119), AND IT SHOULD STAY EMPTY. It held
// 'tools/render-merge.js' until that row made the import static; while it did, this rig
// reported "1 shipping, 4 dev-only" and passed — an allowlist quietly EXEMPTING the one
// thing loops-docs web §6 forbids outright ("No dynamic import()"). A shipping dynamic
// import is not a classification to record, it is a violation: anything added here is the
// finding, not the permission.
const SHIPPING_DYNAMIC = new Set([]);
// Dynamic imports gated behind ?dev=1 / ?review=1 / ?budget=1 / ?shadowaudit=1 — never loaded
// in the app, so not swept. A dynamic import in neither list fails the sweep: classify it.
const DEV_ONLY_DYNAMIC = new Set(['tools/feedback.js', 'tools/flycam.js', 'tools/budget-rig.js', 'tools/shadow-audit.js']);

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const has = (name) => args.includes(name);
const SELFTEST = has('--selftest');
const PRE_TVB1 = has('--pre-tvb1');
const BROWSER = flag('--browser', 'chromium');
const READY_MS = Number(flag('--timeout', 120000));
let url = flag('--url', null);

const results = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(52)} ${detail}`);
  results.push({ name, ok });
};
const info = (name, detail) => console.log(`info  ${name.padEnd(52)} ${detail}`);

// ── 1. THE STATIC SWEEP — the shipping module graph, not the payload ─────────────────────────
// The payload carries dev-only modules (budget-rig.js, feedback.js) that the app entry never
// imports, and vendor/ (three's own examples use Canvas 2D). Sweeping either would flag code
// that cannot run on the television. So: walk static imports from the entry, add the dynamic
// imports the app entry takes with no flag, stop at vendor/.
export function shippingGraph(root, entry) {
  const files = new Set();
  const unknownDynamic = [];
  const q = [entry];
  const re = /import\s*(?:[^'"()]*?\s*from\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while (q.length) {
    const f = q.shift();
    if (files.has(f)) continue;
    files.add(f);
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(re)) {
      const spec = m[1] ?? m[2];
      if (!spec || !spec.startsWith('.')) continue;            // bare specifiers resolve into vendor/
      const rel = path.normalize(path.join(path.dirname(f), spec)).split(path.sep).join('/');
      if (rel.startsWith('vendor/')) continue;
      if (m[2] !== undefined) {                                  // a dynamic import: classify it
        if (DEV_ONLY_DYNAMIC.has(rel)) continue;
        if (!SHIPPING_DYNAMIC.has(rel)) unknownDynamic.push(`${f} → import('${spec}')`);
      }
      if (!files.has(rel) && fs.existsSync(path.join(root, rel))) q.push(rel);
    }
  }
  return { files: [...files].sort(), unknownDynamic };
}

export function sweepGetContext(root, files) {
  const hits = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      // Strip comments so a rule quoted in prose ("getContext('2d') returns null") is not a hit.
      const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      const m = code.match(/getContext\(\s*(['"`])([^'"`]*)\1/);
      if (m && m[2] !== 'webgl2') hits.push(`${f}:${i + 1} getContext('${m[2]}')`);
      else if (/getContext\(\s*[^'"`)\s]/.test(code)) hits.push(`${f}:${i + 1} getContext(<non-literal>)`);
    });
  }
  return hits;
}

// ── 2. THE ENVIRONMENT STRIP — runs in the page BEFORE the Loop's first script ─────────────
function installTvosShape() {
  const strip = (obj, name) => {
    try { delete obj[name]; } catch { /* non-configurable — fall through */ }
    if (name in obj) { try { Object.defineProperty(obj, name, { value: undefined, configurable: true, writable: true }); } catch { /* leave it */ } }
  };
  for (const name of ['URL', 'Worker', 'Blob', 'WebAssembly', 'Path2D', 'OffscreenCanvas', 'CanvasRenderingContext2D']) strip(window, name);
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) strip(AC.prototype, 'createConvolver');
  const realGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
    // §6: the ONLY context a canvas can give you is 'webgl2'.
    if (kind !== 'webgl2') return null;
    return realGetContext.call(this, kind, ...rest);
  };
  window.__tvosShape = {
    url: typeof URL, worker: typeof Worker, blob: typeof Blob, wasm: typeof WebAssembly,
    convolver: AC ? typeof AC.prototype.createConvolver : 'no-audiocontext',
  };
}

// TW16's minimal document: an element's `style` accepts plain property assignment and has none
// of CSSStyleDeclaration's methods. The canvas keeps its real style so the renderer can size it.
function installMinimalDocument() {
  const realCreateElement = document.createElement.bind(document);
  document.createElement = (tagName, options) => {
    const el = realCreateElement(tagName, options);
    if (tagName && String(tagName).toLowerCase() !== 'canvas') {
      Object.defineProperty(el, 'style', { value: {}, writable: true, configurable: true });
    }
    return el;
  };
  // Elements that already exist in the entry HTML are found by getElementById; give them the
  // same shape, because the loading cover and the HUD are exactly those.
  const realGetById = document.getElementById.bind(document);
  document.getElementById = (id) => {
    const el = realGetById(id);
    if (el && el.tagName !== 'CANVAS' && !el.__minimal) {
      Object.defineProperty(el, 'style', { value: {}, writable: true, configurable: true });
      el.__minimal = true;
    }
    return el;
  };
}

// The binding before app row TVB1 (2026-09-11): getExtension() returned null for EVERY name.
// three r169 reads a compressed format's GL enum off the extension object, so an ASTC upload
// warns "Attempt to load unsupported compressed texture format" and uploads nothing.
function installPreTvb1() {
  const P = WebGL2RenderingContext.prototype;
  P.getExtension = function () { return null; };
  P.getSupportedExtensions = function () { return []; };
}

// The shell stub. The real shell injects `window.collectivus` before the first script; this
// records what the Loop tells it. It is the rig's, not the dev server's ?shell=1, so the same
// cell runs against any static origin and the fixture alike.
function installShellStub() {
  let handler = null; const queued = [];
  const S = window.__tvosShell = { ready: false, readyAt: 0, cameras: null, log: [], errors: [], changed: [],
    send(e) { if (handler) handler(e); else queued.push(e); } };
  window.collectivus = {
    bridgeVersion: 2,
    on(h) { handler = h; const q = queued.splice(0); q.forEach(h); },
    ready(o) { S.ready = true; S.readyAt = performance.now(); S.cameras = (o && o.cameras) || null; },
    log(m) { S.log.push(String(m)); },
    error(e) { S.errors.push(String((e && e.message) || e)); },
    cameraChanged(id) { S.changed.push(String(id)); },
  };
}

// ── 3. ONE CELL ─────────────────────────────────────────────────────────────────────────────
async function runCell(browser, label, target, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  const warnings = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (m.type() === 'warning') warnings.push(m.text());
  });
  await page.addInitScript(installShellStub);
  if (opts.strip) await page.addInitScript(installTvosShape);
  if (opts.minimal) await page.addInitScript(installMinimalDocument);
  if (opts.preTvb1) await page.addInitScript(installPreTvb1);
  const t0 = Date.now();
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  let stripped = true;
  if (opts.strip) {
    // Prove the strip took hold from OUTSIDE — never assume an init script ran.
    const shape = await page.evaluate(() => window.__tvosShape).catch(() => null);
    stripped = !!shape && shape.url === 'undefined' && shape.worker === 'undefined'
      && shape.blob === 'undefined' && shape.wasm === 'undefined' && shape.convolver === 'undefined';
    check(`${label}: environment stripped`, stripped, JSON.stringify(shape));
  }
  // Wait for ready — but a page error followed by ten seconds without ready is a verdict, not a
  // timeout: the entry module died, and waiting the full cold-start budget teaches nothing.
  const readyBudget = opts.readyMs ?? READY_MS;
  const ready = await (async () => {
    const start = Date.now();
    let firstErrorAt = 0;
    while (Date.now() - start < readyBudget) {
      if (await page.evaluate(() => window.__tvosShell?.ready === true).catch(() => false)) return true;
      if (errors.length && !firstErrorAt) firstErrorAt = Date.now();
      if (firstErrorAt && Date.now() - firstErrorAt > 10000) return false;
      await page.waitForTimeout(250);
    }
    return false;
  })();
  const readyMs = Date.now() - t0;
  await page.waitForTimeout(opts.settleMs ?? 2500);
  let shell = await page.evaluate(() => window.__tvosShell).catch(() => null);
  const first = errors[0] ? errors[0].split('\n')[0].slice(0, 160) : 'none';
  const errCount = errors.length + (shell?.errors.length ?? 0);
  if (opts.informational) {
    info(`${label}: reaches ready`, ready ? `ready in ${readyMs} ms` : `never reached ready (${readyMs} ms) — first error: ${first}`);
    info(`${label}: page errors`, `${errCount} (${first})`);
    const astc = warnings.filter((w) => /unsupported compressed texture format/i.test(w)).length;
    info(`${label}: "unsupported compressed texture format" warnings`, String(astc));
  } else {
    check(`${label}: reaches ready`, ready, ready ? `ready in ${readyMs} ms` : `never reached ready (${readyMs} ms) — first error: ${first}`);
    check(`${label}: zero page errors`, errCount === 0, errCount ? `${errCount} error(s): ${first}` : 'none');
    // ★ WHICH errors, by class (TV1, 2026-10-06). Once Canvas 2D was out, the stripped cell
    //   readied with every remaining error a texture the default cook's Basis images could not
    //   become: three's transcoder runs in a Worker built from a Blob, and the binding has
    //   neither — which is why the `-tvos-` cook is ETC2 and why reading it is TV2's (#132).
    //   The check above stays red for them; this line says whose red it is.
    if (errCount) {
      const all = [...errors, ...(shell?.errors ?? [])];
      const tex = all.filter((e) => /Couldn't load texture|KTX2Loader|transcoder|basis/i.test(e)).length;
      const other = all.filter((e) => !/Couldn't load texture|KTX2Loader|transcoder|basis/i.test(e));
      info(`${label}: errors by class`, `${tex} texture (Basis needs a Worker + Blob: TV2's ETC2 path) · ${other.length} other${other.length ? ' — first: ' + other[0].split('\n')[0].slice(0, 120) : ''}`);
    }
  }
  if (ready && opts.camera) {
    // The second declared camera: the shell asks, the Loop moves, and confirms with cameraChanged.
    const before = errCount;
    await page.evaluate((id) => window.__tvosShell.send({ type: 'camera', id }), opts.camera);
    await page.waitForTimeout(4000);
    shell = await page.evaluate(() => window.__tvosShell).catch(() => shell);
    const after = errors.length + (shell?.errors.length ?? 0);
    const confirmed = !!shell && shell.changed.includes(opts.camera);
    check(`${label}: camera '${opts.camera}' confirmed`, confirmed, confirmed ? `cameraChanged ${JSON.stringify(shell.changed)}` : `cameraChanged ${JSON.stringify(shell?.changed)}`);
    check(`${label}: zero errors after the camera switch`, after === before, after === before ? 'none' : `${after - before} new error(s): ${errors[errors.length - 1]?.split('\n')[0].slice(0, 160)}`);
  }
  await page.close();
  return { ready, errors, warnings, shell, readyMs };
}

// ── 4. THE ORIGIN — spawn the repo's own dev server unless one was given ───────────────────
async function withServer(fn) {
  if (url) return fn(url.replace(/\/?$/, '/'));
  const port = 5300 + Math.floor(Math.random() * 400);
  const server = spawn(process.execPath, [path.join(ROOT, 'tools/dev-server.mjs'), String(port)],
    { cwd: ROOT, env: { ...process.env, NO_AUTOPUSH: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = `http://127.0.0.1:${port}/`;
  const up = await new Promise((resolve) => {
    const deadline = Date.now() + 15000;
    const poll = async () => {
      try { const r = await fetch(origin + 'budgets.json'); if (r.ok) return resolve(true); } catch { /* not yet */ }
      if (Date.now() > deadline) return resolve(false);
      setTimeout(poll, 200);
    };
    poll();
  });
  if (!up) { server.kill(); throw new Error(`dev server did not answer on ${origin} within 15 s`); }
  try { return await fn(origin); } finally { server.kill(); }
}

async function launch() {
  const pw = await import('playwright');
  const engine = pw[BROWSER];
  if (!engine) throw new Error(`unknown --browser ${BROWSER}`);
  // Metal-backed ANGLE so the GPU does the work; SwiftShader would make a 4.5M-triangle Loop's
  // cold start a timing failure rather than a fact about the build.
  const launchArgs = BROWSER === 'chromium' ? { args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] } : {};
  return engine.launch(launchArgs);
}

// ── 5. THE GATE ─────────────────────────────────────────────────────────────────────────────
async function gate() {
  const graph = shippingGraph(ROOT, ENTRY);
  console.log(`shipping graph: ${graph.files.length} files from ${ENTRY} (vendor/ excluded; dev-only dynamic imports excluded: ${[...DEV_ONLY_DYNAMIC].join(', ')})`);
  // Two things must hold: every import() is classified, AND none is classified as shipping.
  check('tvos: every dynamic import() is classified', graph.unknownDynamic.length === 0,
    graph.unknownDynamic.length ? graph.unknownDynamic.join(' | ') : `${SHIPPING_DYNAMIC.size} shipping, ${DEV_ONLY_DYNAMIC.size} dev-only`);
  check('tvos: no dynamic import() in the shipping path', SHIPPING_DYNAMIC.size === 0,
    SHIPPING_DYNAMIC.size ? `${[...SHIPPING_DYNAMIC].join(', ')} — the binding resolves the import graph up front` : 'none');
  const hits = sweepGetContext(ROOT, graph.files);
  check('tvos: every getContext() in the shipping graph says webgl2', hits.length === 0,
    hits.length ? `${hits.length} hit(s): ${hits.slice(0, 4).join(' | ')}${hits.length > 4 ? ' …' : ''}` : 'no Canvas 2D in the shipping graph');

  const browser = await launch();
  try {
    await withServer(async (origin) => {
      const entry = origin + ENTRY;
      // The control: the SAME entry, unstripped, in the SAME harness. No control → no result.
      const control = await runCell(browser, 'control (unstripped app entry)', entry, {});
      if (!control.ready) {
        console.log('\nNO RESULT: the unstripped app entry did not reach ready in this harness, so a stripped failure would be unattributable (loops-docs web §3 rule 12). Check the runner load, the browser (--browser webkit), and --timeout before reading anything below.');
        results.length = 0;
        results.push({ name: 'control', ok: false });
        return;
      }
      await runCell(browser, 'tvos shape: app entry, room', entry, { strip: true, camera: 'screens' });
      await runCell(browser, 'minimal document: app entry', entry, { minimal: true });
      if (PRE_TVB1) {
        // Unstripped on purpose: with the strip on, the Canvas 2D death masks the question this
        // cell asks, which is what three r169 does when every extension is null.
        await runCell(browser, 'pre-TVB1 binding (getExtension → null, unstripped)', entry, { preTvb1: true, informational: true });
      }
    });
  } finally {
    await browser.close();
  }
}

// ── 6. THE SELFTEST — clean fixture passes, six plants each fail on the NAMED check ─────────
async function selftest() {
  // Static sweep against a temporary two-file graph: clean → 0 hits; planted → the one hit named.
  const tmp = fs.mkdtempSync(path.join(ROOT, '.tvos-selftest-'));
  try {
    fs.mkdirSync(path.join(tmp, 'a/b'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'a/b/index.html'), `<script type="module">import { x } from '../mod.js'; import('./dev.js');</script>`);
    fs.writeFileSync(path.join(tmp, 'a/mod.js'), `export const x = document.createElement('canvas').getContext('webgl2'); // getContext('2d') in a comment is not a hit\n`);
    fs.writeFileSync(path.join(tmp, 'a/b/dev.js'), `export const y = 1;\n`);
    let g = shippingGraph(tmp, 'a/b/index.html');
    check('selftest sweep: clean graph has no hits', sweepGetContext(tmp, g.files).length === 0, `${g.files.length} files`);
    check('selftest sweep: an unclassified dynamic import is caught', g.unknownDynamic.length === 1, g.unknownDynamic.join(' | ') || 'none caught');
    fs.appendFileSync(path.join(tmp, 'a/mod.js'), `export const g = document.createElement('canvas').getContext('2d');\n`);
    g = shippingGraph(tmp, 'a/b/index.html');
    const hits = sweepGetContext(tmp, g.files);
    check('selftest sweep: a planted getContext(\'2d\') is caught', hits.length === 1 && /mod\.js:2 getContext\('2d'\)/.test(hits[0]), hits.join(' | ') || 'none caught');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const browser = await launch();
  try {
    await withServer(async (origin) => {
      const fixture = origin + 'tools/fixtures/tvos-shape/index.html';
      const clean = await runCell(browser, 'selftest clean: stripped', fixture, { strip: true, settleMs: 500, readyMs: 15000 });
      const cleanMin = await runCell(browser, 'selftest clean: minimal document', fixture, { minimal: true, settleMs: 500, readyMs: 15000 });
      if (!clean.ready || !cleanMin.ready) return;
      // Each plant: the named check must go red, and the rest of the run must stay legible.
      const plants = [
        ['canvas2d', { strip: true }, (r) => !r.ready || r.errors.some((e) => /null|fillStyle/i.test(e))],
        ['url', { strip: true }, (r) => r.errors.some((e) => /URL/.test(e))],
        ['convolver', { strip: true }, (r) => r.errors.some((e) => /createConvolver/.test(e))],
        ['noready', { strip: true }, (r) => !r.ready],
        ['style', { minimal: true }, (r) => r.errors.some((e) => /setProperty/.test(e))],
      ];
      for (const [name, opts, expect] of plants) {
        const before = results.length;
        const r = await runCell(browser, `selftest plant=${name}`, `${fixture}?plant=${name}`, { ...opts, settleMs: 500, readyMs: 15000 });
        // The cell's own checks were EXPECTED to fail; fold them into one verdict on the plant.
        const own = results.splice(before);
        const red = own.some((c) => !c.ok);
        check(`selftest: plant '${name}' fails the named check`, red && expect(r),
          red ? `red on: ${own.filter((c) => !c.ok).map((c) => c.name.replace(`selftest plant=${name}: `, '')).join(', ')}` : 'stayed green — the check is decoration');
      }
    });
  } finally {
    await browser.close();
  }
}

if (SELFTEST) await selftest(); else await gate();

const failed = results.filter((r) => !r.ok);
console.log('');
if (failed.length) {
  console.log(`TVOS SURFACE ASSERT FAILED: ${failed.map((r) => r.name).join(', ')}`);
  console.log(`TVOS_FAILED_CHECKS=${failed.map((r) => r.name).join('|')}`);
  process.exit(1);
}
console.log(SELFTEST ? 'TVOS SURFACE SELFTEST PASS' : 'TVOS SURFACE ASSERT PASS');
