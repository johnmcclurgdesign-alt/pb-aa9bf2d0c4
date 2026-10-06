// web-leg-verdicts.mjs — THE INSTRUMENT of the web class, shared by two drivers.
//
// [006/HARN1] (2026-09-18). Extracted from `scripts/web-leg-driver.mjs` (LP3c, WS3/WS4,
// LOOP-VIBES-WEB, WEB-INPUT-DELIVERY) so that two programs can run the SAME instrument. Two verdicts
// changed on the way, both declared where they are made: `picture` now FAILS a box with no Loop in
// it (it used to count the player's error panel), and the site's `ready` evidence names the Loop's
// budget instead of a fixed 15 s (TIER1 made the budget the Loop's). Everything else moved verbatim.
// The two programs:
//
//   1. `scripts/web-leg-driver.mjs` — our web class, driven through the real site by
//      `scripts/device-leg.sh --classes web`.
//   2. `collectivus-loops-docs.git/40-delivery/tools/loop-harness/` — the developer's copy, run on
//      a Loop author's own desk against a payload zip, which writes `HARNESS.md`.
//
// ⚠ THE HARNESS CARRIES A BYTE-IDENTICAL COPY OF THIS FILE, AND `scripts/check-harness-parity.sh`
// FAILS THE MOMENT THE TWO DIFFER. A developer's green `HARNESS.md` is the `web` surface's evidence
// under the delivery gate on its own (Josh, LP7a) — so his green is our green only while this file
// and his copy are the same bytes. Edit it HERE, then copy it to loops-docs in the same change.
//
// ⚠ THEREFORE IT IMPORTS NOTHING BUT NODE ITSELF. No monorepo path, no package — the developer has
// Node and a Chromium and nothing else of ours.
//
// What lives here is everything that DECIDES a row, and everything that measures what the decision
// reads: the browser launch, the CDP session, the page-side recorder and delivery probe, the
// picture census, the press, and the verdict functions for `ready`, `picture`, `input`, `exit`
// and `page` — and, since [007/WEBKIT1], the audio probe and the `audio` verdict, which the SITE
// driver runs on both engines (Chromium over CDP here; WebKit through `scripts/web-leg-webkit.mjs`,
// which imports this file) and the developer's harness does not use. What does NOT live here is how each driver gets a Loop onto the screen (the site's
// tile and `?play=1` for ours; a static host page for the developer's) — that is the one part the
// two legitimately do differently, and `open` is judged by each driver for that reason.
//
// It asserts no frame rate (`fps-counter-is-not-render-assertion`) and flips no `proven`
// (standing rule 1).

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

// ⚠ [006/TIER2] `screenWidth`/`screenHeight` ARE SET, NOT LEFT TO CHROMIUM. The web player picks a
// Loop's tier from `window.screen` (TIER1 `webTier`: short side < 768 → phone), and headless
// Chromium reports an 800×600 screen at the desktop viewport unless told otherwise — measured
// 2026-09-18 — so every "desktop" run was handed `phone`. The emulated screen is the viewport.
export const VIEWPORTS = {
  // A 16:10 laptop, the shape most of the beta is read on.
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
    screenWidth: 1440, screenHeight: 900 },
  // iPhone 12 Pro's CSS viewport — the device the shell's own web Loops were proven on (WG2/WG4).
  phone: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    screenWidth: 390, screenHeight: 844 },
};

/** The rows the two drivers share. The site driver adds `tile` in front of them.
 *  [007/LEGFIX1] `files` last: it reads every request of the run, so it is decided after `exit`. */
export const SHARED_ROWS = ['open', 'ready', 'picture', 'input', 'exit', 'page', 'files'];

// ── finding a browser, without installing one ────────────────────────────────────────────────────

function newestUnder(root, prefix, tail) {
  if (!existsSync(root)) return null;
  const names = readdirSync(root)
    .filter((name) => name.startsWith(prefix))
    // The suffix is a build number, so it sorts numerically, not lexically: 1234 is newer than 999.
    .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
  for (const name of names) {
    const candidate = join(root, name, ...tail);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Playwright's browser cache, which `npx playwright install chromium` fills — on macOS and Linux. */
function playwrightCache() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  const home = process.env.HOME ?? '';
  return process.platform === 'darwin'
    ? join(home, 'Library', 'Caches', 'ms-playwright')
    : join(home, '.cache', 'ms-playwright');
}

export function findChromium() {
  if (process.env.CLV_CHROMIUM) {
    return existsSync(process.env.CLV_CHROMIUM) ? process.env.CLV_CHROMIUM : null;
  }
  const cache = playwrightCache();
  return (
    // Chrome for Testing: a real browser with a real GPU path, which is what a viewer has.
    newestUnder(cache, 'chromium-', [
      'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS',
      'Google Chrome for Testing',
    ]) ??
    newestUnder(cache, 'chromium-', [
      'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium',
    ]) ??
    newestUnder(cache, 'chromium-', ['chrome-linux', 'chrome']) ??
    newestUnder(cache, 'chromium-', ['chrome-linux64', 'chrome']) ??
    // ⚠ The headless shell is the FALLBACK, not the first choice: it renders WebGL through
    // SwiftShader, so a census taken on it measures a software rasteriser rather than a GPU. Still
    // a true answer to "is anything drawn"; a weaker one to "does this look right", which this
    // instrument does not claim anyway.
    newestUnder(cache, 'chromium_headless_shell-', [
      'chrome-headless-shell-mac-arm64', 'chrome-headless-shell',
    ]) ??
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
     '/Applications/Chromium.app/Contents/MacOS/Chromium',
     '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => existsSync(p)) ??
    null
  );
}

/**
 * Start one headless Chromium with its own throwaway profile. One per viewport: a phone is not a
 * narrow desktop, and a second run in the same browser would read state the first one warmed.
 *
 * ⚠ `close()` MAY NOT THROW (Q252). `rmSync` races the browser process that was SIGKILLed a line
 * earlier and still has its profile open, so it throws `ENOTEMPTY` intermittently; a throw there
 * once killed the driver BEFORE it printed a verdict it had already reached. A temp directory that
 * outlives the run is litter, and litter is not worth a measurement.
 */
export function launchBrowser(binary) {
  const profile = mkdtempSync(join(tmpdir(), 'clv-web-leg-'));
  const port = 9222 + Math.floor(Math.random() * 700);
  const child = spawn(binary, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    // ⚠ NOT `--disable-web-security`, and never. The payload fetch is a real request and the
    // origin really does answer it. Switching the check off would turn the one assertion that a
    // Loop is actually reachable from a browser into a tautology.
    '--hide-scrollbars', '--mute-audio',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  return {
    port, profile, stderr, child,
    close() {
      child.kill('SIGKILL');
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (error) {
        console.error(`web-leg: left ${profile} behind — ${error.message}`);
      }
    },
  };
}

// ── CDP, over node's own WebSocket ───────────────────────────────────────────────────────────────

export class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => this.receive(JSON.parse(event.data)));
  }

  receive(message) {
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${message.error.message} (${waiter.method})`));
      else waiter.resolve(message.result);
      return;
    }
    for (const handler of this.listeners.get(message.method) ?? []) handler(message.params);
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

export function withDeadline(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${what}`)), ms);
    }),
  ]);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `check` until it returns something truthy, or give up. Returns null on the deadline rather
 *  than throwing, so the caller decides whether a miss is a FAIL or something milder. */
export async function until(check, ms, step = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}

export async function openBrowser(port) {
  // The port takes a moment to answer; /json/version is the handshake.
  const version = await until(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      return response.ok ? await response.json() : null;
    } catch { return null; }
  }, 20_000, 200);
  if (!version) throw new Error('the browser never opened its DevTools port');
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('the DevTools socket refused')), { once: true });
  });
  return new CDP(socket);
}

// ── the page-side recorder ───────────────────────────────────────────────────────────────────────
//
// ⚠ IT LISTENS ON THE BRIDGE, NOT ON THE COMPONENT. What has to be asserted is that the LOOP said
// `ready` and that the LOOP answered a click — not that a host set a variable. `postMessage` from
// the Loop's iframe to its parent is the actual wire (the service worker's injected shim posts
// `{source:"collectivus-loop", message:…}`), so recording that is recording the same traffic the
// player itself reads, from outside the player.
export const RECORDER = `
  if (window.top === window) {
    window.__clvLeg = { messages: [], errors: [] };
    window.addEventListener('message', function (event) {
      if (event.data && event.data.source === 'collectivus-loop') {
        window.__clvLeg.messages.push(event.data.message);
      }
    });
    window.addEventListener('error', function (event) {
      window.__clvLeg.errors.push(String(event.message));
    });
  }
`;

// ── the delivery probe, in the Loop's OWN document ───────────────────────────────────────────────
//
// [006/WEB-INPUT-DELIVERY], Josh's Q253 answer (PREP5, 2026-09-14). ⚠ THE `input` ROW ASSERTS
// DELIVERY. Until then the row proved delivery by the LOOP ANSWERING — so it could not tell
// "arrived, Loop silent" from "never arrived", and printed the second one's wording for the first.
// Delivery is what the shell must guarantee; whether a Loop reacts is the Loop's business.
//
// ⚠ THREE LINKS, NAMED SEPARATELY, BECAUSE A FAILING ROW MUST SAY WHICH ONE BROKE. The chain is
// overlay → `pointMessage`/`primaryMessage` → postMessage → the shim's `__deliver` → the handler the
// Loop registered with `collectivus.on` → whatever the Loop does with it. This records the last
// three: what entered the shim, what reached the Loop's own handler, and what that handler threw.
//
// ⚠ IT WRAPS, IT NEVER REPLACES. `on` passes the Loop's own function through to the real `on`,
// inside a wrapper that counts and rethrows; the shim's own `try/catch` therefore still sees the
// throw and still calls `api.error`. Calling `on` ourselves would EVICT the Loop's handler — the rig
// would then be measuring itself, which is [[experiment-must-prove-it-acted]] with the sign flipped.
//
// ⚠ IT MUST BE IN PLACE BEFORE THE SHIM RUNS, which is why it is injected with the recorder through
// `Page.addScriptToEvaluateOnNewDocument` and takes `window.collectivus` by accessor rather than by
// reading it later. The shim's own guard is `if (window.collectivus) { return; }`, so the getter
// returns `undefined` until the shim assigns — anything else here would stop the bridge installing.
//
// ⚠ AND `installed` IS THE PROBE'S PROOF THAT IT ACTED. A probe that never ran looks exactly like a
// press that never arrived ([[experiment-must-prove-it-acted]]); `inputVerdict` refuses to call that
// a Loop failure, and says the rig measured nothing instead.
export const DELIVERY_PROBE = `
  if (window.top !== window) {
    var state = { installed: false, subscribed: false, reason: '',
                  intoBridge: [], intoHandler: [], threw: [] };
    window.__clvDelivery = state;
    var describe = function (event) {
      if (!event || typeof event !== 'object') return { type: 'unknown', detail: 'unknown' };
      if (event.type === 'input' && event.input) {
        return { type: 'input',
                 detail: String(event.input.kind) + ' ' + String(event.input.phase) };
      }
      return { type: String(event.type), detail: String(event.type) };
    };
    var real;
    try {
      Object.defineProperty(window, 'collectivus', {
        configurable: true,
        get: function () { return real; },
        set: function (api) {
          real = api;
          if (!api || typeof api.__deliver !== 'function' || typeof api.on !== 'function') {
            state.reason = 'window.collectivus was assigned something that is not the bridge shim';
            return;
          }
          var deliver = api.__deliver;
          api.__deliver = function (event) {
            state.intoBridge.push(describe(event));
            return deliver.apply(this, arguments);
          };
          var on = api.on;
          api.on = function (fn) {
            state.subscribed = true;
            return on.call(this, function (event) {
              state.intoHandler.push(describe(event));
              try { return fn.apply(this, arguments); }
              catch (e) { state.threw.push(String((e && e.message) || e)); throw e; }
            });
          };
          state.installed = true;
        }
      });
    } catch (e) {
      state.reason = 'the probe could not take window.collectivus: ' + String((e && e.message) || e);
    }
  }
`;

/**
 * One tab, wired the way both drivers need it: console and exceptions recorded, failed requests
 * recorded with their URLs, the viewport (and touch, for the phone) emulated, and the recorder and
 * delivery probe registered for every new document. Returns the helpers the rows are measured with.
 */
export async function openSession(cdp, view, { audio = false } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => cdp.send(method, params, sessionId);

  const consoleLines = [];
  cdp.on('Runtime.consoleAPICalled', (params) => {
    consoleLines.push({
      level: params.type,
      text: params.args.map((a) => a.value ?? a.description ?? '').join(' '),
    });
  });
  cdp.on('Runtime.exceptionThrown', (params) => {
    // ⚠ `exceptionDetails.text` ALONE IS USELESS EVIDENCE — for a rejected promise it is the literal
    // string "Uncaught (in promise)" and nothing else. The thrown value's own description is the
    // part a reader can act on.
    const details = params.exceptionDetails ?? {};
    const thrown = details.exception?.description ?? details.exception?.value;
    const where = details.url ? ` @ ${details.url}:${details.lineNumber ?? '?'}` : '';
    consoleLines.push({
      level: 'error',
      text: `${details.text ?? 'exception'}${thrown ? `: ${thrown}` : ''}${where}`,
    });
  });

  // A request's URL is on `requestWillBeSent` and a failure carries only the id, so the map is the
  // only way `loadingFailed` can name what failed (a CSP or CORS block arrives that way).
  // [007/LEGFIX1] `document` is the URL of the document that MADE the request (CDP's `documentURL`),
  // and `requests` is every request, answered or not — the `files` row reads both (`filesVerdict`).
  const httpFailures = [];
  const requests = [];
  const requestURLs = new Map();
  const requestDocuments = new Map();
  cdp.on('Network.requestWillBeSent', (params) => {
    const url = params.request?.url ?? '';
    requestURLs.set(params.requestId, url);
    requestDocuments.set(params.requestId, params.documentURL ?? '');
    requests.push({ url, document: params.documentURL ?? '' });
  });
  cdp.on('Network.responseReceived', (params) => {
    const { status, url } = params.response ?? {};
    if (url) requestURLs.set(params.requestId, url);
    if ((status ?? 0) >= 400) {
      httpFailures.push({ status, url, document: requestDocuments.get(params.requestId) ?? '' });
    }
  });
  cdp.on('Network.loadingFailed', (params) => {
    // ⚠ `net::ERR_ABORTED` IS THE RIG'S OWN DOING. The `exit` row navigates away mid-run, which
    // aborts whatever the Loop still had in flight.
    if (params.errorText === 'net::ERR_ABORTED') return;
    httpFailures.push({
      status: params.blockedReason ? `blocked (${params.blockedReason})` : (params.errorText || 'failed'),
      url: requestURLs.get(params.requestId) ?? 'unknown request',
      document: requestDocuments.get(params.requestId) ?? '',
    });
  });

  await call('Runtime.enable');
  await call('Page.enable');
  await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', view);
  if (view.mobile) await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await call('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
  // ⚠ A SECOND REGISTRATION, NOT AN APPENDED STRING — a syntax error in either cannot silence the
  // other; one page-init script that throws takes everything after it in the same source with it.
  await call('Page.addScriptToEvaluateOnNewDocument', { source: DELIVERY_PROBE });
  // [007/WEBKIT1] OPT-IN: only the site driver's `audio` row reads it, and the developer's harness,
  // which calls this with no options, must launch exactly the page it launched before.
  if (audio) await call('Page.addScriptToEvaluateOnNewDocument', { source: AUDIO_PROBE });

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const goto = async (url) => {
    await call('Page.navigate', { url });
    await until(() => evaluate('document.readyState === "complete"'), 20_000, 150);
  };
  return { call, evaluate, goto, consoleLines, httpFailures, requests };
}

// ── ready ────────────────────────────────────────────────────────────────────────────────────────

/** The Loop's own `ready` info, as JSON text, once it has crossed the bridge — else null. */
export async function readyInfo(evaluate) {
  const seen = await evaluate('window.__clvLeg.messages.some((m) => m && m.type === "ready")');
  if (!seen) return null;
  return evaluate(
    'JSON.stringify((window.__clvLeg.messages.find((m) => m.type === "ready") || {}).info || {})');
}

/**
 * The `ready` row. ⚠ A CLAIM, NEVER A VERDICT ON ITS OWN — the census corroborates it
 * (`ready-flag-must-be-corroborated`).
 *
 * ⚠ [006/HARN1] THE VERDICT IS WHAT THE PLAYER DID, NOT A STOPWATCH. The player gives up when its
 * budget timer fires; a `ready` handled before that callback runs is accepted, one after it is not.
 * The Loop's iframe is same-origin and shares the page's main thread, so a Loop that holds the
 * thread delays that timer — Pirate Beach v0.1.0's desktop `ready` was HANDLED at 16.6 s on
 * 2026-09-18 and accepted. Judging by the clock would fail a Loop the player let through; judging by
 * the player makes both hosts decide the same race the same way. The clock is printed, and warned.
 *
 * @param {object} reading
 * @param {string|null} reading.info — the ready info as JSON text, or null if none crossed.
 * @param {number} reading.waitedSeconds — how long the driver watched the wire.
 * @param {number|null} [reading.budgetSeconds] — the player's budget, when the driver knows it.
 * @param {boolean} [reading.accepted] — the player took this `ready` (the harness host reports it).
 * @param {number|null} [reading.readyAfterMs] — when the player handled it, from its own start.
 */
export function readyVerdict({ info, waitedSeconds, budgetSeconds = null, accepted = false, readyAfterMs = null }) {
  if (budgetSeconds == null) {
    // The site driver's reading: it cannot see the entry's budget, only the wire — and the site's
    // player has already taken the Loop down if its budget ran out, so no `ready` can cross after.
    if (info != null) {
      return { verdict: 'PASS',
        label: 'the Loop announced ready over the bridge (a claim — the census corroborates it)',
        evidence: info.slice(0, 160) };
    }
    return { verdict: 'FAIL', label: `no \`ready\` crossed the bridge inside ${waitedSeconds}s`,
      evidence: 'the player gives up at the Loop\'s ready budget (15 s unless it declares `readyBudgetSeconds`) '
        + 'and shows its error state; check the payload fetch and the service worker' };
  }
  const when = readyAfterMs == null ? '' : `ready handled at ${(readyAfterMs / 1000).toFixed(1)} s · `;
  if (info != null && accepted) {
    const late = readyAfterMs != null && readyAfterMs > budgetSeconds * 1000
      ? `⚠ past the ${budgetSeconds} s budget — the player's timer ran late because the Loop held the main thread, `
        + 'so it was accepted, as the site would; on a slower machine this Loop misses its budget · '
      : '';
    return { verdict: 'PASS',
      label: `the Loop announced ready over the bridge and the player accepted it — ${budgetSeconds} s budget (a claim — the census corroborates it)`,
      evidence: `${when}${late}${info.slice(0, 140)}` };
  }
  if (info != null) {
    return { verdict: 'FAIL',
      label: `\`ready\` arrived after the player had given up at its ${budgetSeconds} s budget`,
      evidence: `${when}a viewer sees the error state, not the Loop` };
  }
  return { verdict: 'FAIL',
    label: `no \`ready\` crossed the bridge inside the ${budgetSeconds} s budget`,
    evidence: `watched ${waitedSeconds} s · the player gives up at ${budgetSeconds} s and shows its error state, `
      + 'which is exactly what a viewer sees' };
}

// ── PNG → a colour census ────────────────────────────────────────────────────────────────────────
//
// ⚠ THE CENSUS IS TAKEN ON WHAT THE COMPOSITOR PRODUCED, NOT ON WHAT THE PAGE SAYS IT DREW. Reading
// the canvas back from inside the page (`gl.readPixels`, `toDataURL`) would prove nothing this row
// cares about: it cannot tell a Loop that is on screen from one painted behind an opaque overlay,
// and web-test-loop-001 does not even keep its drawing buffer. `Page.captureScreenshot` is the
// browser's own picture of the box — the web's equivalent of the shell's `WebLoopPictureCensus`.

/** Decode an 8-bit truecolour PNG (Chrome's screenshot format) into {width, height, pixels}. */
export function decodePNG(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let header = null;
  const data = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colour: body[9],
        interlace: body[12],
      };
    } else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!header) throw new Error('PNG has no IHDR');
  if (header.depth !== 8 || (header.colour !== 2 && header.colour !== 6) || header.interlace !== 0) {
    throw new Error(`unsupported PNG: depth ${header.depth}, colour ${header.colour}, interlace ${header.interlace}`);
  }
  const channels = header.colour === 6 ? 4 : 3;
  const stride = header.width * channels;
  const raw = inflateSync(Buffer.concat(data));
  const pixels = Buffer.alloc(stride * header.height);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = value & 0xff;
    }
    previous = out;
  }
  return { width: header.width, height: header.height, channels, pixels };
}

/** 48 × 48 = 2304 samples — the SAME sample count the shell's census reports, so a web number and
 *  an iPhone number in one DEVICE-LEG.md can be read side by side. */
export const CENSUS_SIDE = 48;

export function census(image) {
  const seen = new Set();
  for (let row48 = 0; row48 < CENSUS_SIDE; row48 += 1) {
    for (let col = 0; col < CENSUS_SIDE; col += 1) {
      const x = Math.min(image.width - 1, Math.floor(((col + 0.5) / CENSUS_SIDE) * image.width));
      const y = Math.min(image.height - 1, Math.floor(((row48 + 0.5) / CENSUS_SIDE) * image.height));
      const at = (y * image.width + x) * image.channels;
      seen.add((image.pixels[at] << 16) | (image.pixels[at + 1] << 8) | image.pixels[at + 2]);
    }
  }
  return seen.size;
}

/** The player box, in CSS px, or null. Both hosts draw the player as `.loop-embed`. */
export function playerBox(evaluate) {
  return evaluate(`(() => {
    const el = document.querySelector('.loop-embed');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);
}

/**
 * The `picture` row: photograph the COMPOSITED player box and count its colours.
 * ⚠ A FLOOR, NOT A VERDICT: a stuck loading screen scores hundreds of colours (WG1c).
 *
 * ⚠ [006/HARN1] — AND ONLY WHILE THE LOOP IS STILL IN THE BOX. A player that has given up (the ready
 * budget ran out) takes the iframe down and draws its ERROR state, and the census used to count
 * THAT: Pirate Beach v0.1.0's `picture` PASS on #114 (10 colours on desktop, 56 on the phone, at
 * 1200×675 / 342×192) was the error panel's text over the page colour, measured two seconds after
 * the `input` row on the same run said "the player iframe was gone by the press". Which side of the
 * floor it landed on depended on the host's error panel, not on the Loop — the site's scored 10, the
 * harness's plainer one scored under 8, and the two instruments disagreed about a Loop neither had
 * photographed. A box with no Loop in it is a FAIL for that reason, said as that reason.
 */
export async function judgePicture(call, evaluate, box, censusFloor) {
  if (!box || box.width < 8 || box.height < 8) {
    return { verdict: 'FAIL', label: 'the player box has no area to photograph', evidence: JSON.stringify(box) };
  }
  const mounted = await evaluate('!!document.querySelector("iframe.player-frame")');
  const shot = await call('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
    captureBeyondViewport: false,
  });
  const colours = census(decodePNG(Buffer.from(shot.data, 'base64')));
  return pictureVerdict(colours, censusFloor, box, mounted);
}

export function pictureVerdict(colours, censusFloor, box, mounted = true) {
  const label = `${colours} distinct colours over ${CENSUS_SIDE * CENSUS_SIDE} samples`;
  const size = `${Math.round(box.width)}×${Math.round(box.height)} CSS px`;
  if (!mounted) {
    return { verdict: 'FAIL',
      label: 'there was no Loop in the player to photograph — the player had given up and drew its error state',
      evidence: `a census of the ERROR state, not of the Loop: ${label} · ${size}` };
  }
  if (colours < censusFloor) {
    // ⚠ A FLAT BOX IS THE FAILURE THIS ROW EXISTS FOR: `dominantColor` is painted behind the
    // player, so a Loop that never drew leaves a perfectly pleasant coloured rectangle.
    return { verdict: 'FAIL', label: `the player rendered a BLANK picture (floor ${censusFloor})`,
      evidence: `${label} · ${size}` };
  }
  return { verdict: 'PASS', label: 'something was drawn (not blank, NOT correct)',
    evidence: `picture census: ${label} — DREW SOMETHING · ${size}` };
}

// ── input ────────────────────────────────────────────────────────────────────────────────────────

/**
 * The `input` row's verdict, as a pure function of what the delivery probe saw in the Loop's own
 * document and what the Loop said back. [006/WEB-INPUT-DELIVERY], Josh's Q253 answer.
 *
 * ⚠ PASS IS DELIVERY, AND ONLY DELIVERY. The press reaching the handler the Loop registered is what
 * the shell must guarantee; what the Loop then does with it is the Loop's business.
 *
 * ⚠ AND EVERY FAILING VERDICT NAMES WHICH LINK BROKE. The branches below are ordered from the
 * shell's end of the chain to the Loop's, so the first thing that is missing is the thing named.
 *
 * ⚠ A BLIND PROBE IS `UNRUN`, NEVER A FAIL ([[experiment-must-prove-it-acted]]).
 *
 * @param {{probe: object|null, reason: string}} reading — `readDelivery`'s result.
 * @param {string[]} answered — `log` lines the Loop posted back, if any. Extra evidence only.
 * @param {string} where — the press itself: "at (x,y) · pointerType …".
 */
export function inputVerdict(reading, answered, where) {
  const said = answered && answered.length
    ? ` · the Loop answered: ${answered.join(' · ').slice(0, 160)}`
    : '';

  if (!reading || !reading.probe) {
    return { verdict: 'UNRUN',
      label: 'the delivery probe never installed, so NOTHING about this press was measured',
      evidence: `${where} · ${(reading && reading.reason) || 'no reason recorded'}`
        + ' · this says nothing about the Loop' + said };
  }
  const probe = reading.probe;
  const into = (list) => (list || []).filter((e) => e && e.type === 'input');
  const bridge = into(probe.intoBridge);
  const handler = into(probe.intoHandler);
  const counts = `${bridge.length} into the bridge, ${handler.length} into the Loop's handler`;
  const crossed = handler.length
    ? handler.map((e) => e.detail).join(', ')
    : bridge.map((e) => e.detail).join(', ');
  const trail = `${where} · ${counts}${crossed ? `: ${crossed}` : ''}`;

  if (!probe.installed) {
    return { verdict: 'FAIL',
      label: "the payload document never received the bridge SHIM, so the press had nothing to arrive at",
      evidence: `${trail} · \`window.collectivus\` was never assigned in the Loop's own document`
        + (probe.reason ? ` · ${probe.reason}` : '') };
  }
  if (!bridge.length) {
    return { verdict: 'FAIL',
      label: 'the press NEVER REACHED the Loop — nothing arrived at the payload\'s bridge',
      evidence: `${trail} · the shell's postMessage did not reach \`collectivus.__deliver\`:`
        + ' the overlay, the message or the service-worker shim broke' };
  }
  if (!probe.subscribed) {
    return { verdict: 'FAIL',
      label: 'the press reached the payload, but the Loop had SUBSCRIBED to nothing, so it was queued',
      evidence: `${trail} · \`collectivus.on\` was never called, so the shim had no handler to hand it to` };
  }
  if (!handler.length) {
    return { verdict: 'FAIL',
      label: "the press reached the payload's bridge and the Loop's own handler was never called",
      evidence: `${trail} · \`collectivus.on\` was called, so this is the shim's own hand-off` };
  }
  const threw = (probe.threw || []).length
    ? ` · ⚠ the Loop's handler THREW: ${probe.threw.join(' · ').slice(0, 160)}`
    : '';
  return { verdict: 'PASS',
    label: answered && answered.length
      ? "the press was DELIVERED to the Loop's own handler, and the LOOP answered"
      : "the press was DELIVERED to the Loop's own handler; this Loop answers nothing, which is the Loop's business",
    evidence: trail + said + threw };
}

/**
 * The `input` row, measured: one real press at the player's centre, then what the delivery probe
 * saw in the Loop's own document.
 *
 * ⚠ THE COUNTERS ARE CLEARED HERE, `subscribed` AND `installed` ARE NOT. Those two are facts about
 * the whole run — the Loop subscribes once, long before this press.
 * ⚠ WAIT ON DELIVERY, NOT ON THE ANSWER, then let the whole press land before reading the count: a
 * press is four events and the first satisfies the assertion long before the release is processed.
 */
export async function judgeInput(call, evaluate, box, view) {
  await evaluate(`(() => {
    const frame = document.querySelector('iframe.player-frame');
    const state = frame && frame.contentWindow && frame.contentWindow.__clvDelivery;
    if (!state) return false;
    state.intoBridge.length = 0; state.intoHandler.length = 0; state.threw.length = 0;
    return true;
  })()`);
  await evaluate('window.__clvLeg.messages.length = 0');
  const cx = Math.round(box ? box.x + box.width / 2 : view.width / 2);
  const cy = Math.round(box ? box.y + box.height / 2 : view.height / 2);
  const point = {
    x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1,
    pointerType: view.mobile ? 'touch' : 'mouse',
  };
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point });
  await sleep(120);
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point });
  const readDelivery = () => evaluate(`(() => {
    const frame = document.querySelector('iframe.player-frame');
    if (!frame) return JSON.stringify({ probe: null, reason: 'the player iframe was gone by the press' });
    let state;
    try { state = frame.contentWindow && frame.contentWindow.__clvDelivery; }
    catch (e) { return JSON.stringify({ probe: null, reason: 'the payload document is not same-origin: ' + e.message }); }
    if (!state) return JSON.stringify({ probe: null, reason: 'the delivery probe never ran in the payload document' });
    return JSON.stringify({ probe: state, reason: '' });
  })()`);
  const deliveredCount = async () => {
    const reading = JSON.parse(await readDelivery());
    return reading.probe ? (reading.probe.intoHandler || []).length : 0;
  };
  await until(async () => (await deliveredCount()) > 0, 8000, 200);
  let settled = -1;
  await until(async () => {
    const n = await deliveredCount();
    const stable = n > 0 && n === settled;
    settled = n;
    return stable;
  }, 2500, 200);
  const answered = await until(async () => {
    const logs = await evaluate(
      'JSON.stringify(window.__clvLeg.messages.filter((m) => m && m.type === "log").map((m) => m.message))');
    const parsed = JSON.parse(logs);
    return parsed.length ? parsed : null;
  }, 4000, 200);
  return inputVerdict(JSON.parse(await readDelivery()), answered ?? [],
    `at (${cx},${cy}) · pointerType ${point.pointerType}`);
}

// ── audio: does the FIRST press start the Loop's sound ───────────────────────────────────────────
//
// [007/WEBKIT1] (2026-09-24), Q255 and Q280. Q255 was a Loop that drew on the first press and stayed
// silent until a second one, in Safari only; Chromium delegates the parent's activation into the
// payload document through `allow="autoplay"` and WebKit does not. A driver that only ever ran
// Chromium could not see it. This row reads `AudioContext.state` IN THE PAYLOAD DOCUMENT after the
// one press a viewer makes, the detail page's play control, so the same row can be red on one engine
// and green on the other.
//
// ⚠ NOTHING MAY BE EVALUATED IN ANY DOCUMENT BETWEEN THE PRESS AND THE READING
// (`docs/lessons/playwright-evaluate-is-a-user-gesture.md`). Playwright's `evaluate` carries an
// emulated user gesture in both engines, so reading the payload by `evaluate` would grant the very
// activation this row measures. The probe is an init script and REPORTS over `console`, every event
// as one `CLVAUDIO {json}` line, which is read from the console the driver already records.
//
// ⚠ AN ACCESSOR, NOT A VALUE (`docs/lessons/probe-a-global-with-an-accessor-not-a-value.md`). The web
// player's service-worker shim REPLACES `window.AudioContext` in the payload document to hand over the
// context the press unlocked (AUDIO2). A probe that assigned a wrapper would be overwritten and report
// "no context" — a confident absence. The setter wraps whoever assigns next, so the old player and
// the new one read through one instrument, and `handedOver` says which one this was.
//
// ⚠ THE CONTROL IS WHY A PASS MEANS ANYTHING. A context made in the top document on `load`, with no
// gesture and no evaluate, must NOT come up `running`; if it does, this engine enforces no autoplay
// policy and a silent first press could never show here. That is UNRUN, never a PASS.
export const AUDIO_TAG = 'CLVAUDIO';

export const AUDIO_PROBE = `
  (function () {
    var where = window.top === window ? 'top' : 'payload';
    var emit = function (o) {
      o.where = where; o.t = Math.round(performance.now());
      try { console.log('${AUDIO_TAG} ' + JSON.stringify(o)); } catch (e) {}
    };
    var Native = window.AudioContext || window.webkitAudioContext;
    if (!Native) { emit({ what: 'no-audio-context' }); return; }
    var activation = function () {
      var u = navigator.userActivation;
      return u ? (u.isActive ? 'active' : u.hasBeenActive ? 'sticky' : 'none') : 'no-api';
    };
    var contexts = [];
    var watch = function (ctx) {
      var id = contexts.push(ctx) - 1;
      emit({ what: 'created', id: id, state: ctx.state, activation: activation(),
             handedOver: !(ctx instanceof Native) });
      try { ctx.addEventListener('statechange', function () {
        emit({ what: 'statechange', id: id, state: ctx.state }); }); } catch (e) {}
      return ctx;
    };
    var wrap = function (ctor) {
      if (typeof ctor !== 'function') return ctor;
      return new Proxy(ctor, {
        construct: function (target, args, newTarget) { return watch(Reflect.construct(target, args, newTarget)); },
        apply: function (target, self, args) { return watch(Reflect.apply(target, self, args)); }
      });
    };
    ['AudioContext', 'webkitAudioContext'].forEach(function (name) {
      if (!(name in window)) return;
      var live = wrap(window[name]);
      try {
        Object.defineProperty(window, name, { configurable: true,
          get: function () { return live; },
          set: function (value) { emit({ what: 'replaced', name: name }); live = wrap(value); } });
      } catch (e) { emit({ what: 'probe-failed', error: String(e) }); }
    });
    if (where === 'payload') {
      emit({ what: 'installed', activation: activation() });
      setInterval(function () {
        if (!contexts.length) return;
        emit({ what: 'tick', activation: activation(),
               states: contexts.map(function (c) { return c.state; }),
               clocks: contexts.map(function (c) { return Math.round(c.currentTime * 1000) / 1000; }) });
      }, 1000);
    } else {
      addEventListener('load', function () {
        var control = new Native();
        setTimeout(function () {
          emit({ what: 'control', state: control.state, activation: activation() });
          try { control.close(); } catch (e) {}
        }, 1000);
      });
    }
  })();
`;

/** Every `CLVAUDIO` event the console recorded, parsed, in order. A line that does not parse is
 *  skipped — it cannot be one of ours, and one bad line must not hide the rest. */
export function audioEvents(consoleLines) {
  const out = [];
  for (const line of consoleLines) {
    const text = String(line && line.text || '');
    if (!text.startsWith(`${AUDIO_TAG} `)) continue;
    try { out.push(JSON.parse(text.slice(AUDIO_TAG.length + 1))); } catch { /* not ours */ }
  }
  return out;
}

/** The payload's FIRST context, followed to its last reported state and clock. */
function firstPayloadContext(events) {
  const payload = events.filter((e) => e.where === 'payload');
  const born = payload.find((e) => e.what === 'created');
  if (!born) return null;
  let state = born.state;
  const clocks = [];
  for (const e of payload.slice(payload.indexOf(born) + 1)) {
    if (e.what === 'statechange' && e.id === born.id) state = e.state;
    if (e.what === 'tick' && Array.isArray(e.states)) {
      state = e.states[born.id] ?? state;
      if (Array.isArray(e.clocks) && e.clocks[born.id] != null) clocks.push(e.clocks[born.id]);
    }
  }
  return { born, state, clocks };
}

/**
 * The `audio` row. PASS only when the payload's first `AudioContext` is `running` after ONE press.
 *
 * @param {object[]} events — `audioEvents(...)` from the press onward (the control is read before it).
 * @param {number} waitedSeconds — how long the driver waited for the payload to make a context.
 * @param {string} where — the press itself, for the evidence.
 */
export function audioVerdict({ events, waitedSeconds, where }) {
  const control = events.find((e) => e.where === 'top' && e.what === 'control');
  if (!control) {
    return { verdict: 'UNRUN', label: 'the gesture-free control never reported, so nothing says this engine enforces an autoplay policy',
      evidence: `${where} · without the control a PASS here would mean nothing` };
  }
  if (control.state === 'running') {
    return { verdict: 'UNRUN', label: 'this engine started a gesture-free AudioContext — no autoplay policy, so a silent first press cannot show here',
      evidence: `control read running with activation ${control.activation} · ${where}` };
  }
  const payload = events.filter((e) => e.where === 'payload');
  if (!payload.some((e) => e.what === 'installed' || e.what === 'no-audio-context')) {
    return { verdict: 'UNRUN', label: 'the probe never reported from the payload document, so this press was not measured',
      evidence: `${where} · waited ${waitedSeconds} s · control ${control.state}` };
  }
  const first = firstPayloadContext(events);
  if (!first) {
    return { verdict: 'N/A', label: `the Loop made no AudioContext within ${waitedSeconds} s of the press — no Web Audio to start`,
      evidence: `${where} · control ${control.state}` };
  }
  const owner = first.born.handedOver ? 'handed over by the player' : "the Loop's own";
  const clock = first.clocks.length ? ` · clock ${first.clocks[0]} → ${first.clocks[first.clocks.length - 1]} s` : '';
  const trail = `${where} · born ${first.born.state} (${owner}, payload activation ${first.born.activation})`
    + ` → ${first.state}${clock} · control ${control.state}`;
  if (first.state === 'running') {
    return { verdict: 'PASS', label: "the first press started the Loop's sound — its AudioContext was running with no second press",
      evidence: trail };
  }
  return { verdict: 'FAIL', label: `the Loop's AudioContext was '${first.state}' after the first press — silent until a second press (Q255)`,
    evidence: trail };
}

// ── exit and page ────────────────────────────────────────────────────────────────────────────────

/**
 * [006/LOOP-VIBES-WEB] — the requests that FAILED during a run, appended to the evidence of a row
 * that failed anyway. ⚠ THIS CHANGES NO VERDICT. It only puts the failed requests NEXT TO the error
 * they caused (Q238: the rig had the decisive 404 and printed only the symptom).
 * ⚠ THE RIG'S OWN ORIGIN GOES FIRST — a request served by THIS run's own server is one the Loop
 * under test asked for; anything else is the environment. Nothing is dropped, only ranked below.
 */
export function httpFailureEvidence(failures, origin = '', budget = 300) {
  const distinct = [];
  for (const failure of failures) {
    const line = `${failure.status} ${failure.url}`;
    if (!distinct.includes(line)) distinct.push(line);
  }
  if (!distinct.length) return '';
  const ours = origin ? distinct.filter((line) => line.includes(origin)) : [];
  const ranked = [...ours, ...distinct.filter((line) => !ours.includes(line))];

  const shown = [];
  let spent = 0;
  for (const line of ranked) {
    if (spent + line.length > budget && shown.length) break;
    shown.push(line);
    spent += line.length + 3;
  }
  const dropped = ranked.length - shown.length;
  return ` · requests that failed during the run: ${shown.join(' · ')}`
    + (dropped ? ` (+${dropped} more)` : '');
}

/** Known rig-environment failures: a SITE build made without the site's own secrets. Enumerated
 *  rather than pattern-matched loosely, so a NEW page error can never be swallowed by this list. */
export const RIG_ENVIRONMENT = [
  /svelte-clerk: Missing publishableKey/,
  // [007/WEBKIT1] SEC2's REPORT-ONLY CSP lists the CDN in `connect-src`, never this rig's LOCAL dev
  // origin, so the payload fetch from 127.0.0.1 is reported (not blocked). WebKit prints that report
  // to the console; in the same run Chromium's CDP console did not show it (measured 2026-09-24 — that
  // Chromium sends it to the Log domain, which this session does not enable, is inference). Only a
  // report-only refusal of 127.0.0.1 is the rig's — any other URL still fails.
  // [007/MEDIA5] `load` as well as `connect`: `img-src` refuses the same origin's poster, which
  // dev-stage.py points a NEW id at on purpose (`art/<id>/poster-dev.jpg`, expected to 404). Every
  // first web leg of a Loop the shipping catalog has not got read `page` FAIL on WebKit for it
  // (web-test-loop-005, 2026-09-29).
  /^\[Report Only\] Refused to (connect to|load) http:\/\/127\.0\.0\.1:\d+\//,
];

/**
 * [007/WEBCSS1] #417 — "Unable to preload CSS for …/_app/immutable/assets/1.*.css" on WebKit only.
 *
 * ⚠ THE RIG'S, AND PROVED SO EACH TIME, NEVER BY THE TEXT ALONE. SvelteKit imports the root error
 * page (node 1) eagerly on every load and does not await it (`void default_error_loader()`); Vite's
 * preload helper rejects when that stylesheet's <link> fires `error`. WebKit fires it on the OUTGOING
 * document when a navigation cancels the load — the rig's `goto` lands milliseconds after `load`
 * (measured 2026-10-03: 3 of 5 immediate navigations raised it, the stylesheet never requested by
 * that page; 0 of 5 pages left alone did). Chromium raises nothing. A viewer is not shown it: the
 * page that logs it is already being left. So it is explained only when ALL hold — the WebKit
 * session saw it while its own navigation was in flight (`leaving`), it names our own origin's
 * `/_app/immutable/` asset, and that very asset was served to this run (`served`). A missing or
 * refused stylesheet, or the error with no navigation in flight, still fails `page`.
 */
export function cancelledPreload(line, served, origin) {
  if (!line.leaving) return false;
  const named = /Unable to preload CSS for (\S+)/.exec(line.text);
  if (!named) return false;
  let url;
  try { url = new URL(named[1]); } catch { return false; }
  return url.origin === origin && url.pathname.startsWith('/_app/immutable/') && served.includes(url.href);
}

/**
 * The `exit` and `page` rows, from what the console saw over the whole run.
 *
 * ⚠ TWO ROWS, BECAUSE THE HOST PAGE'S PROBLEMS ARE NOT THE LOOP'S. Errors the LOOP or the PLAYER
 * raised (`[loop-embed]`, `[loop-runtime]`, anything under `/loop-runtime/`) decide `exit`;
 * everything else is `page`. 403/404 console lines are excluded from both — a gated CDN refusing an
 * unkeyed rig its poster art is not the Loop's fault — and quoted as evidence when a row fails.
 */
export function exitAndPageVerdicts({ gone, consoleLines, httpFailures, origin, served = [] }) {
  const errors = consoleLines.filter(
    (line) => line.level === 'error' && !/\b(403|404)\b/.test(line.text));
  const loopErrors = errors.filter(
    (line) => /\[loop-embed\]|\[loop-runtime\]|loop-runtime\//.test(line.text));
  const siteErrors = errors.filter((line) => !loopErrors.includes(line));
  const cancelled = siteErrors.filter((line) => cancelledPreload(line, served, origin));
  const unexplained = siteErrors.filter((line) => !cancelled.includes(line)
    && !RIG_ENVIRONMENT.some((pattern) => pattern.test(line.text)));

  let exit;
  if (!gone) {
    exit = { verdict: 'FAIL', label: 'leaving the Loop left the player mounted',
      evidence: 'iframe.player-frame survived the navigation' };
  } else if (loopErrors.length) {
    exit = { verdict: 'FAIL', label: 'the Loop or the player threw during the run',
      evidence: loopErrors.map((e) => e.text).join(' · ').slice(0, 220)
        + httpFailureEvidence(httpFailures, origin) };
  } else {
    exit = { verdict: 'PASS',
      label: 'the viewer left the Loop, the player was torn down, and the Loop threw nothing',
      evidence: `${consoleLines.length} console lines, ${loopErrors.length} from the Loop` };
  }

  let page;
  if (unexplained.length) {
    page = { verdict: 'FAIL', label: 'the host page threw something this rig does not explain',
      evidence: unexplained.map((e) => e.text).join(' · ').slice(0, 220)
        + httpFailureEvidence(httpFailures, origin) };
  } else if (cancelled.length) {
    page = { verdict: 'PASS',
      label: 'the host page threw only errors the rig explains — a stylesheet preload its own navigation cancelled',
      evidence: [...cancelled, ...siteErrors.filter((e) => !cancelled.includes(e))]   // the explained one first
        .map((e) => e.text.slice(0, 140)).join(' · ').slice(0, 220) };
  } else if (siteErrors.length) {
    page = { verdict: 'PASS',
      label: 'the host page threw only rig-environment errors — a worktree build has no site secrets',
      evidence: siteErrors.map((e) => e.text.slice(0, 90)).join(' · ').slice(0, 220) };
  } else {
    page = { verdict: 'PASS', label: 'the host page threw nothing', evidence: `${consoleLines.length} console lines` };
  }
  return { exit, page };
}

// ── files: every file the payload asked for is inside its own mount, and was there ──────────────
//
// [007/LEGFIX1] (2026-09-30), #371. Float v1.1.5 asked for all 59 zones of its soundscape one `../`
// out of its folder — `/loop-runtime/assets/…` for `/loop-runtime/vibes-collectivus/assets/…`. The
// service worker answered 404 to every one, the bed was silent on the web, and this instrument
// passed it on every row at both viewports in both engines: `exitAndPageVerdicts` drops every
// 403/404 CONSOLE line (so a gated CDN refusing an unkeyed rig its poster art fails nothing), and
// nothing else read the network. On an Apple player the same `../` clamps back in at
// `clv-loop://loop/`, so the Loop works there — the web is where the defect is, and where it hid.
//
// ⚠ THE CONSOLE EXEMPTION IS UNTOUCHED. This row reads the NETWORK, and only two things in it:
//   escaped — a same-origin request under `/loop-runtime/` outside `/loop-runtime/<id>/`, or one
//             the payload's OWN document made anywhere on the rig's origin outside its mount —
//             answered or not (a `../` that happens to find a file on the site is still one the
//             Apple players resolve somewhere else);
//   missing — a request inside the mount the service worker answered 404: the payload lacks it.
// The CDN's poster art is another origin, and the host page's own requests are not the payload's,
// so neither can reach this row.
//
// ⚠ A ROW THAT SAW NO REQUEST INSIDE THE MOUNT MEASURED NOTHING, and says UNRUN
// ([[experiment-must-prove-it-acted]]) — the payload's own entry document is always one.

const LOOP_RUNTIME = '/loop-runtime/';

/** A same-origin http(s) URL's path, or null — `blob:`/`data:` and other origins are not ours. */
function rigPath(url, rigOrigin) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== rigOrigin) return null;
    return parsed.pathname;
  } catch { return null; }
}

/** The distinct paths, the first few named, the rest counted — a report cell, not a dump. */
function namedPaths(paths, shown = 4) {
  const head = paths.slice(0, shown).join(' · ');
  return paths.length > shown ? `${head} (+${paths.length - shown} more)` : head;
}

/** { mount, seen, escaped, missing } — the three readings `filesVerdict` decides on. */
export function payloadFiles({ requests = [], httpFailures = [], origin, loopId }) {
  const rigOrigin = new URL(origin).origin;
  const mount = `${LOOP_RUNTIME}${encodeURIComponent(loopId)}/`;
  const inMount = (path) => path != null && path.startsWith(mount);
  const escapes = (r) => {
    const path = rigPath(r.url, rigOrigin);
    if (path == null || inMount(path)) return false;
    return path.startsWith(LOOP_RUNTIME) || inMount(rigPath(r.document ?? '', rigOrigin));
  };
  const distinct = (list) => [...new Set(list.map((r) => rigPath(r.url, rigOrigin)))];
  return {
    mount,
    seen: requests.filter((r) => inMount(rigPath(r.url, rigOrigin))).length,
    escaped: distinct([...requests, ...httpFailures].filter(escapes)),
    missing: distinct(httpFailures.filter((f) => f.status === 404 && inMount(rigPath(f.url, rigOrigin)))),
  };
}

/**
 * The `files` row. FAIL names every escaping and every missing path it can fit; `payloadFiles`
 * returns the full lists for a driver that wants to print them all.
 */
export function filesVerdict({ requests, httpFailures, origin, loopId }) {
  if (!loopId) {
    return { verdict: 'UNRUN', label: 'the driver named no Loop id, so its mount is unknown and nothing was judged',
      evidence: 'pass the Loop id to filesVerdict' };
  }
  const { mount, seen, escaped, missing } = payloadFiles({ requests, httpFailures, origin, loopId });
  if (!seen) {
    return { verdict: 'UNRUN', label: `the rig recorded no request inside ${mount}, so nothing about the payload's files was measured`,
      evidence: `${requests?.length ?? 0} requests recorded in all` };
  }
  const said = [];
  if (escaped.length) said.push(`${escaped.length} path(s) OUTSIDE its mount ${mount}: ${namedPaths(escaped)}`);
  if (missing.length) said.push(`${missing.length} path(s) inside its mount answered 404 — not in the payload: ${namedPaths(missing)}`);
  if (said.length) {
    return { verdict: 'FAIL',
      label: escaped.length
        ? 'the payload asked for files outside its own folder — on the web they are not there'
        : 'the payload asked for files it does not carry',
      evidence: said.join(' · ') };
  }
  return { verdict: 'PASS', label: 'every file the payload asked for was inside its own folder, and there',
    evidence: `${seen} request(s) inside ${mount}, none outside it, none answered 404` };
}

// ── self-test: the parts that can lie without a browser ──────────────────────────────────────────
//
// ⚠ Run by BOTH drivers' `--self-test`. The PNG decoder and the census (a wrong unfilter would
// score a plausible-looking number on a picture that is not the one on screen), the evidence
// ranking (Q238), every `input` link (Q253), and the ready, picture, exit and page verdicts.

function pngOf(width, height, scanlines) {
  const crc = (buf) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, 'ascii'), body])), 0);
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(scanlines))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** @param {(what: string, ok: boolean, detail?: string) => void} check */
export function verdictSelfTest(check) {
  // A 2×2 RGB PNG with one known pixel per corner, filter 0, built by hand.
  const image = decodePNG(pngOf(2, 2, [0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]));
  check('the PNG decoder reads the header', image.width === 2 && image.height === 2);
  // Row 0 is red then green; row 1 is blue then white.
  check('and the pixels, unfiltered',
    image.pixels[0] === 255 && image.pixels[1] === 0 && image.pixels[2] === 0
    && image.pixels[3] === 0 && image.pixels[4] === 255 && image.pixels[5] === 0
    && image.pixels[8] === 255 && image.pixels[9] === 255 && image.pixels[11] === 255,
    Array.from(image.pixels).join(','));
  check('the census counts DISTINCT colours, not pixels', census(image) === 4, String(census(image)));
  const flat = decodePNG(pngOf(2, 2, [0, 9, 9, 9, 9, 9, 9, 0, 9, 9, 9, 9, 9, 9]));
  check('a flat picture censuses as ONE colour — the blank case this row refuses', census(flat) === 1);

  const BOX = { x: 0, y: 0, width: 640, height: 360 };
  check('a census under the floor is a BLANK picture, a FAIL',
    pictureVerdict(1, 8, BOX).verdict === 'FAIL' && /BLANK/.test(pictureVerdict(1, 8, BOX).label));
  check('a census at the floor is a PASS that still says NOT correct',
    pictureVerdict(8, 8, BOX).verdict === 'PASS' && /NOT correct/.test(pictureVerdict(8, 8, BOX).label));
  // ⚠ Pirate Beach v0.1.0's own numbers: the site's error panel scored 10 and 56 — above the floor.
  check('a colourful box with NO Loop in it is a FAIL, never a PASS — it is the error state',
    pictureVerdict(56, 8, BOX, false).verdict === 'FAIL'
    && /no Loop in the player/.test(pictureVerdict(56, 8, BOX, false).label));

  // ready — the site driver's reading (no budget known) and the harness's (budget known).
  check('the site reading: a ready that crossed is a PASS',
    readyVerdict({ info: '{}', waitedSeconds: 20 }).verdict === 'PASS');
  check('the site reading: none inside the wait is a FAIL naming the wait',
    readyVerdict({ info: null, waitedSeconds: 20 }).label.includes('inside 20s'));
  const took = readyVerdict({ info: '{}', waitedSeconds: 17, budgetSeconds: 15, accepted: true, readyAfterMs: 4200 });
  check('the budget reading: a ready the player accepted is a PASS that prints when',
    took.verdict === 'PASS' && took.evidence.includes('4.2 s') && !took.evidence.includes('⚠'));
  const lateTook = readyVerdict({ info: '{}', waitedSeconds: 17, budgetSeconds: 15, accepted: true, readyAfterMs: 16600 });
  check('a ready the player accepted LATE (its timer was starved) is the player\'s PASS, with a warning',
    lateTook.verdict === 'PASS' && lateTook.evidence.includes('⚠ past the 15 s budget'));
  check('the budget reading: a ready the player did NOT accept is a FAIL, whatever the clock says',
    readyVerdict({ info: '{}', waitedSeconds: 30, budgetSeconds: 15, accepted: false, readyAfterMs: 9000 }).verdict === 'FAIL');
  check('the budget reading: no ready at all is a FAIL naming the budget',
    readyVerdict({ info: null, waitedSeconds: 17, budgetSeconds: 15 }).label.includes('15 s budget'));

  const RIG = 'http://127.0.0.1:8782';
  check('a run with no failed request appends NOTHING — a clean row stays clean',
    httpFailureEvidence([], RIG) === '');
  // Q238's own run, in the order it really happened: ten CDN 403s, then the decisive 404.
  const q238 = [
    ...Array.from({ length: 10 }, (_, n) => (
      { status: 403, url: `https://cdn.collectivus.com/art/web-test-loop-00${n % 3}/wide-3840x2160-b5c00c6${n}.jpg` })),
    { status: 404, url: `${RIG}/loop-runtime/vendor/three/addons/libs/basis/basis_transcoder.js` },
    { status: 404, url: `${RIG}/loop-runtime/vendor/three/addons/libs/basis/basis_transcoder.js` },
  ];
  check('the 404 that caused the failure is named, in full, path and all',
    httpFailureEvidence(q238, RIG).includes(`404 ${RIG}/loop-runtime/vendor/three/addons/libs/basis/basis_transcoder.js`));
  check('a failure on the rig\'s OWN origin outranks the CDN 403s that happened first',
    httpFailureEvidence(q238, RIG).indexOf('basis_transcoder.js')
      < httpFailureEvidence(q238, RIG).indexOf('cdn.collectivus.com'));
  check('the same URL failing twice is said once',
    httpFailureEvidence(q238, RIG).match(/basis_transcoder\.js/g).length === 1);
  check('a 403 from the gated CDN is still reported, ranked below rather than dropped',
    httpFailureEvidence(q238, RIG, 4000).includes('403 https://cdn.collectivus.com/'));
  check('a budget too small for even one URL still names one, and counts the rest',
    httpFailureEvidence(q238, RIG, 0).includes('basis_transcoder.js')
    && httpFailureEvidence(q238, RIG, 0).includes('(+10 more)'));
  check('a request blocked rather than answered is named by its block reason and its URL',
    httpFailureEvidence([{ status: 'blocked (csp)', url: `blob:${RIG}/abc` }], RIG)
      .includes(`blocked (csp) blob:${RIG}/abc`));

  // input — every link named separately (Q253). Each case was WATCHED FAILING against the old logic.
  const WHERE = 'at (720,588) · pointerType mouse';
  const press = [{ type: 'input', detail: 'point began' }, { type: 'input', detail: 'primary down' },
    { type: 'input', detail: 'point ended' }, { type: 'input', detail: 'primary up' }];
  const probe = (over = {}) => ({
    probe: { installed: true, subscribed: true, reason: '',
      intoBridge: press, intoHandler: press, threw: [], ...over },
  });
  const silent = inputVerdict(probe(), [], WHERE);
  check('a press delivered to a Loop that answers nothing is a PASS — delivery is the assertion',
    silent.verdict === 'PASS', `${silent.verdict}: ${silent.label}`);
  check('and it says the LOOP was silent, never that the press did not arrive',
    /deliver/i.test(silent.label) && !/NOTHING back from the Loop|never reached/i.test(silent.label));
  const lost = inputVerdict(probe({ intoBridge: [], intoHandler: [] }), [], WHERE);
  check('a press that reached nothing is a FAIL that says it NEVER REACHED the Loop',
    lost.verdict === 'FAIL' && /never reached/i.test(lost.label) && !/answer/i.test(lost.label));
  const queued = inputVerdict(probe({ subscribed: false, intoHandler: [] }), [], WHERE);
  check('a Loop that registered no handler is FAILED for THAT, not for the press going missing',
    queued.verdict === 'FAIL' && /subscribed/i.test(queued.label) && !/never reached/i.test(queued.label));
  const noShim = inputVerdict(probe({ installed: false, intoBridge: [], intoHandler: [], subscribed: false }), [], WHERE);
  check('a payload document that never got the bridge shim is FAILED for THAT',
    noShim.verdict === 'FAIL' && /shim/i.test(noShim.label));
  const blind = inputVerdict({ probe: null, reason: 'the payload document is not same-origin' }, [], WHERE);
  check('a probe that never ran is UNRUN — it measured nothing, and no Loop is implicated',
    blind.verdict === 'UNRUN' && !/never reached/i.test(blind.label)
    && blind.evidence.includes('not same-origin'));
  const answered = inputVerdict(probe(), ['tap at 0.50,0.50'], WHERE);
  check('a Loop that DOES answer still has its answer quoted on the row',
    answered.verdict === 'PASS' && answered.evidence.includes('tap at 0.50,0.50'));
  check('every verdict prints what crossed each link',
    silent.evidence.includes('primary down') && lost.evidence.includes('0'));
  const threw = inputVerdict(probe({ threw: ['x is not a function'] }), [], WHERE);
  check('a handler that THREW was still delivered to — a PASS that names the throw',
    threw.verdict === 'PASS' && threw.evidence.includes('x is not a function'));

  // audio — [007/WEBKIT1]. AUDIO1's two readings of the first press are the RED and the GREEN case.
  const AT = 'press at (720,367) on .surface-play';
  const ev = (...events) => audioEvents(events.map((o) => ({ level: 'log', text: `${AUDIO_TAG} ${JSON.stringify(o)}` })));
  const control = { where: 'top', what: 'control', state: 'suspended', activation: 'none' };
  const installed = { where: 'payload', what: 'installed', activation: 'none' };
  const born = (state, handedOver = false) => ({ where: 'payload', what: 'created', id: 0, state, activation: 'none', handedOver });
  const tick = (state, clock) => ({ where: 'payload', what: 'tick', states: [state], clocks: [clock] });
  const webkitOld = audioVerdict({ events: ev(control, installed, born('suspended'), tick('interrupted', 0)), waitedSeconds: 20, where: AT });
  check('audio: WebKit before AUDIO2 — born suspended, never running — is a FAIL that names Q255',
    webkitOld.verdict === 'FAIL' && /interrupted/.test(webkitOld.label) && /Q255/.test(webkitOld.label), webkitOld.label);
  const chromium = audioVerdict({ events: ev(control, installed, born('running'), tick('running', 1.2), tick('running', 2.2)), waitedSeconds: 20, where: AT });
  check('audio: Chromium — born running — is a PASS that prints the clock',
    chromium.verdict === 'PASS' && chromium.evidence.includes('clock 1.2 → 2.2 s'), chromium.evidence);
  const handed = audioVerdict({ events: ev(control, installed, born('running', true)), waitedSeconds: 20, where: AT });
  check('audio: a context the player handed over is a PASS that says so',
    handed.verdict === 'PASS' && handed.evidence.includes('handed over by the player'), handed.evidence);
  const resumed = audioVerdict({ events: ev(control, installed, born('suspended'),
    { where: 'payload', what: 'statechange', id: 0, state: 'running' }), waitedSeconds: 20, where: AT });
  check('audio: a context that starts suspended and goes running on the press is a PASS',
    resumed.verdict === 'PASS', resumed.label);
  check('audio: no control line is UNRUN — the policy was never shown to be enforced',
    audioVerdict({ events: ev(installed, born('running')), waitedSeconds: 20, where: AT }).verdict === 'UNRUN');
  check('audio: a control that came up RUNNING is UNRUN, never a PASS — the engine enforces nothing',
    audioVerdict({ events: ev({ ...control, state: 'running' }, installed, born('running')), waitedSeconds: 20, where: AT }).verdict === 'UNRUN');
  check('audio: a payload the probe never reported from is UNRUN, not "no audio"',
    audioVerdict({ events: ev(control), waitedSeconds: 20, where: AT }).verdict === 'UNRUN');
  check('audio: a Loop that made no AudioContext is N/A',
    audioVerdict({ events: ev(control, installed), waitedSeconds: 20, where: AT }).verdict === 'N/A');
  check('audio: a second context does not overrule the first',
    audioVerdict({ events: ev(control, installed, born('suspended'),
      { where: 'payload', what: 'created', id: 1, state: 'running', activation: 'none', handedOver: false }),
    waitedSeconds: 20, where: AT }).verdict === 'FAIL');
  check('audio: a console line that is not ours, or does not parse, is skipped',
    audioEvents([{ text: 'hello' }, { text: `${AUDIO_TAG} {not json` }, { text: `${AUDIO_TAG} {"what":"x"}` }]).length === 1);

  // exit and page — whose error is whose.
  const lines = (...texts) => texts.map((text) => ({ level: 'error', text }));
  const quiet = exitAndPageVerdicts({ gone: true, consoleLines: [], httpFailures: [], origin: RIG });
  check('a clean run passes both exit and page', quiet.exit.verdict === 'PASS' && quiet.page.verdict === 'PASS');
  const loopThrew = exitAndPageVerdicts({ gone: true,
    consoleLines: lines('[loop-embed] x the Loop never became ready in 15 s'), httpFailures: [], origin: RIG });
  check('a player or Loop error fails EXIT and leaves PAGE alone',
    loopThrew.exit.verdict === 'FAIL' && loopThrew.page.verdict === 'PASS');
  const hostThrew = exitAndPageVerdicts({ gone: true,
    consoleLines: lines('TypeError: host is broken'), httpFailures: [], origin: RIG });
  check('a host-page error fails PAGE and leaves EXIT alone',
    hostThrew.page.verdict === 'FAIL' && hostThrew.exit.verdict === 'PASS');
  const rigOnly = exitAndPageVerdicts({ gone: true,
    consoleLines: lines('svelte-clerk: Missing publishableKey'), httpFailures: [], origin: RIG });
  check('a known rig-environment error is quoted, not failed', rigOnly.page.verdict === 'PASS');
  const reportOnly = (url) => exitAndPageVerdicts({ gone: true, httpFailures: [], origin: RIG, consoleLines: lines(
    `[Report Only] Refused to connect to ${url} because it does not appear in the connect-src directive of the Content Security Policy.`) }).page.verdict;
  check('a report-only CSP refusal of the rig\'s own 127.0.0.1 origin is the rig\'s (WebKit prints it)',
    reportOnly('http://127.0.0.1:8781/loops/x/x.zip') === 'PASS');
  check('…and its img-src refusal of the dev-lane poster too (a new id\'s art/<id>/poster-dev.jpg)',
    exitAndPageVerdicts({ gone: true, httpFailures: [], origin: RIG, consoleLines: lines(
      '[Report Only] Refused to load http://127.0.0.1:8781/art/x/poster-dev.jpg because it does not appear in the img-src directive of the Content Security Policy.') })
      .page.verdict === 'PASS');
  check('…and of any other origin is still a page FAIL',
    reportOnly('https://evil.example/x.zip') === 'FAIL' && reportOnly('http://127.0.0.2:8781/x') === 'FAIL');
  check('a 404 console line decides neither row',
    exitAndPageVerdicts({ gone: true, consoleLines: lines('Failed to load resource: 404'), httpFailures: [], origin: RIG })
      .exit.verdict === 'PASS');
  check('a player that survived leaving is an exit FAIL',
    exitAndPageVerdicts({ gone: false, consoleLines: [], httpFailures: [], origin: RIG }).exit.verdict === 'FAIL');

  // [007/WEBCSS1] #417. SvelteKit imports the root error page (node 1) eagerly on every load, and
  // Vite's preload helper rejects when that stylesheet's <link> fires `error`. WebKit fires it on the
  // OUTGOING page when the rig's own goto cancels the load (measured: the stylesheet was never even
  // requested by that page). Explained only when all three hold — raised during the rig's navigation,
  // our own /_app/immutable/ asset, and that asset served to this run — never by the text alone.
  const css = `${RIG}/_app/immutable/assets/1.DKuFEGaJ.css`;
  const preload = (url, leaving) => ({ level: 'error', leaving,
    text: `Uncaught: Unhandled Promise Rejection: Error: Unable to preload CSS for ${url} @ ${RIG}/_app/immutable/entry/app.Bc3-XjyH.js:2` });
  const preloadPage = (line, served) =>
    exitAndPageVerdicts({ gone: true, consoleLines: [line], httpFailures: [], origin: RIG, served }).page;
  const aborted = preloadPage(preload(css, true), [css]);
  check('WEBCSS1: a CSS preload the rig\'s own navigation cancelled, the asset served, is quoted not failed',
    aborted.verdict === 'PASS' && /navigation cancelled/.test(aborted.label) && aborted.evidence.includes('1.DKuFEGaJ.css'));
  check('WEBCSS1: …and its evidence names the stylesheet first, ahead of the rig\'s CSP reports (#417 run A cut it off)',
    exitAndPageVerdicts({ gone: true, httpFailures: [], origin: RIG, served: [css], consoleLines: [
      ...lines('[Report Only] Refused to load http://127.0.0.1:8781/art/x/poster-dev.jpg because it does not appear in the img-src directive of the Content Security Policy.',
        '[Report Only] Refused to load http://127.0.0.1:8781/art/x/poster-dev.jpg because it does not appear in the img-src directive of the Content Security Policy.'),
      preload(css, true)] }).page.evidence.includes('1.DKuFEGaJ.css'));
  check('WEBCSS1: …the same error with NO navigation in flight is still a page FAIL',
    preloadPage(preload(css, false), [css]).verdict === 'FAIL');
  check('WEBCSS1: …during a navigation but the asset never served (a 404, a missing file) is still a page FAIL',
    preloadPage(preload(css, true), []).verdict === 'FAIL');
  check('WEBCSS1: …another origin\'s stylesheet, or one outside /_app/immutable/, is still a page FAIL',
    preloadPage(preload('https://evil.example/_app/immutable/assets/1.css', true), ['https://evil.example/_app/immutable/assets/1.css']).verdict === 'FAIL'
      && preloadPage(preload(`${RIG}/elsewhere/1.css`, true), [`${RIG}/elsewhere/1.css`]).verdict === 'FAIL');
  check('WEBCSS1: …and beside a real host error the page still FAILs, naming the real one',
    (() => { const v = exitAndPageVerdicts({ gone: true, httpFailures: [], origin: RIG, served: [css],
      consoleLines: [preload(css, true), ...lines('TypeError: host is broken')] }).page;
    return v.verdict === 'FAIL' && v.evidence.includes('host is broken') && !v.evidence.includes('preload'); })());
  check('WEBCSS1: a caller that passes no `served` list explains nothing (Chromium\'s session has none)',
    exitAndPageVerdicts({ gone: true, consoleLines: [preload(css, true)], httpFailures: [], origin: RIG }).page.verdict === 'FAIL');

  // files — [007/LEGFIX1], #371. Float v1.1.5's own shape: the entry and its code inside the mount,
  // every soundscape zone one `../` out of it, the CDN refusing the host page its poster art.
  const MOUNT = `${RIG}/loop-runtime/vibes-collectivus/`;
  const ENTRY = `${MOUNT}index.html`;
  const zone = (n) => `${RIG}/loop-runtime/assets/audio/inst/zone-${n}.m4a`;
  const float115 = {
    requests: [{ url: ENTRY, document: `${RIG}/worlds/vibes-collectivus?play=1` },
      { url: `${MOUNT}main.js`, document: ENTRY },
      ...Array.from({ length: 59 }, (_, n) => ({ url: zone(n), document: ENTRY })),
      { url: 'https://cdn.collectivus.com/art/vibes-collectivus/poster.jpg', document: `${RIG}/` }],
    httpFailures: [...Array.from({ length: 59 }, (_, n) => ({ status: 404, url: zone(n), document: ENTRY })),
      { status: 403, url: 'https://cdn.collectivus.com/art/vibes-collectivus/poster.jpg', document: `${RIG}/` }],
    origin: RIG, loopId: 'vibes-collectivus',
  };
  const red = filesVerdict(float115);
  check('files: Float v1.1.5 — 59 zones one `../` out of the mount — is a FAIL that counts them',
    red.verdict === 'FAIL' && red.evidence.startsWith('59 path(s) OUTSIDE its mount /loop-runtime/vibes-collectivus/'),
    `${red.verdict}: ${red.evidence}`);
  check('files: …and names the escaping paths, the rest counted',
    red.evidence.includes('/loop-runtime/assets/audio/inst/zone-0.m4a') && red.evidence.includes('(+55 more)'), red.evidence);
  check('files: …and never the CDN\'s 403 on the poster — the art exemption is untouched',
    !red.evidence.includes('cdn.collectivus.com') && payloadFiles(float115).escaped.length === 59);
  check('files: the same zones INSIDE the mount, all answered, are a PASS',
    filesVerdict({ ...float115, httpFailures: float115.httpFailures.slice(59),
      requests: float115.requests.map((r) => ({ ...r, url: r.url.replace('/loop-runtime/assets/', '/loop-runtime/vibes-collectivus/assets/') })) })
      .verdict === 'PASS');
  const lacks = filesVerdict({ ...float115, requests: float115.requests.slice(0, 2),
    httpFailures: [{ status: 404, url: `${MOUNT}assets/missing.ktx2`, document: ENTRY }] });
  check('files: a 404 INSIDE the mount is a FAIL — the payload lacks the file',
    lacks.verdict === 'FAIL' && /does not carry/.test(lacks.label) && lacks.evidence.includes('/assets/missing.ktx2'), lacks.evidence);
  check('files: a `../../` that the site answers is still an escape — the payload document asked for it',
    filesVerdict({ ...float115, httpFailures: [],
      requests: [...float115.requests.slice(0, 2), { url: `${RIG}/favicon.ico`, document: ENTRY }] }).verdict === 'FAIL');
  check('files: the host page\'s own requests on the rig origin are not the payload\'s',
    filesVerdict({ ...float115, httpFailures: [{ status: 404, url: `${RIG}/art/x/poster-dev.jpg`, document: `${RIG}/worlds/x` }],
      requests: [...float115.requests.slice(0, 2), { url: `${RIG}/_app/start.js`, document: `${RIG}/` }] }).verdict === 'PASS');
  check('files: a blob: or data: URL the payload made is not a path on the rig',
    filesVerdict({ ...float115, httpFailures: [], requests: [...float115.requests.slice(0, 2),
      { url: `blob:${RIG}/0b1c`, document: ENTRY }, { url: 'data:text/plain,x', document: ENTRY }] }).verdict === 'PASS');
  check('files: a run that saw no request inside the mount is UNRUN, never a PASS',
    filesVerdict({ ...float115, requests: [], httpFailures: [] }).verdict === 'UNRUN');
  check('files: no Loop id is UNRUN — the mount is unknown',
    filesVerdict({ ...float115, loopId: '' }).verdict === 'UNRUN');
  check('files: another Loop\'s mount is outside this one\'s',
    payloadFiles({ ...float115, httpFailures: [], requests: [{ url: `${RIG}/loop-runtime/vibes-collectivus-2/a.js`, document: ENTRY }] })
      .escaped.length === 1);
  check('files: the rows both drivers share end with `files`', SHARED_ROWS[SHARED_ROWS.length - 1] === 'files');

  check('both viewports are defined, and only one of them is a touch device',
    VIEWPORTS.desktop.mobile === false && VIEWPORTS.phone.mobile === true);
}
