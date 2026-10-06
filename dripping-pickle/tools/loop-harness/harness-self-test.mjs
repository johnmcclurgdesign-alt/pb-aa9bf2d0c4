// harness-self-test.mjs — `node harness.mjs --self-test`. Every row of HARNESS.md is watched FAILING
// on a planted payload, and a known-good plant is watched passing all of them, before any verdict
// about a real Loop is trusted ([[calibrate-against-a-known-answer]]).
//
// The plants are built here, in memory, as real zips: the same zip reader, the same local origin,
// the same service-worker shim and the same instrument a real run uses. Nothing is downloaded.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChromium, verdictSelfTest } from './web-leg-verdicts.mjs';

const LOOP_JSON = (entry = 'index.html') => JSON.stringify({ manifestVersion: 1, entry, title: 'Harness plant' });

// A Loop that draws a moving colour field, subscribes, answers a press, and says ready.
const DRAWS = `
  const c = document.getElementById('c');
  c.width = innerWidth; c.height = innerHeight;
  const g = c.getContext('2d');
  function draw(t) {
    for (let x = 0; x < c.width; x += 6) {
      g.fillStyle = 'hsl(' + ((x + t / 10) % 360) + ' 70% 50%)';
      g.fillRect(x, 0, 6, c.height);
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);`;
const SUBSCRIBES = `
  collectivus.on(function (e) {
    if (e.type === 'input' && e.input.kind === 'primary' && e.input.phase === 'down') {
      collectivus.log('tap at ' + e.input.x.toFixed(2) + ',' + e.input.y.toFixed(2));
    }
  });`;
const page = (script, body = '<canvas id="c" style="width:100%;height:100%;display:block"></canvas>') =>
  `<!doctype html><html><head><meta charset="utf-8"></head>`
  + `<body style="margin:0;height:100vh;background:#000">${body}<script>${script}</script></body></html>`;

// ⚠ THE SHIM-LESS DOCUMENT IS A REAL WAY TO LOSE THE BRIDGE: a Loop that swaps its own document for
// a `blob:` one is same-origin but was never fetched through the service worker, so nothing injected
// `window.collectivus` into it. It fakes `ready` on the raw wire so the player keeps it mounted and
// the press can be measured — which is precisely the case the `input` row must name as "no shim".
const SHIMLESS = `
  var inner = '<!doctype html><body style="margin:0;background:#123"><canvas id="c" style="width:100%;height:100%"></canvas>'
    + '<scr' + 'ipt>' + ${JSON.stringify(DRAWS)} + ';parent.postMessage({source:"collectivus-loop",message:{type:"ready",info:{}}},location.origin)</scr' + 'ipt></body>';
  location.replace(URL.createObjectURL(new Blob([inner], { type: 'text/html' })));`;

// MEDIA6 — a Loop that will not say ready until its `boot` media file reads back through the lane.
const NEEDS_BOOT_MEDIA = `
  fetch('media/boot/palette.json').then(function (r) { return r.ok ? r.json() : null; }).then(function (p) {
    if (p && p.palette === 'ok') { ${DRAWS} collectivus.ready({}); }
  });${SUBSCRIBES}`;

const PLANTS = [
  { name: 'media-boot', media: 'good', entry: page(NEEDS_BOOT_MEDIA),
    expect: { open: 'PASS', ready: 'PASS', picture: 'PASS', page: 'PASS' },
    why: 'a Loop whose `boot` media file is served through the lane reads it and passes' },
  { name: 'media-corrupt', media: 'corrupt', entry: page(NEEDS_BOOT_MEDIA),
    expect: { open: 'FAIL' },
    why: 'a `boot` media file whose bytes fail sha256 FAILS `open` — the site does not open the Loop either' },
  { name: 'known-good', viewports: ['desktop', 'phone'], entry: page(`${DRAWS}${SUBSCRIBES} collectivus.ready({});`),
    expect: { open: 'PASS', ready: 'PASS', picture: 'PASS', input: 'PASS', exit: 'PASS', page: 'PASS', files: 'PASS' },
    why: 'a Loop that draws, subscribes and says ready passes every row at both viewports' },
  { name: 'blank', entry: page(`${SUBSCRIBES} collectivus.ready({});`, ''),
    expect: { picture: 'FAIL', ready: 'PASS', input: 'PASS' },
    why: 'a Loop that says ready and draws nothing FAILS `picture`' },
  { name: 'never-ready', entry: page(`${DRAWS}${SUBSCRIBES}`),
    expect: { open: 'PASS', ready: 'FAIL', exit: 'FAIL' },
    why: 'a Loop that never says ready FAILS `ready`, and the player\'s give-up line FAILS `exit`' },
  { name: 'shim-less', entry: page(SHIMLESS),
    expect: { input: 'FAIL' }, label: { input: /SHIM/ },
    why: 'a document the shim never reached FAILS `input`, naming the shim' },
  { name: 'no-entry', manifest: LOOP_JSON('missing.html'), entry: page(''),
    expect: { open: 'FAIL' },
    why: 'a loop.json naming an entry that is not in the payload FAILS `open`' },
  // LEGFIX1 (#371) — Float v1.1.5's defect: a sound fetched one `../` out of the Loop's own folder.
  // It draws, answers and says ready, so every other row passes; only `files` can see it.
  { name: 'escapes', entry: page(`${DRAWS}${SUBSCRIBES} fetch('../assets/audio/zone.m4a').catch(function () {});
      collectivus.ready({});`),
    expect: { ready: 'PASS', picture: 'PASS', exit: 'PASS', page: 'PASS', files: 'FAIL' },
    label: { files: /outside its own folder/ },
    why: 'a payload that fetches outside `/loop-runtime/<id>/` FAILS `files`, and only `files`' },
  { name: 'lacks-a-file', entry: page(`${DRAWS}${SUBSCRIBES} fetch('assets/missing.bin').catch(function () {});
      collectivus.ready({});`),
    expect: { ready: 'PASS', exit: 'PASS', files: 'FAIL' }, label: { files: /does not carry/ },
    why: 'a payload that fetches a file it does not carry (a 404 inside its folder) FAILS `files`' },
  { name: 'host-error', plant: 'host-error', entry: page(`${DRAWS}${SUBSCRIBES} collectivus.ready({});`),
    expect: { page: 'FAIL', exit: 'PASS' },
    why: 'an error thrown by the HOST page FAILS `page` and leaves `exit` alone' },
];

/** ⚠ harness.mjs hands its own functions in, rather than this file importing them: harness.mjs is
 *  the entry module and is still evaluating its top-level `await` when this runs, so an import back
 *  into it would wait on itself forever. */
/** A release directory as `loop-media.py generate` writes one: media.json and a default media zip. */
function mediaRelease(root, loopId, files, doc) {
  mkdirSync(root, { recursive: true });
  const zip = writeZipOf(files);
  const sha8 = createHash('sha256').update(zip).digest('hex').slice(0, 8);
  writeFileSync(join(root, `${loopId}-media-20260929-${sha8}.zip`), zip);
  writeFileSync(join(root, 'media.json'), JSON.stringify(doc));
  return root;
}
let writeZipOf;

/** The media each plant runs with: loadMedia's own answer, or that answer with its bytes swapped. */
function plantMedia(kind, loadMedia, tmp) {
  if (!kind) return undefined;
  const doc = { mediaVersion: 1, files: [{ path: 'media/boot/palette.json', policy: 'boot' }] };
  const dir = mediaRelease(join(tmp, `plant-${kind}`), 'plant-media', new Map([['media/boot/palette.json', '{"palette":"ok"}']]), doc);
  const media = loadMedia([dir], 'plant-media');
  if (kind === 'corrupt') for (const o of media.objects.values()) o.bytes = Buffer.from('{"palette":"no"}');
  return media;
}

function mediaUnitChecks(check, loadMedia, tmp) {
  const pool = mediaRelease(join(tmp, 'v1'), 'demo', new Map([['media/music/a.m4a', 'AAAA']]),
    { mediaVersion: 1, files: [{ path: 'media/music/a.m4a', policy: 'stream' }] });
  const shaA = createHash('sha256').update('AAAA').digest('hex');
  const now = mediaRelease(join(tmp, 'v2'), 'demo', new Map([['media/boot/p.json', '{}']]),
    { mediaVersion: 1, files: [{ path: 'media/boot/p.json', policy: 'boot' },
      { path: 'media/music/a.m4a', policy: 'stream', carried: false, sha256: shaA }] });
  const media = loadMedia([now, pool], 'demo');
  check('--media: a carried file and a `carried: false` one (found by hash in another --media) are both served',
    media.list.length === 2 && media.list[1].url === `/harness/media/${shaA}.m4a` && media.list[1].type === 'audio/mp4'
    && media.objects.get(media.list[1].url).bytes.toString() === 'AAAA');
  let refused = '';
  try { loadMedia([now], 'demo'); } catch (error) { refused = error.message; }
  check('--media: a `carried: false` file no --media directory holds is refused, naming the path',
    refused.includes('media/music/a.m4a'), refused);
}

export async function selfTest({ identify, loadMedia, readZip, renderReport, runHarness, writeZip }) {
  writeZipOf = writeZip;
  const tmp = mkdtempSync(join(tmpdir(), 'loop-harness-'));
  try {
    return await selfTestIn(tmp, { identify, loadMedia, readZip, renderReport, runHarness, writeZip });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function selfTestIn(tmp, { identify, loadMedia, readZip, renderReport, runHarness, writeZip }) {
  let passed = 0; let failed = 0;
  const check = (what, ok, detail = '') => {
    if (ok) { passed += 1; console.log(`  ok    ${what}`); }
    else { failed += 1; console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ''}`); }
  };

  console.log('loop-harness self-test\n\nthe instrument, without a browser (web-leg-verdicts.mjs — shared with the monorepo)');
  verdictSelfTest(check);

  console.log('\nthe payload reader and the report');
  const files = new Map([['loop.json', LOOP_JSON()], ['index.html', '<p>x</p>'], ['sub/a.bin', Buffer.alloc(3000, 7)]]);
  const round = readZip(writeZip(files));
  check('a zip reads back every member, byte for byte',
    round.size === 3 && round.get('sub/a.bin').equals(Buffer.alloc(3000, 7)) && round.get('index.html').toString() === '<p>x</p>');
  const bytes = writeZip(files);
  const sha8 = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  const meta = { ...identify(`/tmp/harness-plant-20260918-${sha8}.zip`, bytes, ''),
    budgetSeconds: 15, budgetSource: 'the default', tier: null, overrides: [] };
  check('the loop id and the sha8 come from the file name and the bytes',
    meta.loopId === 'harness-plant' && meta.sha8 === sha8 && meta.nameSha8 === sha8);
  // LDTOOLS1 (#398) — the id is the name's head with the `-catalog` and a platform tag stripped, as the pre-flight's `name:` does.
  for (const [file, id] of [['vibes-collectivus-catalog-20261001-', 'vibes-collectivus'], ['vibes-collectivus-tvos-20261001-', 'vibes-collectivus'],
    ['vibes-collectivus-catalog-ios-20261001-', 'vibes-collectivus'], ['vibes-collectivus-ipados-20261001-', 'vibes-collectivus'],
    ['vibes-collectivus-macos-20261001-', 'vibes-collectivus'], ['tvos-demo-20261001-', 'tvos-demo']]) {
    const got = identify(`/tmp/${file}${sha8}.zip`, bytes, '').loopId;
    check(`${file}${sha8}.zip names the loop ${id}`, got === id, got);
  }
  const green = [{ viewport: 'desktop', browser: 'x', rows: ['open', 'ready', 'picture', 'input', 'exit', 'page', 'files']
    .map((id) => ({ id, verdict: 'PASS', label: 'l', evidence: 'e' })) },
  { viewport: 'phone', browser: 'x', rows: ['open', 'ready', 'picture', 'input', 'exit', 'page', 'files']
    .map((id) => ({ id, verdict: 'PASS', label: 'l', evidence: 'e' })) }];
  const report = renderReport(meta, green);
  check('HARNESS.md opens with the marker the delivery gate reads, naming the loop and the sha8',
    report.split('\n')[0] === `<!-- collectivus-harness: loop=harness-plant payload=${sha8} -->`, report.split('\n')[0]);
  check('and names the payload FILE, so the evidence is bound to these bytes', report.includes(`harness-plant-20260918-${sha8}.zip`));
  check('a desktop row and a phone row each carry PASS',
    /^\| desktop[^\n]*\| PASS \|/m.test(report) && /^\| phone[^\n]*\| PASS \|/m.test(report));
  const ab = renderReport({ ...meta, overrides: ['--budget 40'] }, green);
  check('an A/B run names NO payload in its marker, so the gate cannot take it as evidence',
    ab.split('\n')[0].includes(`payload=override-${sha8}`) && ab.includes('NOT EVIDENCE'));
  const red = renderReport(meta, [{ ...green[0], rows: [{ id: 'open', verdict: 'FAIL', label: 'l', evidence: 'e' }] }]);
  check('a FAIL renders as a bare FAIL cell, which the gate refuses', /\| FAIL \|/.test(red) && red.includes('**Verdict: FAIL.**'));

  console.log('\nthe media lane (MEDIA6)');
  mediaUnitChecks(check, loadMedia, tmp);

  console.log('\nevery row, watched failing in a real browser');
  if (!findChromium()) {
    console.log('  UNRUN — no Chromium on this machine (npx playwright install chromium); the rows were NOT watched failing');
    console.log(`\n${passed} passed, ${failed} failed, browser half UNRUN`);
    return 2;
  }
  for (const plant of PLANTS) {
    const payload = new Map([['loop.json', plant.manifest ?? LOOP_JSON()], ['index.html', plant.entry]]);
    const zip = writeZip(payload);
    const { results, quiet } = await runHarness(zip, {
      loopId: `plant-${plant.name}`, title: plant.name, payloadName: `plant-${plant.name}.zip`,
      budgetSeconds: 3, tier: null, viewports: plant.viewports ?? ['desktop'], dwell: 1, censusFloor: 8,
      port: 0, plant: plant.plant, media: plantMedia(plant.media, loadMedia, tmp),
    });
    for (const result of results) {
      const by = Object.fromEntries(result.rows.map((r) => [r.id, r]));
      const wrong = Object.entries(plant.expect).filter(([id, v]) => by[id]?.verdict !== v)
        .concat(Object.entries(plant.label ?? {}).filter(([id, re]) => !re.test(by[id]?.label ?? '')).map(([id]) => [id, 'label']));
      check(`${plant.name} (${result.viewport}): ${plant.why}`, !wrong.length,
        wrong.map(([id]) => `${id} ${by[id]?.verdict}: ${by[id]?.label} — ${by[id]?.evidence}`).join(' / '));
    }
    check(`${plant.name}: nothing answers on the harness port afterwards`, quiet);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed ? 1 : 0;
}
