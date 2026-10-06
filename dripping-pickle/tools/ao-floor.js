// Give the FLOOR its own AO radius and amount, without a second GTAO pass.
//
// WHY IT IS NOT TWO PASSES. The obvious way to get two radii is to run GTAOPass twice and
// mask the results together, but a GTAOPass re-renders the scene's depth AND normals every
// frame before it does any AO work — so a second one is a second full scene pass for two
// numbers. Instead this patches the ONE pass so the radius is chosen per fragment. The AO
// shader already has the view normal in hand at exactly the point where it decides the
// radius, and it already carries `cameraWorldMatrix`, so working out "is this pixel facing
// up" costs a matrix multiply and a smoothstep.
//
// WHAT COUNTS AS FLOOR. Not an object list — the world normal's Y. Anything facing up is
// floor, anything facing sideways is wall, and the changeover is a smoothstep so a ramp or
// a chamfer crossfades instead of drawing a line across itself. That means it also catches
// table tops and the tops of crates, which is usually what you wanted anyway; if it ever is
// not, the up-range is a dial.
//
// ★ PINNED-VERSION TERRITORY. This matches three r169's GTAOShader by exact string, the
// same deal as pcss.js. It THROWS on a miss rather than carrying on, because an AO split
// that silently does nothing looks exactly like an AO split whose numbers you have not
// found the right values for yet, and you would spend the afternoon on the dials.

import * as THREE from 'three';

const MASK_GLSL = /* glsl */`
  // View normal -> world, then how far "up" it points. 1 = floor, 0 = wall.
  float aoFloorMaskOf( vec3 viewNormal, mat4 camWorld, float upMin, float upMax ) {
    vec3 wn = normalize( ( camWorld * vec4( viewNormal, 0.0 ) ).xyz );
    return smoothstep( upMin, upMax, wn.y );
  }
`;

function must(src, find, replace, what) {
  if (!src.includes(find)) {
    throw new Error(`[ao-floor] could not find ${what} in three's GTAOShader — the pinned ` +
                    `three version has moved. Looked for: ${JSON.stringify(find)}`);
  }
  return src.split(find).join(replace);
}

/**
 * @param {GTAOPass} pass
 * @param {object} [o]
 * @param {number} [o.upMin]  world normal Y where a surface starts counting as floor
 * @param {number} [o.upMax]  world normal Y where it fully counts
 * @param {number} [o.thicknessRatio] floor thickness / floor radius, same coupling as the
 *                 wall radius uses — see RT_AOTHICK in the scene. Untying these is what made
 *                 the AO evaporate as the radius went up.
 */
export function splitFloorAO(pass, { upMin = 0.5, upMax = 0.85, thicknessRatio = 1.0 } = {}) {
  const gt = pass.gtaoMaterial;
  const bl = pass.blendMaterial;

  // Start matched to the walls, so installing this changes nothing until a dial moves.
  const floorRadius    = { value: gt.uniforms.radius.value };
  const floorThickness = { value: gt.uniforms.thickness.value };
  const floorIntensity = { value: pass.blendIntensity };
  const uUpMin = { value: upMin };
  const uUpMax = { value: upMax };

  // ── the AO shader: choose radius and thickness per fragment ────────────────
  let f = gt.fragmentShader;
  f = must(f, 'uniform float radius;',
    'uniform float radius;\nuniform float uFloorRadius, uFloorThickness, uFloorUpMin, uFloorUpMax;'
    + '\n' + MASK_GLSL, 'the radius uniform');
  f = must(f, 'float radiusToUse = radius;',
    'float aoFloorMask = aoFloorMaskOf( viewNormal, cameraWorldMatrix, uFloorUpMin, uFloorUpMax );\n'
    + '\t\t\tfloat radiusToUse = mix( radius, uFloorRadius, aoFloorMask );',
    'the radius assignment');
  // thickness is read in three more places than the falloff line, and all of them have to
  // agree or the floor marches with one depth budget and rejects with another.
  f = must(f, 'float distanceFalloffToUse = thickness;',
    'float thicknessToUse = mix( thickness, uFloorThickness, aoFloorMask );\n'
    + '\t\t\tfloat distanceFalloffToUse = thicknessToUse;',
    'the thickness assignment');
  f = must(f, 'abs(viewDelta.z) < thickness', 'abs(viewDelta.z) < thicknessToUse',
    'the thickness depth tests');
  gt.fragmentShader = f;
  Object.assign(gt.uniforms, {
    uFloorRadius: floorRadius, uFloorThickness: floorThickness,
    uFloorUpMin: uUpMin, uFloorUpMax: uUpMax,
  });
  gt.needsUpdate = true;

  // ── the blend shader: choose the AMOUNT per fragment ───────────────────────
  // GTAOPass writes `intensity` from pass.blendIntensity every frame, so that stays the
  // wall control and the floor gets its own uniform alongside it.
  let b = bl.fragmentShader;
  b = must(b, 'uniform float intensity;',
    'uniform float intensity;\nuniform float uFloorIntensity, uFloorUpMin, uFloorUpMax;\n'
    + 'uniform sampler2D tFloorNormal;\nuniform mat4 uFloorCamWorld;\n' + MASK_GLSL,
    'the blend intensity uniform');
  b = must(b, 'gl_FragColor = vec4(mix(vec3(1.), texel.rgb, intensity), texel.a);',
    // unpackRGBToNormal, written out — the blend shader has no three includes to draw on.
    'vec3 vn = texture2D( tFloorNormal, vUv ).rgb * 2.0 - 1.0;\n'
    + '\t\t\tfloat m = aoFloorMaskOf( vn, uFloorCamWorld, uFloorUpMin, uFloorUpMax );\n'
    + '\t\t\tfloat amt = mix( intensity, uFloorIntensity, m );\n'
    + '\t\t\tgl_FragColor = vec4(mix(vec3(1.), texel.rgb, amt), texel.a);',
    'the blend composite');
  bl.fragmentShader = b;
  Object.assign(bl.uniforms, {
    uFloorIntensity: floorIntensity, uFloorUpMin: uUpMin, uFloorUpMax: uUpMax,
    tFloorNormal: { value: pass.normalTexture },
    uFloorCamWorld: { value: new THREE.Matrix4() },
  });
  bl.needsUpdate = true;

  // The blend material is not a scene material, so nothing keeps its camera matrix current
  // — and a stale one rotates the mask with a camera that has stopped moving, which reads
  // as the split drifting off the floor. Same trap as GTAOPass's own captured camera.
  const render = pass.render.bind(pass);
  pass.render = function (renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    bl.uniforms.uFloorCamWorld.value.copy(this.camera.matrixWorld);
    bl.uniforms.tFloorNormal.value = this.normalTexture;
    return render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  };

  return {
    /** Floor AO reach in metres. Thickness follows it — see the note on thicknessRatio. */
    setFloorRadius: (v) => { floorRadius.value = v; floorThickness.value = v * thicknessRatio; },
    setFloorAmount: (v) => { floorIntensity.value = v; },
    /** Where the wall/floor crossfade sits, in world normal Y. */
    setUpRange: (min, max) => { uUpMin.value = min; uUpMax.value = max; },
    get floorRadius() { return floorRadius.value; },
    get floorAmount() { return floorIntensity.value; },
  };
}
