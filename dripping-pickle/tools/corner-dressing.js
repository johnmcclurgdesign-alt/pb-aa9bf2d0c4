// tools/corner-dressing.js — the front-right corner (ENV-009).
//
// Gate A Ring 4: "Front-left: stencilled shipping crates. Front-right: pipes,
// wall-mounted HVAC, the mouse crack."
//
// WHAT IS ACTUALLY MISSING, measured against the live scene rather than against
// the list — two of the four are already in the room and building them again
// would be dressing on top of dressing:
//   - crates: `Prop_Old_Wooden_Crate` ×3 and `Prop_Wooden_Military_Crate` are
//     already stacked in the front-left corner. What they lack is the STENCIL
//     ("RIPE INTENTIONS", per the concept art), which is a texture job in the
//     .blend, not geometry — filed rather than faked here.
//   - pipes: the right wall already carries a full vertical run (valve, tee,
//     elbows, x 1.82–1.94) from the floor to the eaves.
// So this module builds the two that genuinely do not exist: the HVAC unit and
// the mouse crack.
//
// ★ AND BOTH ARE PLACED AGAINST THE FRAME, NOT AGAINST THE FLOOR PLAN. Canon
//   puts the mouse crack in the front-right corner. Every point along the base
//   of the right wall is occluded from the loop camera — by `Prop_Desk_Right_2`,
//   `Prop_File_Cabinets`, `Prop_Small_Table001_1` — so a crack there is not
//   restrained set dressing, it is absent set dressing. It goes at the base of
//   the FRONT wall at z = 1.2, which is the nearest point to canon's corner that
//   the camera can actually see (NDC 0.24, −0.47), measured by raycasting from
//   the shipped pose and reading what the ray hits FIRST.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const box = (w, h, d, x, y, z) => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
};

export const DEFAULTS = {
  // Right wall plane is z = 2.94. The unit hangs below the horizontal pipe run
  // (`Pipe_Offset_391021`, y 2.27–2.63) with 11 cm of clearance and above the
  // file cabinets — measured, not guessed.
  hvac: { x: 0.85, y: 1.85, z: 2.94, w: 0.86, h: 0.54, d: 0.30 },
  crack: { x: 2.069, y: 0.0, z: 1.20, w: 0.075, h: 0.135 },
};

/**
 * A through-wall air handler of the right vintage: a plain enamelled box with a
 * pressed louvre face, two angle brackets into the brick, and a condensate pipe.
 * Nothing about it is clever — it is the kind of unit somebody bolted up in 1968
 * and nobody has touched since, which is the whole register.
 */
function buildHVAC(p) {
  const { x, y, z, w, h, d } = p;
  const face = z - d;                       // room-facing plane
  const body = [];
  body.push(box(w, h, d, x, y, z - d / 2));
  // a shallow rolled lip around the face, so it is not a bare cuboid
  const lip = 0.035;
  body.push(box(w + 2 * lip, lip, d * 0.25, x, y + h / 2 + lip / 2, face + d * 0.125));
  body.push(box(w + 2 * lip, lip, d * 0.25, x, y - h / 2 - lip / 2, face + d * 0.125));
  body.push(box(lip, h + 2 * lip, d * 0.25, x - w / 2 - lip / 2, y, face + d * 0.125));
  body.push(box(lip, h + 2 * lip, d * 0.25, x + w / 2 + lip / 2, y, face + d * 0.125));
  // brackets back to the wall
  for (const s of [-1, 1]) {
    body.push(box(0.05, 0.05, d + 0.04, x + s * (w / 2 - 0.08), y + h / 2 + 0.05, z - d / 2));
    body.push(box(0.05, 0.14, 0.05, x + s * (w / 2 - 0.08), y + h / 2 + 0.10, z - 0.03));
  }
  // condensate pipe, down the wall and out of sight
  body.push(box(0.035, 0.85, 0.035, x + w / 2 - 0.05, y - h / 2 - 0.42, z - 0.06));
  const shell = mergeGeometries(body, false);
  for (const g of body) g.dispose();

  // Louvres are their own material — a darker recess, so the face reads as
  // slatted rather than as a painted rectangle at the distance the camera sees
  // it from (about 6 m; the unit is ~90 px wide there).
  const slats = [];
  const n = 7, span = h * 0.72, step = span / n;
  for (let i = 0; i < n; i++) {
    const sy = y - span / 2 + step * (i + 0.5);
    const g = box(w * 0.82, step * 0.55, 0.03, x, sy, face + 0.026);
    g.rotateX(0.35);
    g.translate(0, 0, 0);
    slats.push(g);
  }
  const louvre = mergeGeometries(slats, false);
  for (const g of slats) g.dispose();
  return { shell, louvre };
}

/**
 * The mouse crack. Mouse-sized and unremarkable is the brief, so it is a hole
 * shape rather than a drawn crack: an irregular opening at the skirting with an
 * interior too dark for anything in this room to light.
 */
function buildCrack(p) {
  const { x, y, z, w, h } = p;
  // an irregular silhouette — a rectangle at this size reads as a decal
  const s = new THREE.Shape();
  s.moveTo(-w * 0.42, 0);
  s.lineTo(-w * 0.50, h * 0.35);
  s.lineTo(-w * 0.28, h * 0.62);
  s.lineTo(-w * 0.34, h * 0.88);
  s.lineTo(0.0, h);
  s.lineTo(w * 0.30, h * 0.80);
  s.lineTo(w * 0.44, h * 0.44);
  s.lineTo(w * 0.50, 0);
  s.closePath();
  const g = new THREE.ShapeGeometry(s);
  // The front wall's inward normal is −x, so the opening stands on the room side
  // of the plane by 4 mm. Any less and it z-fights the brick at this distance.
  g.rotateY(-Math.PI / 2);
  g.translate(x - 0.004, y, z);
  return g;
}

export function createCornerDressing({ scene, params = {} } = {}) {
  const p = {
    hvac: { ...DEFAULTS.hvac, ...(params.hvac || {}) },
    crack: { ...DEFAULTS.crack, ...(params.crack || {}) },
  };
  const group = new THREE.Group();
  group.name = 'CornerDressing';

  const matShell = new THREE.MeshStandardMaterial({
    name: 'HVAC_Shell', color: 0x5b6058, roughness: 0.66, metalness: 0.25,
  });
  const matLouvre = new THREE.MeshStandardMaterial({
    name: 'HVAC_Louvre', color: 0x33372f, roughness: 0.78, metalness: 0.2,
    side: THREE.DoubleSide,
  });
  // Unlit black, like the conveyor's cut-outs: a hole is defined by being darker
  // than anything the light in this room can make a surface.
  const matCrack = new THREE.MeshBasicMaterial({
    name: 'Mouse_Crack', color: 0x050403, side: THREE.DoubleSide,
  });

  const { shell, louvre } = buildHVAC(p.hvac);
  const hvac = new THREE.Mesh(shell, matShell);
  hvac.name = 'Prop_HVAC_Unit';
  hvac.castShadow = true; hvac.receiveShadow = true;
  const grille = new THREE.Mesh(louvre, matLouvre);
  grille.name = 'Prop_HVAC_Louvres';
  grille.castShadow = false; grille.receiveShadow = true;
  group.add(hvac, grille);

  const crack = new THREE.Mesh(buildCrack(p.crack), matCrack);
  crack.name = 'Mouse_Crack';
  crack.castShadow = false; crack.receiveShadow = false;
  group.add(crack);

  group.userData.noMove = false;   // static dressing — a reviewer may drag it
  scene.add(group);

  return {
    group,
    // matCrack is MeshBasic and stays out of the GI/PCSS patch, like the
    // conveyor's cut-out plates.
    materials: [matShell, matLouvre],
    params: p,
  };
}
