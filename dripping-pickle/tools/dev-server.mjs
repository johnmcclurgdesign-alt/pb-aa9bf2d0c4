// Local dev server. Serves the site exactly like `python -m http.server`, and adds
// one endpoint the browser can POST to so the feedback panel can write notes
// straight into the repo. Nothing here ships — GitHub Pages serves the static
// files and never sees this.
//
//   node tools/dev-server.mjs [port]

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] ?? 5173);
const FEEDBACK_DIR = join(ROOT, 'feedback');
const SHOTS_DIR = join(FEEDBACK_DIR, 'shots');
const NOTES = join(FEEDBACK_DIR, 'notes.json');
// Deleted notes are moved here rather than dropped. A note carries a screenshot and a
// camera that cannot be reconstructed, so a mis-click must be recoverable.
const DELETED = join(FEEDBACK_DIR, 'deleted.json');
// Cat behaviours authored in loops/cat-sequencer/. They live under assets/ rather
// than feedback/ because they are SHOW DATA, not review traffic — the warehouse
// cat is meant to run one by name.
const BEHAVIORS = join(ROOT, 'assets', 'cat', 'behaviors.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb':  'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.hdr':  'image/vnd.radiance',
  '.exr':  'image/x-exr',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.ktx2': 'image/ktx2',
  // ⚠ Media types are load-bearing, not cosmetic. iOS Safari refuses to start a
  // <video> served as application/octet-stream, and the symptom is a silently
  // black screen in the scene with no error anywhere.
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mov':  'video/quicktime',
  '.m4v':  'video/x-m4v',
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.wav':  'audio/wav',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.bin':  'application/octet-stream',
};

// ── the shell stand-in, injected by ?shell=1 (see the static handler) ──────────────────────
// Deliberately small and deliberately faithful to 30-engines/web/20-the-loop-manifest-and-bridge.md.
// `window.__shell` is the harness: .pause() .resume() .exit() .camera(id) .input(...) .mute(...)
// plus .log (everything the Loop said), .cameras and .readyInfo (what it declared at ready).
// Page-URL switches, all optional (W9): &device=<tier> presents bridge v3's `collectivus.device`
// with that tier; &ros=hang|decline|other offers a `runOfShow()` that never answers, answers null,
// or answers another Loop's manifest — each must fall back to the seed.
const SHELL_STUB = `<script>
(function () {
  var handler = null, queued = [];
  window.__shell = {
    log: [], cameras: null, ready: false, readyInfo: null, readyAtMs: null, changed: [], errors: [],
    send: function (e) { if (handler) handler(e); else queued.push(e); },
    pause:  function () { this.send({ type: 'pause' }); },
    resume: function () { this.send({ type: 'resume' }); },
    exit:   function () { this.send({ type: 'exit' }); },
    camera: function (id) { this.send({ type: 'camera', id: id }); },
    mute:   function (m, g) { this.send({ type: 'mute', muted: !!m, gain: g == null ? 0 : g }); },
    // unit space, origin top-left — never pixels
    point:  function (x, y, phase) { this.send({ type: 'input', input: { kind: 'point', x: x, y: y, phase: phase || 'hover' } }); },
    primary: function (phase, x, y) { this.send({ type: 'input', input: { kind: 'primary', phase: phase, x: x, y: y } }); },
    tap: function (x, y) { this.primary('down', x, y); this.primary('up', x, y); },
  };
  var qs = new URLSearchParams(location.search), tier = qs.get('device'), ros = qs.get('ros');
  window.collectivus = {
    bridgeVersion: tier ? 3 : 2,
    on: function (h) { handler = h; var q = queued; queued = []; q.forEach(h); },
    ready: function (o) {
      window.__shell.ready = true; window.__shell.readyInfo = o || {}; window.__shell.readyAtMs = performance.now();
      window.__shell.cameras = (o && o.cameras) || null;
    },
    log: function (m) { window.__shell.log.push(String(m)); },
    error: function (e) { window.__shell.errors.push(String(e && e.message || e)); },
    cameraChanged: function (id) { window.__shell.changed.push(String(id)); },
  };
  if (tier) window.collectivus.device = { class: 'web', tier: tier, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio } };
  if (ros) window.collectivus.runOfShow = function () {
    if (ros === 'hang') return new Promise(function () {});
    if (ros === 'decline') return Promise.resolve(null);
    return Promise.resolve({ manifestVersion: 1, loopId: 'some-other-loop', runSeed: 1, epoch: 0, validFrom: 0, validUntil: 3600, prefetchLeadSec: 60 });
  };
})();
</script>`;


function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((ok, fail) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { fail(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

// A missing file is not an error — nobody has authored a behaviour yet.
async function loadBehaviors() {
  try {
    const d = JSON.parse(await readFile(BEHAVIORS, 'utf8'));
    return { version: d.version ?? 1, behaviors: Array.isArray(d.behaviors) ? d.behaviors : [] };
  } catch { return { version: 1, behaviors: [] }; }
}

async function loadNotes() {
  try { return JSON.parse(await readFile(NOTES, 'utf8')); }
  catch { return []; }
}

async function loadDeleted() {
  try { return JSON.parse(await readFile(DELETED, 'utf8')); }
  catch { return []; }
}

// ★ NOT `notes.length + 1`, which is what this used to be. That only holds while notes are
// append-only: delete one and the next note reuses a LIVE id, whose screenshot is then
// overwritten in feedback/shots/ — the note keeps its text and silently gains someone
// else's picture. Take the highest id ever issued, deleted ones included, so a retired id
// is never handed out again while its .jpg is still on disk.
function nextId(...lists) {
  const max = lists.flat().reduce((m, n) => {
    const hit = /^n(\d+)$/.exec(n?.id ?? '');
    return hit ? Math.max(m, Number(hit[1])) : m;
  }, 0);
  return 'n' + String(max + 1).padStart(3, '0');
}

// ── auto-push (2026-08-19) ──────────────────────────────────────────────────
// A note written into the repo used to sit UNCOMMITTED until someone remembered
// to file it — shots lingered in the working tree for hours. Now every write to
// feedback/ schedules a commit+push of that directory, debounced 5 s so a note
// and its screenshot (and a burst of tick-offs) land as ONE commit. Failures
// only warn: no remote, no auth, or offline must never break note-taking.
// NO_AUTOPUSH=1 turns it off for a session.
const git = (args) => new Promise((ok) =>
  execFile('git', args, { cwd: ROOT }, (err, stdout, stderr) =>
    ok({ err, out: String(stdout) + String(stderr) })));
let pushTimer = null;
const pushReasons = new Set();
function schedulePush(reason) {
  if (process.env.NO_AUTOPUSH) return;
  pushReasons.add(reason);
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    const what = [...pushReasons].join(', ');
    pushReasons.clear();
    let r = await git(['add', 'feedback']);
    if (r.err) { console.warn('  ↥ autopush add failed:', r.out.trim()); return; }
    r = await git(['commit', '-m', `Notes: ${what}`]);
    if (r.err) {
      if (!/nothing to commit/.test(r.out)) console.warn('  ↥ autopush commit failed:', r.out.trim());
      return;
    }
    r = await git(['push']);
    console.log(r.err
      ? `  ↥ committed (${what}) but push failed — push by hand when back online`
      : `  ↥ pushed to GitHub: ${what}`);
  }, 5000);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ---- feedback endpoints -------------------------------------------------
  if (url.pathname === '/api/feedback' && req.method === 'POST') {
    try {
      const note = JSON.parse((await readBody(req)).toString('utf8'));
      await mkdir(SHOTS_DIR, { recursive: true });

      const notes = await loadNotes();
      const id = nextId(notes, await loadDeleted());
      let shot = null;

      if (note.screenshot?.startsWith('data:image/')) {
        const [meta, b64] = note.screenshot.split(',');
        const ext = meta.includes('png') ? '.png' : '.jpg';
        shot = `shots/${id}${ext}`;
        await writeFile(join(FEEDBACK_DIR, shot), Buffer.from(b64, 'base64'));
      }
      delete note.screenshot;

      notes.push({ id, status: 'open', ...note, shot });
      await writeFile(NOTES, JSON.stringify(notes, null, 2) + '\n', 'utf8');

      console.log(`  ✎ ${id}  ${note.object ?? '(no object)'}  —  ${String(note.comment ?? '').slice(0, 60)}`);
      schedulePush(`${id} filed`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id, shot }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) }));
    }
    return;
  }

  if (url.pathname === '/api/feedback' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(await loadNotes()));
    return;
  }

  // Update an existing note — this is how a note gets closed off. Separate from the POST
  // above, which only ever APPENDS: a reviewer filing feedback and someone working through
  // it are different jobs, and conflating them is how you accidentally overwrite a note
  // while trying to tick it off. Only status and resolution are writable; the note's own
  // record of what was seen (object, camera, screenshot) is never edited after the fact.
  if (url.pathname === '/api/feedback/update' && req.method === 'POST') {
    try {
      const { id, status, resolution } = JSON.parse((await readBody(req)).toString('utf8'));
      const notes = await loadNotes();
      const note = notes.find((n) => n.id === id);
      if (!note) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'no such note: ' + id }));
        return;
      }
      if (status !== undefined) note.status = status;
      if (resolution !== undefined) note.resolution = resolution;
      note.updated = new Date().toISOString();

      await writeFile(NOTES, JSON.stringify(notes, null, 2) + '\n', 'utf8');
      console.log(`  ✓ ${id}  ${note.status}${note.resolution ? '  —  ' + note.resolution.slice(0, 60) : ''}`);
      schedulePush(`${id} ${note.status}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, note }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) }));
    }
    return;
  }

  // Delete a note. "Mark done" is for a note that was dealt with; this is for one that
  // should never have been filed — a duplicate, a test, a note against a loop that no
  // longer exists. It is NOT a harder version of closing, so it keeps no resolution.
  //
  // The record moves to feedback/deleted.json instead of being dropped: the screenshot and
  // the camera in a note cannot be reconstructed, and the button sits one row away from
  // "Mark done". The .jpg in feedback/shots/ is deliberately left where it is — the
  // tombstone still points at it, so an undelete is a copy back rather than a re-shoot.
  if (url.pathname === '/api/feedback/delete' && req.method === 'POST') {
    try {
      const { id } = JSON.parse((await readBody(req)).toString('utf8'));
      const notes = await loadNotes();
      const i = notes.findIndex((n) => n.id === id);
      if (i < 0) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'no such note: ' + id }));
        return;
      }
      const [gone] = notes.splice(i, 1);

      const tomb = await loadDeleted();
      tomb.push({ ...gone, deleted_at: new Date().toISOString() });
      await writeFile(DELETED, JSON.stringify(tomb, null, 2) + '\n', 'utf8');
      await writeFile(NOTES, JSON.stringify(notes, null, 2) + '\n', 'utf8');

      console.log(`  ✗ ${id}  deleted  —  moved to feedback/deleted.json`);
      schedulePush(`${id} deleted`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id, notes }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) }));
    }
    return;
  }

  // Save a hero thumbnail straight out of a running loop. The gallery card wants a picture of
  // the scene at its own loop camera, and the only thing that can produce that is the scene
  // itself — there is no headless renderer here. So the browser captures its canvas and posts
  // the data URL, and this writes it to assets/thumbs/<id>.jpg.
  //
  // Capture note for whoever does the next one: a backgrounded tab never fires
  // requestAnimationFrame, so its drawing buffer is empty and toDataURL returns a blank
  // image that looks like a broken canvas. Drive one render by hand (__looks.render()) and
  // read the canvas in the SAME call. preserveDrawingBuffer must also be on, which it is
  // whenever the feedback panel is.
  if (url.pathname === '/api/thumb' && req.method === 'POST') {
    try {
      const { id, dataUrl } = JSON.parse((await readBody(req)).toString('utf8'));
      // The id becomes a filename, so it is not allowed to describe a path.
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id ?? '')) throw new Error('bad id: ' + id);
      const [meta, b64] = String(dataUrl ?? '').split(',');
      if (!/^data:image\/(jpeg|png);base64$/.test(meta ?? '')) throw new Error('expected a jpeg or png data URL');

      const dir = join(ROOT, 'assets', 'thumbs');
      await mkdir(dir, { recursive: true });
      const file = `${id}${meta.includes('png') ? '.png' : '.jpg'}`;
      const bytes = Buffer.from(b64, 'base64');
      await writeFile(join(dir, file), bytes);

      console.log(`  ▣ assets/thumbs/${file}  ${(bytes.length / 1024).toFixed(0)} KB`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: `assets/thumbs/${file}`, bytes: bytes.length }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) }));
    }
    return;
  }

  // ---- cat behaviour endpoints --------------------------------------------
  // Upsert by id, so Save on a loaded behaviour EDITS it rather than piling up
  // near-identical copies — which is what a plain append gives you the first
  // time someone tweaks a duration and saves again.
  if (url.pathname === '/api/behaviors' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(await loadBehaviors()));
    return;
  }

  if (url.pathname === '/api/behaviors' && req.method === 'POST') {
    try {
      const b = JSON.parse((await readBody(req)).toString('utf8'));
      // The id is how the warehouse cat will ask for one by name, so it has to
      // stay a plain slug — no paths, no spaces, nothing that needs quoting.
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(b.id ?? '')) throw new Error('bad id: ' + b.id);
      if (!Array.isArray(b.steps) || !b.steps.length) throw new Error('a behaviour needs at least one step');

      const doc = await loadBehaviors();
      const i = doc.behaviors.findIndex((x) => x.id === b.id);
      const rec = {
        id: b.id,
        name: String(b.name ?? b.id),
        loop: b.loop !== false,
        notes: String(b.notes ?? ''),
        steps: b.steps.map((s) => ({
          clip: String(s.clip),
          seconds: Math.max(0.05, Number(s.seconds) || 0),
          fade: Math.max(0, Number(s.fade) || 0),
        })),
      };
      if (i >= 0) doc.behaviors[i] = rec; else doc.behaviors.push(rec);
      await mkdir(join(ROOT, 'assets', 'cat'), { recursive: true });
      await writeFile(BEHAVIORS, JSON.stringify(doc, null, 2) + '\n', 'utf8');

      const secs = rec.steps.reduce((a, s) => a + s.seconds, 0);
      console.log('  \u266a ' + rec.id + '  ' + (i >= 0 ? 'updated' : 'saved') +
                  '  \u2014  ' + rec.steps.length + ' steps, ' + secs.toFixed(1) + 's');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: rec.id, behaviors: doc.behaviors }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) }));
    }
    return;
  }

  if (url.pathname === '/api/behaviors/delete' && req.method === 'POST') {
    try {
      const { id } = JSON.parse((await readBody(req)).toString('utf8'));
      const doc = await loadBehaviors();
      const i = doc.behaviors.findIndex((x) => x.id === id);
      if (i < 0) throw new Error('no such behaviour: ' + id);
      const [gone] = doc.behaviors.splice(i, 1);
      await writeFile(BEHAVIORS, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      console.log('  \u2717 ' + gone.id + '  behaviour deleted');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, behaviors: doc.behaviors }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) }));
    }
    return;
  }

  // ---- static files -------------------------------------------------------
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }

  try {
    let body = await readFile(file);
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';

    // ── ?shell=1 — a stand-in for the Collectivus shell, for THIS SERVER ONLY ────────────────
    // ★ THE BRIDGE IS THE ONE PART OF A WEB LOOP A BROWSER CANNOT EXERCISE, because
    // `window.collectivus` is injected by the host before the first script runs — so a Loop
    // opened over http never takes the bridge path at all, and every lifecycle, camera and
    // input bug in it is invisible until an attended device leg. Two Gate B bugs (#101 audio
    // not resuming, #88 the lost context on re-entry) live behind exactly that door.
    //
    // The stub is injected HERE, in an authoring tool the payload never contains, rather than
    // added to the scene behind a query flag: a shell stand-in inside the Loop would ship, and
    // a Loop that can pretend to be hosted is a Loop that can disagree with the real host.
    // It implements only what the contract says (`on`, `ready`, `log`, `error`,
    // `cameraChanged`, `bridgeVersion`) and drives it from `window.__shell`.
    if (type.startsWith('text/html') && url.searchParams.get('shell') === '1') {
      body = Buffer.from(String(body).replace('<head>', '<head>\n' + SHELL_STUB));
    }
    // assets change constantly during art direction; never let the browser
    // hold a stale .glb. This cost us an hour once already.
    const base = { 'content-type': type, 'cache-control': 'no-store', 'accept-ranges': 'bytes' };

    // ⚠ Range is MANDATORY for media, not an optimisation. WebKit probes a
    // media resource with a byte-range request before it will begin playback,
    // and a 200-with-the-whole-body stalls it SILENTLY. Desktop browsers are
    // forgiving and hide this; iOS Safari is not, so a <video> texture is a
    // black screen on a phone and correct on the Mac — which is exactly how it
    // presented, and it briefly looked like a finding about the phone.
    // The app's own scheme handler answers ranges; a dev server that does not
    // is a rig that disagrees with the thing it is standing in for.
    const range = req.headers.range;
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      const size = body.length;
      let start, end;
      if (m[1] === '') {                       // bytes=-suffix
        const suffix = Number(m[2]);
        if (!suffix) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return; }
        start = Math.max(0, size - suffix); end = size - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
      }
      if (start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...base,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': end - start + 1,
      });
      res.end(body.subarray(start, end + 1));
      return;
    }

    res.writeHead(200, { ...base, 'content-length': body.length });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found: ' + p);
  }
});

await mkdir(SHOTS_DIR, { recursive: true });
server.listen(PORT, () => {
  console.log(`  serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  notes -> ${NOTES}`);
});
