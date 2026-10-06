// apps/web/static/loop-runtime-sw.js
//
// WEB1d — a scoped Service Worker giving a fetched-and-verified Loop payload a REAL same-origin
// URL, so ES modules and <video> Range requests work exactly as they do for every other page —
// the browser's version of what native solved with a custom WKURLSchemeHandler
// (apps/apple-universal/Sources/WebSupport/WebLoopSchemeHandler.swift). Same reasoning: a `file://`
// origin is opaque and silently breaks module loading; a blob: URL breaks Range entirely.
//
// Registered with { scope: '/loop-runtime/' } from LoopEmbedPlayer.svelte (Task 9) — this worker
// never intercepts any other request on the site.
//
// STATE: the Maps below are the working copy, keyed by loopId. The browser can stop an idle worker
// at any time and a restart empties them, so [007/WB-SW] (Q53 (1)) also writes each Loop's
// registration — its files, its device and its media manifest — to Cache Storage (LOOP_CACHE), and
// the first read for a Loop the worker no longer knows rebuilds it from there. Nothing in that store
// leaves the browser. LoopEmbedPlayer still re-sends 'install' on every mount, which replaces it.
//
// ⚠ SAME-ORIGIN TRUST BOUNDARY, ACCEPTED (Josh, 2026-08-27). This worker can only ever serve
// same-origin with the rest of the site (a Service Worker cannot control another origin's scope),
// so a Loop's injected shim below deliberately restricts postMessage to `window.location.origin`
// on both sides rather than "*" — see docs/superpowers/specs/2026-08-27-web1d-embed-player-design.md
// for the full reasoning on why this is accepted rather than isolated further.

const loops = new Map(); // loopId -> Map<relativePath, { bytes: Uint8Array, mimeType: string }>
// TIER1 — loopId -> the `{ class: 'web', tier }` the player picked (bridge.ts `webDevice`, the ONE
// web pick). The worker picks nothing; it only splices what it was handed in ahead of the shim.
const devices = new Map();
// [007/MEDIA5] — loopId -> Map<path, { path, policy, type, sha256, bytes, url }>, from the install
// message. Kept like `loops` (persisted with the registration since WB-SW). The verified BYTES live
// in Cache Storage (MEDIA_CACHE), separately, by hash.
const media = new Map();

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'install') return;
  const files = new Map();
  for (const file of data.files) {
    files.set(file.path, { bytes: file.bytes, mimeType: file.mimeType });
  }
  loops.set(data.loopId, files);
  devices.set(data.loopId, data.device || null);
  // [007/MEDIA5] — the Loop's media objects, resolved by the player (`media-lane.ts`). A Loop with
  // none acknowledges at once, exactly as before the lane existed.
  const objects = mediaObjectsOf(data.media);
  media.set(data.loopId, objects);
  // [007/WB-SW] — the registration is written to Cache Storage alongside, so a restarted worker can
  // rebuild it. The ack does not wait for the write; `waitUntil` keeps the worker alive until it lands.
  const saved = persistRegistration(data.loopId, data.files, data.device || null, objects);
  if (typeof event.waitUntil === 'function') event.waitUntil(saved);
  if (objects.size === 0) {
    event.source.postMessage({ type: 'installed', loopId: data.loopId });
    return;
  }
  // `boot` objects are verified and stored BEFORE the ack, so the Loop never starts without them;
  // `prefetch` runs after it. `waitUntil` keeps the worker alive for both.
  const work = installBoot(objects).then(
    () => {
      event.source.postMessage({ type: 'installed', loopId: data.loopId });
      return prefetch(objects);
    },
    (error) => event.source.postMessage({ type: 'installed', loopId: data.loopId, error: messageOf(error) })
  );
  if (typeof event.waitUntil === 'function') event.waitUntil(work);
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const match = /^\/loop-runtime\/([^/]+)\/(.*)$/.exec(url.pathname);
  if (!match) return; // outside our scope's path shape — let the network handle it
  // ENC1 — `url.pathname` is percent-ENCODED; the file map is keyed by the zip's DECODED member
  // names. Pirate Beach's `luts/Sea Breeze (Presetpro).cube` arrived as `Sea%20Breeze%20(...)` and
  // 404'd in every leg before v0.1.7. Decode ONCE, here, so `serve()` only ever sees real names.
  const loopId = decodeOnce(match[1]);
  const relativePath = decodeOnce(match[2]);
  if (loopId === null || relativePath === null) {
    // A malformed escape (`%zz`) is a bad request, not a crash: an exception thrown out of the
    // fetch handler makes the browser fall through to the network, which cannot serve a Loop file
    // and produces a confusing cross-origin failure instead of an answer.
    event.respondWith(new Response('bad request', { status: 400 }));
    return;
  }
  event.respondWith(serve(event.request, loopId, relativePath));
});

/**
 * One percent-decode, or `null` when the escape is malformed. Never two: a member literally named
 * `a%20b.txt` is requested as `a%2520b.txt`, and a second pass would turn it into `a b.txt`.
 * `+` is left alone — it is a literal plus in a path, not a space (that is query-string decoding).
 */
function decodeOnce(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

async function serve(request, loopId, relativePath) {
  // [007/WB-SW] — a worker the browser stopped and restarted has empty Maps; the first read for a
  // Loop it no longer knows rebuilds that Loop's registration from Cache Storage before answering.
  if (!loops.has(loopId)) await restoreRegistration(loopId);
  // [007/MEDIA5] — a path the Loop's media manifest names comes from the lane, never the payload.
  // A `media/…` path it does not name falls through to the payload map, which never holds one (the
  // publish gate reserves the prefix), so it is a 404 — the kit's "not in this Loop's manifest".
  const mediaObject = media.get(loopId)?.get(relativePath);
  if (mediaObject) return serveMedia(request, mediaObject);
  const files = loops.get(loopId);
  const file = files ? files.get(relativePath) : undefined;
  if (!file) {
    return new Response('not found', { status: 404 });
  }
  const body = file.mimeType === 'text/html' ? injectShim(file.bytes, devices.get(loopId)) : file.bytes;
  const range = parseRange(request.headers.get('Range'), body.byteLength);
  if (range) {
    const slice = body.slice(range.start, range.end);
    return new Response(slice, {
      status: 206,
      headers: {
        'Content-Type': file.mimeType,
        'Content-Length': String(slice.byteLength),
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${range.start}-${range.end - 1}/${body.byteLength}`
      }
    });
  }
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': file.mimeType,
      'Content-Length': String(body.byteLength),
      'Accept-Ranges': 'bytes'
    }
  });
}

// `bytes=start-end` / `bytes=start-`. Mirrors WebLoopSchemeHandler.requestedRange exactly — a
// multi-range request is deliberately not honoured, matching the native shell's own choice.
function parseRange(header, total) {
  if (!header || total === 0 || !header.startsWith('bytes=') || header.includes(',')) return null;
  const [startStr, endStr] = header.slice('bytes='.length).split('-');
  const start = Number(startStr);
  if (!Number.isFinite(start) || start >= total) return null;
  const end = endStr ? Math.min(Number(endStr) + 1, total) : total;
  if (!(start < end)) return null;
  return { start, end };
}

// ── [007/MEDIA5] the Loop media lane ─────────────────────────────────────────────────────────────
//
// A Loop reads `media/…` by PATH; the player resolved each path to { sha256, bytes, type, policy,
// url } (`src/lib/loop-embed/media-lane.ts`). This half owns the bytes, and keeps the kit's rules
// (`packages/loop-shell-kit/Sources/LoopShellKit/MediaRead.swift`, `MediaSession.swift`, MEDIA3):
//   - Cache Storage keyed by sha256, shared across Loops; only a download whose sha256 matched is
//     ever stored, so a stored object is trusted by its name and not re-hashed per read.
//   - ONE download per object, shared by every reader (`transfers`).
//   - `Range` answered from the manifest's size, so a stream can answer `206 … /total` early.
//   - PREP3 q4 (Josh, 2026-09-27): a `stream` object read by an <audio>/<video> ELEMENT may be served
//     as it arrives; everything else waits for verification. The signal is `request.destination`
//     (`audio`/`video` for an element, '' for fetch/XHR) — the browser sets it and script cannot.
//   - A mismatch is discarded and its hash REFUSED (a marker in the same cache, so it survives a
//     restart): never streamed again, read verify-first from then on.

const MEDIA_CACHE = 'clv-media-v1';
// Cache keys must be http(s) URLs; `.invalid` is reserved (RFC 2606), so no key can ever be a real
// request the browser would also make.
const MEDIA_KEY_BASE = 'https://media.collectivus.invalid/';
const MEDIA_CHUNK_BYTES = 256 * 1024; // per enqueue on a stream: never a whole track in one piece
const MEDIA_POLICIES = ['boot', 'prefetch', 'onDemand', 'stream'];
const transfers = new Map(); // sha256 -> the one download in flight (startTransfer)
const refusedHashes = new Set(); // memory mirror of the refused markers

function mediaObjectsOf(list) {
  const objects = new Map();
  if (!Array.isArray(list)) return objects;
  for (const o of list) {
    if (!o || typeof o.path !== 'string' || !/^[0-9a-f]{64}$/.test(o.sha256)) continue;
    if (!(o.bytes > 0) || typeof o.url !== 'string') continue;
    const policy = MEDIA_POLICIES.includes(o.policy) ? o.policy : 'onDemand';
    objects.set(o.path, { ...o, policy, type: o.type || 'application/octet-stream' });
  }
  return objects;
}

const messageOf = (error) => String((error && error.message) || error);
const objectKey = (sha256) => `${MEDIA_KEY_BASE}objects/${sha256}`;
const refusedKey = (sha256) => `${MEDIA_KEY_BASE}refused/${sha256}`;

function installBoot(objects) {
  const boot = [...objects.values()].filter((o) => o.policy === 'boot');
  return Promise.all(
    boot.map((o) =>
      verifiedBlob(o).catch((error) => {
        throw new Error(`boot media ${o.path} could not be installed: ${messageOf(error)}`);
      })
    )
  );
}

// One at a time, in path order: the resolved manifest is a map, so the authored order does not
// survive the intake (Q359, MEDIA3) — the kit prefetches in path order too.
async function prefetch(objects) {
  const queue = [...objects.values()].filter((o) => o.policy === 'prefetch').sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const o of queue) {
    try { await verifiedBlob(o); } catch { /* a failed prefetch fails only that read, later */ }
  }
}

async function serveMedia(request, object) {
  const range = mediaRange(request.headers.get('Range'), object.bytes);
  if (range === null) {
    return new Response(null, { status: 416, headers: mediaHeaders(object, null, '416') });
  }
  try {
    const cached = await cachedBlob(object.sha256);
    if (cached) return mediaAnswer(object, range, cached.slice(range.start, range.end));
    if (await mayStreamUnverified(request, object)) {
      return mediaAnswer(object, range, streamBody(transferFor(object), range, object.bytes));
    }
    const blob = await verifiedBlob(object);
    return mediaAnswer(object, range, blob.slice(range.start, range.end));
  } catch (error) {
    return new Response(`media ${object.path} not served: ${messageOf(error)}`, { status: 502 });
  }
}

// q4's exception, and every condition it has: the `stream` policy, an element reading, and a hash
// that has never failed here. (Bytes already verified were answered from the cache above.)
async function mayStreamUnverified(request, object) {
  if (object.policy !== 'stream') return false;
  if (request.destination !== 'audio' && request.destination !== 'video') return false;
  return !(await isRefused(object.sha256));
}

function mediaAnswer(object, range, body) {
  return new Response(body, { status: range.partial ? 206 : 200, headers: mediaHeaders(object, range) });
}

function mediaHeaders(object, range, unsatisfiable) {
  // `Accept-Ranges` on every answer: a media element checks for it before it asks for a range.
  const headers = { 'Content-Type': object.type, 'Accept-Ranges': 'bytes' };
  if (unsatisfiable) {
    headers['Content-Range'] = `bytes */${object.bytes}`;
  } else {
    headers['Content-Length'] = String(range.end - range.start);
    if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end - 1}/${object.bytes}`;
  }
  return headers;
}

// `bytes=a-b`, `bytes=a-`, `bytes=-n` against the manifest's size — the kit's `MediaByteRange`.
// A multi-range or malformed header is the whole body (a valid answer to any range request); a start
// past the end is null, answered 416. Deliberately separate from `parseRange` above, which serves
// payload files and has never answered a suffix range.
function mediaRange(header, total) {
  const whole = { start: 0, end: total, partial: false };
  if (!header || !header.startsWith('bytes=') || header.includes(',')) return whole;
  const parts = header.slice('bytes='.length).split('-').map((s) => s.trim());
  if (parts.length !== 2) return whole;
  if (parts[0] === '') {
    const suffix = Number(parts[1]);
    if (!Number.isInteger(suffix)) return whole;
    return suffix > 0 ? { start: Math.max(0, total - suffix), end: total, partial: true } : null;
  }
  const start = Number(parts[0]);
  if (!Number.isInteger(start) || start < 0) return whole;
  if (start >= total) return null;
  if (parts[1] === '') return { start, end: total, partial: true };
  const last = Number(parts[1]);
  if (!Number.isInteger(last) || last < start) return whole;
  return { start, end: Math.min(last + 1, total), partial: true };
}

async function cachedBlob(sha256) {
  const cache = await self.caches.open(MEDIA_CACHE);
  const hit = await cache.match(objectKey(sha256));
  return hit ? hit.blob() : null;
}

async function isRefused(sha256) {
  if (refusedHashes.has(sha256)) return true;
  const cache = await self.caches.open(MEDIA_CACHE);
  if (!(await cache.match(refusedKey(sha256)))) return false;
  refusedHashes.add(sha256);
  return true;
}

// The object's verified bytes: from the cache, or from the one download (which stores them).
async function verifiedBlob(object) {
  return (await cachedBlob(object.sha256)) || transferFor(object).verified;
}

function transferFor(object) {
  const existing = transfers.get(object.sha256);
  if (existing) return existing;
  const transfer = startTransfer(object);
  transfers.set(object.sha256, transfer);
  const forget = () => transfers.delete(object.sha256);
  transfer.verified.then(forget, forget);
  return transfer;
}

// One download: chunks are kept as they arrive (a stream reads them), hashed whole at the end.
// ⚠ THE WHOLE OBJECT IS HELD IN MEMORY until it is verified — `crypto.subtle.digest` has no
// incremental form. Fine for the lane's sizes today; an hour of music is Q361's question.
function startTransfer(object) {
  const transfer = { chunks: [], received: 0, finished: false, failed: null, waiters: [] };
  const wake = () => { const w = transfer.waiters; transfer.waiters = []; w.forEach((fn) => fn()); };
  transfer.verified = (async () => {
    try {
      const response = await self.fetch(object.url);
      if (!response.ok || !response.body) throw new Error(`the origin answered ${response.status}`);
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        transfer.chunks.push(value);
        transfer.received += value.byteLength;
        wake();
      }
      return await storeIfVerified(object, new Blob(transfer.chunks, { type: object.type }));
    } catch (error) {
      transfer.failed = error;
      throw error;
    } finally {
      transfer.finished = true;
      wake();
    }
  })();
  transfer.verified.catch(() => {}); // every reader observes it; this stops an unhandled rejection
  return transfer;
}

async function storeIfVerified(object, blob) {
  const digest = await self.crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const actual = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  const cache = await self.caches.open(MEDIA_CACHE);
  if (actual !== object.sha256) {
    refusedHashes.add(object.sha256);
    await cache.put(refusedKey(object.sha256), new Response('refused'));
    console.warn(`[loop-runtime] media ${object.path} REFUSED — sha256 mismatch; discarded`);
    throw new Error('sha256 mismatch — discarded');
  }
  await cache.put(objectKey(object.sha256), new Response(blob, { headers: { 'Content-Type': object.type } }));
  return blob;
}

// A body read from a download still arriving, a chunk per pull. The range's LAST chunk is held until
// the download is verified, so a mismatch errors the element's read rather than completing it —
// "verified at download end, a mismatch discarded" (q4). An earlier range closes as soon as its
// bytes are here: holding it would stall playback on the whole file.
function streamBody(transfer, range, total) {
  let offset = range.start;
  return new ReadableStream({
    async pull(controller) {
      while (transfer.received <= offset && !transfer.finished) await new Promise((r) => transfer.waiters.push(r));
      if (transfer.failed) return controller.error(transfer.failed);
      if (offset < range.end && transfer.received > offset) {
        const upTo = Math.min(range.end, transfer.received, offset + MEDIA_CHUNK_BYTES);
        controller.enqueue(copyOut(transfer.chunks, offset, upTo));
        offset = upTo;
        if (offset < range.end) return;
      }
      if (range.end === total) {
        try { await transfer.verified; } catch (error) { return controller.error(error); }
      }
      controller.close();
    }
  });
}

function copyOut(chunks, from, to) {
  const out = new Uint8Array(to - from);
  let base = 0;
  let written = 0;
  for (const chunk of chunks) {
    const chunkEnd = base + chunk.byteLength;
    if (chunkEnd > from && base < to) {
      const part = chunk.subarray(Math.max(from, base) - base, Math.min(to, chunkEnd) - base);
      out.set(part, written);
      written += part.byteLength;
    }
    base = chunkEnd;
    if (base >= to) break;
  }
  return out;
}

// ── [007/WB-SW] the registration, persisted (Q53 (1)) ─────────────────────────────────────────────
//
// One cache, LOOP_CACHE. Per Loop: an INDEX (`<loop>/index`: generation, file list with types,
// device, media objects) and its files under `<loop>/<generation>/file/<path>`. An install writes a
// NEW generation's files first and the index LAST, then deletes the previous generation's files —
// so a read never sees half a registration or two versions mixed, and a stopped write leaves the
// previous registration whole. Writes for one Loop run one after another (`persisting`).
//
// ⚠ A restore reads the WHOLE payload back into memory on the first read after a restart — exactly
// what the install held before it, nothing more. A worker stopped before the write finished (the
// browser normally waits for `waitUntil`) restores the previous registration, or none: a 404, as
// before this row.

const LOOP_CACHE = 'clv-loops-v1';
const LOOP_KEY_BASE = 'https://loops.collectivus.invalid/'; // `.invalid`: see MEDIA_KEY_BASE
const persisting = new Map(); // loopId -> the last write queued for it
const restoring = new Map(); // loopId -> the one rebuild in flight

const loopPrefix = (loopId) => `${LOOP_KEY_BASE}${encodeURIComponent(loopId)}/`;
const indexKey = (loopId) => `${loopPrefix(loopId)}index`;
const fileKey = (loopId, generation, path) => `${loopPrefix(loopId)}${generation}/file/${encodeURIComponent(path)}`;

function persistRegistration(loopId, files, device, objects) {
  if (!self.caches) return Promise.resolve();
  const previous = persisting.get(loopId) || Promise.resolve();
  const write = previous
    .then(() => writeRegistration(loopId, files, device, objects))
    .catch((error) => console.warn(`[loop-runtime] ${loopId} registration not saved: ${messageOf(error)}`));
  persisting.set(loopId, write);
  return write;
}

async function writeRegistration(loopId, files, device, objects) {
  const cache = await self.caches.open(LOOP_CACHE);
  const old = await readIndex(cache, loopId);
  const generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const written = [];
  try {
    for (const file of files) {
      written.push(fileKey(loopId, generation, file.path));
      await cache.put(written[written.length - 1], new Response(file.bytes));
    }
  } catch (error) {
    // A full disk part-way: drop this generation's files, keep the previous registration whole.
    for (const key of written) await cache.delete(key).catch(() => {});
    throw error;
  }
  const index = {
    generation,
    files: files.map((file) => ({ path: file.path, mimeType: file.mimeType })),
    device,
    media: [...objects.values()]
  };
  await cache.put(indexKey(loopId), new Response(JSON.stringify(index), { headers: { 'Content-Type': 'application/json' } }));
  if (old && old.generation !== generation) {
    for (const file of old.files) await cache.delete(fileKey(loopId, old.generation, file.path));
  }
}

async function readIndex(cache, loopId) {
  const hit = await cache.match(indexKey(loopId));
  if (!hit) return null;
  const index = await hit.json();
  return index && typeof index.generation === 'string' && Array.isArray(index.files) ? index : null;
}

function restoreRegistration(loopId) {
  if (!self.caches) return Promise.resolve();
  const existing = restoring.get(loopId);
  if (existing) return existing;
  const rebuild = readRegistration(loopId)
    .catch((error) => console.warn(`[loop-runtime] ${loopId} registration not restored: ${messageOf(error)}`))
    .finally(() => restoring.delete(loopId));
  restoring.set(loopId, rebuild);
  return rebuild;
}

async function readRegistration(loopId) {
  const cache = await self.caches.open(LOOP_CACHE);
  const index = await readIndex(cache, loopId);
  if (!index) return; // never installed in this browser: the read stays a 404
  const files = new Map();
  for (const file of index.files) {
    const hit = await cache.match(fileKey(loopId, index.generation, file.path));
    if (!hit) return; // an incomplete registration serves nothing rather than half a Loop
    files.set(file.path, { bytes: new Uint8Array(await hit.arrayBuffer()), mimeType: file.mimeType });
  }
  if (loops.has(loopId)) return; // a fresh install landed while this read — it wins
  loops.set(loopId, files);
  devices.set(loopId, index.device || null);
  media.set(loopId, mediaObjectsOf(index.media));
}

function injectShim(htmlBytes, device) {
  const text = new TextDecoder().decode(htmlBytes);
  // ⚠ JSON, NEVER INTERPOLATED FIELDS: the device is the player's own object, but a string spliced
  // into a <script> is a string spliced into a program. `<` is escaped so no value can close the tag.
  const handoff = device ? `window.__clv_device = ${JSON.stringify(device).replace(/</g, '\\u003c')};` : '';
  const tag = `<script>${handoff}${SHIM_SOURCE}</script>`;
  const headMatch = /<head[^>]*>/i.exec(text);
  if (!headMatch) {
    // ⚠ LOUD ON PURPOSE. The fallback prepends the shim before the WHOLE document — ahead of
    // `<!DOCTYPE html>`, which puts the page in quirks mode and changes how the Loop lays out and
    // renders. That is a silent difference in behaviour with no other symptom, so it is announced.
    // The behaviour is unchanged (the shim must still run before the Loop's own script); only the
    // diagnosability is.
    console.warn('[loop-runtime] entry document has no <head> tag; shim injection order is not guaranteed');
  }
  const injected = headMatch
    ? text.slice(0, headMatch.index + headMatch[0].length) + tag + text.slice(headMatch.index + headMatch[0].length)
    : tag + text; // no <head> found — still runs before any script tag in document order
  return new TextEncoder().encode(injected);
}

// The Loop-facing API — window.collectivus. Deliberately the SAME shape native's WebLoopBridge
// injects (apps/apple-universal/Sources/WebSupport/WebLoopBridge.swift): a Loop authored once
// targets one contract regardless of which shell hosts it. Message shape here MUST match
// apps/web/src/lib/loop-embed/bridge.ts (Task 6) exactly — that file is the parent side, this is
// the Loop side, and they are independently written because a Service Worker is a static file, not
// a bundled module.
//
// Injected as a <script> tag prepended right after <head>, so it always runs before the Loop's own
// module script even though that script can execute before DOMContentLoaded.
const SHIM_SOURCE = `
(function () {
  if (window.collectivus) { return; }
  // AUDIO2 — THE AUDIO HAND-OVER (Q255). The parent unlocked one AudioContext inside the visitor's
  // press, seconds before this document existed, and parked it. Make the Loop's own
  // \`new AudioContext()\` return that already-running object.
  //
  // ⚠ WHY HERE AND NOT OVER postMessage. This runs synchronously, before the Loop's own script; a
  // message would arrive after the Loop had already built its context. The frame is same-origin
  // (sandbox="allow-scripts allow-same-origin", src on our own origin), so the parent's object is
  // simply reachable.
  //
  // ⚠ FEATURE-DETECTED, NEVER ENGINE-DETECTED. Nothing parked — a Loop opened directly, a
  // cross-origin host, a navigation straight to ?play=1 with no press in this document — and every
  // line below folds into the behaviour this shim had before the row.
  //
  // ⚠ WEB AUDIO ONLY. An <audio>/<video> element's play() is gated on THIS document's own
  // activation and no hand-over reaches it; such a Loop still needs a press inside the frame.
  (function () {
    var Native = window.AudioContext || window.webkitAudioContext;
    if (!Native) { return; }
    var shared = null;
    try {
      var holder = window.parent;
      // A cross-origin parent throws on the property read, not on the \`window.parent\` access.
      if (holder && holder !== window) { shared = holder["__clvSharedAudioContext"] || null; }
    } catch (e) { shared = null; }
    if (!shared || typeof shared.resume !== "function" || shared.state === "closed") { return; }
    var handedOver = false;
    function SharedAudioContext(options) {
      // The hand-over happens ONCE. A Loop that wants a second context wants a second context.
      if (handedOver) { return new Native(options); }
      // ⚠ A DECLARED sampleRate IS HONOURED RATHER THAN QUIETLY IGNORED. The shared context was
      // built with this device's default rate; handing it to a Loop that asked for a different one
      // would silently resample everything it decodes.
      if (options && typeof options.sampleRate === "number" && options.sampleRate !== shared.sampleRate) {
        return new Native(options);
      }
      handedOver = true;
      // Interrupted or suspended again since the press (WebKit does both): resume from here, where
      // the parent's activation still reaches us.
      if (shared.state !== "running") { try { shared.resume(); } catch (e) {} }
      return shared;
    }
    // So \`ctx instanceof AudioContext\` still holds for the handed-over object, whose prototype
    // belongs to the parent's realm rather than this one's.
    try { SharedAudioContext.prototype = Object.getPrototypeOf(shared); } catch (e) {}
    window.AudioContext = SharedAudioContext;
    if (window.webkitAudioContext) { window.webkitAudioContext = SharedAudioContext; }
  })();
  var handler = null;
  var queued = [];
  // v3 (TIER1) — collectivus.device. The worker hands over { class, tier } in __clv_device;
  // viewport is GETTERS over this frame, so it is the box the Loop actually draws into.
  var device;
  if (window.__clv_device && typeof window.__clv_device === "object") {
    device = { "class": window.__clv_device["class"], tier: window.__clv_device.tier };
    device.viewport = {
      get width() { return window.innerWidth; },
      get height() { return window.innerHeight; },
      get dpr() { return window.devicePixelRatio || 1; }
    };
  }
  try { delete window.__clv_device; } catch (e) { window.__clv_device = undefined; }
  var api = {
    bridgeVersion: 6,
    on: function (fn) {
      handler = fn;
      var pending = queued;
      queued = [];
      pending.forEach(function (event) { try { handler(event); } catch (e) { report(e); } });
    },
    ready: function (info) { post({ type: "ready", info: info || {} }); },
    // v6 (LOAD1) — "my own loading screen is up", { progress? } 0..1, the apps' exact shape. The
    // player turns its ready budget into a minute of silence, restarted by each call.
    loading: function (info) {
      var message = { type: "loading" };
      if (info && info.progress !== undefined) { message.progress = info.progress; }
      post(message);
    },
    cameraChanged: function (id) { post({ type: "cameraChanged", id: String(id) }); },
    // v4 (HAP2) — accepted and dropped: the web has no haptics path (loops-docs 60-haptics §1).
    // Nothing is posted and the Loop is never told, which is the contract on every no-op host.
    haptic: function () {},
    // v5 (WB2v2) — accepted and dropped: the website has no synthesized cursor to pull toward a
    // hotspot (the visitor's own mouse is the pointer) and no Debug Mode to list events in
    // (loops-docs web §3.6). The Loop's functions are never called and nothing is posted.
    provideHotspots: function () {},
    provideDebugEvents: function () {},
    // [007/L2c] (Q381) — WEB ONLY until [008/ATTRIB1], so not a bridge version: no Apple host has it
    // and a Loop feature-detects it. TEXT ONLY (Q378): { title, by? } as strings; no title clears.
    nowPlaying: function (info) {
      var message = { type: "nowPlaying", title: null };
      if (info && info.title !== null && info.title !== undefined) { message.title = String(info.title); }
      if (info && info.by !== null && info.by !== undefined) { message.by = String(info.by); }
      post(message);
    },
    log: function (message) { post({ type: "log", message: String(message) }); },
    error: function (error) { post({ type: "error", message: String((error && error.stack) || error) }); },
    __deliver: function (event) {
      if (handler) { try { handler(event); } catch (e) { report(e); } }
      else { queued.push(event); }
    }
  };
  // [007/PH2] (Q450) — an error the SHELL noticed (uncaught, a rejected promise, a throwing handler),
  // as distinct from the Loop's own \`collectivus.error\`: marked \`uncaught: true\`, as both Apple shims
  // do since [007/PH1]. The player logs it and never ends a playing Loop on it (\`player-health.ts\`).
  function report(error) {
    post({ type: "error", message: String((error && error.stack) || error), uncaught: true });
  }
  function post(message) {
    try {
      window.parent.postMessage({ source: "collectivus-loop", message: message }, window.location.origin);
    } catch (e) {}
  }
  window.addEventListener("message", function (event) {
    if (event.origin !== window.location.origin) { return; }
    if (!event.data || event.data.source !== "collectivus-shell") { return; }
    api.__deliver(event.data.message);
  });
  window.addEventListener("error", function (e) {
    report(e.message + " @ " + e.filename + ":" + e.lineno);
  });
  window.addEventListener("unhandledrejection", function (e) { report(e.reason); });
  if (device) { api.device = device; }
  window.collectivus = api;
})();
`;
