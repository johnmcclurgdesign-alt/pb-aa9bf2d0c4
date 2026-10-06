// The phone tier's cut list: draws that no loop-camera ray ever reaches (BUD4, 2026-09-22).
//
// ★ THIS IS A DELETION, AND IT IS ALLOWED IN EXACTLY ONE CASE. PLAN §2's standing rule is "a
//   tier hides, it does not delete". Josh suspended it on 2026-09-13 (PROGRAM decision 16) for
//   objects a loop-camera ray never reaches, on the PHONE, and nowhere else — put to him marked
//   as a rule break and taken anyway. It is not licence to thin the room.
//
// ★ WHY IT IS WORTH ANYTHING. BUD4's device walks put the phone's fixed cost on the LIT DRAWS:
//   render scale 0.2 buys nothing, 410k triangles hidden buy nothing, while the same draws unlit
//   run at 60 fps. A lit draw here binds 11-16 samplers and ~120 uniforms whatever it covers, so
//   a draw that paints nothing costs what one that paints the back wall costs. Measured on the
//   iPhone 12 Pro at rung 5 (W1c): the first 17 were worth ~3-5 ms of a ~45 ms frame.
//
// ★ HOW EACH NAME EARNED ITS PLACE — AN ID PASS, NEVER A BOUNDING BOX
//   (docs/lessons/is-it-seen-is-an-id-pass-not-a-bounding-box). Every draw in the room pose's
//   beauty pass got a flat id colour and was counted at the room pose over 12 s of drift, along
//   both flights between the two declared cameras, and at the screens pose: 24 painted 0 px
//   everywhere. Then each was hidden and the LIT frame differenced (null control 0 px, alive
//   control 47,343 px): four moved pixels — two cast a visible shadow (M_DPW_Metal:5 304 px,
//   Persian_Carpet_2 2 px), two are visible in the lit frame (the study lamp's reflector 91 px,
//   the HVAC louvres 7 px) — and two are glass, which an id pass cannot see through
//   (depthWrite false). All six stay. `Jar_Fill` is a mover on the belt and was never a
//   candidate. What is left is below.
// ⚠ AND A SEVENTH CAME OFF AT CLOSE-OUT. `Prop_Weird_Russian_Device001_10` (an orange LED, 14
//   triangles) painted 0 px in the first 78 samples and 1 px in one sample of the gate's run on
//   the merged tree — the drift is a sway, and one pose of it reaches the LED. A loop-camera ray
//   reaches it, so it is drawn. That is why the gate re-samples rather than trusting a list.
//
// ⚠ NAMES ARE THE CONTRACT, AND A RE-DRESS BREAKS THEM SILENTLY. The `Merged:<material>:<n>`
//   names come from tools/render-merge.js's buckets; add a prop on one of those materials and
//   the bucket's count changes. So applyPhoneCuts() reports every name it did NOT find, and
//   `node tools/phone-cuts-check.mjs` re-proves the whole list against the live scene — run it
//   after any change to the room.

export const PHONE_CUTS = [
  'Merged:M_DPW_MetalRust_01:2',
  'Merged:M_Conduit_Galv_Boxes:2',
  'cable_box_3way003',
  'BézierCurve048',
  'Merged:modular_factory_facade_windows_60:6',
  'Merged:modular_factory_facade_trim_01_60:6',
  'Merged:M_DPW_Rubber:2',
  'SM_DPW_Concrete_014002',
  'Merged:Chair_Office_Dark:2',
  'Cube',
  'Prop_Stapler_1',
  'Prop_Stapler_2',
  'Prop_Small_Table001_2',
  'Rug003',
  'Cube065_4',
];
// ⚠ ART2 (2026-10-06) took 'Prop_Vintage_Floor_Lamp_4' off this list WITH the lamp: it was the old
//   lamp's 38-triangle orange part inside the shade (`Material.002`). The original lamp that
//   replaced it is four draws where the old one was eight (seven on the phone, with that cut),
//   so the phone draws three fewer for the lamp, and no new name was added — an unseen part of
//   the new lamp would need the id pass above to earn a place here, and none was run.

/**
 * Hide the listed draws. Returns what it did and what it could not find, so the caller can
 * say so where a device leg will read it. Only VISIBLE meshes are touched, which is what keeps
 * a render proxy's hidden SOURCE meshes (same names, visible = false, still raycastable) out
 * of it — and the cut is by visibility, so every name, bbox and hotspot survives.
 * @param {import('three').Object3D} scene
 * @param {string[]} [names]
 */
export function applyPhoneCuts(scene, names = PHONE_CUTS) {
  const want = new Set(names), hit = new Set(), hidden = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.visible || !want.has(o.name)) return;
    // Never a mover: the id pass hid them, so it has no evidence about them.
    if (o.isSkinnedMesh || o.isInstancedMesh) return;
    o.visible = false;
    hidden.push(o);
    hit.add(o.name);
  });
  return { hidden, missing: names.filter((n) => !hit.has(n)) };
}
