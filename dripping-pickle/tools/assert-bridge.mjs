#!/usr/bin/env node
/**
 * assert-bridge — does the Loop keep its half of the shell contract? (W9, #44 PLT-006, #5, #141)
 *
 *   node tools/assert-bridge.mjs             # spawns the dev server; five entries + five pause/resume cycles
 *   node tools/assert-bridge.mjs --selftest  # plants three violations (ready, silence, belt catch-up); each must turn its check red
 *
 * WHY. The bridge is the one part of a web Loop a browser cannot exercise on its own, and every Gate B
 * bug that lived behind it (#101 audio never back, #103 hover dead in-app) was found on a device. The
 * dev server's `?shell=1` stand-in (tools/dev-server.mjs) makes it drivable; this rig drives it the
 * way the contract reads (loops-docs 30-engines/web/20 §3, 10-platform/30 §2–§3, 55 §5):
 *
 *   ENTRY ×5 — a web host is NON-RESIDENT (web 00-status: every entry is a fresh JS, GL and audio
 *   context), so "re-entry" is a fresh page. Each one: `ready` arrives after real frames with the
 *   declared cameras = loop.json's and the booted tier; the picture at ready is the lit room; a press
 *   is logged (#141); the scheduler's state equals a client that never left (no jump); the manifest
 *   source is named; nothing is written to persistent storage; `renderer.info.memory` is the same at
 *   every entry (no leak); zero page errors.
 *
 *   PAUSE/RESUME ×5 in ONE context — the sleep/wake the iPad does on a background (§3). Each cycle:
 *   pause = the audio suspended within 150 ms and the frame loop stopped; resume = the audio back
 *   (believing the promise), frames moving, the scheduler caught up to now with a state equal to a
 *   fresh client's, the belt caught up by the time it was away; `renderer.info.memory` flat across all
 *   five.
 *
 *   MUTE and CAMERAS — mute silences without stopping the world; a declared camera is confirmed, an
 *   undeclared one refused.
 *
 * ⚠ The stand-in is not the shell. What this proves is that the Loop answers the contract as written;
 *   what the shell actually sends is the device leg's to prove (W9's attended window).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELFTEST = process.argv.includes('--selftest');
const ENTRIES = 5, CYCLES = 5, PAUSE_MS = 3000, TIER = 'laptop';
const LIT_FLOOR = 45;   // budgets.json's pixel floor

// loop.json's cameras, read out of the script that writes it — the rig must disagree with the Loop
// the moment either side changes, so it never carries its own copy.
function loopJsonCameras() {
  const sh = fs.readFileSync(path.join(ROOT, 'tools/build-payload.sh'), 'utf8');
  const body = /cat > "\$STAGE\/loop\.json" <<JSON\n([\s\S]*?)\nJSON/.exec(sh)?.[1];
  if (!body) throw new Error('cannot find the loop.json heredoc in build-payload.sh');
  const json = JSON.parse(body.replace(/\$ENTRY/g, 'x').replace(/\$TIER_ASSETS/g, '[]'));
  return json.cameras.map((c) => ({ id: c.id, title: c.title }));
}

// Runs before any page script: counts animation frames, so "ready after real frames" is a number.
function installProbe(plant) {
  let frames = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => { frames++; cb(t); });
  window.__probe = { get frames() { return frames; }, framesAtReady: null };
  const armReady = () => {
    const c = window.collectivus; if (!c || c.__probed) return;
    c.__probed = true;
    const ready = c.ready;
    c.ready = function (o) {
      window.__probe.framesAtReady = frames;
      if (plant === 'ready') o = { ...(o || {}), cameras: (o?.cameras || []).slice(0, 1), tier: undefined };
      return ready.call(this, o);
    };
  };
  // the stand-in is an inline <script> in the document, so wrap it once it exists
  document.addEventListener('readystatechange', armReady);
  queueMicrotask(armReady);
  const trap = (name, wrap) => {
    let v; Object.defineProperty(window, name, { configurable: true, get: () => v, set: (x) => { v = x && wrap(x); } });
  };
  if (plant === 'silence') trap('__audio', (a) => ({ ...a, pause: () => {} }));
  if (plant === 'catchup') trap('__conveyor', (c) => { c.catchUp = () => 0; return c; });
}

async function openEntry(browser, origin, plant) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
  await page.addInitScript(installProbe, plant);
  const t0 = Date.now();
  await page.goto(origin + `loops/dripping-pickle/?shell=1&device=${TIER}`, { waitUntil: 'domcontentloaded' });
  const ready = await page.waitForFunction(() => window.__shell?.ready, null, { timeout: 180000 }).then(() => true, () => false);
  return { context, page, errors, ready, readyMs: Date.now() - t0 };
}

// The scheduler a client that NEVER LEFT would hold at this second, against the live one.
const noJump = () => (async () => {
  const { RunOfShow } = await import('../../tools/events/runofshow.js');
  const ev = window.__events;
  ev.resume();                                   // the live client, caught up to now
  const s = ev.sched.lastEvaluated;
  const seed = await fetch('../../assets/dripping-pickle/run-of-show.json').then((r) => r.json());
  const fresh = new RunOfShow({ manifest: seed, defs: ev.defs, nowSecond: s });
  fresh.advanceTo(s);
  return { live: ev.sched.stateFingerprint(), fresh: fresh.stateFingerprint(), lagSec: Math.floor(Date.now() / 1000) - s };
})();

const litOf = (page) => page.evaluate(() => {
  const r = window.__rt.renderer, gl = r.getContext();
  window.__rt.renderFrame(performance.now() / 1000);
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let lit = 0, n = 0;
  for (let i = 0; i < px.length; i += 4 * 16) { n++; if ((0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255 > 0.08) lit++; }
  return +(100 * lit / n).toFixed(1);
});

const memOf = (page) => page.evaluate(() => {
  const i = window.__rt.renderer.info;
  return { geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs?.length ?? null };
});

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
  return ok;
};

async function entries(browser, origin, plant, n) {
  const cams = loopJsonCameras();
  const mems = [];
  for (let k = 1; k <= n; k++) {
    console.log(`\n== entry ${k} of ${n} ==`);
    const { context, page, errors, ready, readyMs } = await openEntry(browser, origin, plant);
    if (!check('ready arrived', ready, `${(readyMs / 1000).toFixed(1)} s after navigation`)) { await context.close(); continue; }
    const sh = await page.evaluate(() => ({ info: window.__shell.readyInfo, log: window.__shell.log, frames: window.__probe.framesAtReady, changed: window.__shell.changed }));
    check('ready came after real frames', sh.frames >= 3, `${sh.frames} animation frames before ready (the Loop waits two through its own loop, then one more)`);
    const got = (sh.info.cameras || []).map((c) => ({ id: c.id, title: c.title }));
    check('ready cameras = loop.json cameras', JSON.stringify(got) === JSON.stringify(cams), got.map((c) => `${c.id} "${c.title}"`).join(', ') || 'none');
    check(`ready says the tier it booted (asked for ${TIER})`, sh.info.tier === TIER, `tier ${sh.info.tier}`);
    check('the opening shot is reported', sh.changed[0] === 'room', `cameraChanged: ${sh.changed.join(', ') || 'none'}`);
    // The event engine starts just after `ready` (its library is fetched once the room is up), so
    // its line is read after the settle, not at ready.
    await page.waitForTimeout(1500);
    const log2 = await page.evaluate(() => window.__shell.log);
    check('the run of show names its source', log2.some((l) => /run of show seed \(shell has no runOfShow\(\)\)/.test(l)),
      log2.find((l) => /run of show/.test(l))?.replace(/^dripping-pickle: /, '').slice(0, 110) || 'no events line');
    const lit = await litOf(page);
    check('the picture after ready is the lit room', lit >= LIT_FLOOR, `${lit}% lit (floor ${LIT_FLOOR}%)`);
    await page.evaluate(() => window.__shell.tap(0.5, 0.5));
    await page.waitForTimeout(200);
    const pressed = await page.evaluate(() => window.__shell.log.filter((l) => /primary down/.test(l)));
    check('a primary press is logged (#141)', pressed.length === 1, pressed[0] || 'no line');
    const j = await page.evaluate(noJump);
    check('scheduler = a client that never left (no jump)', j.live === j.fresh && j.lagSec <= 1, `${j.live.split(',').length} state entries, lag ${j.lagSec} s`);
    const stored = await page.evaluate(async () => ({
      local: localStorage.length, session: sessionStorage.length,
      idb: (await indexedDB.databases?.())?.length ?? 0,
    }));
    check('nothing written to persistent storage', !stored.local && !stored.session && !stored.idb, `localStorage ${stored.local}, sessionStorage ${stored.session}, IndexedDB ${stored.idb}`);
    await page.waitForTimeout(3000);
    mems.push(await memOf(page));
    check('zero page errors', errors.length === 0, errors[0] || 'none');
    await context.close();
  }
  // ⚠ NOT "identical": a fresh page at a different second shows different scheduled content — an
  //   in-flight event adds a panel or a fallen jar — and a W9 run read 409g/214t/126p four times and
  //   411g/215t/127p once. A fresh page cannot inherit from the one before it, so a LEAK across
  //   entries would climb; what is asserted is that no entry exceeds the first by more than one
  //   event's worth (4 of each) and that the counts do not climb entry over entry.
  const tol = 4, over = (m) => m.geometries - mems[0].geometries > tol || m.textures - mems[0].textures > tol || m.programs - mems[0].programs > tol;
  const climbs = mems.length === n && mems.every((m, i) => i === 0 || (m.geometries > mems[i - 1].geometries && m.textures > mems[i - 1].textures));
  console.log('');
  check(`renderer.info.memory does not climb across ${n} entries (no leak)`, mems.length === n && !mems.some(over) && !climbs,
    mems.map((m) => `${m.geometries}g/${m.textures}t/${m.programs}p`).join(' · '));
}

async function cycles(browser, origin, plant, n) {
  console.log(`\n== pause / resume ×${n}, one context ==`);
  const { context, page, errors, ready } = await openEntry(browser, origin, plant);
  if (!check('ready arrived', ready)) { await context.close(); return; }
  await page.waitForTimeout(3000);
  const before = await memOf(page);
  for (let k = 1; k <= n; k++) {
    await page.evaluate(() => window.__shell.pause());
    await page.waitForTimeout(150);
    const p = await page.evaluate(() => ({ paused: window.__audio.paused, state: window.__audio.contextState, f: window.__probe.frames }));
    await page.waitForTimeout(PAUSE_MS);
    const f2 = await page.evaluate(() => window.__probe.frames);
    check(`cycle ${k}: pause is silence at once`, p.paused && p.state === 'suspended', `paused ${p.paused}, context ${p.state} 150 ms after pause`);
    // the frame loop is three's setAnimationLoop; a stopped loop asks for no more frames (±1 in flight)
    const logBefore = await page.evaluate(() => window.__shell.log.length);
    await page.evaluate(() => window.__shell.resume());
    await page.waitForTimeout(1200);
    const r = await page.evaluate((lb) => ({
      paused: window.__audio.paused, state: window.__audio.contextState, f: window.__probe.frames,
      caught: window.__shell.log.slice(lb).find((l) => /belt caught up/.test(l)) || null,
    }), logBefore);
    check(`cycle ${k}: the frame loop stopped while paused and runs after`, f2 - p.f <= 1 && r.f - f2 > 5, `${f2 - p.f} frames during ${PAUSE_MS / 1000} s paused, ${r.f - f2} in 1.2 s after`);
    check(`cycle ${k}: resume puts the sound back (the promise believed)`, !r.paused && r.state === 'running', `paused ${r.paused}, context ${r.state}`);
    const secs = r.caught ? parseFloat(/up ([\d.]+) s/.exec(r.caught)[1]) : 0;
    // At least the pause, and not wildly more: a belt already behind from load-time frame clamps
    // (dt is clamped to 0.1 s) catches that up too — measured 3.1-4.2 s after 3 s pauses.
    check(`cycle ${k}: the belt caught up by the time it was away`, secs >= PAUSE_MS / 1000 - 0.2 && secs < PAUSE_MS / 1000 + 3, r.caught ? `${secs} s` : 'no catch-up');
    const j = await page.evaluate(noJump);
    check(`cycle ${k}: scheduler = a client that never slept`, j.live === j.fresh && j.lagSec <= 1, `lag ${j.lagSec} s`);
  }
  await page.waitForTimeout(2000);
  const after = await memOf(page);
  check(`renderer.info.memory flat across ${n} cycles`, JSON.stringify(before) === JSON.stringify(after),
    `${before.geometries}g/${before.textures}t/${before.programs}p → ${after.geometries}g/${after.textures}t/${after.programs}p`);

  console.log('\n== mute, and the cameras ==');
  const f0 = await page.evaluate(() => window.__probe.frames);
  await page.evaluate(() => window.__shell.mute(true, 0));
  await page.waitForTimeout(600);
  const m = await page.evaluate(() => ({ muted: window.__audio.muted, paused: window.__audio.paused, f: window.__probe.frames }));
  check('mute silences without stopping the world', m.muted && !m.paused && m.f - f0 > 5, `muted ${m.muted}, paused ${m.paused}, ${m.f - f0} frames in 0.6 s`);
  await page.evaluate(() => window.__shell.mute(false, 1));
  await page.evaluate(() => window.__shell.camera('screens'));
  await page.waitForTimeout(4000);
  await page.evaluate(() => window.__shell.camera('not-a-camera'));
  await page.waitForTimeout(300);
  const c = await page.evaluate(() => ({ changed: window.__shell.changed, refused: window.__shell.log.some((l) => /refused undeclared camera not-a-camera/.test(l)) }));
  check('a declared camera is confirmed on arrival', c.changed.at(-1) === 'screens', `cameraChanged: ${c.changed.join(' → ')}`);
  check('an undeclared camera is refused, not approximated', c.refused && c.changed.at(-1) === 'screens');
  await page.evaluate(() => window.__shell.camera('room'));
  check('zero page errors', errors.length === 0, errors[0] || 'none');
  await context.close();
}

async function withServer(fn) {
  const port = 5300 + Math.floor(Math.random() * 400);
  const server = spawn(process.execPath, [path.join(ROOT, 'tools/dev-server.mjs'), String(port)], { cwd: ROOT, stdio: 'ignore' });
  const origin = `http://127.0.0.1:${port}/`;
  for (let t = Date.now(); Date.now() - t < 15000;) {
    try { if ((await fetch(origin + 'budgets.json')).ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  try { return await fn(origin); } finally { server.kill(); }
}

const LAUNCH = { args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--autoplay-policy=no-user-gesture-required'] };

await withServer(async (origin) => {
  const browser = await chromium.launch(LAUNCH);
  try {
    if (!SELFTEST) {
      console.log(`assert-bridge — ${origin} (shell stand-in, bridge v3, device tier ${TIER})`);
      await entries(browser, origin, null, ENTRIES);
      await cycles(browser, origin, null, CYCLES);
      console.log(failures ? `\nFAIL — ${failures} check(s)` : '\nPASS — the Loop keeps its half of the bridge');
      return;
    }
    // Each plant must turn exactly its own check red. A rig that stays green here is not measuring.
    const plants = [
      ['ready', 'ready drops a camera and the tier', (fn) => entries(browser, origin, 'ready', 1), /ready cameras|tier it booted/],
      ['silence', 'pause does not silence', (fn) => cycles(browser, origin, 'silence', 1), /pause is silence/],
      ['catchup', 'the belt does not catch up', (fn) => cycles(browser, origin, 'catchup', 1), /belt caught up/],
    ];
    let caught = 0;
    for (const [id, what, run, want] of plants) {
      console.log(`\n### PLANT ${id}: ${what}`);
      const lines = [];
      const log = console.log; console.log = (s = '') => { lines.push(String(s)); log(s); };
      const f0 = failures;
      await run();
      console.log = log;
      const red = lines.filter((l) => l.includes('[FAIL]'));
      const ok = failures > f0 && red.some((l) => want.test(l));
      console.log(`### ${ok ? 'CAUGHT' : 'MISSED'} — ${red.length} red line(s)`);
      if (ok) caught++;
    }
    console.log(`\nSELFTEST ${caught === plants.length ? 'PASS' : 'FAIL'} — ${caught}/${plants.length} plants caught`);
    failures = caught === plants.length ? 0 : 1;
  } finally { await browser.close(); }
});
process.exit(failures ? 1 : 0);
