// Render proxies — merge to DRAW, keep the originals to THINK with.
//
// WHY THIS SHAPE. A room built out of 385 meshes costs 385 draw calls plus a shadow draw
// for every caster, and on an A14 phone the 60 FPS knee is 24-49 draws. The obvious fix is
// to merge the room in the asset pipeline (gltf-transform join), and it is the wrong one
// here, because in this Loop a mesh is not only a thing to draw. It is:
//
//   - a Blender NAME a reviewer clicks in the feedback panel ("move that barrel left"),
//   - a BOUNDING BOX the cat's walkability grid measures the room from,
//   - a RAYCAST TARGET for the hotspot arbiter, the mouse's route probe, the drip's search
//     for pipes to fall from, and every "is this prop actually visible" audit,
//   - a row in `asset-provenance.csv`, found by its `Prop_*` node name.
//
// Merging in the glb destroys all five at once. So the merge happens HERE, at load, and
// only for rendering: the merged proxy is added to the scene, and every source mesh stays
// exactly where it was with `visible = false`.
//
// ★ AN INVISIBLE MESH IS STILL RAYCASTABLE. three's `Raycaster.intersect()` tests
//   `object.layers` and nothing else — it has no visibility check (r169, Raycaster.js) — so
//   every name, box, pick and audit above keeps working unchanged, and the picture is the
//   only thing that moves. That one fact is what makes this cheap; verify it again before
//   assuming it on a three upgrade.
//
// ★ AND AN UNRENDERED GEOMETRY IS NEVER UPLOADED. three uploads a BufferGeometry the first
//   time it draws it, so sources hidden before the first frame cost host RAM (their arrays,
//   which the raycaster needs anyway) and zero GPU memory. Merge before the first paint.
//
// WHAT IT COSTS. Frustum culling: a merged mesh is one object with one bounding sphere, so
// it is drawn whenever any part of it is on screen. In this room that is nearly free (at the
// room pose 436 draws served 385 visible meshes, i.e. almost nothing was being culled), but
// it is the thing to measure first in a bigger space.

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ★ CLONING AN INTERLEAVED ATTRIBUTE WORKS AND SHOUTS ABOUT IT. glTF ships interleaved
//   buffers, and three's `InterleavedBufferAttribute.clone()` de-interleaves them while
//   logging a line per attribute — ten identical warnings at load, in the one place a
//   device leg reads for evidence. Doing the same copy by hand is silent, and explicit
//   about what it costs.
function flatten(three, attr) {
  if (!attr.isInterleavedBufferAttribute) return attr.clone();
  const n = attr.count, size = attr.itemSize;
  const out = new Float32Array(n * size);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < size; c++) out[i * size + c] = attr.getComponent(i, c);
  }
  return new three.BufferAttribute(out, size, attr.normalized);
}

function flatGeometry(three, src) {
  const g = new three.BufferGeometry();
  for (const name of Object.keys(src.attributes)) g.setAttribute(name, flatten(three, src.attributes[name]));
  if (src.index) g.setIndex(src.index.clone());
  return g;
}

/**
 * @param {object}   o
 * @param {object}   o.three    the THREE namespace
 * @param {Object3D} o.root     the subtree to merge (this Loop passes `pickables`)
 * @param {Object3D} o.parent   where the proxies are added — NOT `root`, or the grid, the
 *                              picker and the census would all start seeing them
 * @param {function} [o.exclude] (mesh) => true to leave a mesh alone
 * @returns {{group, groups, sources, before, after, saved, bytes}}
 */
export function buildRenderProxies({ three, root, parent, exclude = () => false } = {}) {
  root.updateMatrixWorld(true);

  // The signature has to carry everything that makes two draws DIFFERENT draws, or the
  // merge silently changes behaviour: `layers` because the AO's props channel renders
  // camera layer 1 alone, cast/receiveShadow because that is per object and this row is
  // about to measure a caster list, renderOrder because it sequences transparency, and
  // the attribute set because mergeGeometries refuses a mismatch (a wall with uv1+uv2 and
  // a pipe with uv alone cannot share a buffer).
  const signature = (o) => {
    const g = o.geometry;
    const attrs = Object.keys(g.attributes).sort()
      .map((k) => `${k}:${g.attributes[k].itemSize}:${g.attributes[k].array.constructor.name}`).join(',');
    return [o.material.uuid, o.castShadow ? 1 : 0, o.receiveShadow ? 1 : 0,
            o.layers.mask, o.renderOrder, g.index ? 'i' : 'n', attrs].join('|');
  };

  const buckets = new Map();
  let candidates = 0, visibleMeshes = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    visibleMeshes++;
    if (!o.visible || o.isSkinnedMesh || o.isInstancedMesh) return;
    if (Array.isArray(o.material) || !o.material || !o.geometry) return;
    if (o.geometry.morphAttributes && Object.keys(o.geometry.morphAttributes).length) return;
    // An ancestor that is hidden, or driven by the scene, takes its whole subtree with it:
    // the cat and the mouse are SkinnedMeshes inside a Group whose matrix a simulation
    // writes every frame, and baking that matrix into a buffer freezes them mid-stride.
    for (let a = o; a && a !== root; a = a.parent) {
      if (!a.visible || a.userData?.noMove || a.userData?.renderProxy) return;
    }
    if (exclude(o)) return;
    candidates++;
    const k = signature(o);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(o);
  });

  const group = new three.Group();
  group.name = 'RenderProxies';
  // It is an output, not a thing to drag, and the cat must not read it as wall.
  group.userData.noMove = true;
  group.userData.noBlock = true;
  group.userData.renderProxy = true;
  group.matrixAutoUpdate = false;

  const groups = [];
  let sources = 0, bytes = 0;
  for (const [, members] of buckets) {
    // One member is already one draw. Merging it would only cost it its frustum culling.
    if (members.length < 2) continue;
    const geos = members.map((m) => {
      const g = flatGeometry(three, m.geometry);
      g.applyMatrix4(m.matrixWorld);       // proxies live in world space, identity transform
      return g;
    });
    let merged = null;
    try { merged = mergeGeometries(geos, false); } catch (e) { merged = null; }
    geos.forEach((g) => g.dispose());
    // mergeGeometries reports a refusal by RETURNING NULL after a console.error, so a
    // try/catch alone would wave it through and hide half the room.
    if (!merged) { console.warn('render-merge: refused a bucket of', members.length, members[0].name); continue; }
    merged.computeBoundingBox();
    merged.computeBoundingSphere();

    const src = members[0];
    const proxy = new three.Mesh(merged, src.material);
    proxy.name = `Merged:${src.material.name || src.name}:${members.length}`;
    proxy.castShadow = src.castShadow;
    proxy.receiveShadow = src.receiveShadow;
    proxy.renderOrder = src.renderOrder;
    proxy.layers.mask = src.layers.mask;
    proxy.matrixAutoUpdate = false;
    proxy.userData.noMove = true;
    proxy.userData.noBlock = true;
    proxy.userData.renderProxy = true;
    proxy.userData.mergedFrom = members.map((m) => m.name);
    group.add(proxy);

    for (const m of members) { m.visible = false; m.userData.renderProxied = true; }
    sources += members.length;
    for (const k of Object.keys(merged.attributes)) bytes += merged.attributes[k].array.byteLength;
    if (merged.index) bytes += merged.index.array.byteLength;
    groups.push({ name: proxy.name, from: members.length });
  }

  parent.add(group);
  return {
    group, groups,
    meshes: visibleMeshes, candidates, sources,
    proxies: group.children.length,
    saved: sources - group.children.length,
    bytes,
  };
}

/**
 * The same trick again, for a DEPTH-ONLY pass — and it merges much harder, because a pass
 * that overrides the material does not care which material a triangle came from.
 *
 * ★ THE AO's PROPS CHANNEL COSTS ONE DRAW PER PROP FOR AN ANSWER THAT IS JUST A SHAPE.
 *   Screen-space AO has no way to know what an object is, so the scene renders camera
 *   layer 1 (the props) to its own depth buffer each frame and the composite compares it
 *   against scene depth. With the material overridden and only `position` read, every
 *   static prop in the room can be one buffer: 95 draws -> a handful.
 *
 * The proxies live on layer 1 ONLY, so they are invisible to the beauty pass, and layer 1
 * is switched OFF on the sources so nothing is drawn twice. Movers keep their own layer 1
 * (they move, so they cannot be baked), and anything with `depthWrite: false` is left
 * alone — `renderDepthOnly` hides those rather than overriding them, and a merged buffer
 * would lose that distinction.
 *
 * @returns {{group, proxies, sources, bytes}}
 */
export function buildDepthProxies({ three, root, parent, layer = 1 } = {}) {
  root.updateMatrixWorld(true);

  const isMover = (o) => {
    if (o.isSkinnedMesh || o.isInstancedMesh) return true;
    for (let a = o; a; a = a.parent) {
      if (a.userData?.renderProxy) return false;
      if (a.userData?.noMove) return true;
    }
    return false;
  };

  const sources = [];
  root.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.geometry) return;
    if (!o.layers.isEnabled(layer)) return;
    if (isMover(o)) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m || m.depthWrite === false) return;
    for (let a = o; a; a = a.parent) if (!a.visible) return;
    sources.push(o);
  });

  const group = new three.Group();
  group.name = 'DepthProxies';
  group.userData.noMove = true;
  group.userData.noBlock = true;
  group.userData.renderProxy = true;
  group.matrixAutoUpdate = false;

  // Position only: the override material reads nothing else, so stripping every other
  // attribute makes geometries that could never be merged compatible AND cuts the copy to
  // 12 bytes a vertex.
  const indexed = [], plain = [];
  for (const o of sources) {
    const src = o.geometry;
    if (!src.attributes.position) continue;
    const g = new three.BufferGeometry();
    g.setAttribute('position', flatten(three, src.attributes.position));
    if (src.index) g.setIndex(src.index.clone());
    g.applyMatrix4(o.matrixWorld);
    (src.index ? indexed : plain).push(g);
  }

  let bytes = 0;
  for (const set of [indexed, plain]) {
    if (!set.length) continue;
    let merged = null;
    try { merged = mergeGeometries(set, false); } catch (e) { merged = null; }
    set.forEach((g) => g.dispose());
    if (!merged) { console.warn('render-merge: depth proxy bucket refused'); continue; }
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    const mesh = new three.Mesh(merged, new three.MeshBasicMaterial());
    mesh.name = `DepthProxy:${set.length}`;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.layers.set(layer);            // layer 1 alone: the beauty pass never sees it
    mesh.userData.noMove = true;
    mesh.userData.noBlock = true;
    mesh.userData.renderProxy = true;
    group.add(mesh);
    bytes += merged.attributes.position.array.byteLength + (merged.index ? merged.index.array.byteLength : 0);
  }

  for (const o of sources) o.layers.disable(layer);
  parent.add(group);
  return { group, proxies: group.children.length, sources: sources.length, bytes };
}
