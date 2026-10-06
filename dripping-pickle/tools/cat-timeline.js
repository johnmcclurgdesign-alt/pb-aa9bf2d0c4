// The cat behaviour timeline — a bottom bar for stringing clips into a named
// behaviour. Authoring UI only; the playback logic lives in cat-behavior.js and
// the AnimationMixer stays entirely in the scene.
//
// The bar is deliberately laid out around the panels that were already here:
// the clip picker owns top-right, the feedback panel bottom-right (310 px), the
// hud bottom-left and the back link top-left. That leaves one free strip, and
// the two offsets below are measured against those neighbours rather than
// picked — see the CSS.

import {
  createBehaviorPlayer, normaliseBehavior, defaultHold, totalSeconds,
  loadBehaviors, uid, stepAt, poseAt,
} from './cat-behavior.js';

const CSS = `
#seq {
  position: fixed; left: 14px; bottom: 74px; z-index: 45;
  /* 336 = the feedback panel's 310 px + its 14 px margin + a 12 px gap. 74 =
     clear of the three-line hud at bottom:12px. Both are neighbours' numbers,
     so if either panel is resized this is where to look. */
  right: 336px; min-width: 300px;
  font: 11px/1.5 ui-monospace, Consolas, monospace;
  background: rgba(16,18,23,0.90); border: 1px solid #262c38; border-radius: 7px;
  color: #9aa3b2; backdrop-filter: blur(6px);
}
#seq .head { display: flex; align-items: center; gap: 6px; padding: 7px 8px; flex-wrap: wrap; }
#seq h4 { margin: 0 6px 0 0; font-size: 10px; letter-spacing: .09em;
          text-transform: uppercase; color: #626b7c; font-weight: 600; cursor: pointer; }
#seq h4:hover { color: #9aa3b2; }
#seq button {
  font: inherit; padding: 4px 8px; cursor: pointer; color: #aeb7c6;
  background: #171b23; border: 1px solid #262c38; border-radius: 4px; white-space: nowrap;
}
#seq button:hover:not(:disabled) { background: #1e242e; color: #dfe5ee; }
#seq button:disabled { opacity: .4; cursor: default; }
#seq button.go { background: #2d4a2f; border-color: #47714a; color: #d8f0d9; }
#seq button.danger:hover { background: #4a2d2d; border-color: #714747; color: #f0d8d8; }
#seq input[type=text], #seq select {
  font: inherit; padding: 4px 6px; color: #dfe5ee;
  background: #0f1319; border: 1px solid #262c38; border-radius: 4px; min-width: 0;
}
#seq input#seq-name { flex: 1 1 120px; }
#seq select { max-width: 150px; }
#seq label { display: inline-flex; align-items: center; gap: 4px; color: #7f8796; cursor: pointer; }
#seq .total { color: #6b8a6e; margin-left: auto; white-space: nowrap; }
#seq .msg { flex-basis: 100%; color: #6b8a6e; min-height: 14px; }
#seq .msg.bad { color: #c98b8b; }

/* The track. flex-grow carries the duration, so a step's width IS its share of
   the behaviour — no pixel maths, and it reflows on resize for free. The
   min-width stops a 0.2 s step collapsing to an unclickable sliver. */
#seq .track { display: flex; gap: 3px; padding: 0 8px 8px; align-items: stretch; min-height: 46px; }
#seq .track.empty::before {
  content: 'no steps yet — pick a clip on the right, then press + add';
  color: #545c6b; padding: 14px 4px; font-style: italic;
}
#seq .step {
  position: relative; overflow: hidden; min-width: 52px;
  background: #171b23; border: 1px solid #262c38; border-radius: 4px;
  padding: 5px 6px; cursor: grab; user-select: none;
}
#seq .step:hover { border-color: #3a4354; }
#seq .step.sel { border-color: #6f9d72; background: #1b2620; }
#seq .step.now { background: #223026; }
#seq .step.drag { opacity: .35; }
#seq .step .n { display: block; color: #dfe5ee; white-space: nowrap;
                overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
#seq .step .s { display: block; color: #7f8796; pointer-events: none; }
/* The lane holds the track and the ruler so ONE playhead can span both. */
#seq .lane { position: relative; }
#seq .ruler {
  position: relative; height: 17px; margin: 0 8px 6px; cursor: ew-resize;
  border-top: 1px solid #262c38; touch-action: none;
}
#seq .ruler .tick { position: absolute; top: 0; width: 1px; height: 4px; background: #333b48; }
#seq .ruler .tick.lab { height: 6px; background: #46506180; }
#seq .ruler .tlab { position: absolute; top: 6px; font-size: 9px; color: #545c6b;
                    transform: translateX(-50%); pointer-events: none; }
/* Spans track + ruler. pointer-events off so it never eats a click meant for a
   step; the ruler underneath is what you actually grab. */
#seq .ph { position: absolute; top: 0; width: 2px; background: #d8c169;
           pointer-events: none; z-index: 3; box-shadow: 0 0 4px #d8c16988; }
#seq .ph::after {
  content: ''; position: absolute; left: -4px; bottom: -1px;
  border-left: 5px solid transparent; border-right: 5px solid transparent;
  border-bottom: 6px solid #d8c169;
}
#seq.scrubbing .ph { background: #f0d97a; }
#seq .time { color: #d8c169; white-space: nowrap; font-variant-numeric: tabular-nums; }
#seq .edit { display: flex; align-items: center; gap: 6px; padding: 0 8px 8px; flex-wrap: wrap; }
#seq .edit .lbl { color: #626b7c; }
#seq .edit input[type=number] {
  width: 62px; font: inherit; padding: 3px 5px; color: #dfe5ee;
  background: #0f1319; border: 1px solid #262c38; border-radius: 4px;
}
#seq.collapsed .track, #seq.collapsed .edit, #seq.collapsed .msg { display: none; }
`;

/**
 * @param clips   the scene's CLIPS table  [{ file, label, loop }]
 * @param play    the scene's crossfader    play(name, fade)
 * @param info    (clip) -> { seconds, loop }   natural length, from the mixer
 * @param current () -> the clip name playing right now, for "+ add"
 * @param onRun   (running) -> void, so the scene can switch wander off
 * @param rightGap how much room to leave on the right, in px. 336 clears the
 *                 feedback panel; 14 is the plain page margin when it is off.
 */
export function createCatTimeline({ clips, play, info, current, onRun = null, rightGap = 336,
                                   pose = null, endPose = null }) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.id = 'seq';
  // Overrides the CSS default, which assumes the feedback panel is there.
  el.style.right = `${Math.max(14, rightGap)}px`;
  el.innerHTML = `
    <div class="head">
      <h4 id="seq-fold" title="collapse">Behaviour</h4>
      <button id="seq-run" class="go">play</button>
      <button id="seq-add">+ add</button>
      <input type="text" id="seq-name" placeholder="name it…" spellcheck="false">
      <label><input type="checkbox" id="seq-loop" checked> loop</label>
      <select id="seq-pick"><option value="">load…</option></select>
      <button id="seq-save">save</button>
      <button id="seq-del" class="danger">delete</button>
      <span class="time" id="seq-time">0.00 s</span>
      <span class="total" id="seq-total">/ 0.0 s</span>
      <span class="msg" id="seq-msg"></span>
    </div>
    <div class="lane" id="seq-lane">
      <div class="track" id="seq-track"></div>
      <div class="ruler" id="seq-ruler"></div>
      <div class="ph" id="seq-ph" hidden></div>
    </div>
    <div class="edit" id="seq-edit"></div>`;
  document.body.appendChild(el);

  const $ = (id) => el.querySelector('#' + id);
  const $track = $('seq-track'), $edit = $('seq-edit'), $msg = $('seq-msg');
  const $name = $('seq-name'), $pick = $('seq-pick'), $loop = $('seq-loop');
  const $run = $('seq-run'), $total = $('seq-total');
  const $lane = $('seq-lane'), $ruler = $('seq-ruler'), $ph = $('seq-ph'), $time = $('seq-time');

  const labelOf = (file) => clips.find((c) => c.file === file)?.label ?? file;

  let behavior = { id: uid(), name: '', loop: true, notes: '', steps: [] };
  let saved = [];           // everything on file
  let writable = false;
  let sel = -1;             // selected step
  let dragFrom = -1;
  let scrubT = null;        // where the playhead sits when parked, in seconds

  const player = createBehaviorPlayer({ play, info, onStep: () => paint() });

  function say(text, bad = false) {
    $msg.textContent = text;
    $msg.classList.toggle('bad', !!bad);
  }

  // ── painting ────────────────────────────────────────────────────
  function paint() {
    $track.classList.toggle('empty', !behavior.steps.length);
    $track.replaceChildren(...behavior.steps.map((s, i) => {
      const d = document.createElement('div');
      d.className = 'step' + (i === sel ? ' sel' : '') +
                    (player.running && i === player.index ? ' now' : '');
      d.style.flex = `${Math.max(0.05, s.seconds)} 1 0`;
      d.draggable = true;
      d.dataset.i = i;
      d.title = `${labelOf(s.clip)} · ${s.seconds}s · fade ${s.fade}s`;
      d.innerHTML = `<span class="n"></span><span class="s"></span>`;
      d.querySelector('.n').textContent = labelOf(s.clip);
      d.querySelector('.s').textContent = `${s.seconds}s`;
      return d;
    }));
    $total.textContent = `/ ${totalSeconds(behavior).toFixed(1)} s`;
    $run.textContent = player.running ? 'stop' : 'play';
    $run.classList.toggle('go', !player.running);
    paintRuler();
    paintPlayhead();
    paintEdit();
  }

  // ── the playhead ────────────────────────────────────────────────
  // ★ Position comes from the BLOCK RECTS, never from time / total. The track
  // giveseach step a min-width, so a 0.85 s step next to a 20 s one is far wider
  // than its share — map through time/total and the head drifts off the block
  // it claims to be inside, worst exactly where the short transitions are.
  function timeToX(T) {
    const { index, localT } = stepAt(behavior, T);
    const b = $track.children[index];
    if (!b) return 0;
    const secs = behavior.steps[index]?.seconds || 1;
    return b.offsetLeft + (localT / secs) * b.offsetWidth;
  }

  function xToTime(x) {
    const steps = behavior.steps;
    if (!steps.length) return 0;
    let before = 0;
    for (let i = 0; i < steps.length; i++) {
      const b = $track.children[i];
      if (!b) break;
      const l = b.offsetLeft, w = b.offsetWidth;
      if (x < l) return before;                                  // in a gap, or left of the track
      if (x <= l + w) return before + ((x - l) / w) * steps[i].seconds;
      before += steps[i].seconds;
    }
    return totalSeconds(behavior);
  }

  /** Global time now: playback position, or the parked scrub, or nothing. */
  function headTime() {
    if (player.running) {
      let t = 0;
      for (let i = 0; i < player.index; i++) t += behavior.steps[i].seconds;
      return t + player.elapsed;
    }
    return scrubT;
  }

  function paintPlayhead() {
    const T = headTime();
    if (T == null || !behavior.steps.length) {
      $ph.hidden = true; $time.textContent = '0.00 s'; return;
    }
    $ph.hidden = false;
    $ph.style.left = `${timeToX(T)}px`;
    $ph.style.height = `${$lane.offsetHeight}px`;
    $time.textContent = `${T.toFixed(2)} s`;
  }

  // Ticks are drawn at even SECONDS but placed through timeToX, so they land
  // where that second actually is on a non-proportional track. That unevenness
  // is the point: it shows you the short steps are over-represented.
  let rulerKey = '';
  function paintRuler(force = false) {
    const total = totalSeconds(behavior);
    // Rebuilt only when the shape changes. During playback paint() runs several
    // times a second and the ticks never move.
    const key = `${total}|${behavior.steps.length}|${$track.offsetWidth}`;
    if (!force && key === rulerKey) return;
    rulerKey = key;
    $ruler.replaceChildren();
    if (!total || !$track.children.length) return;
    const raw = total / 12;
    const nice = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    const gap = nice.find((n) => n >= raw) ?? 60;
    for (let t = 0; t <= total + 1e-6; t += gap) {
      const x = timeToX(t);
      const tick = document.createElement('div');
      tick.className = 'tick lab';
      tick.style.left = `${x}px`;
      $ruler.appendChild(tick);
      const lab = document.createElement('div');
      lab.className = 'tlab';
      lab.style.left = `${x}px`;
      lab.textContent = gap < 1 ? t.toFixed(1) : String(Math.round(t));
      $ruler.appendChild(lab);
    }
  }

  /** Move the head and pose the cat there. */
  function seek(T) {
    scrubT = Math.max(0, Math.min(T, totalSeconds(behavior)));
    // poseAt weights BOTH clips inside a step's fade, so dragging through a
    // transition shows the blend rather than snapping between the two clips.
    pose?.(poseAt(behavior, scrubT, info));
    const { index } = stepAt(behavior, scrubT);
    if (index >= 0) {
      for (const [i, d] of [...$track.children].entries()) d.classList.toggle('now', i === index);
    }
    paintPlayhead();
  }

  // Grab anywhere on the ruler. Pointer capture rather than window listeners so
  // a drag that leaves the bar still tracks, and still ends on release.
  let scrubbing = false;
  const laneX = (e) => e.clientX - $lane.getBoundingClientRect().left;
  $ruler.addEventListener('pointerdown', (e) => {
    if (!behavior.steps.length) return;
    e.preventDefault();
    scrubbing = true;
    el.classList.add('scrubbing');
    // Capture is an optimisation, not the mechanism — it keeps a drag that
    // leaves the bar tracking. It THROWS for a pointer id the browser is not
    // currently tracking, and unguarded that exception aborts the handler
    // before the seek below ever runs, so the click does nothing at all.
    try { $ruler.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
    if (player.running) { player.stop(); paint(); }
    seek(xToTime(laneX(e)));
  });
  $ruler.addEventListener('pointermove', (e) => { if (scrubbing) seek(xToTime(laneX(e))); });
  const endScrub = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    el.classList.remove('scrubbing');
    try { $ruler.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  };
  $ruler.addEventListener('pointerup', endScrub);
  $ruler.addEventListener('pointercancel', endScrub);

  // Arrow keys nudge the head once it is parked — the only way to land on a
  // specific frame of a 0.85 s transition, which is the whole point of scrubbing
  // one. Shift for a whole second. Ignored while typing in a field.
  addEventListener('keydown', (e) => {
    if (scrubT == null || player.running) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    seek(scrubT + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 1 : 0.05));
  });

  function paintEdit() {
    const s = behavior.steps[sel];
    if (!s) { $edit.replaceChildren(); return; }
    const nat = info?.(s.clip);
    const natTxt = nat && Number.isFinite(nat.seconds)
      ? `natural ${nat.seconds.toFixed(2)}s${nat.loop ? ' (loops)' : ' (one-shot)'}` : '';
    $edit.innerHTML = `
      <span class="lbl">step ${sel + 1}</span>
      <b style="color:#dfe5ee"></b>
      <span class="lbl">hold</span><input type="number" id="e-secs" min="0.05" step="0.05">
      <span class="lbl">fade</span><input type="number" id="e-fade" min="0" step="0.05">
      <button id="e-play">preview</button>
      <button id="e-dup">duplicate</button>
      <button id="e-del" class="danger">remove</button>
      <span class="lbl" id="e-nat"></span>`;
    $edit.querySelector('b').textContent = labelOf(s.clip);
    $edit.querySelector('#e-nat').textContent = natTxt;
    const secs = $edit.querySelector('#e-secs'), fade = $edit.querySelector('#e-fade');
    secs.value = s.seconds; fade.value = s.fade;
    // `input` not `change`: typing should update the block width as you go, which
    // is the only feedback that the number means "share of the behaviour".
    secs.oninput = () => { s.seconds = Math.max(0.05, Number(secs.value) || 0.05); paint(); };
    fade.oninput = () => { s.fade = Math.max(0, Number(fade.value) || 0); };
    $edit.querySelector('#e-play').onclick = () => {
      player.stop(); scrubT = null; endPose?.(); onRun?.(false);
      play(s.clip, s.fade); paint();
    };
    $edit.querySelector('#e-dup').onclick = () => {
      behavior.steps.splice(sel + 1, 0, { ...s }); sel += 1; paint();
    };
    $edit.querySelector('#e-del').onclick = () => {
      behavior.steps.splice(sel, 1);
      sel = Math.min(sel, behavior.steps.length - 1);
      paint();
    };
  }

  // ── track interaction ───────────────────────────────────────────
  $track.addEventListener('click', (e) => {
    const d = e.target.closest('.step'); if (!d) return;
    sel = Number(d.dataset.i);
    if (player.running) player.goTo(sel);      // click-to-scrub while running
    paint();
  });
  $track.addEventListener('dragstart', (e) => {
    const d = e.target.closest('.step'); if (!d) return;
    dragFrom = Number(d.dataset.i);
    d.classList.add('drag');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox will not start a drag without payload, and the payload is unused.
    e.dataTransfer.setData('text/plain', String(dragFrom));
  });
  $track.addEventListener('dragend', () => {
    dragFrom = -1;
    $track.querySelectorAll('.drag').forEach((d) => d.classList.remove('drag'));
  });
  $track.addEventListener('dragover', (e) => { if (dragFrom >= 0) e.preventDefault(); });
  $track.addEventListener('drop', (e) => {
    if (dragFrom < 0) return;
    e.preventDefault();
    const d = e.target.closest('.step');
    const target = d ? Number(d.dataset.i) : behavior.steps.length;
    // Remove FIRST, then clamp the insertion point into the shortened array.
    // Dropping right of where it came from lands after the target, dropping
    // left lands before it — which is what the drag looks like it is doing.
    const [moved] = behavior.steps.splice(dragFrom, 1);
    const to = Math.max(0, Math.min(target, behavior.steps.length));
    behavior.steps.splice(to, 0, moved);
    sel = to; dragFrom = -1;
    paint();
  });

  // ── header actions ──────────────────────────────────────────────
  $('seq-fold').onclick = () => el.classList.toggle('collapsed');

  $('seq-add').onclick = () => {
    const clip = current?.();
    if (!clip) return say('pick a clip on the right first', true);
    const step = { clip, seconds: defaultHold(clip, info), fade: 0.3 };
    const at = sel >= 0 ? sel + 1 : behavior.steps.length;
    behavior.steps.splice(at, 0, step);
    sel = at;
    paint();
    say(`added ${labelOf(clip)}`);
  };

  $run.onclick = () => {
    if (player.running) { player.stop(); onRun?.(false); say('stopped'); }
    else if (!behavior.steps.length) say('nothing to play yet', true);
    else {
      // Leaving a scrub: every action is PAUSED, so playback has to be handed
      // back before the player fades anything in.
      scrubT = null; endPose?.();
      onRun?.(true); player.start(behavior); say(`playing ${behavior.steps.length} steps`);
    }
    paint();
  };

  $loop.onchange = () => { behavior.loop = $loop.checked; };
  $name.oninput = () => { behavior.name = $name.value; };

  $pick.onchange = () => {
    const b = saved.find((x) => x.id === $pick.value);
    if (!b) return;
    // A deep copy, or editing the loaded behaviour would silently mutate the
    // in-memory list and "revert" would have nothing to go back to.
    behavior = normaliseBehavior(JSON.parse(JSON.stringify(b)), info);
    sel = behavior.steps.length ? 0 : -1;
    $name.value = behavior.name;
    $loop.checked = behavior.loop;
    player.stop(); onRun?.(false);
    paint();
    say(`loaded ${behavior.name}`);
  };

  // A behaviour's id is what the warehouse cat will ask for, so it is derived
  // from the name once and then FROZEN — renaming a saved behaviour must not
  // orphan whatever is already calling it.
  const slug = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-')
                       .replace(/^-+|-+$/g, '').slice(0, 40);

  $('seq-save').onclick = async () => {
    const name = $name.value.trim();
    if (!name) return say('give it a name first', true);
    if (!behavior.steps.length) return say('nothing to save', true);
    const known = saved.find((x) => x.id === behavior.id);
    const rec = {
      ...behavior,
      name,
      id: known ? behavior.id : (slug(name) || uid()),
      loop: $loop.checked,
    };
    if (!known && saved.some((x) => x.id === rec.id)) {
      return say(`"${rec.id}" already exists — load it, or pick another name`, true);
    }
    if (!writable) {
      const json = JSON.stringify(rec, null, 2);
      try { await navigator.clipboard.writeText(json); say('read-only — behaviour copied to clipboard'); }
      catch { say('read-only — no dev server, and the clipboard refused', true); }
      return;
    }
    try {
      const r = await fetch('/api/behaviors', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rec),
      });
      const out = await r.json();
      if (!out.ok) throw new Error(out.error);
      behavior = rec;
      saved = out.behaviors.map((b) => normaliseBehavior(b, info));
      fillPicker(rec.id);
      say(`saved "${rec.name}" as ${rec.id} — assets/cat/behaviors.json`);
    } catch (e) { say('save failed: ' + (e.message ?? e), true); }
  };

  $('seq-del').onclick = async () => {
    const known = saved.find((x) => x.id === behavior.id);
    if (!known) return say('this one is not saved yet', true);
    if (!writable) return say('read-only — deleting needs the dev server', true);
    // Two clicks, same bargain as the feedback tracker's delete: the button sits
    // next to save and only one of the two is reversible.
    const btn = $('seq-del');
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1'; btn.textContent = 'sure?';
      say(`click again to delete "${known.name}"`, true);
      setTimeout(() => { btn.dataset.armed = '0'; btn.textContent = 'delete'; }, 4000);
      return;
    }
    btn.dataset.armed = '0'; btn.textContent = 'delete';
    try {
      const r = await fetch('/api/behaviors/delete', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: behavior.id }),
      });
      const out = await r.json();
      if (!out.ok) throw new Error(out.error);
      saved = out.behaviors.map((b) => normaliseBehavior(b, info));
      fillPicker('');
      say(`deleted ${behavior.id}`);
      behavior = { ...behavior, id: uid() };      // the edit stays, its identity does not
    } catch (e) { say('delete failed: ' + (e.message ?? e), true); }
  };

  function fillPicker(selectId) {
    $pick.replaceChildren();
    const none = new Option(saved.length ? 'load…' : '(none saved)', '');
    $pick.appendChild(none);
    for (const b of saved) $pick.appendChild(new Option(b.name, b.id));
    $pick.value = selectId ?? '';
  }

  // ── boot ────────────────────────────────────────────────────────
  (async () => {
    const r = await loadBehaviors();
    saved = r.behaviors; writable = r.writable;
    fillPicker('');
    $('seq-save').title = writable ? 'writes assets/cat/behaviors.json'
                                   : 'read-only — copies JSON to the clipboard';
    say(writable ? `${saved.length} saved · writing to assets/cat/behaviors.json`
                 : `${saved.length} saved · read-only, no dev server`, !writable);
    paint();
  })();

  // Every position on the head and the ruler is a pixel measurement, so a resize
  // invalidates all of it — and the bar's width is tied to the window.
  addEventListener('resize', () => { paintRuler(true); paintPlayhead(); });

  let paintT = 0;
  return {
    el, player,
    get behavior() { return behavior; },
    /** Call in the frame loop BEFORE mixer.update(dt). */
    update(dt) {
      if (!player.running) return;
      player.update(dt);
      paintPlayhead();            // one style write — cheap enough every frame
      // The blocks only change on a step boundary, so the rest of the repaint
      // runs at a fraction of the frame rate.
      paintT += dt;
      if (paintT > 0.12) { paintT = 0; paint(); }
    },
  };
}
