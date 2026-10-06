#!/usr/bin/env node
// harness.mjs — run Collectivus's web class on your own desk, against your own payload, and write
// HARNESS.md. The page that explains it is ../../35-harness.md.
//
//   node harness.mjs build/<loop-id>-<YYYYMMDD>-<sha8>.zip          # both viewports → ./HARNESS.md
//   node harness.mjs <dir with loop.json> --id <loop-id>           # an unzipped build (not evidence)
//   node harness.mjs <zip> --budget 40                              # A/B: another ready budget
//   node harness.mjs <zip> --tier phone                             # A/B: force collectivus.device.tier
//   node harness.mjs <zip> --media dist/v1.2.0                      # with media.json + media zips (MEDIA6)
//   node harness.mjs --self-test                                    # every row watched failing on a plant
//
// Options: --out <file> (default ./HARNESS.md) · --viewports desktop,phone · --dwell <s> (12) ·
// --census-floor <n> (8) · --port <n> (a free one) · --media <dir> (repeatable: a `carried: false`
// file is found by hash in any of them).
//
// Exit 0: every row PASS at every viewport. 1: something FAILED or was UNRUN. 2: bad usage, or the
// harness could not run at all (no Chromium, Node too old).
//
// ════════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS OURS AND WHAT IS NOT
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// `web-leg-verdicts.mjs` and `loop-runtime-sw.js` are BYTE-IDENTICAL copies of the Collectivus
// monorepo's `scripts/web-leg-verdicts.mjs` (the web class's instrument: the browser, the census,
// the press, and every verdict) and `apps/web/static/loop-runtime-sw.js` (the site's service-worker
// shim, which is what injects `window.collectivus` into your document). The monorepo's
// `scripts/check-harness-parity.sh` fails when either copy drifts. Do not edit them here — an edit
// in your copy makes your HARNESS.md measure something the gate does not.
//
// What this file does differently from our web class is only how the Loop gets onto the screen:
// the site finds your tile in the Loop Pool and opens `?play=1`; this serves your payload from a
// local origin and mounts it in `host.html`, the site player reduced to what a Loop can observe.
// So there is no `tile` row here. Every other row — open, ready, picture, input, exit, page — is
// the web class's, decided by the same code.
//
// ⚠ NO DEPENDENCIES. Node 22+ (for its built-in WebSocket) and a Chromium. `npx playwright install
// chromium` is the easy way to get the browser; this script finds it in Playwright's cache. Nothing
// is downloaded by this script.
//
// ⚠ NOTHING IS LEFT LISTENING. The server lives inside this process and each browser is a child of
// it; both are closed in `finally`, on SIGINT/SIGTERM, and the port is swept before exit.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  SHARED_ROWS, VIEWPORTS, exitAndPageVerdicts, filesVerdict, findChromium, judgeInput, judgePicture,
  launchBrowser, openBrowser, openSession, playerBox, readyInfo, readyVerdict, sleep, until,
  withDeadline,
} from './web-leg-verdicts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_VERSION = '1.1.0';
const DEFAULT_BUDGET_SECONDS = 15;
const MAX_BUDGET_SECONDS = 60;
// `-catalog` (a release's name) and a platform tag (a cook's) are not part of the id — the pre-flight's `name:` strips them too (LDTOOLS1, #398).
const PAYLOAD_NAME = /^(?<id>[a-z0-9][a-z0-9-]*?)(?:-catalog)?(?:-(?:tvos|ios|ipados|macos))?-(?<date>\d{8})-(?<sha8>[0-9a-f]{8})\.zip$/;

// ── reading a payload ────────────────────────────────────────────────────────────────────────────

/** A zip's files, from its central directory. Stored and deflated members; no zip64 (a payload is
 *  capped at 200 MB, far under it). Directory entries are dropped, as the site's unzip drops them. */
export function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  if (at === 0xffffffff || count === 0xffff) throw new Error('a zip64 archive — not a payload this shell reads');
  const files = new Map();
  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error(`central directory entry ${n} is corrupt`);
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: local header is corrupt`);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + compressedSize);
    if (method === 0) files.set(name, Buffer.from(data));
    else if (method === 8) files.set(name, inflateRawSync(data));
    else throw new Error(`${name}: compression method ${method} is not one a browser unzip reads`);
    if (files.get(name).length !== size) throw new Error(`${name}: inflated to the wrong size`);
  }
  return files;
}

/** A tiny zip writer for the self-test's plants: one member per file, deflated. */
export function writeZip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content);
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc32(data), 14); head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(head, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function crc32(buffer) {
  let c = ~0;
  for (const byte of buffer) {
    c ^= byte;
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function readDirectory(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.set(relative(root, full).split(sep).join('/'), readFileSync(full));
    }
  };
  walk(root);
  return files;
}

/** Everything the report says about WHAT it ran — the gate binds HARNESS.md to the sha8. */
export function identify(path, bytes, idOverride) {
  const name = basename(path);
  const match = PAYLOAD_NAME.exec(name);
  if (!bytes) {
    return { name, loopId: idOverride, sha256: null, sha8: null, nameSha8: null, packaged: false };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    name, loopId: idOverride || match?.groups.id || '', sha256, sha8: sha256.slice(0, 8),
    nameSha8: match?.groups.sha8 ?? null, packaged: true, bytes: bytes.length,
  };
}

/** loop.json's `readyBudgetSeconds`, bounded the way the player bounds it (1–60 whole seconds). */
export function declaredBudget(files) {
  try {
    const manifest = JSON.parse(files.get('loop.json').toString('utf8'));
    const value = manifest.readyBudgetSeconds;
    const valid = Number.isInteger(value) && value >= 1 && value <= MAX_BUDGET_SECONDS;
    return { seconds: valid ? value : null, title: typeof manifest.title === 'string' ? manifest.title : null,
      refused: value !== undefined && !valid ? value : undefined };
  } catch {
    return { seconds: null, title: null };
  }
}

// ── the Loop's media (MEDIA6; ../../20-contract/25-media-lane.md) ─────────────────────────────────
//
// `--media <release dir>` names the directory holding your media.json and media zips (what
// `tools/loop-media.py generate` writes). The web reads each path's DEFAULT variant — the site's
// player resolves `variants.web ?? variants.default`, and nothing is ever keyed `web` — so only
// the untagged `<id>-media-…zip` is read for carried files. A `carried: false` file is found BY
// HASH in any `--media` directory: repeat `--media` with the published release that carried it.
// Each object is served at `/harness/media/<sha256><ext>`, standing in for the CDN's
// `media/<sha256><ext>`; the service worker downloads, verifies and caches it exactly as on the site.
// This does not re-check media.json — `loop-media.py check` does, with the intake's rules.

// publish-policy.json `mediaTypes` → Content-Type. The allowlist itself is loop-media.py's to enforce.
const MEDIA_TYPES = {
  '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ktx2': 'image/ktx2', '.glb': 'model/gltf-binary', '.json': 'application/json',
  '.geojson': 'application/geo+json', '.pmtiles': 'application/vnd.pmtiles',
};
const MEDIA_ZIP = /-media-\d{8}-[0-9a-f]{8}\.zip$/;
const extOf = (path) => { const m = /\.[^./]+$/.exec(path); return m ? m[0].toLowerCase() : ''; };
const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Every media zip's members in each directory: [{ platform, path, bytes, sha256, dir }]. */
function mediaMembers(dirs, loopId) {
  const found = [];
  for (const dir of dirs) {
    for (const name of readdirSync(dir).filter((n) => MEDIA_ZIP.test(n)).sort()) {
      const head = name.replace(MEDIA_ZIP, '');
      if (head !== loopId && !head.startsWith(`${loopId}-`)) continue;
      const platform = head === loopId ? 'default' : head.slice(loopId.length + 1);
      for (const [path, bytes] of readZip(readFileSync(join(dir, name)))) {
        if (!path.endsWith('/')) found.push({ platform, path, bytes, sha256: sha256Of(bytes), dir });
      }
    }
  }
  return found;
}

/** `--media` → { list (what the install message carries), objects (url → { bytes, type }) }. */
export function loadMedia(dirs, loopId) {
  const none = { list: [], objects: new Map() };
  if (!dirs.length) return none;
  const doc = JSON.parse(readFileSync(join(dirs[0], 'media.json'), 'utf8'));
  const members = mediaMembers(dirs, loopId);
  const list = []; const objects = new Map();
  for (const entry of doc.files ?? []) {
    const carried = entry.carried !== false;
    const member = carried
      ? members.find((m) => m.dir === dirs[0] && m.platform === 'default' && m.path === entry.path)
      : members.find((m) => m.sha256 === entry.sha256);
    if (!member) {
      throw new Error(carried
        ? `${entry.path}: listed as carried and not in ${basename(dirs[0])}'s default media zip`
        : `${entry.path}: carried: false, and no --media directory holds sha256 ${String(entry.sha256).slice(0, 12)}… — add the published release that carried it with another --media`);
    }
    const url = `/harness/media/${member.sha256}${extOf(entry.path)}`;
    const type = MEDIA_TYPES[extOf(entry.path)] ?? 'application/octet-stream';
    objects.set(url, { bytes: member.bytes, type });
    list.push({ path: entry.path, policy: entry.policy, type, sha256: member.sha256, bytes: member.bytes.length, url });
  }
  return { list, objects };
}

// ── the local origin ─────────────────────────────────────────────────────────────────────────────

function startServer(zip, config, port, mediaObjects = new Map()) {
  const shim = readFileSync(join(HERE, 'loop-runtime-sw.js'));
  const host = readFileSync(join(HERE, 'host.html'));
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, type, body) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', host);
    if (url.pathname === '/loop-runtime-sw.js') return send(200, 'text/javascript', shim);
    if (url.pathname === '/harness/config.json') return send(200, 'application/json', JSON.stringify(config));
    // A browser asks for this on its own; a 404 for it would sit in every failing row's evidence.
    if (url.pathname === '/favicon.ico') return send(204, 'image/x-icon', '');
    if (url.pathname === '/harness/payload.zip') return send(200, 'application/zip', zip);
    // The CDN's `media/<sha256><ext>`, whole: the service worker never asks the origin for a range.
    const media = mediaObjects.get(url.pathname);
    if (media) return send(200, media.type, media.bytes);
    // ⚠ Everything else is a 404 from the NETWORK, which is what the site answers too. A payload
    // that asks for `/loop-runtime/vendor/…` (a `../` out of its own folder) is answered by the
    // service worker's own 404 first — the failure the sub-path exists to expose.
    return send(404, 'text/plain', 'not found');
  });
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(port || 0, '127.0.0.1', () => resolvePort({ server, port: server.address().port }));
  });
}

/** ⚠ THE PORT SWEEP: after close, nothing may still answer on the port this run used. */
function portIsQuiet(port) {
  return new Promise((done) => {
    const probe = request({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, () => done(false));
    probe.on('error', () => done(true));
    probe.on('timeout', () => { probe.destroy(); done(true); });
    probe.end();
  });
}

// ── one viewport ─────────────────────────────────────────────────────────────────────────────────

function unreached(rows, verdict, why) {
  for (const id of SHARED_ROWS) {
    if (!rows.some((r) => r.id === id)) rows.push({ id, verdict, label: 'not reached', evidence: why });
  }
}

async function driveViewport(rows, port, origin, viewport, run) {
  const view = VIEWPORTS[viewport];
  const push = (id, v) => rows.push({ id, ...v });
  const cdp = await openBrowser(port);
  const s = await openSession(cdp, view);
  const query = new URLSearchParams();
  if (run.tier) query.set('tier', run.tier);
  if (run.plant) query.set('plant', run.plant);
  await s.goto(`${origin}/${query.size ? `?${query}` : ''}`);
  const harness = (expr) => s.evaluate(`(window.__clvHarness || {}).${expr}`);

  // ── open ──
  const budgetMs = run.budgetSeconds * 1000;
  const opened = await until(async () => (
    (await s.evaluate('!!document.querySelector("iframe.player-frame")')) || (await harness('stage')) === 'error'
  ), budgetMs + 10_000);
  if (!opened || (await harness('stage')) === 'error') {
    const why = (await harness('error')) || 'the host never mounted the Loop';
    push('open', { verdict: 'FAIL', label: 'the player never mounted the Loop', evidence: `page state: ${why}` });
    unreached(rows, 'FAIL', 'the Loop was never opened');
    return;
  }
  push('open', { verdict: 'PASS', label: 'the player mounted the Loop at its sub-path, through the site\'s own shim',
    evidence: `iframe src ${await s.evaluate('document.querySelector("iframe.player-frame").getAttribute("src")')}` });

  // ── ready ──
  const startedAt = await harness('startedAt');
  await until(async () => (await readyInfo(s.evaluate)) != null || (await harness('stage')) === 'error',
    budgetMs + 2000);
  const info = await readyInfo(s.evaluate);
  const waited = Math.round(((await s.evaluate('performance.now()')) - startedAt) / 1000);
  push('ready', readyVerdict({ info, waitedSeconds: waited, budgetSeconds: run.budgetSeconds,
    accepted: (await harness('accepted')) === true, readyAfterMs: await harness('readyAfterMs') }));

  // Let it actually run before photographing it — a census of the first frame measures the clear.
  await sleep(Math.max(1, run.dwell) * 1000);

  // ── picture, input ──
  const box = await playerBox(s.evaluate);
  push('picture', await judgePicture(s.call, s.evaluate, box, run.censusFloor));
  push('input', await judgeInput(s.call, s.evaluate, box, view));

  // ── exit, page ──
  await s.goto(`${origin}/?idle=1`);
  const gone = await until(() => s.evaluate('!document.querySelector("iframe.player-frame")'), 10_000);
  const { exit, page } = exitAndPageVerdicts({ gone: !!gone, consoleLines: s.consoleLines,
    httpFailures: s.httpFailures, origin });
  push('exit', exit);
  push('page', page);
  // `files` (Collectivus LEGFIX1): no request your payload made left `/loop-runtime/<id>/`, and none
  // inside it answered 404 — the one the console rows cannot see (a 404 line decides neither).
  push('files', filesVerdict({ requests: s.requests, httpFailures: s.httpFailures, origin, loopId: run.loopId }));
}

async function runViewport(viewport, port, origin, run, live) {
  const rows = [];
  const binary = findChromium();
  if (!binary) {
    unreached(rows, 'UNRUN', 'no Chromium on this machine — run `npx playwright install chromium`, '
      + 'or set CLV_CHROMIUM to a Chrome or Chromium binary');
    return { viewport, rows, browser: null };
  }
  const browser = launchBrowser(binary);
  live.add(browser);
  try {
    await withDeadline(driveViewport(rows, browser.port, origin, viewport, run),
      (run.budgetSeconds + run.dwell + 90) * 1000, `the ${viewport} run`);
  } catch (error) {
    // ⚠ A HANG PRINTS FAIL FOR WHAT IT NEVER REACHED, NEVER A BLANK.
    unreached(rows, 'FAIL', `${error.message}${browser.stderr.length ? ` · browser stderr: ${browser.stderr.join('').slice(-200)}` : ''}`);
  } finally {
    browser.close();
    live.delete(browser);
  }
  const order = (id) => SHARED_ROWS.indexOf(id);
  rows.sort((a, b) => order(a.id) - order(b.id));
  return { viewport, rows, browser: binary.replace(process.env.HOME ?? '', '~') };
}

/** One full harness run: serve, drive every viewport, close everything. Returns the results.
 *  `zip` is the payload's bytes — an unzipped directory is zipped first, so both take one path. */
export async function runHarness(zip, run) {
  const config = {
    loopId: run.loopId, title: run.title, budgetSeconds: run.budgetSeconds, payloadName: run.payloadName,
    sha256: createHash('sha256').update(zip).digest('hex'), media: run.media?.list ?? [],
  };
  const { server, port } = await startServer(zip, config, run.port, run.media?.objects);
  const origin = `http://127.0.0.1:${port}`;
  const live = new Set();
  const stop = () => { for (const b of live) b.close(); server.close(); };
  const onSignal = () => { stop(); process.exit(130); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const results = [];
  try {
    for (const viewport of run.viewports) results.push(await runViewport(viewport, port, origin, run, live));
  } finally {
    stop();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    server.closeAllConnections?.();
    await new Promise((done) => server.close(() => done()));
  }
  const quiet = await portIsQuiet(port);
  return { results, origin, quiet };
}

// ── HARNESS.md ───────────────────────────────────────────────────────────────────────────────────

const VIEW_NAMES = { desktop: 'desktop (1440×900)', phone: 'phone (390×844, touch)' };
const cell = (text) => String(text).replace(/\|/g, '¦').replace(/\n/g, ' ');

export function overallVerdict(results) {
  const all = results.flatMap((r) => r.rows.map((x) => x.verdict));
  if (all.includes('FAIL')) return 'FAIL';
  if (all.includes('UNRUN') || !all.length) return 'INCOMPLETE';
  return 'PASS';
}

/**
 * ⚠ THE SHAPE THE DELIVERY GATE READS (monorepo `packages/catalog/loop-intake.py`,
 * `harness_satisfies` / `evidence_sha8`, built at [006/LP7b]): the FIRST line is the marker naming
 * the loop and the payload's sha8; a table whose `desktop…` and `phone…` rows carry PASS; and no
 * cell anywhere reading FAIL or UNRUN. An A/B run (`--budget`, `--tier`) or an unzipped directory
 * names NO payload in its marker, so the gate reads it as about other bytes — it is not evidence.
 */
export function renderReport(meta, results, when = new Date()) {
  const bound = meta.packaged && !meta.overrides.length;
  const payloadField = bound ? meta.sha8 : meta.packaged ? `override-${meta.sha8}` : 'unpackaged';
  const verdict = overallVerdict(results);
  const lines = [
    `<!-- collectivus-harness: loop=${meta.loopId} payload=${payloadField} -->`,
    `# HARNESS — ${meta.loopId}`,
    '',
    meta.packaged
      ? `**Payload:** \`${meta.name}\` — ${meta.bytes.toLocaleString('en-US')} bytes, sha256 \`${meta.sha256}\``
      : `**Payload:** the unzipped directory \`${meta.name}\` — no file, so no sha256`,
    `**Ran:** ${when.toISOString()} · **Harness:** loop-harness ${HARNESS_VERSION} · **Browser:** ${results.find((r) => r.browser)?.browser ?? 'none found'}`,
    ...(meta.instrument ? [`**Instrument:** \`web-leg-verdicts.mjs\` ${meta.instrument.verdicts} · \`loop-runtime-sw.js\` ${meta.instrument.shim} (sha256, first 12 — the monorepo's parity gate holds both to its own)`] : []),
    `**Ready budget:** ${meta.budgetSeconds} s (${meta.budgetSource}) · **Tier:** ${meta.tier || 'the player’s own pick (`phone` under 768 px short side, else `desktop`)'}`,
    ...(meta.media?.length ? [`**Media:** ${meta.media.length} path(s) from \`--media\`, served from this desk, each object's default variant (${meta.media.map((m) => `${m.policy} ${m.sha256.slice(0, 8)}`).join(', ')})`] : []),
    '',
  ];
  if (!bound) {
    lines.push(meta.packaged
      ? `⚠ **NOT EVIDENCE — an A/B run** (${meta.overrides.join(', ')}). The player uses loop.json's budget and its own tier pick; this run did not. Re-run without overrides for the file you attach.`
      : '⚠ **NOT EVIDENCE — an unzipped directory.** The gate binds evidence to the zip\'s bytes. Run the zip you will release.', '');
  }
  if (meta.nameSha8 && meta.nameSha8 !== meta.sha8) {
    lines.push(`⚠ **The file name says \`${meta.nameSha8}\`, the bytes say \`${meta.sha8}\`.** The gate binds to the bytes; rename the file (\`10-delivering-a-release.md\` §1).`, '');
  }
  lines.push(`**Verdict: ${verdict}.**`, '');
  lines.push(`| Viewport | ${SHARED_ROWS.join(' | ')} |`, `| --- |${SHARED_ROWS.map(() => ' --- |').join('')}`);
  for (const r of results) {
    const by = Object.fromEntries(r.rows.map((x) => [x.id, x.verdict]));
    lines.push(`| ${VIEW_NAMES[r.viewport] ?? r.viewport} | ${SHARED_ROWS.map((id) => by[id] ?? 'UNRUN').join(' | ')} |`);
  }
  lines.push('', '## Each row, with the line that decided it', '',
    '| Viewport | Row | Verdict | What it means | Evidence |', '| --- | --- | --- | --- | --- |');
  for (const r of results) {
    for (const x of r.rows) {
      lines.push(`| ${r.viewport} | \`${x.id}\` | **${x.verdict}** | ${cell(x.label)} | ${cell(x.evidence)} |`);
    }
  }
  lines.push('',
    '> The `picture` row is a floor — "not blank", never "correct". A green table says the web',
    '> surface opened, announced ready inside its budget, drew, took a press and left cleanly. It',
    '> does not say the Loop looks right; your `Surfaces:` line does. What each FAIL means:',
    '> loops-docs `40-delivery/20-validating-a-build.md` §5.',
    '',
    `<sub>Written by \`40-delivery/tools/loop-harness/harness.mjs\` ${HARNESS_VERSION} — the Collectivus web class, run by the Loop's author.</sub>`,
    '');
  return lines.join('\n');
}

// ── arguments ────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { payload: '', id: '', out: 'HARNESS.md', viewports: ['desktop', 'phone'], dwell: 12,
    censusFloor: 8, port: 0, budget: null, tier: null, media: [], selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const take = () => {
      if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
      return argv[++i];
    };
    switch (argv[i]) {
      case '--id': args.id = take(); break;
      case '--out': args.out = take(); break;
      case '--viewports': args.viewports = take().split(',').filter(Boolean); break;
      case '--dwell': args.dwell = Number(take()); break;
      case '--census-floor': args.censusFloor = Number(take()); break;
      case '--port': args.port = Number(take()); break;
      case '--budget': args.budget = Number(take()); break;
      case '--tier': args.tier = take(); break;
      case '--media': args.media.push(take()); break;
      case '--self-test': args.selfTest = true; break;
      case '-h': case '--help': args.help = true; break;
      default:
        if (argv[i].startsWith('--') || args.payload) throw new Error(`unexpected argument ${argv[i]}`);
        args.payload = argv[i];
    }
  }
  for (const v of args.viewports) if (!VIEWPORTS[v]) throw new Error(`unknown viewport ${v} (desktop, phone)`);
  if (args.budget != null && !(Number.isInteger(args.budget) && args.budget >= 1 && args.budget <= MAX_BUDGET_SECONDS)) {
    throw new Error(`--budget must be a whole number of seconds, 1–${MAX_BUDGET_SECONDS} (the player refuses anything else)`);
  }
  const TIERS = ['phone', 'tablet', 'laptop', 'desktop', 'ultra', 'max', 'tv'];
  if (args.tier && !TIERS.includes(args.tier)) throw new Error(`--tier must be one of ${TIERS.join(', ')}`);
  return args;
}

async function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (error) { console.error(`harness: ${error.message}`); return 2; }
  if (typeof WebSocket === 'undefined') {
    console.error(`harness: Node ${process.versions.node} has no built-in WebSocket — use Node 22 or newer`);
    return 2;
  }
  if (args.selfTest) {
    return (await import('./harness-self-test.mjs'))
      .selfTest({ identify, loadMedia, readZip, renderReport, runHarness, writeZip });
  }
  if (args.help || !args.payload) {
    console.error('usage: node harness.mjs <payload.zip | unzipped dir> [--id <loop-id>] [--out HARNESS.md]\n'
      + '       [--viewports desktop,phone] [--budget <s>] [--tier <rung>] [--dwell <s>]\n'
      + '       [--media <release dir with media.json>]…\n'
      + '       node harness.mjs --self-test');
    return args.help ? 0 : 2;
  }
  const path = resolve(args.payload);
  if (!existsSync(path)) { console.error(`harness: no such file or directory: ${path}`); return 2; }
  const isDir = statSync(path).isDirectory();
  let files; let meta;
  try {
    const bytes = isDir ? null : readFileSync(path);
    files = isDir ? readDirectory(path) : readZip(bytes);
    meta = identify(path, bytes, args.id);
  } catch (error) { console.error(`harness: ${basename(path)}: ${error.message}`); return 2; }
  if (!meta.loopId) {
    console.error('harness: no loop id — name the zip `<loop-id>-<YYYYMMDD>-<sha8>.zip`, or pass --id');
    return 2;
  }
  const declared = declaredBudget(files);
  meta.overrides = [args.budget != null && `--budget ${args.budget}`, args.tier && `--tier ${args.tier}`].filter(Boolean);
  meta.budgetSeconds = args.budget ?? declared.seconds ?? DEFAULT_BUDGET_SECONDS;
  meta.budgetSource = args.budget != null ? 'the --budget override'
    : declared.seconds != null ? 'loop.json `readyBudgetSeconds`'
    : declared.refused !== undefined ? `the default — loop.json's \`readyBudgetSeconds: ${declared.refused}\` is outside 1–60, so the player ignores it`
    : 'the default — loop.json declares no `readyBudgetSeconds`';
  meta.tier = args.tier;
  const sha12 = (name) => createHash('sha256').update(readFileSync(join(HERE, name))).digest('hex').slice(0, 12);
  meta.instrument = { verdicts: sha12('web-leg-verdicts.mjs'), shim: sha12('loop-runtime-sw.js') };
  let media;
  try { media = loadMedia(args.media.map((d) => resolve(d)), meta.loopId); } catch (error) {
    console.error(`harness: --media: ${error.message}`);
    return 2;
  }
  meta.media = media.list;

  console.error(`harness: ${meta.name} · ${files.size} files · budget ${meta.budgetSeconds} s · viewports ${args.viewports.join(', ')}`);
  const { results, quiet } = await runHarness(isDir ? writeZip(files) : readFileSync(path), {
    loopId: meta.loopId, title: declared.title, payloadName: meta.name, budgetSeconds: meta.budgetSeconds,
    tier: args.tier, viewports: args.viewports, dwell: args.dwell, censusFloor: args.censusFloor, port: args.port,
    media,
  });
  const report = renderReport(meta, results);
  writeFileSync(resolve(args.out), report);
  for (const r of results) {
    for (const x of r.rows) console.log(`${r.viewport.padEnd(8)} ${x.id.padEnd(8)} ${x.verdict.padEnd(6)} ${x.label}`);
  }
  console.log(`\nharness: ${overallVerdict(results)} — wrote ${resolve(args.out)}`);
  if (!quiet) console.error('harness: ⚠ something still answers on the harness port after close');
  return overallVerdict(results) === 'PASS' && quiet ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
