// Feedback panel — dev only, loaded when the page is opened with ?dev=1.
//
// Point: kill the ambiguity in art-direction notes. Click a thing, and the note
// carries its real Blender name, its material, where you clicked in world space,
// the camera you were looking through, and a screenshot. "The beams are 90° off"
// becomes a note pinned to Beam_Large.001 that goes straight to the right object.
//
// It deliberately does NOT reimplement a scene inspector — Needle Inspector is
// better at that. This is only the bridge back to Claude and to Blender.

import * as THREE from 'three';
import { createFlyTo } from './flyto.js';
// Same pinned three as the scene's importmap — an addon, not a new dependency.
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const CSS = `
#fbk {
  position: fixed; right: 14px; bottom: 14px; width: 310px; z-index: 9999;
  font: 12px/1.5 ui-monospace, Consolas, monospace; color: #dfe3ea;
  background: rgba(16,18,23,.94); border: 1px solid #2b3140; border-radius: 10px;
  backdrop-filter: blur(6px); box-shadow: 0 10px 30px rgba(0,0,0,.5);
}
#fbk header {
  display:flex; align-items:center; justify-content:space-between;
  padding: 9px 12px; border-bottom: 1px solid #2b3140;
  font-size: 10px; letter-spacing:.14em; text-transform:uppercase; color:#8b93a7;
}
#fbk .body { padding: 11px 12px 12px; }
/* Deliberately NOT styled like the textarea below it. It had the same background,
   border and radius, which made a read-only readout look like a field you could type
   into. Bare text, holding its height so the panel does not jump as names change. */
#fbk .pick {
  padding: 2px 1px; margin-bottom: 9px; min-height: 34px;
}
#fbk .pick .none { color:#68708a; }
#fbk .pick .nm { color:#7fd18a; word-break: break-all; }
#fbk .pick .mt { color:#8b93a7; word-break: break-all; }
#fbk .pick .xyz { color:#5f6880; margin-top:3px; }
#fbk textarea {
  width:100%; box-sizing:border-box; height: 74px; resize: vertical;
  background:#0e1116; color:#dfe3ea; border:1px solid #262c39; border-radius:6px;
  padding:7px 8px; font: 12px/1.45 ui-monospace, Consolas, monospace;
}
#fbk textarea:focus { outline:none; border-color:#3c76c4; }
#fbk .row { display:flex; gap:7px; margin-top:8px; }
#fbk button {
  flex:1; padding:7px 9px; border-radius:6px; cursor:pointer;
  border:1px solid #2b3140; background:#1b2029; color:#dfe3ea;
  font: 500 12px ui-monospace, Consolas, monospace;
  display:flex; align-items:center; justify-content:center; gap:5px;
  white-space:nowrap;
}
/* Emoji fall back to the system emoji font; pin the size so they do not shove the
   label around when one glyph is taller than another. */
#fbk button .ico {
  font: 13px/1 "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif;
  flex: none;
}
#fbk button.wide { flex:2; }
#fbk button.primary { background:#2f6fd0; border-color:#2f6fd0; }
#fbk button.primary:hover { background:#3a7fe0; }
#fbk button:hover { background:#232936; }
#fbk button:disabled { opacity:.45; cursor:default; }
#fbk .views { margin-top:0; margin-bottom:9px; }
#fbk .views button { padding:5px 0; font-size:11px; gap:4px; }
#fbk .tools { display:flex; gap:5px; margin-bottom:9px; }
#fbk .tools button { padding:5px 0; font-size:11px; gap:4px; }
#fbk .tools button[aria-pressed="true"] { background:#2f6fd0; border-color:#2f6fd0; }
#fbk .moved {
  margin-bottom:9px; padding:7px 9px; border-radius:6px; font-size:11px;
  background:#171a12; border:1px solid #3d4a2a; color:#c9d6a8;
}
#fbk .moved b { color:#dfe9c4; font-weight:500; }
#fbk .moved .undo {
  display:block; margin-top:5px; color:#8b93a7; text-decoration:underline;
  cursor:pointer; font-size:10.5px;
}
/* Which object the typed note will be filed against. Shown only while there is text,
   because that is the only time it can go to the wrong place. */
#fbk .target {
  margin-top:6px; padding:1px; font-size:10.5px; color:#8b93a7;
}
#fbk .target b { color:#7fd18a; font-weight:500; word-break:break-all; }
#fbk .target .wipe { color:#8b93a7; text-decoration:underline; cursor:pointer; margin-left:6px; }
#fbk .msg { margin-top:7px; min-height:15px; color:#7fd18a; font-size:11px; }
#fbk .msg.err { color:#e2725b; }
#fbk .hint { margin-top:6px; color:#5f6880; font-size:10.5px; }
`;

// Build a link that restores this exact view and selection. This is the part
// that makes team feedback usable: a comment always arrives with the camera it
// was written from, so nobody has to describe where they were standing.
function deepLink({ camera, controls, object }) {
  const u = new URL(location.href);
  const f = (n) => +n.toFixed(3);
  u.searchParams.set('cam', [f(camera.position.x), f(camera.position.y), f(camera.position.z)].join(','));
  if (controls) u.searchParams.set('tgt', [f(controls.target.x), f(controls.target.y), f(controls.target.z)].join(','));
  if (object) u.searchParams.set('sel', object); else u.searchParams.delete('sel');
  u.searchParams.set('review', '1');
  return u.toString();
}

// Restore a view from ?cam= / ?tgt= / ?sel=
export function restoreView({ scene, camera, controls }) {
  const q = new URLSearchParams(location.search);
  const num = (s) => s?.split(',').map(Number).filter(n => Number.isFinite(n));
  const cam = num(q.get('cam'));
  const tgt = num(q.get('tgt'));
  if (cam?.length === 3) camera.position.set(cam[0], cam[1], cam[2]);
  if (tgt?.length === 3 && controls) controls.target.set(tgt[0], tgt[1], tgt[2]);
  if (controls) controls.update();
  const sel = q.get('sel');
  if (!sel) return null;
  let found = null;
  scene.traverse((o) => { if (!found && o.isMesh && o.name === sel) found = o; });
  return found;
}

// pickRoot: raycast against this instead of the whole scene. Pass the loaded
// glTF root so atmosphere helpers (light shafts, dust, sky) are never selectable —
// they have no Blender names and would just report "(unnamed mesh)".
//
// Two opt-outs the SCENE sets, on the object or any ancestor:
//   userData.noPick — not selectable at all (used internally for the gizmos)
//   userData.noMove — selectable and commentable, but no handles. For anything the
//                     scene drives rather than an artist places: a steered character,
//                     something on a path. Its transform is an output, so a dragged
//                     pose is not a suggestion — it is a value that gets overwritten,
//                     or silently persisted as an offset nothing ever corrects.
// renderFrame: optional scene-supplied "draw one full frame now" — composer scenes
// pass the same function their animation loop uses (beauty target, prepasses, the
// composer chain), so a captured shot carries the grade, AO, lens and letterbox the
// reviewer was actually looking at. Without it the capture falls back to a raw
// renderer.render, which is honest geometry but none of the look.
// pick: false — the panel loads but NOTHING in the scene is selectable, so no
// gizmos, no drags and no edits. Presentation mode (?ui=0) needs this: it hides
// the panel with CSS but still needs the module, because flyTo() is what the
// warehouse tellies travel with. Hiding the UI alone left a visitor able to pick
// and drag props they could not see they had moved.
export function initFeedback({ scene, camera, renderer, controls, pickRoot = null, loop = 'scene',
                               renderFrame = null, pick = true, flyer: injectedFlyer = null }) {
  // Captured FIRST, before anything in here can move the camera: the scene has just
  // finished pointing it down the glTF camera's own forward axis, so this is the shot
  // as it was framed in Blender. A deep link (?cam=) is applied later in this function,
  // and must not be mistaken for home — otherwise "reset" returns you to whichever view
  // someone happened to send you.
  const home = {
    position: camera.position.clone(),
    target: controls ? controls.target.clone() : new THREE.Vector3(),
  };

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.id = 'fbk';
  el.innerHTML = `
    <header><span>feedback</span><span id="fbk-count">0 sent</span></header>
    <div class="body">
      <div class="pick" id="fbk-pick"><span class="none">Click anything in the scene to start</span></div>
      <div class="tools">
        <button id="fbk-none" aria-pressed="true" title="Look around and click things, but nothing can be moved by accident">
          <span class="ico">👁</span>Preview Mode</button>
        <button id="fbk-move" aria-pressed="false" title="Drag the arrows to slide it, or the rings to turn it">
          <span class="ico">✋</span>Select Mode</button>
      </div>
      <div class="row views">
        <button id="fbk-home" title="Fly back to the shot as it was framed in Blender">
          <span class="ico">🎥</span>Reset View</button>
        <button id="fbk-clear" title="Unpick everything. Nothing you moved is undone and your note is left alone.">
          <span class="ico">🚫</span>Clear Selection</button>
      </div>
      <div class="moved" id="fbk-moved" hidden></div>
      <textarea id="fbk-note" placeholder="What should change? Plain English is perfect."></textarea>
      <div class="target" id="fbk-target" hidden></div>
      <div class="row">
        <button id="fbk-send" class="primary" disabled title="Ctrl+Enter also sends">
          <span class="ico">📨</span><span id="fbk-send-label">Send Note</span></button>
      </div>
      <div class="row">
        <button id="fbk-shot" class="wide" title="Copy the picture so you can paste it straight into a message or doc">
          <span class="ico">📸</span><span id="fbk-shot-label">Screenshot</span></button>
        <button id="fbk-save" title="Save the picture to your computer instead">
          <span class="ico">💾</span>Save</button>
      </div>
      <div class="msg" id="fbk-msg"></div>
      <div class="hint" id="fbk-hint">Shift-click to pick more than one thing · Esc to unpick</div>
    </div>`;
  document.body.appendChild(el);

  const $pick  = el.querySelector('#fbk-pick');
  const $note  = el.querySelector('#fbk-note');
  const $send  = el.querySelector('#fbk-send');
  const $clear = el.querySelector('#fbk-clear');
  const $msg   = el.querySelector('#fbk-msg');
  const $count = el.querySelector('#fbk-count');
  const $shot  = el.querySelector('#fbk-shot');
  const $save  = el.querySelector('#fbk-save');
  const $hint  = el.querySelector('#fbk-hint');
  const $moved = el.querySelector('#fbk-moved');
  const $target = el.querySelector('#fbk-target');
  const $tools = {
    none: el.querySelector('#fbk-none'),      // preview
    select: el.querySelector('#fbk-move'),    // move AND rotate — one gizmo, both handles
  };

  // The dev server can write into the repo. The deployed static site cannot, so
  // the same panel falls back to putting a formatted note on the clipboard for
  // the reviewer to paste wherever they like.
  let hasApi = false;
  fetch('/api/feedback', { method: 'GET' })
    .then(r => { hasApi = r.ok; })
    .catch(() => { hasApi = false; })
    .finally(() => {
      // On the deployed site there is no server to write to, so the note goes to the
      // clipboard instead. Say which one it is rather than leaving them to find out.
      el.querySelector('#fbk-send-label').textContent = hasApi ? 'Send Note' : 'Copy Note';
      $send.title = hasApi
        ? 'Send this note to the team'
        : 'Copy the note and a link back to this exact view, ready to paste anywhere';
      $hint.textContent = hasApi
        ? 'Shift-click to pick more than one thing · Esc to unpick'
        : 'Your note is copied for pasting — nothing is sent automatically';
    });

  // ---- view -------------------------------------------------------------------
  //
  // Flying back rather than cutting: a hard jump leaves you re-orienting for a second,
  // and the trip itself shows how far off you had wandered.

  const $home = el.querySelector('#fbk-home');

  // ★ The tween lives in tools/flyto.js now, and the SCENE may own the instance.
  //   The warehouse tellies travel with it, so binding it to this dev-only module is
  //   what forced the reviewer panel into the app payload (PLT-002). `flyer` is passed
  //   in by a scene that already has one; the fallback keeps every other loop working.
  const flyer = injectedFlyer || createFlyTo({ camera, controls, onLand: () => refreshHome() });
  const { flyTo } = flyer;

  const atHome = () => !!controls &&
    camera.position.distanceTo(home.position) < 1e-3 &&
    controls.target.distanceTo(home.target) < 1e-3;

  /** Grey the button out when it would do nothing — it also teaches what "home" is. */
  function refreshHome() {
    if ($home) $home.disabled = atHome();
  }

  $home?.addEventListener('click', () => flyTo(home.position, home.target));
  controls?.addEventListener('change', refreshHome);

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let picked = null;          // { object, material, point }
  let sent = 0;

  // Outline every selected object so there's no doubt what the note is attached to.
  // A pool rather than one helper, because the selection can hold several objects.
  const boxes = [];
  function boxFor(i) {
    if (!boxes[i]) {
      const b = new THREE.BoxHelper(new THREE.Object3D(), 0x7fd18a);
      b.material.depthTest = false;
      b.renderOrder = 999;
      b.userData.noPick = true;
      b.visible = false;
      boxes[i] = b;
      scene.add(b);
    }
    return boxes[i];
  }
  /** Redraw the outlines to match the current selection. */
  function drawBoxes() {
    selection.forEach((o, i) => {
      const b = boxFor(i);
      b.setFromObject(o);
      b.visible = true;
    });
    for (let i = selection.length; i < boxes.length; i++) boxes[i].visible = false;
  }
  const boxesVisible = (v) => boxes.forEach(b => { if (b) b.visible = v && selection.length > 0; });

  // ---- move / rotate -------------------------------------------------------
  //
  // A note that says "this barrel is 30cm too far left" is still a guess the next
  // person has to interpret. Dragging the barrel and shipping the exact offset is
  // not. The scene is never saved — the numbers ride along with the note and get
  // applied in Blender, so this stays a commenting tool, not an editor.
  //
  // Two things here are load bearing:
  //
  //  · The handles hang off a PIVOT PROXY at the centre of the selection, not off
  //    the objects. glTF nodes keep whatever origin the artist left them, which for
  //    props is routinely nowhere near the mesh — handles on the origin would float
  //    off in space and rotation would swing the object around instead of turning it
  //    in place.
  //  · The selection is BOUND to that proxy once, by storing each object's pose
  //    relative to it. Every later frame is just `pivotWorld * offset`. Nothing is
  //    re-measured per drag, which is what stops the handles creeping off the object
  //    a little further with every rotation (the box of a rotated shape is not
  //    centred on the point it was rotated about). It also makes N objects free:
  //    one pivot, N stored offsets, and the whole group moves rigidly together.

  // `tool` is what is live right now; `preferred` is what a fresh pick arms. Picking an
  // object and getting no handles reads as "the gizmo is broken", so the default is to
  // arm them — "look" is a deliberate opt-out for when you only want to comment.
  let tool = 'none';                 // 'none' (preview) | 'select' (move + rotate)
  let preferred = 'select';
  let lookOnly = false;              // set only when the user explicitly picks "look"
  let selection = [];                // every Object3D under the handles
  let primary = null;                // the last one clicked — what the note names
  // obj -> the pose it had the first time it was touched. Kept for the whole session so
  // a reviewer can move six props, wander back to the first one, and still see its offset.
  const origins = new Map();
  let dragFrom = null;               // poses captured when a drag starts, for the undo stack
  const bound = new Map();           // obj -> its matrix relative to the pivot

  const pivot = new THREE.Object3D();
  pivot.name = 'fbk-pivot';
  pivot.userData.noPick = true;
  scene.add(pivot);

  // TransformControls has ONE mode at a time — translate or rotate, never both. So the
  // combined gizmo is two of them sharing the pivot: arrows to slide, rings to turn, all
  // live at once. The rings are drawn slightly larger so they sit outside the arrowheads
  // rather than tangling with them.
  //
  // The hazard is both starting a drag on the same click where their pickers overlap,
  // which would apply the delta twice. Whichever gets the pointer first disables the
  // other for the duration (see dragging-changed below), and a TransformControls with
  // enabled=false ignores pointerdown outright.
  function makeGizmo(mode, size) {
    const g = new TransformControls(camera, renderer.domElement);
    g.setMode(mode);
    g.setSpace('local');             // props read as "turn it a bit", not world axes
    g.size = size;
    const helper = g.getHelper();
    helper.visible = false;
    helper.traverse((o) => { o.userData.noPick = true; });
    scene.add(helper);
    return { g, helper };
  }

  /**
   * Strip the two rotate handles that are not axis rings, leaving red/green/blue only:
   *
   *  · XYZE — free rotate. Its picker is a solid SPHERE, so it claims the middle of the
   *    gizmo as a disc rather than a band, the one shape that cannot share space with the
   *    translate arrows.
   *  · E — the faint yellow screen-space ring on the outside. Pure clutter around a
   *    manipulator this small, and the axis rings already cover what people reach for.
   *
   * Twinmotion's manipulator has neither.
   */
  const EXTRA_ROTATE_HANDLES = new Set(['XYZE', 'E']);

  function trimRotateHandles(g) {
    const tcg = g.getHelper().children.find(c => c.type === 'TransformControlsGizmo');
    for (const group of [tcg.gizmo.rotate, tcg.picker.rotate, tcg.helper.rotate]) {
      for (const o of group.children.filter(c => EXTRA_ROTATE_HANDLES.has(c.name))) {
        o.geometry?.dispose();
        group.remove(o);
      }
    }
  }

  // Half the size it was, and the whole manipulator with it. The rings HAVE to stay
  // outside the arrows: seen at an angle a rotate ring projects across everything inside
  // it, so an inner ring and an outer arrow cannot each own a clean band. Shrinking both
  // together keeps the arrows-inside / rings-outside split that makes them separable.
  //
  // ORDER MATTERS: whichever is constructed first registers its pointer listeners first
  // and wins where both are hoverable. Translate first, so the arrows win their overlap.
  const move = makeGizmo('translate', 0.4);
  const turn = makeGizmo('rotate', 0.45);
  trimRotateHandles(turn.g);
  const gizmos = [move.g, turn.g];
  const helpers = [move.helper, turn.helper];

  // Kept for the dev hook and the older call sites that only ever needed "a" gizmo.
  const gizmo = move.g;
  const gizmoHelper = move.helper;

  const anyDragging = () => gizmos.some(g => g.dragging);
  const setHelpersVisible = (v) => helpers.forEach(h => { h.visible = v; });

  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();

  /**
   * Park the pivot at the centre of the selection and record where every member sits
   * relative to it. Called when the selection changes or when something moves the
   * objects behind our back (undo, revert) — never after an ordinary drag, since the
   * pivot and its members have already moved together.
   */
  function bindSelection() {
    bound.clear();
    if (!selection.length) return;
    const union = new THREE.Box3();
    for (const o of selection) {
      o.updateWorldMatrix(true, false);
      union.union(new THREE.Box3().setFromObject(o));
    }
    const centre = union.isEmpty()
      ? selection[0].getWorldPosition(new THREE.Vector3())
      : union.getCenter(new THREE.Vector3());
    // Orient to the primary object so "local" handles line up with the thing you clicked.
    (primary ?? selection[0]).matrixWorld.decompose(new THREE.Vector3(), _q, _s);
    pivot.position.copy(centre);
    pivot.quaternion.copy(_q);
    pivot.scale.set(1, 1, 1);
    pivot.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(pivot.matrixWorld).invert();
    for (const o of selection) {
      bound.set(o, new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    }
  }

  // three is Y-up, Blender is Z-up: (x, y, z) -> (x, -z, y). That is a proper
  // rotation of the frame, so the same remap works on a vector, on a quaternion's
  // vector part, and therefore on a rotation delta.
  const vecToBlender = (v) => [+v.x.toFixed(3), +(-v.z).toFixed(3), +v.y.toFixed(3)];

  /**
   * The edit to `obj` so far, in Blender terms. null when it is back where it started.
   * Measured against the pose it had the FIRST time it was touched this session, so it
   * survives picking something else and coming back.
   */
  function offset(obj = primary) {
    const start = obj && origins.get(obj);
    if (!obj || !start) return null;
    const dp = new THREE.Vector3().subVectors(obj.position, start.position);
    const dq = new THREE.Quaternion().copy(start.quaternion).invert().premultiply(obj.quaternion);
    const moved = dp.lengthSq() > 1e-10 || Math.abs(dq.w) < 0.9999995;
    if (!moved) return null;
    const dqB = new THREE.Quaternion(dq.x, -dq.z, dq.y, dq.w);
    const e = new THREE.Euler().setFromQuaternion(dqB, 'XYZ');
    const deg = (r) => +THREE.MathUtils.radToDeg(r).toFixed(2);
    return {
      move_blender: vecToBlender(dp),
      rotate_blender_deg: [deg(e.x), deg(e.y), deg(e.z)],
    };
  }

  /** Every object still sitting somewhere other than where it started. */
  function allEdits() {
    const out = [];
    for (const obj of origins.keys()) {
      const o = offset(obj);
      if (o) out.push({ object: nameOf(obj), ...o });
    }
    return out;
  }

  // ---- undo -----------------------------------------------------------------
  //
  // One entry per completed drag: where the object was, and where it ended up.
  // Undo walks back through every object, not just the selected one, because set
  // dressing is a sequence of small moves across several props.

  const undoStack = [];              // each entry: [{ obj, from, to }, …] — one drag
  const redoStack = [];
  const UNDO_LIMIT = 100;
  const pose = (o) => ({ position: o.position.clone(), quaternion: o.quaternion.clone() });
  const samePose = (a, b) => a.position.equals(b.position) && a.quaternion.equals(b.quaternion);

  function applyPose(obj, p) {
    obj.position.copy(p.position);
    obj.quaternion.copy(p.quaternion);
    obj.updateMatrixWorld(true);
  }

  /** Something moved the objects behind the handles' back — re-bind and redraw. */
  function afterExternalChange() {
    bindSelection();
    drawBoxes();
    showOffset();
    save();
  }

  function pushEdit(items) {
    const real = (items || []).filter(i => !samePose(i.from, i.to));
    if (!real.length) return;
    undoStack.push(real);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;              // a new edit forks the timeline
    showOffset();
    save();
  }

  function undo() {
    const e = undoStack.pop();
    if (!e) return false;
    for (const i of e) applyPose(i.obj, i.from);
    redoStack.push(e);
    afterExternalChange();
    return true;
  }

  function redo() {
    const e = redoStack.pop();
    if (!e) return false;
    for (const i of e) applyPose(i.obj, i.to);
    undoStack.push(e);
    afterExternalChange();
    return true;
  }

  // ---- surviving a refresh ---------------------------------------------------
  //
  // Ten minutes of set dressing must not die to an accidental F5. Only the edits are
  // stored — never the scene — so the .glb stays the source of truth and a reviewer
  // with no stored edits sees exactly what was exported.
  //
  // Objects are keyed by their path of child indices from the pick root, with the name
  // kept as a check. A path survives a reload of the same .glb exactly; the name alone
  // would not, because glTF names are not guaranteed unique.

  const STORE_KEY = `fbk-edits:${loop}`;
  let restoring = false;

  // Objects whose transform the scene owns, marked by the scene with
  // `userData.noMove` — the same opt-out idiom as `userData.noPick` above, one step
  // weaker: pickable and commentable, just not draggable.
  //
  // The flag is checked on an object AND its ancestors, because what gets picked is
  // the mesh INSIDE the driven node, not the node itself. The cat is a SkinnedMesh
  // inside a Group whose matrix the steering writes every frame; dragging the mesh
  // offsets it within that group, so the steering carries on driving the group while
  // the cat renders somewhere else entirely. It survives a reload too, since the edit
  // is stored by node path and replayed on load, and nothing in the sim ever puts it
  // back — the only clue is a cat that is quietly in the wrong place forever.
  function locked(obj) {
    for (let n = obj; n; n = n.parent) if (n.userData?.noMove) return true;
    return false;
  }

  function pathOf(obj) {
    const root = pickRoot || scene;
    const path = [];
    for (let n = obj; n && n !== root; n = n.parent) {
      if (!n.parent) return null;                        // not under the root at all
      path.unshift(n.parent.children.indexOf(n));
    }
    return path;
  }

  function objAtPath(path) {
    let n = pickRoot || scene;
    for (const i of path) {
      if (!n.children || !n.children[i]) return null;
      n = n.children[i];
    }
    return n;
  }

  const poseArr = (p) => [
    +p.position.x.toFixed(6), +p.position.y.toFixed(6), +p.position.z.toFixed(6),
    +p.quaternion.x.toFixed(6), +p.quaternion.y.toFixed(6), +p.quaternion.z.toFixed(6), +p.quaternion.w.toFixed(6),
  ];
  const arrPose = (a) => ({
    position: new THREE.Vector3(a[0], a[1], a[2]),
    quaternion: new THREE.Quaternion(a[3], a[4], a[5], a[6]),
  });

  function save() {
    if (restoring) return;
    try {
      const items = [];
      for (const [obj, start] of origins) {
        if (locked(obj)) continue;                       // scene-driven — its pose is not ours to keep
        if (!offset(obj)) continue;                      // back where it started — nothing to keep
        const path = pathOf(obj);
        if (!path) continue;
        items.push({ path, name: nameOf(obj), start: poseArr(start), now: poseArr(pose(obj)) });
      }
      if (!items.length) localStorage.removeItem(STORE_KEY);
      else localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, at: Date.now(), items }));
    } catch { /* private mode, quota — never break the panel over storage */ }
  }

  /** @returns {number} how many edits came back. */
  function restore() {
    let n = 0, dropped = 0;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return 0;
      const data = JSON.parse(raw);
      if (!data || data.v !== 1 || !Array.isArray(data.items)) return 0;
      restoring = true;
      for (const it of data.items) {
        const obj = objAtPath(it.path);
        // The name check is the guard against a re-exported .glb whose node order moved:
        // rather than silently dragging the wrong prop, that edit is dropped.
        if (!obj || nameOf(obj) !== it.name) continue;
        // Also drop anything the scene now drives. This is what heals a session that
        // stored one of these before the object was locked — leave it in and the stale
        // offset comes back on every single load with nothing to correct it.
        if (locked(obj)) { dropped++; continue; }
        origins.set(obj, arrPose(it.start));
        applyPose(obj, arrPose(it.now));
        n++;
      }
      // Prune what we refused, so a stale locked edit is gone for good instead of
      // being skipped on every load forever.
      if (dropped) {
        const keep = data.items.filter((it) => {
          const o = objAtPath(it.path);
          return o && nameOf(o) === it.name && !locked(o);
        });
        if (keep.length) localStorage.setItem(STORE_KEY, JSON.stringify({ ...data, items: keep }));
        else localStorage.removeItem(STORE_KEY);
      }
    } catch { /* corrupt entry — start clean rather than fail to boot */ }
    restoring = false;
    if (n) { try { localStorage.setItem(STORE_KEY, localStorage.getItem(STORE_KEY)); } catch { /* noop */ } }
    return n;
  }

  let restoredCount = 0;

  /**
   * The capture button does two different jobs, so it says which one is live: a plain
   * screenshot until something has been moved, a before/after once there is a change
   * worth showing. Answers "what will this button give me?" without a tooltip.
   */
  function refreshShotLabel() {
    const suggesting = allEdits().length > 0;
    const lbl = el.querySelector('#fbk-shot-label');
    if (lbl) lbl.textContent = suggesting ? 'Capture Suggestion' : 'Screenshot';
    $shot.title = suggesting
      ? 'Copy a before-and-after picture, ready to paste into a message or doc'
      : 'Copy a picture of this view, ready to paste into a message or doc';
    if ($save) {
      $save.title = suggesting
        ? 'Save the before-and-after picture to your computer'
        : 'Save a picture of this view to your computer';
    }
  }

  function showOffset() {
    refreshShotLabel();
    const o = offset();
    const others = allEdits().filter(e => !primary || e.object !== nameOf(primary)).length;
    $moved.hidden = !o && !others && !undoStack.length;
    if ($moved.hidden) return;
    const parts = [];
    if (o) {
      const [mx, my, mz] = o.move_blender;
      const [rx, ry, rz] = o.rotate_blender_deg;
      if (mx || my || mz) parts.push(`<b>move</b> ${mx}, ${my}, ${mz} m`);
      if (rx || ry || rz) parts.push(`<b>rotate</b> ${rx}, ${ry}, ${rz}°`);
    }
    if (others) parts.push(`<b>${others}</b> other object${others === 1 ? '' : 's'} moved`);
    if (restoredCount) parts.push(`restored <b>${restoredCount}</b> from your last visit`);
    if (!parts.length) parts.push('nothing moved');
    const bits = [];
    if (undoStack.length) bits.push('<span class="undo" id="fbk-undo">↩ Undo that (Ctrl+Z)</span>');
    if (redoStack.length) bits.push('<span class="undo" id="fbk-redo">↪ Redo it</span>');
    if (o) bits.push('<span class="undo" id="fbk-revert">⤺ Put this one back</span>');
    if (allEdits().length) bits.push('<span class="undo" id="fbk-revert-all">⤻ Put everything back</span>');
    $moved.innerHTML = parts.join('<br>') + bits.join('');
    el.querySelector('#fbk-undo')?.addEventListener('click', undo);
    el.querySelector('#fbk-redo')?.addEventListener('click', redo);
    el.querySelector('#fbk-revert')?.addEventListener('click', revert);
    el.querySelector('#fbk-revert-all')?.addEventListener('click', revertAll);
  }

  /** Put the selected objects back where they started — itself an undoable step. */
  function revert() {
    const items = [];
    for (const obj of selection) {
      const start = origins.get(obj);
      if (!start || !offset(obj)) continue;
      const from = pose(obj);
      applyPose(obj, start);
      items.push({ obj, from, to: pose(obj) });
    }
    pushEdit(items);
    afterExternalChange();
  }

  function revertAll() {
    const items = [];
    for (const [obj, start] of origins) {
      if (!offset(obj)) continue;
      const from = pose(obj);
      applyPose(obj, start);
      items.push({ obj, from, to: pose(obj) });
    }
    pushEdit(items);
    afterExternalChange();
  }

  function setTool(next, remember = true) {
    if (remember) {
      lookOnly = next === 'none';
      if (next !== 'none') preferred = next;
    }
    tool = selection.length ? next : 'none';
    // Something in the selection is driven by the scene rather than authored — a
    // simulated character, anything on a path. Its transform is an OUTPUT, so a
    // dragged pose is not a suggestion, it is a value that gets overwritten on the
    // next frame or, worse, persists as a permanent offset the sim never corrects.
    // Still fully selectable: writing a note about him is the point of the panel.
    if (selection.some(locked)) tool = 'none';
    // With nothing picked, show what the NEXT pick will arm rather than a flat "preview" —
    // otherwise the panel claims a mode the user did not choose.
    const shown = selection.length ? tool : (lookOnly ? 'none' : preferred);
    for (const k of Object.keys($tools)) $tools[k].setAttribute('aria-pressed', String(k === shown));
    if (tool === 'none') {
      gizmos.forEach(g => g.detach());
      setHelpersVisible(false);
      return;
    }
    gizmos.forEach(g => { g.enabled = true; g.attach(pivot); });
    setHelpersVisible(true);
  }

  // The pivot is the only thing the handles move. Every member follows it rigidly
  // through the offset recorded at bind time, so each object keeps its own origin,
  // its parent and its scale — and the group holds its shape.
  const onPivotMoved = () => {
    if (!selection.length) return;
    pivot.updateMatrixWorld(true);
    for (const o of selection) {
      const rel = bound.get(o);
      if (!rel) continue;
      const world = new THREE.Matrix4().multiplyMatrices(pivot.matrixWorld, rel);
      if (o.parent) {
        o.parent.updateWorldMatrix(true, false);
        world.premultiply(_m.copy(o.parent.matrixWorld).invert());
      }
      world.decompose(o.position, o.quaternion, o.scale);
      o.updateMatrixWorld(true);
    }
    drawBoxes();
    showOffset();
  };

  for (const g of gizmos) {
    g.addEventListener('objectChange', onPivotMoved);

    // OrbitControls here is bound to the left button, so it WILL fight the handles
    // unless it is switched off for the duration of the drag. The sibling gizmo is
    // switched off for the same reason: its pickers overlap this one's near the centre,
    // and two of them dragging the same pivot would double every delta.
    g.addEventListener('dragging-changed', (e) => {
      if (controls) controls.enabled = !e.value;
      for (const other of gizmos) if (other !== g) other.enabled = !e.value;
      if (e.value) {
        dragFrom = selection.map(o => ({ obj: o, from: pose(o) }));
      } else {
        // One undo step per completed drag, covering every object it moved.
        if (dragFrom) pushEdit(dragFrom.map(d => ({ obj: d.obj, from: d.from, to: pose(d.obj) })));
        dragFrom = null;
        save();
      }
    });
  }

  function label() {
    refreshTarget();          // the note's destination changes with the selection
    if (!picked) {
      $pick.innerHTML = '<span class="none">Click anything in the scene to start</span>';
      $send.disabled = !$note.value.trim();
      return;
    }
    const p = picked.point;
    const extra = selection.length - 1;
    $pick.innerHTML =
      `<div class="nm">${picked.object}${extra > 0 ? ` <span class="mt">+ ${extra} more</span>` : ''}</div>` +
      (extra > 0
        ? `<div class="mt">${selection.filter(o => o !== primary).map(nameOf).join(', ')}</div>`
        : `<div class="mt">${picked.material ?? '—'}</div>`) +
      `<div class="xyz">blender xyz  ${p.bx.toFixed(2)}, ${p.by.toFixed(2)}, ${p.bz.toFixed(2)}</div>`;
    $send.disabled = false;
  }

  // three is Y-up, Blender is Z-up. Report BLENDER coordinates, because the
  // whole point is that the note is actionable in Blender without conversion.
  const toBlender = (v) => ({ bx: v.x, by: -v.z, bz: v.y });

  // glTF hangs the Blender object name on the NODE, and the Mesh under it is
  // often unnamed. Climb until we find a real name, otherwise the note says
  // "(unnamed mesh)" and is useless — which is the whole thing we're fixing.
  function nameOf(o) {
    let n = o;
    while (n) {
      if (n.name && !/^(Scene|Group|Object)_?\d*$/i.test(n.name)) return n.name;
      n = n.parent;
    }
    return o.name || '(unnamed mesh)';
  }

  function pickAt(clientX, clientY, add = false) {
    if (!pick) return;                 // presentation mode — see the `pick` option
    const r = renderer.domElement.getBoundingClientRect();
    ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);
    const roots = pickRoot ? [pickRoot] : scene.children;
    const hits = ray.intersectObjects(roots, true)
      .filter(h => h.object.isMesh && h.object.visible && !h.object.userData?.noPick);
    // Shift-clicking past the model keeps the selection: losing six picked props to one
    // stray click would be worse than requiring Esc to clear.
    if (!hits.length) { if (!add) deselect(); return; }
    const h = hits[0];
    const mat = Array.isArray(h.object.material) ? h.object.material[0] : h.object.material;
    picked = {
      object: nameOf(h.object),
      material: mat?.name || null,
      point: { ...toBlender(h.point), x: h.point.x, y: h.point.y, z: h.point.z },
    };
    // Move the node that carries the Blender name, not the bare mesh under it —
    // that is the object the note is about and the one Blender will be told about.
    adopt(namedNode(h.object), add);
    label();
  }

  /** Climb to the node whose name nameOf() reported, so edits match the note. */
  function namedNode(o) {
    let n = o;
    while (n) {
      if (n.name && !/^(Scene|Group|Object)_?\d*$/i.test(n.name)) return n;
      n = n.parent;
    }
    return o;
  }

  /**
   * @param {THREE.Object3D} obj
   * @param {boolean} add  shift-click: add to the selection, or drop it if already in.
   */
  function adopt(obj, add = false) {
    // Edits SURVIVE a re-pick: dressing a set means moving several things in turn, and
    // silently snapping the last one back would throw away work. Everything moved is
    // reported on the note, and undo reaches across objects.
    if (add) {
      const at = selection.indexOf(obj);
      if (at >= 0) {
        selection.splice(at, 1);
        if (primary === obj) primary = selection[selection.length - 1] ?? null;
      } else {
        selection.push(obj);
        primary = obj;
      }
    } else {
      selection = [obj];
      primary = obj;
    }
    if (!selection.length) { deselect(); return; }
    for (const o of selection) if (!origins.has(o)) origins.set(o, pose(o));
    bindSelection();
    drawBoxes();
    setTool(lookOnly ? 'none' : preferred, false);   // a pick arms the handles
    showOffset();
  }

  function deselect() {
    // Deselecting is not undoing — anything moved stays moved and stays on the note.
    picked = null;
    selection = [];
    primary = null;
    bound.clear();
    drawBoxes();
    setTool('none', false);          // dropping a selection is not a mode choice
    // Not force-hidden: things moved earlier are still moved, and the row should say so.
    showOffset();
    label();
  }

  // Distinguish a click from an orbit drag, otherwise every camera move
  // re-selects whatever happens to be under the cursor.
  // Left button only: the right button is the fly camera's, and a tap of it that
  // happens not to move would otherwise re-pick whatever is under the cursor.
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) { down = null; return; }
    down = { x: e.clientX, y: e.clientY };
  });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 4) return;
    // Releasing a handle is a click by this measure — it must not re-pick whatever
    // is behind the gizmo, or the edit is dropped the moment it is finished.
    if (anyDragging()) return;
    // Shift-click adds to the selection (and clicking a selected object again drops it).
    // Clearing moved to Esc and the clear button, which were always there.
    pickAt(e.clientX, e.clientY, e.shiftKey);
  });

  /**
   * Typed text outlives a selection change, so it can quietly end up filed against
   * whatever was clicked last. Rather than wiping what someone typed — which is worse
   * than the problem — the note says out loud where it is going, and offers to bin it.
   */
  function refreshTarget() {
    const text = $note.value.trim();
    $target.hidden = !text;
    if (!text) return;
    $target.innerHTML = picked
      ? `Goes to <b>${picked.object}</b>${selection.length > 1 ? ` +${selection.length - 1}` : ''}` +
        '<span class="wipe" id="fbk-wipe">clear the text</span>'
      : 'Goes to <b>the scene</b> — nothing is picked<span class="wipe" id="fbk-wipe">clear the text</span>';
    el.querySelector('#fbk-wipe')?.addEventListener('click', () => {
      $note.value = '';
      refreshTarget();
      label();
    });
  }

  $note.addEventListener('input', () => {
    $send.disabled = !picked && !$note.value.trim();
    refreshTarget();
  });
  // Ctrl/Cmd+Enter from inside the box sends, so a note can be written and sent
  // without the hand leaving the keyboard.
  $note.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !$send.disabled) {
      e.preventDefault();
      $send.click();
    }
  });
  // Selection only. The note is deliberately left alone — see refreshTarget().
  $clear.addEventListener('click', () => { deselect(); $msg.textContent = ''; });
  addEventListener('keydown', (e) => {
    // Inside the note field, ctrl-z belongs to the text box, not to the scene.
    if (e.target.tagName === 'TEXTAREA') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      if (e.shiftKey ? redo() : undo()) e.preventDefault();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) { if (redo()) e.preventDefault(); return; }
    if (mod || e.altKey) return;
    if (e.key === 'Escape') deselect();
    if (e.key === 'Home') { flyTo(home.position, home.target); e.preventDefault(); }
    if (!pick) return;                 // presentation mode — see the `pick` option
    // Unreal's keys — this team lives in UE, and nothing here uses W/E otherwise.
    if (e.key === 'w' || e.key === 'W') setTool('select');
    if (e.key === 'q' || e.key === 'Q') setTool('none');
  });

  for (const [mode, btn] of Object.entries($tools)) {
    btn.addEventListener('click', () => setTool(mode === 'none' ? 'none' : mode));
  }

  /**
   * Render the scene alone — no panel, no handles.
   *
   * The selection outline STAYS IN by default: a note six weeks old is only useful if
   * you can see which object it was about, and the green box is the whole answer to
   * "which wall?". The handles still go, because they are thick, they occlude the
   * thing being discussed, and they say nothing once the drag is over.
   */
  function capture({ outline = true } = {}) {
    el.style.visibility = 'hidden';
    const gizmoWas = helpers.some(h => h.visible);
    // The 3D BoxHelper stays OFF in shots now — at capture resolution its 1px
    // hairline vanished against a busy scene (a green line around a green TV
    // screen was the reported case: "the note doesn't know what I selected").
    // The shot gets a thick 2D outline drawn on top instead, below.
    boxesVisible(false);
    setHelpersVisible(false);
    if (renderFrame) renderFrame(); else renderer.render(scene, camera);

    const src = renderer.domElement;
    const c2 = document.createElement('canvas');
    c2.width = src.width; c2.height = src.height;
    const g = c2.getContext('2d');
    g.drawImage(src, 0, 0);

    if (outline && selection.length) {
      const lw = Math.max(3, Math.round(c2.width / 500));
      g.lineWidth = lw;
      g.strokeStyle = '#7fd18a';
      g.font = `${Math.max(14, Math.round(c2.width / 90))}px ui-monospace, monospace`;
      const v = new THREE.Vector3();
      for (const o of selection) {
        const box = new THREE.Box3().setFromObject(o);
        if (box.isEmpty()) continue;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = true;
        for (let i = 0; i < 8; i++) {
          v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y,
                i & 4 ? box.max.z : box.min.z).project(camera);
          if (v.z < 1) behind = false;
          const sx = (v.x * 0.5 + 0.5) * c2.width, sy = (-v.y * 0.5 + 0.5) * c2.height;
          x0 = Math.min(x0, sx); y0 = Math.min(y0, sy);
          x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
        }
        if (behind) continue;
        x0 = Math.max(x0, lw); y0 = Math.max(y0, lw);
        x1 = Math.min(x1, c2.width - lw); y1 = Math.min(y1, c2.height - lw);
        g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = lw * 2;
        g.strokeRect(x0, y0, x1 - x0, y1 - y0);
        const label = o.name || '(unnamed mesh)';
        const ty = y0 > 30 ? y0 - lw * 2 : y1 + lw * 5;
        g.fillStyle = '#7fd18a';
        g.fillText(label, x0, ty);
        g.shadowBlur = 0;
      }
    }
    const data = c2.toDataURL('image/jpeg', 0.82);
    boxesVisible(true);
    setHelpersVisible(gizmoWas);
    el.style.visibility = 'visible';
    return data;
  }

  // ---- capturing a suggestion ------------------------------------------------
  //
  // A moved prop with no reference is just a picture of the scene — the reader cannot
  // see what changed. When something has been dragged, the shot is taken twice, once
  // with everything back at its original pose, and the two are laid side by side. That
  // picture IS the suggestion, which is the whole point of letting people drag at all.

  const loadImg = (src) => new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });

  /** Render the scene with every edited object temporarily back where it started. */
  function captureOriginal() {
    const held = [];
    for (const [obj, start] of origins) {
      if (!offset(obj)) continue;
      held.push([obj, pose(obj)]);
      applyPose(obj, start);           // deliberately NOT an undo step — this is a render trick
    }
    drawBoxes();                       // the outline has to follow the rewound pose too,
    const data = capture();            // otherwise "before" is boxed where the object ISN'T
    for (const [obj, p] of held) applyPose(obj, p);
    drawBoxes();
    return data;
  }

  function labelStrip(ctx, x, y, w, text) {
    ctx.font = '600 22px ui-monospace, Consolas, monospace';
    const padX = 12, padY = 7;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(10,12,16,.78)';
    ctx.fillRect(x + 14, y + 14, tw + padX * 2, 22 + padY * 2);
    ctx.fillStyle = '#dfe3ea';
    ctx.fillText(text, x + 14 + padX, y + 14 + padY + 18);
  }

  /** @returns {Promise<{blob: Blob, kind: 'before/after'|'view'}>} */
  async function suggestionImage() {
    const edited = allEdits().length;
    const after = await loadImg(capture());
    if (!edited) {
      const c = document.createElement('canvas');
      c.width = after.naturalWidth; c.height = after.naturalHeight;
      c.getContext('2d').drawImage(after, 0, 0);
      return { blob: await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85)), kind: 'view' };
    }
    const before = await loadImg(captureOriginal());
    const w = after.naturalWidth, h = after.naturalHeight, gap = 8;
    const c = document.createElement('canvas');
    c.width = w * 2 + gap;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0e1116';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(before, 0, 0);
    ctx.drawImage(after, w + gap, 0);
    labelStrip(ctx, 0, 0, w, 'BEFORE');
    labelStrip(ctx, w + gap, 0, w, 'AFTER');
    return { blob: await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85)), kind: 'before/after' };
  }

  /** A filename that says what it is and never collides with the last one. */
  function shotName(kind) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
    const what = kind === 'before/after' ? 'suggestion' : 'view';
    return `${loop}-${picked?.object ?? 'view'}-${what}-${stamp}.jpg`;
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** Run a capture, keeping both buttons disabled so a double-click cannot overlap two renders. */
  async function withCapture(fn) {
    $shot.disabled = true;
    $save.disabled = true;
    $msg.className = 'msg';
    $msg.textContent = 'Taking the picture…';
    try {
      await fn(await suggestionImage());
    } catch (err) {
      $msg.className = 'msg err';
      $msg.textContent = String(err?.message ?? err);
    }
    $shot.disabled = false;
    $save.disabled = false;
  }

  $shot.addEventListener('click', () => withCapture(async ({ blob, kind }) => {
    let copied = false;
    try {
      if (navigator.clipboard?.write && window.ClipboardItem) {
        // PNG is the only image type browsers accept on the clipboard reliably.
        const png = await new Promise(r => {
          const c = document.createElement('canvas');
          const i = new Image();
          i.onload = () => { c.width = i.naturalWidth; c.height = i.naturalHeight;
                             c.getContext('2d').drawImage(i, 0, 0); c.toBlob(r, 'image/png'); };
          i.src = URL.createObjectURL(blob);
        });
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        copied = true;
      }
    } catch { copied = false; }
    // Copy is the whole point of the button, but a browser can refuse the write —
    // falling back to a file beats telling someone their picture is gone.
    if (!copied) { downloadBlob(blob, shotName(kind)); }
    $msg.textContent = copied
      ? (kind === 'before/after'
          ? '📋 Before-and-after copied — paste it anywhere'
          : '📋 Picture copied — paste it anywhere')
      : '⬇ Copying was blocked, so it saved to your Downloads instead';
  }));

  $save.addEventListener('click', () => withCapture(async ({ blob, kind }) => {
    downloadBlob(blob, shotName(kind));
    $msg.textContent = '⬇ Saved to your Downloads folder';
  }));

  $send.addEventListener('click', async () => {
    const comment = $note.value.trim();
    if (!comment && !picked) return;
    $send.disabled = true;
    $msg.className = 'msg';
    $msg.textContent = hasApi ? 'Sending…' : 'Copying…';

    const screenshot = capture();
    const link = deepLink({ camera, controls, object: picked?.object });

    // ---- static site: clipboard, no server involved ----
    if (!hasApi) {
      const edits = allEdits();
      const lines = [
        picked ? `object:   ${picked.object}` : 'object:   (none — general note)',
        picked ? `material: ${picked.material ?? '—'}` : null,
        picked ? `blender:  ${picked.point.bx.toFixed(2)}, ${picked.point.by.toFixed(2)}, ${picked.point.bz.toFixed(2)}` : null,
        edits.length ? '' : null,
        edits.length ? `moved (blender xyz, metres / degrees):` : null,
        ...edits.map(e =>
          `  ${e.object}: move ${e.move_blender.join(', ')} · rotate ${e.rotate_blender_deg.join(', ')}`),
        '',
        comment || '(no comment)',
        '',
        `view: ${link}`,
      ].filter(Boolean).join('\n');
      try {
        await navigator.clipboard.writeText(lines);
        $msg.className = 'msg';
        $msg.textContent = '📋 Note copied — paste it anywhere';
        $note.value = '';
        refreshTarget();
      } catch {
        $msg.className = 'msg err';
        $msg.textContent = 'Your browser blocked the copy — use Screenshot instead';
      }
      $send.disabled = false;
      return;
    }

    const cam = {
      position: [+camera.position.x.toFixed(3), +camera.position.y.toFixed(3), +camera.position.z.toFixed(3)],
      fov: +camera.fov.toFixed(2),
      aspect: +camera.aspect.toFixed(4),
      target: controls ? [+controls.target.x.toFixed(3), +controls.target.y.toFixed(3), +controls.target.z.toFixed(3)] : null,
    };

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          loop,
          at: new Date().toISOString(),
          object: picked?.object ?? null,
          // Everything under the handles when the note was written, primary first.
          objects: selection.length ? [nameOf(primary), ...selection.filter(o => o !== primary).map(nameOf)] : [],
          material: picked?.material ?? null,
          point_blender: picked ? [ +picked.point.bx.toFixed(3), +picked.point.by.toFixed(3), +picked.point.bz.toFixed(3) ] : null,
          // Every object the reviewer dragged, not just the selected one — dressing a set
          // is several moves in a row. Blender-space, ready to apply to the named objects;
          // the scene itself is never saved. Empty array when nothing was moved.
          edits: allEdits(),
          comment,
          camera: cam,
          url: location.href,
          view: link,
          screenshot,
        }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || 'server refused');
      sent++;
      $count.textContent = `${sent} sent`;
      $msg.className = 'msg';
      $msg.textContent = `✅ Sent — thanks! (${j.id})`;
      $note.value = '';
      refreshTarget();
    } catch (err) {
      $msg.className = 'msg err';
      $msg.textContent = String(err.message ?? err);
    }
    $send.disabled = false;
  });

  // Bring back anything moved before the page was reloaded. Runs before the deep-link
  // preselect so a restored object is already in its edited pose when it gets selected.
  restoredCount = restore();
  if (restoredCount) {
    $msg.className = 'msg';
    $msg.textContent = `Brought back ${restoredCount} change${restoredCount === 1 ? '' : 's'} from last time`;
  }

  // if the page was opened from a deep link, re-select what was noted
  const preselect = restoreView({ scene, camera, controls });
  if (preselect) {
    const mat = Array.isArray(preselect.material) ? preselect.material[0] : preselect.material;
    const c = new THREE.Box3().setFromObject(preselect).getCenter(new THREE.Vector3());
    picked = { object: preselect.name, material: mat?.name || null,
               point: { ...toBlender(c), x: c.x, y: c.y, z: c.z } };
    adopt(namedNode(preselect));
  }
  // Nothing selected but edits restored — still show them, so a reload does not look
  // like the work vanished.
  if (!selection.length && restoredCount) showOffset();

  // The gizmo has to follow a perspective change; the scene only ever has one camera,
  // but the helper still needs the live one each frame it is visible.
  gizmos.forEach(g => { g.camera = camera; });

  // One source of truth for the button state — the markup ships a default that would
  // otherwise claim "look" when the next pick is actually going to arm move.
  if (!selection.length) setTool('none', false);

  refreshHome();   // a deep link lands you away from home, so the button starts live
  label();

  // Dev hook. The panel only exists under ?dev=1/?review=1, so this is not shipped
  // to anyone who isn't already reviewing — and it is the only way to drive the
  // handles from a script when checking them.
  const api = {
    pickAt, setTool, offset, allEdits, revert, revertAll, undo, redo, deselect,
    save, restore, capture, captureOriginal, suggestionImage,
    flyTo, home, atHome,
    get undoDepth() { return undoStack.length; },
    get redoDepth() { return redoStack.length; },
    get restoredCount() { return restoredCount; },
    scene, camera, renderer, controls, gizmo, gizmoHelper, gizmos, helpers, anyDragging, pivot,
    get picked() { return picked; },
    get selection() { return selection.slice(); },
    get pickedObj() { return primary; },
    get tool() { return tool; },
  };
  window.__fbk = api;
  return api;
}
