// tools/looper-link.js — TEST LINK to Looper (the team's event scheduler), for demos and hosted test pages only.
//
// Off unless the page is opened with ?schedule=<looper url> (or ?schedule=1 for a local Looper on :5197). It never
// touches the event engine's own run of show: the ambient schedule still comes from the seed (or the shell). On top:
//   · hello every 10 s → Looper learns this page and its events (the catalogue below), and gets back any
//     "Fire now" clicks queued since the last hello, which fire here at once.
//   · the run of show: GET <looper>/api/runofshow/dripping-pickle?looper=1 every 10 s; each scheduled entry fires
//     when its second arrives (up to 90 s late, so a throttled background tab still catches it), once.
//   · every fire is reported back (POST /fired) so Looper's grid marks it.
// Looper ids are family.<engine id> (screens.signal_interference): Looper groups and colours by the part before the '.'.

const q = new URLSearchParams(location.search);
const p = q.get('schedule');
const base = !p || p === '0' ? null
  : p === '1' ? `${location.protocol === 'https:' ? 'https:' : 'http:'}//${location.hostname || 'localhost'}:5197`
  : (p.match(/^(https?:\/\/[^/]+)/) ?? [])[1] ?? null;

const LOOP = 'dripping-pickle', TITLE = 'The Dripping Pickle', TZ = 'America/Chicago';
const POLL_MS = 10000, HELLO_MS = 10000, LATE_SEC = 90;

// what Looper may schedule or fire: the room's own events (local reactions like jar_offbelt / mouse_bolt stay out)
const CATALOGUE = [
  ['signal_interference', 'Screens', 'Signal interference', 3],
  ['screens_dial', 'Screens', 'Raw feed dial', 2],
  ['delivery_mission', 'Screens', 'Delivery mission', 80],
  ['mission_report', 'Screens', 'Mission report', 46],
  ['cat_stirs', 'Cat', 'Stirs', 14],
  ['cat_hunts', 'Cat', 'Hunts the mouse', 60],
  ['mouse_errand', 'Mouse', 'Errand', 46],
  ['mouse_belt_run', 'Mouse', 'Belt run', 40],
  ['conveyor_stall', 'Conveyor', 'Stall', 12],
  ['jar_knock', 'Jar', 'Knock', 3],
  ['pendant_flicker', 'Pendant', 'Flicker', 2],
  ['radio_on', 'Radio', 'On', 2],
  ['radio_off', 'Radio', 'Off', 2],
];
const toEngine = (id) => String(id).slice(String(id).indexOf('.') + 1);
const events = CATALOGUE.map(([id, group, label, duration]) => ({ id: `${group.toLowerCase()}.${id}`, group, label, duration, params: null }));

const clockIn = (t) => new Date(t * 1000).toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false });

if (base) start();

function start() {
  let offMs = 0;   // this device's clock against Looper's (internet time)
  const now = () => Date.now() + offMs;
  async function syncClock() {
    let best = null;
    for (let i = 0; i < 4; i++) {
      const t0 = Date.now();
      try {
        const r = await fetch(`${base}/api/time`, { cache: 'no-store' });
        const t = r.ok ? (await r.json()).now : NaN, t1 = Date.now();
        if (Number.isFinite(t) && (!best || t1 - t0 < best.rtt)) best = { rtt: t1 - t0, off: t - (t0 + t1) / 2 };
      } catch { /* the next try */ }
    }
    if (best) offMs = Math.round(best.off);
  }
  // no keepalive (Chromium caps them in flight); text/plain keeps it a simple CORS request
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) }).catch(() => null);

  const fire = (looperId) => {
    const ev = window.__events;
    if (!ev) return { ok: false, error: 'event engine not started' };
    try { ev.fire(toEngine(looperId)); return { ok: true }; } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  };
  const fired = (body) => post(`/api/loops/${LOOP}/fired`, { clock: 'wall', href: location.href, time: new Date().toISOString(), ...body });

  // ---- Fire now, via the hello's reply
  let cmdSince = null;
  const hello = () => post(`/api/loops/${LOOP}/hello`, { loop: LOOP, title: TITLE, href: location.href, events, state: {}, rev, clock: 'wall', wall: clockIn(now() / 1000), cmdSince })
    .then((r) => r?.json?.()).then((b) => {
      if (!b) return;
      for (const cmd of b.commands ?? []) {
        const r = fire(cmd.event);
        console.info(`[looper] fire now ${cmd.event}${r.ok ? '' : ` — ${r.error}`}`);
        fired({ cue: `now:${cmd.cid}`, event: cmd.event, at: 'now', firedAt: clockIn(now() / 1000), ok: r.ok, error: r.error });
      }
      if (b.cmdHead != null) cmdSince = Math.max(cmdSince ?? 0, b.cmdHead, ...(b.commands ?? []).map((c) => c.cid));
    }).catch(() => {});

  // ---- the run of show: fire each scheduled moment when its second comes
  let rev = null, scheduled = [], refs = {};
  const done = new Set();
  async function poll() {
    try {
      const r = await fetch(`${base}/api/runofshow/${LOOP}?looper=1`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const m = await r.json();
      scheduled = m.scheduled ?? []; refs = m.looper?.refs ?? {};
      if (m.looper?.rev !== rev) { rev = m.looper?.rev ?? null; console.info(`[looper] run of show rev ${rev}: ${scheduled.length} scheduled`); }
    } catch (e) { console.warn(`[looper] run of show: ${e.message}`); }
  }
  function tick() {
    const s = Math.floor(now() / 1000);
    for (const e of scheduled) {
      if (done.has(e.id) || e.at > s) continue;
      done.add(e.id);
      if (s - e.at > LATE_SEC) continue;   // already past when we learned of it: skipped, never caught up
      const r = fire(e.kind);
      console.info(`[looper] ${clockIn(e.at)} ${e.kind}${r.ok ? '' : ` — ${r.error}`}`);
      const ref = refs[e.id];
      if (ref) fired({ cue: ref.cue, event: e.kind, at: ref.at, k: ref.k, firedAt: clockIn(s), ok: r.ok, error: r.error });
    }
  }

  // wait for the room's event engine, then join
  const ready = setInterval(async () => {
    if (!window.__events) return;
    clearInterval(ready);
    await syncClock(); setInterval(syncClock, 600000);
    await poll();
    // whatever is already past at join is not fired (a late tab must not replay the evening)
    const s0 = Math.floor(now() / 1000);
    for (const e of scheduled) if (e.at <= s0 - 1) done.add(e.id);
    hello(); setInterval(hello, HELLO_MS);
    setInterval(poll, POLL_MS);
    setInterval(tick, 250);
    console.info(`[looper] linked to ${base} as ${LOOP}`);
  }, 250);
}
