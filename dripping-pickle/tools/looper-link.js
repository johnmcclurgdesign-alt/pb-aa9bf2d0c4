// tools/looper-link.js — TEST LINK to Looper (the team's event scheduler), for demos and hosted test pages only.
//
// Off unless the page is opened with ?schedule=<looper url> (or ?schedule=1 for a local Looper on :5197). It never
// touches the event engine's own run of show: the ambient schedule still comes from the seed (or the shell). On top:
//   · hello every 10 s → Looper learns this page and its events (the catalogue below), and gets back any
//     "Fire now" clicks queued since the last hello, which fire here at once.
//   · the run of show: GET <looper>/api/runofshow/dripping-pickle?looper=1 every 10 s; each scheduled entry fires
//     when its second arrives (up to 90 s late, so a throttled background tab still catches it), once.
//   · every fire is reported back (POST /fired) so Looper's grid marks it.
//   · two chips bottom-right, as on Pirate Beach's test pages: "Looper in sync · <Chicago time>" (or what is wrong) and
//     "N fps · ms · WebGL"; they fade after 4 s without a touch and come back on the next.
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
  // one id per tab, so Looper counts the pages on this loop (its "clients connected")
  const client = Math.random().toString(36).slice(2, 12);
  const hello = () => post(`/api/loops/${LOOP}/hello`, { client, loop: LOOP, title: TITLE, href: location.href, events, state: {}, rev, clock: 'wall', wall: clockIn(now() / 1000), cmdSince })
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
  let rev = null, scheduled = [], refs = {}, lastOk = 0, status = 'loading';
  const done = new Set();
  async function poll() {
    try {
      const r = await fetch(`${base}/api/runofshow/${LOOP}?looper=1`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const m = await r.json();
      lastOk = Date.now(); status = 'on';
      scheduled = m.scheduled ?? []; refs = m.looper?.refs ?? {};
      if (m.looper?.rev !== rev) { rev = m.looper?.rev ?? null; console.info(`[looper] run of show rev ${rev}: ${scheduled.length} scheduled`); }
    } catch (e) { if (status !== 'unreachable') console.warn(`[looper] run of show: ${e.message}`); status = 'unreachable'; }
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

  hud(() => {
    const ago = lastOk ? Date.now() - lastOk : Infinity;
    if (status === 'loading' && !lastOk) return ['wait', 'connecting…'];
    if (status === 'unreachable' || ago > 30000) return ['down', lastOk ? `not heard from in ${Math.round(ago / 1000)} s` : 'not reachable'];
    return ['ok', `in sync · ${clockIn(now() / 1000)}`];
  });
}

// ---- the chips (Pirate Beach's src/looperBadge.js + its stats line, same look)
function hud(state) {
  const TONE = { ok: '#5fd38a', down: '#ef6b5f', wait: '#8da3a8' };
  const chip = 'position:fixed;right:14px;z-index:41;pointer-events:none;display:flex;align-items:center;gap:7px;'
    + 'font:500 12px/1 ui-monospace,Consolas,monospace;color:#c4d9d6;background:rgba(10,20,24,.55);padding:5px 9px;'
    + 'border-radius:6px;font-variant-numeric:tabular-nums;letter-spacing:.03em;white-space:nowrap;transition:opacity .35s ease';
  const badge = document.createElement('div'), dot = document.createElement('i'), text = document.createElement('span');
  badge.style.cssText = chip + ';bottom:38px';
  dot.style.cssText = 'width:8px;height:8px;border-radius:50%;flex:none';
  badge.append(dot, text);
  const fps = document.createElement('div');
  fps.style.cssText = chip + ';bottom:12px';
  fps.textContent = '-- fps';
  document.body.append(badge, fps);

  const draw = () => {
    const [tone, line] = state();
    dot.style.background = TONE[tone];
    dot.style.boxShadow = tone === 'ok' ? `0 0 6px ${TONE.ok}` : 'none';
    text.textContent = `Looper ${line}`;
  };
  draw(); setInterval(draw, 1000);

  // frames per half second, the way Pirate Beach counts them
  let frames = 0, t0 = performance.now();
  const count = (t) => {
    frames++;
    if (t - t0 >= 500) {
      const f = (frames * 1000) / (t - t0);
      fps.textContent = `${f.toFixed(0)} fps · ${(1000 / f).toFixed(1)} ms · WebGL`;
      frames = 0; t0 = t;
    }
    requestAnimationFrame(count);
  };
  requestAnimationFrame(count);

  // fade out after 4 s untouched, back on the next touch / move / key
  let timer = 0;
  const show = (on) => { for (const el of [badge, fps]) el.style.opacity = on ? '1' : '0'; };
  const wake = () => { show(true); clearTimeout(timer); timer = setTimeout(() => show(false), 4000); };
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel']) addEventListener(ev, wake, { capture: true, passive: true });
  wake();
}
