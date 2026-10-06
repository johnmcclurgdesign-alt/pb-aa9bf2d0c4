// Does every name on the phone's cut list still paint NOTHING a viewer can see?
//
// ★ WHY THIS IS A GATE. tools/phone-cuts.js deletes draws on the phone — the one place PLAN §2's
//   "a tier hides, it does not delete" is suspended (PROGRAM decision 16), and only for objects a
//   loop-camera ray never reaches. The evidence for each name was taken on one build. A re-dress
//   moves a prop, a new prop joins a merge bucket and renames it, a camera pose is re-framed — and
//   the list goes on hiding whatever now carries that name, on a device nobody is watching from a
//   desk. So the evidence is re-taken, not remembered.
//
// ★ TWO TESTS, BECAUSE EITHER ALONE PASSES A VISIBLE CUT (docs/lessons/
//   is-it-seen-is-an-id-pass-not-a-bounding-box).
//   1. An ID PASS over the room pose's exact beauty draw list, at both declared camera poses and
//      at 129 points walked along the flight between them: every cut must paint 0 px in every
//      sample. It cannot see a shadow, and it cannot see glass (depthWrite false lets
//      what is behind overwrite its id) — which is why:
//   2. the LIT FRAME, at both poses, with every cut hidden at once must not move a pixel by more
//      than 2/255, comparing per-pixel medians of five grabs. Two controls first, every time: null
//      (two independent medians of the untouched frame) must move 0, and alive
//      (hide a wall that is in the picture) must move thousands
//      (docs/lessons/prove-the-differ-before-you-believe-it).
//
//   node tools/phone-cuts-check.mjs [url]
//   node tools/phone-cuts-check.mjs --selftest          # plants a visible wall, requires the id pass's red
//   node tools/phone-cuts-check.mjs --selftest-shadow   # plants a draw that paints 0 px but casts a
//                                                       # visible shadow, requires the LIT half's red
//   node tools/phone-cuts-check.mjs --selftest-drift    # plants the LED only the FLIGHT between the
//                                                       # two cameras reveals, requires the id pass's red
//
// Needs a server on :5181 serving this tree (node tools/dev-server.mjs 5181).

import { chromium } from 'playwright';
import { PHONE_CUTS } from './phone-cuts.js';

const SHADOW_TEST = process.argv.includes('--selftest-shadow');
const DRIFT_TEST = process.argv.includes('--selftest-drift');
const SELFTEST = SHADOW_TEST || DRIFT_TEST || process.argv.includes('--selftest');
const URL = process.argv.find((a) => a.startsWith('http')) ||
  // phonecut=0: the cuts must be DRAWN to be measured. tvvideo/screensaver off: a video texture
  // advances without the frame loop and would move a null control (walk-states-check's note).
  'http://localhost:5181/loops/dripping-pickle/?shell=1&tierlevel=5&phonecut=0&tvvideo=0&screensaver=0';
const ALIVE = 'Merged:modular_factory_facade_brick_60:8';   // the back wall — always in the picture
// The shadow plant is BUD4's own finding: 0 px in every id pass, 304 px of shadow in the lit frame.
// The flight plant is the one that got through: 0 px at both rest poses, 1 px somewhere in flight.
const PLANT = SHADOW_TEST ? 'Merged:M_DPW_Metal:5' : DRIFT_TEST ? 'Prop_Weird_Russian_Device001_10' : ALIVE;
const MIN_ALIVE_PX = 1000;
const LIT_TOL = 2;          // /255, per channel — below this is resample noise, not a picture

const names = SELFTEST ? [...PHONE_CUTS, PLANT] : PHONE_CUTS;
const browser = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(URL, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__rt && window.__tv && window.__tier, null, { timeout: 240000 });
await page.waitForTimeout(5000);

// The room pose's beauty draw list: one plain layer-0 render, recording what three actually drew.
const listed = await page.evaluate((names) => {
  const { renderer } = window.__rt; const scene = window.__rt.rig.parent;
  const camera = scene.getObjectByProperty('isCamera', true);
  const drawn = new Set(); const orig = renderer.renderBufferDirect.bind(renderer);
  renderer.renderBufferDirect = (c, s, g, m, o, gr) => { drawn.add(o); return orig(c, s, g, m, o, gr); };
  renderer.render(scene, camera);
  renderer.renderBufferDirect = orig;
  window.__pcDraws = [...drawn];
  const found = new Set(); scene.traverse((o) => { if (o.isMesh && o.visible && names.includes(o.name)) found.add(o.name); });
  return { draws: drawn.size, missing: names.filter((n) => !found.has(n)) };
}, names);

// One id pass over that list, synchronous: returns the pixel count per listed name.
// ★ THE FLIGHT IS WALKED, NOT WAITED FOR. The first version sampled the camera's flight between
//   the two declared poses on a wall clock (30 grabs, 150 ms apart) and a 14-triangle LED that
//   the flight passes by one pixel got through it — then a later run happened to catch it. The
//   flight is a straight lerp of position AND orbit target (tools/flyto.js), so each pass takes
//   k in [0, 1] and puts the camera exactly there. (There is no sway to sample: the shipping
//   entry's drift is 0 — `?drift` defaults to it — and a render from outside the frame loop
//   never sees a drift anyway, because the loop removes it after its own render.)
const idPass = (k) => page.evaluate(({ names, k }) => {
  const { renderer } = window.__rt; const scene = window.__rt.rig.parent;
  const camera = scene.getObjectByProperty('isCamera', true);
  const ctl = window.__rt.controls, P = window.__pcPoses;
  const savedPos = camera.position.clone(), savedQ = camera.quaternion.clone();
  if (k !== null) {
    camera.position.lerpVectors(P.room.pos, P.screens.pos, k);
    camera.lookAt(P.room.tgt.clone().lerp(P.screens.tgt, k));
    camera.updateMatrixWorld(true);
  }
  const moved = P ? camera.position.distanceTo(P.room.pos) : 0;
  const list = window.__pcDraws;
  let Basic = null; scene.traverse((o) => { if (!Basic && o.material?.type === 'MeshBasicMaterial') Basic = o.material.constructor; });
  const saved = list.map((o) => o.material);
  list.forEach((o, i) => {
    const id = i + 1, m = new Basic({ fog: false, toneMapped: false });
    m.color.setRGB(((id >> 16) & 255) / 255, ((id >> 8) & 255) / 255, (id & 255) / 255);
    const s = Array.isArray(saved[i]) ? saved[i][0] : saved[i];
    if (s) { m.side = s.side; m.depthWrite = s.depthWrite; m.depthTest = s.depthTest; }
    o.material = m;
  });
  const bg = scene.background, tm = renderer.toneMapping, cs = renderer.outputColorSpace;
  scene.background = null; renderer.toneMapping = 0; renderer.outputColorSpace = 'srgb-linear';
  const W = 1280, H = 720, gl = renderer.getContext();
  renderer.setPixelRatio(1); renderer.setSize(W, H, false);
  renderer.setRenderTarget(null); renderer.setClearColor(0x000000, 1); renderer.clear();
  renderer.render(scene, camera);
  const buf = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  list.forEach((o, i) => { o.material.dispose(); o.material = saved[i]; });
  scene.background = bg; renderer.toneMapping = tm; renderer.outputColorSpace = cs;
  window.dispatchEvent(new Event('resize'));
  const counts = new Array(list.length).fill(0);
  for (let q = 0; q < buf.length; q += 4) { const id = (buf[q] << 16) | (buf[q + 1] << 8) | buf[q + 2]; if (id && id <= list.length) counts[id - 1]++; }
  camera.position.copy(savedPos); camera.quaternion.copy(savedQ); camera.updateMatrixWorld(true);
  const out = { __moved: moved }; list.forEach((o, i) => { if (names.includes(o.name)) out[o.name] = (out[o.name] || 0) + counts[i]; });
  return out;
}, { names, k });

const worst = Object.fromEntries(names.map((n) => [n, 0]));
let samples = 0;
let swayMax = 0;
const take = async (k = null) => { const r = await idPass(k); samples++; swayMax = Math.max(swayMax, r.__moved); delete r.__moved; for (const n in r) worst[n] = Math.max(worst[n], r[n]); };
// The two rest poses, read off the live camera and its orbit target once each has landed.
const pose = () => page.evaluate(() => { const c = window.__rt.rig.parent.getObjectByProperty('isCamera', true); return { pos: c.position.toArray(), tgt: window.__rt.controls.target.toArray() }; });
const land = () => page.waitForFunction(() => !window.__rt.controls.enabled ? false : true, null, { timeout: 20000 }).then(() => page.waitForTimeout(1500));

// The lit frame at a FROZEN t with the loop stopped, all cuts hidden at once, and two controls.
const litDiff = (pose) => page.evaluate(({ names, alive, pose }) => {
  const { renderer } = window.__rt; const scene = window.__rt.rig.parent;
  renderer.setAnimationLoop(null);
  const T = 1234.5;
  const byName = (list) => { const out = []; scene.traverse((o) => { if (o.isMesh && o.visible && list.includes(o.name)) out.push(o); }); return out; };
  const grab1 = () => { window.__rt.renderFrame(T); const src = renderer.domElement; const c = document.createElement('canvas'); c.width = 640; c.height = 360; const x = c.getContext('2d'); x.drawImage(src, 0, 0, 640, 360); return x.getImageData(0, 0, 640, 360).data; };
  // ★ A FROZEN FRAME IS NOT A REPEATABLE FRAME. Forty grabs of the same state at the same t move
  //   0-12 px by up to 25/255 against the first (measured 2026-09-22; n8ao advances its noise per
  //   render) — so a single null control that reads 0 is luck, and it read 0 the first time this
  //   gate ran, while two single cuts then "moved" 2 and 13 px that all 17 together did not. The
  //   comparison is between per-pixel MEDIANS of five grabs: a real change is in every grab, the
  //   noise is in one or two, and the null control is two independent medians.
  const grab = () => {
    const k = 5, fr = []; for (let i = 0; i < k; i++) fr.push(grab1());
    const out = new Uint8ClampedArray(fr[0].length), v = new Array(k);
    for (let i = 0; i < out.length; i++) { for (let j = 0; j < k; j++) v[j] = fr[j][i]; v.sort((a, b) => a - b); out[i] = v[k >> 1]; }
    return out;
  };
  const diff = (a, b) => { let n = 0, mx = 0; for (let i = 0; i < a.length; i += 4) { const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])); if (d > 2) n++; mx = Math.max(mx, d); } return { moved: n, max: mx }; };
  const base = grab();
  const nul = diff(base, grab());
  const a = byName([alive]); a.forEach((o) => { o.visible = false; }); const al = diff(base, grab()); a.forEach((o) => { o.visible = true; });
  const h = byName(names); h.forEach((o) => { o.visible = false; }); const cut = diff(base, grab()); h.forEach((o) => { o.visible = true; });
  return { pose, null: nul, alive: al, cut, hidden: h.length };
}, { names, alive: ALIVE, pose });

const lit = [];
const roomPose = await pose();
await take();                                                                              // the room pose
lit.push(await litDiff('room'));
await page.evaluate(() => window.__rt.startLoop());
await page.evaluate(() => { window.__tv.setView('screens'); });
await land();
const screensPose = await pose();
await take();                                                                              // the screens pose
lit.push(await litDiff('screens'));
await page.evaluate(({ a, b }) => {
  const V = window.__rt.rig.parent.getObjectByProperty('isCamera', true).position.constructor;
  window.__pcPoses = { room: { pos: new V(...a.pos), tgt: new V(...a.tgt) }, screens: { pos: new V(...b.pos), tgt: new V(...b.tgt) } };
}, { a: roomPose, b: screensPose });
const STEPS = 128;
for (let i = 0; i <= STEPS; i++) await take(i / STEPS);                                    // the flight, walked exactly
await browser.close();

console.log(`phone-cuts-check — ${names.length} names, ${listed.draws} beauty draws at the room pose, ${samples} id passes`);
const fails = [];
// ★ A FLIGHT THAT DOES NOT MOVE THE CAMERA IS A GATE THAT SAMPLES THE REST POSE 130 TIMES.
console.log(`  the walked flight moved the camera up to ${swayMax.toFixed(2)} m from the room pose`);
if (swayMax < 0.1) fails.push(`the walked flight moved the camera ${swayMax.toFixed(3)} m — the flight is not being sampled, so no zero here is evidence`);
if (listed.missing.length) fails.push(`not in the scene (the room changed, or a merge bucket was renamed): ${listed.missing.join(', ')}`);
for (const n of names) {
  const px = worst[n];
  console.log(`  ${px === 0 ? 'ok  ' : 'FAIL'}  ${n.padEnd(50)} worst ${px} px`);
  if (px > 0) fails.push(`${n} painted ${px} px in at least one sample — a loop-camera ray reaches it`);
}
for (const r of lit) {
  console.log(`  lit ${r.pose.padEnd(8)} null ${r.null.moved} px · alive ${r.alive.moved} px · all cuts hidden (${r.hidden}): ${r.cut.moved} px, max ${r.cut.max}/255`);
  if (r.null.moved !== 0) fails.push(`${r.pose}: the null control moved ${r.null.moved} px — the differ is not deterministic, no number here is safe`);
  if (r.alive.moved < MIN_ALIVE_PX) fails.push(`${r.pose}: the alive control moved only ${r.alive.moved} px — the differ is dead`);
  if (r.cut.moved > 0 && r.cut.max > LIT_TOL) fails.push(`${r.pose}: hiding the cuts moved ${r.cut.moved} px (max ${r.cut.max}/255) of the LIT frame — a shadow, glass, or a visible cut`);
}
if (errors.length) fails.push(`${errors.length} page error(s): ${errors[0]}`);

if (SELFTEST) {
  const hit = SHADOW_TEST ? fails.find((f) => f.includes('of the LIT frame')) : fails.find((f) => f.startsWith(PLANT));
  // the drift plant must be caught by the id pass, and by nothing else
  if (DRIFT_TEST && hit && fails.some((f) => f.includes('of the LIT frame'))) console.log('  (the lit half also moved — fine, the id pass is what this plant tests)');
  if (!hit) { console.error(`\nSELFTEST FAILED — ${PLANT} planted in the list was not caught`); process.exit(2); }
  if (SHADOW_TEST && fails.some((f) => f.startsWith(PLANT))) { console.error(`\nSELFTEST FAILED — the shadow plant was caught by the id pass, so the lit half was not what caught it`); process.exit(2); }
  console.log(`\nSELFTEST PASS — ${PLANT} was caught: ${hit}`);
  process.exit(0);
}
if (fails.length) { console.error('\nphone-cuts-check FAILED:\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1); }
console.log('\nphone-cuts-check: every cut paints nothing at either camera or anywhere in the flight between, lit or by id');
