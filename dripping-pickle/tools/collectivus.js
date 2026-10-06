// Collectivus app integration — everything the SHELL needs from this Loop, in one module.
//
// The contract is published in collectivus-loops-docs/30-engines/web/ (`00-status.md` §3 and
// `20-the-loop-manifest-and-bridge.md`) — read those, not this file, for WHY. Three jobs:
//   1. lifecycle in  — pause / resume / exit stop and restart the frame loop AND the video.
//   2. input in      — the shell's input capture is an overlay ABOVE the web view, so the page
//                      receives no native touches in the app. The bridge's unit-space events are
//                      replayed as synthetic PointerEvents on the canvas, so the scene's existing
//                      click-to-travel handler runs unchanged and nothing is duplicated here.
//   3. `ready` out   — from inside a COMPLETED frame, never from module scope: the shell photographs
//                      the composited frame right after `ready` and counts distinct colours.
//
// Outside the app `window.collectivus` is absent and attach() returns null; the page is unchanged.

/**
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas   the renderer's canvas — the scene's handlers test e.target against it
 * @param {() => void} o.pause          stop the frame loop, the video AND the audio
 * @param {() => void} o.resume         restart all three, then catch the clock up
 * @param {{id: string, title: string}[]} [o.cameras]  the declared views. ⚠ MUST AGREE WITH
 *                                      `loop.json` — the shell logs a disagreement rather than
 *                                      picking a winner — and the FIRST is the opening shot.
 * @param {(id: string) => boolean} [o.onCamera]  move the view. Return false to refuse.
 * @param {(muted: boolean, gain: number) => void} [o.setMuted]  go silent / come back, WITHOUT
 *                                      stopping the world. Not the same call as `pause`.
 * @param {string} [o.tier]            the rung this Loop actually BOOTED (bridge v3, loops-docs web
 *                                      20 §3.5) — sent with `ready` so the shell's
 *                                      `[Loop] tier requested=… booted=…` line and the device leg's
 *                                      `tier` row can say something. A shell before v3 ignores it.
 */
export function attachCollectivus(o) {
  const clv = window.collectivus;
  if (!clv) return null;

  // ── cameras (bridge v1) ───────────────────────────────────────────────────────────────────
  // ★ `cameraChanged` IS NOT POLITENESS — it is the only way the shell learns where the view
  //   actually is. A select is accepted, not arrived: until we confirm, the shell's idea of the
  //   live camera is an assumption about a Loop it cannot see inside, and a Loop that switches
  //   happily but never confirms shows the wrong entry ticked for the rest of the session. It is
  //   also what makes the choice STICK: the shell remembers the viewer's camera per Loop, and
  //   only remembers it when we confirm.
  // ★ AND WE MUST REPORT OUR OWN CUTS TOO, including the one we open on — the viewer pressing
  //   the in-world toggle is a camera change the shell never asked for and would otherwise never
  //   hear about.
  const cameras = Array.isArray(o.cameras) ? o.cameras : [];
  const known = new Set(cameras.map((c) => c.id));
  // Reported once per ARRIVAL, not once per caller. A shell-initiated switch has two honest
  // reporters — the scene's own arrival hook and this confirmation — and both firing sends the
  // id twice. Idempotent for the shell, but a device log is read by people, and a doubled line
  // is a thing somebody has to rule out.
  let lastCamera = null;
  const reportCamera = (id) => {
    if (!known.has(id) || id === lastCamera) return;
    lastCamera = id;
    try { clv.cameraChanged(id); } catch {}
  };

  // ⚠ x/y arrive in UNIT space (0…1, origin top-left), never pixels — the same payload runs on a
  // phone and in a Mac window. Converted at the point of use.
  let down = null;   // the press in flight, in unit space
  const synth = (type, at) => {
    const init = {
      bubbles: true, cancelable: true, isPrimary: true, pointerId: 1, pointerType: 'touch',
      clientX: at.x * innerWidth, clientY: at.y * innerHeight,
      button: 0, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
    };
    o.canvas.dispatchEvent(new PointerEvent(type, init));
  };

  function handleInput(input) {
    if (!input) return;
    switch (input.kind) {
      case 'primary':
        if (input.phase === 'down' && input.x != null) {
          down = { x: input.x, y: input.y };
          // ★ THE PROOF THE PRESS REACHED US (#141, loops-docs 40-delivery/20 §3.2). The web
          // device leg dispatches a real click and asserts it arrived IN THE LOOP; with no line
          // here its `input` row can only say "something came back". One line per press.
          try { clv.log(`dripping-pickle: primary down at ${input.x.toFixed(3)},${input.y.toFixed(3)}`); } catch {}
          synth('pointerdown', down);
        } else if (input.phase === 'up' && down) {
          synth('pointerup', input.x != null ? input : down);
          down = null;
        } else if (input.phase === 'cancelled' && down) {
          // ⚠ `cancelled` means "that press did not happen" — a long press arrives as
          // down → cancelled → secondary(down). A cancel is not an up: no travel.
          synth('pointercancel', down);
          down = null;
        }
        break;
      case 'point':
        // Moves while pressed feed the scene's own 4 px click-not-drag test.
        if (down && input.phase === 'moved') synth('pointermove', input);
        // ★ AND `hover` IS THE ONLY UNPRESSED MOVE THERE IS — `moved` arrives while
        // pressed. Dropping it (as this bridge did until DP-W8) means the aim
        // feedback every hotspot declares is dead inside the app: the Loop still
        // works, and nothing ever lights up under the cursor, which on a television
        // with a synthesised pointer is most of how a viewer finds what to press.
        // loops-docs 00-input.md records the same omission costing Vibes four
        // sessions, for the same reason: a dev shim that shared the bug agreed with it.
        else if (!down && input.phase === 'hover' && input.x != null) synth('pointermove', input);
        break;
      default: break;
    }
  }

  clv.on((event) => {
    switch (event.type) {
      case 'pause': o.pause(); break;
      case 'resume': o.resume(); break;
      case 'exit': o.pause(); break;
      case 'input': handleInput(event.input); break;
      // ⚠ MUTE IS NOT PAUSE (bridge v2, loops-docs 30-audio §2b). Silence now; the world and the
      // shared clock keep running underneath, because a Loop that stops stepping is desynced
      // from anyone watching alongside it. Under WKWebView the shell CANNOT reach a Web Audio
      // graph — it mutes <video>/<audio> and that is all — so without this the Loop talks over
      // the settings panel on iPhone, iPad and Mac while sounding correct on a television.
      case 'mute': o.setMuted?.(!!event.muted, event.gain); break;
      case 'camera': {
        // ⚠ Refuse an id we never declared, SILENTLY, by not confirming it. Switching to
        // something approximate is how a republished Loop with renamed cameras puts a viewer
        // in a view nobody chose.
        if (!known.has(event.id)) { clv.log('dripping-pickle: refused undeclared camera ' + event.id); break; }
        const moved = o.onCamera ? o.onCamera(event.id) : false;
        if (moved !== false) reportCamera(event.id);
        break;
      }
      default: break;
    }
  });

  return {
    // Called by the loading cover's done() — i.e. after the room is complete and two frames have
    // been through the real loop — then deferred one more frame so the reveal has started.
    ready() {
      requestAnimationFrame(() => {
        const info = {};
        if (cameras.length) info.cameras = cameras;
        if (o.tier) info.tier = o.tier;
        clv.ready(info);
        clv.log('dripping-pickle: ready — WebGPU=' + (typeof navigator.gpu !== 'undefined')
              + ' secureContext=' + window.isSecureContext
              + ' dpr=' + devicePixelRatio + ' ' + innerWidth + 'x' + innerHeight
              + ' tier=' + (o.tier ?? 'unset')
              + ' requested=' + (clv.device?.tier ?? 'none (bridge < v3)'));
      });
    },
    log: (m) => clv.log(String(m)),
    /** The scene calls this whenever the view ARRIVES anywhere — its own toggle included. */
    cameraChanged: reportCamera,
  };
}
