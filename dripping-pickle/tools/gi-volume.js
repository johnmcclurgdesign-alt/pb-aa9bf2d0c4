// Irradiance volume — real bounce light, in the browser, with no bake in Blender.
//
// WHAT IT IS. A grid of light probes through the building. Each probe renders a tiny
// cubemap of the room from where it stands, and that cubemap is squashed down into four
// numbers per colour channel (spherical harmonics, band 1). Those numbers answer, for any
// direction you ask, "how much light arrives here facing that way". Surfaces look up the
// grid at their own position and normal and add the answer to their lighting.
//
// It is a photograph of the light in the room, taken 500 times, stored as an average and a
// direction rather than as pixels. The three.js `HemisphereLight` it replaces is the same
// idea frozen at one value for the whole world — sky above, ground below, no position, no
// colour bleed, no idea where the walls are.
//
// WHY IT MATTERS HERE. The handoff measured the gap between the real-time rig and the
// Cycles bake and found it was not the direct light — that part matches easily — but the
// darks. Uniform ambient fills exactly the corners real bounce leaves alone. A volume has
// a value per cubic metre, so a corner is dark because the probe standing in it saw walls,
// not because someone tuned a number down.
//
// MULTI-BOUNCE. Pass 0 bakes with the volume switched off, so probes see direct light only
// — that is bounce 1. Pass 1 bakes again with pass 0's result feeding the materials, so the
// probes now see direct + bounce 1, giving bounce 2. Each pass REPLACES the grid rather
// than adding to it, which is the Neumann series for the rendering equation and is why it
// converges instead of running away.
//
// COST. The bake is the expensive part (seconds, once). Sampling it afterwards is four
// 3D-texture reads per fragment and costs nothing. `serialise()` / `load()` exist so the
// bake can be done once and the result shipped as a file, which is what a published loop
// wants — GitHub Pages should not spend eight seconds baking on every visit.

import * as THREE from 'three';
import { LightProbeGenerator } from 'three/addons/lights/LightProbeGenerator.js';

// ── projecting a probe cubemap onto SH ──────────────────────────────────────
// three ships this as LightProbeGenerator.fromCubeRenderTarget, and we use that as the
// reference — `verifyProjection()` below checks the two agree. But the shipped one is
// ASYNC: it calls readRenderTargetPixelsAsync per face, which polls a GPU fence on a 4 ms
// timer, so six faces cost ~25 ms of waiting per probe no matter how small the cubemap is.
// Across 1,400 probe bakes that is a minute of pure timer latency. The buffers here are
// 4 KB, so a synchronous read stalls for a fraction of that.
//
// The conventions below (face axes, the `flip` for WebGL's coordinate system, the solid
// angle weight, the 4π/totalWeight normalisation) are copied from three r169 exactly. Get
// any of them wrong and the volume is subtly the wrong brightness or mirrored, which reads
// as a grading problem rather than a maths one.
// ★ YIELDING WITH setTimeout MAKES THE BAKE LOOK LIKE A HANG.
// The bake hands control back to the browser between chunks so the tab stays alive. The
// obvious `setTimeout(0)` is clamped to ONE PER SECOND once the tab is backgrounded (or
// merely not compositing), and since a chunk is ~12 ms of work that turns a 20-second bake
// into 25 minutes — measured: 2.2% done after 35 seconds. MessageChannel is not clamped,
// so the same loop runs at full speed whether the tab is in front or not.
const _yieldChannel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
function yieldToBrowser() {
  if (!_yieldChannel) return new Promise((r) => setTimeout(r, 0));
  return new Promise((resolve) => {
    _yieldChannel.port1.addEventListener('message', function once() {
      _yieldChannel.port1.removeEventListener('message', once);
      resolve();
    });
    _yieldChannel.port1.start();
    _yieldChannel.port2.postMessage(0);
  });
}

const _coord = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _basis = [0, 0, 0, 0, 0, 0, 0, 0, 0];

function faceCoord(faceIndex, col, row, flip, out) {
  switch (faceIndex) {
    case 0: return out.set(-1 * flip, row, col * flip);
    case 1: return out.set(1 * flip, row, -col * flip);
    case 2: return out.set(col, 1, -row);
    case 3: return out.set(col, -1, row);
    case 4: return out.set(col, row, 1);
    default: return out.set(-col, row, -1);
  }
}

/**
 * Read a cube render target and project it onto the first `numSH` SH coefficients.
 * Writes into `outVec3s` (an array of THREE.Vector3), which is reused across probes so a
 * 1,400-probe bake does not allocate 1,400 times.
 */
function projectCubeSH(renderer, cubeRT, buf, outVec3s, numSH) {
  const flip = renderer.coordinateSystem === THREE.WebGLCoordinateSystem ? -1 : 1;
  const W = cubeRT.width;
  const pixelSize = 2 / W;
  let totalWeight = 0;

  for (let c = 0; c < numSH; c++) outVec3s[c].set(0, 0, 0);

  for (let face = 0; face < 6; face++) {
    renderer.readRenderTargetPixels(cubeRT, 0, 0, W, W, buf, face);
    for (let i = 0, px = 0; i < buf.length; i += 4, px++) {
      const r = THREE.DataUtils.fromHalfFloat(buf[i]);
      const g = THREE.DataUtils.fromHalfFloat(buf[i + 1]);
      const b = THREE.DataUtils.fromHalfFloat(buf[i + 2]);

      const col = (1 - ((px % W) + 0.5) * pixelSize) * flip;
      const row = 1 - (Math.floor(px / W) + 0.5) * pixelSize;
      faceCoord(face, col, row, flip, _coord);

      // Solid angle of this texel: pixels at a cube face's corner cover less sky than
      // pixels at its centre, and weighting them equally tilts the whole result.
      const lenSq = _coord.lengthSq();
      const weight = 4 / (Math.sqrt(lenSq) * lenSq);
      totalWeight += weight;

      _dir.copy(_coord).normalize();
      THREE.SphericalHarmonics3.getBasisAt(_dir, _basis);
      for (let c = 0; c < numSH; c++) {
        const w = _basis[c] * weight;
        outVec3s[c].x += w * r;
        outVec3s[c].y += w * g;
        outVec3s[c].z += w * b;
      }
    }
  }

  const norm = (4 * Math.PI) / totalWeight;
  for (let c = 0; c < numSH; c++) outVec3s[c].multiplyScalar(norm);
}

// Band-1 spherical harmonics: 4 coefficients (1 constant + 3 directional) x RGB.
// Band 2 would be 9 and visibly better on hard creases, but it needs nine 3D textures
// against four and diffuse bounce is smooth by nature — the constant and the direction
// carry almost all of it. This is the same trade every engine that shipped "light probes"
// made before it could afford a full irradiance field.
const NUM_SH = 4;

// three's own irradiance evaluation, trimmed to band 1. These constants are not arbitrary:
// they are the cosine-lobe convolution that turns radiance coefficients into irradiance,
// and they MUST match `shGetIrradianceAt` in three's bsdfs.glsl or the volume will be
// subtly the wrong brightness against every other light in the scene.
const SH_GLSL = /* glsl */`
  vec3 giSHIrradiance( vec3 n, vec3 c0, vec3 c1, vec3 c2, vec3 c3 ) {
    vec3 r = c0 * 0.886227;
    r += c1 * ( 2.0 * 0.511664 * n.y );
    r += c2 * ( 2.0 * 0.511664 * n.z );
    r += c3 * ( 2.0 * 0.511664 * n.x );
    return r;
  }
`;

export function createGIVolume({
  renderer,
  scene,
  bounds,                 // THREE.Box3 covering the space to light
  spacing = 2.0,          // metres between probes
  cubeSize = 16,          // probe cubemap resolution per face
  maxProbes = 6000,
} = {}) {

  // WebGL2 gives sampler3D and linear filtering of half-float for free. three r163+ is
  // WebGL2-only so this should never fire, but a volume that silently renders black is
  // worse than one that says why.
  const caps = renderer.capabilities;
  if (!caps.isWebGL2 && !renderer.isWebGPURenderer) {
    console.warn('[gi] no WebGL2 — irradiance volume disabled');
    return null;
  }

  const size = bounds.getSize(new THREE.Vector3());
  const dims = new THREE.Vector3(
    Math.max(2, Math.ceil(size.x / spacing) + 1),
    Math.max(2, Math.ceil(size.y / spacing) + 1),
    Math.max(2, Math.ceil(size.z / spacing) + 1),
  );
  // A grid is cubic in cost. Back off uniformly rather than clipping one axis, or the
  // volume gets anisotropic and bounce reads as banding along whichever axis lost.
  let count = dims.x * dims.y * dims.z;
  while (count > maxProbes) {
    dims.set(Math.max(2, dims.x - 1), Math.max(2, dims.y - 1), Math.max(2, dims.z - 1));
    const next = dims.x * dims.y * dims.z;
    if (next === count) break;
    count = next;
  }
  const probeCount = dims.x * dims.y * dims.z;

  // Probe SPACING is derived back from the final dims, because the grid spans the bounds
  // exactly — the corner probes sit ON the faces, not half a cell inside.
  const step = new THREE.Vector3(
    size.x / Math.max(1, dims.x - 1),
    size.y / Math.max(1, dims.y - 1),
    size.z / Math.max(1, dims.z - 1),
  );

  // ── storage ────────────────────────────────────────────────────────────────
  // One RGBA half-float 3D texture per SH coefficient. Half rather than full float
  // because linear filtering of RGBA32F is an optional extension, while RGBA16F
  // filtering is core WebGL2 — and trilinear filtering is the entire point of a volume.
  const data = [];
  const textures = [];
  for (let i = 0; i < NUM_SH; i++) {
    const buf = new Uint16Array(probeCount * 4);
    const tex = new THREE.Data3DTexture(buf, dims.x, dims.y, dims.z);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.HalfFloatType;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.NoColorSpace;   // these are coefficients, not colours to convert
    tex.needsUpdate = true;
    data.push(buf);
    textures.push(tex);
  }

  // Half a texel in each axis. Sampling the volume at exactly 0 or 1 makes trilinear reach
  // for a neighbour that does not exist; clamped to edge that is harmless in the middle of
  // a grid and wrong at the boundary, where it flattens the gradient against the wall.
  const halfTexel = new THREE.Vector3(
    0.5 / dims.x, 0.5 / dims.y, 0.5 / dims.z);

  const uniforms = {
    giSH0: { value: textures[0] },
    giSH1: { value: textures[1] },
    giSH2: { value: textures[2] },
    giSH3: { value: textures[3] },
    giBoundsMin:  { value: bounds.min.clone() },
    giBoundsSize: { value: size.clone() },
    giHalfTexel:  { value: halfTexel },
    // The 8-tap gather works in probe INDEX space, so it needs the grid shape and pitch
    // that used to be implicit in the hardware filter.
    giDims:       { value: dims.clone() },
    giStep:       { value: step.clone() },
    giIntensity:  { value: 1.0 },
    // How hard a surface refuses light from probes BEHIND it. 0 reproduces plain
    // trilinear exactly, which is the honest A/B against the old sampler.
    giBackWeight: { value: 1.0 },
    // How much open sky a probe may see before it stops counting as "in the room".
    // Baked into the alpha of giSH0 as a fraction; 0 disables the test. See bakeValidity().
    giValidThreshold: { value: 0.2 },
    // Push the lookup along the surface normal before sampling, so a surface does not read
    // the probe buried in its own wall. It used to be the ONLY defence against that, which
    // is why it was 0.55 of a cell — and at that size it is a blunt instrument that trades
    // the walls against the floor (n018). The per-probe visibility weight below now does
    // that job properly, so this is back to a small margin rather than a tuning dial.
    giNormalBias: { value: Math.max(step.x, step.y, step.z) * 0.15 },
    // ★ giBackWeight = 0 REPRODUCES THE OLD SAMPLER'S PICTURE AND NOT ITS COST, and the
    //   difference matters to BUD3. The comment above and card #115 both call `givis=0` an
    //   A/B for the 32-read gather; it is not. It only zeroes the per-probe WEIGHT — all
    //   eight texelFetches still execute, four times over, on every fragment. So a cost
    //   question needs a second lever, and this is it: 1 takes the hardware trilinear path,
    //   4 texture() calls instead of 32 texelFetch. Dynamically uniform, so the branch is
    //   free; the shipped value is 0 and the gather is untouched.
    giCheap: { value: 0 },
  };

  // ── material patch ─────────────────────────────────────────────────────────
  const patched = new WeakSet();

  function patch(material, { gain = 1 } = {}) {
    if (!material || patched.has(material)) return;
    patched.add(material);

    // Per-MATERIAL gain on the volume's contribution. giIntensity is one number
    // for the whole room, but the volume systematically over-lights big flat
    // walls relative to a path-traced reference (warehouse: wall patches read
    // 1.6-2.5x the Blender render while the floor did not) — walls face the
    // open room, so every probe agrees with them, where floors and cluttered
    // props sit half in each other's shadow. The gain lives on the material so
    // a scene can say "walls take less bounce" without re-baking or re-grading.
    // Exposed on material.userData.giGain for live dials.
    const gainU = { value: gain };
    material.userData.giGain = gainU;

    // Chain rather than assign. PCSS installs an onBeforeCompile on these same materials,
    // and whichever ran second would otherwise erase the other — which reads as "the GI
    // works but the shadows are hard", or the reverse, depending on load order.
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = function (shader, renderer) {
      if (prev) prev.call(this, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.uniforms.giGain = gainU;

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGIWorldPos;')
        // AFTER project_vertex, `transformed` is final object space — morph targets and
        // skinning have already been applied to it. Reading it earlier would light the
        // bind pose. (InstancedMesh would still need instanceMatrix here; there is none
        // in this scene.)
        .replace('#include <project_vertex>',
                 '#include <project_vertex>\n\tvGIWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vGIWorldPos;
          uniform sampler3D giSH0, giSH1, giSH2, giSH3;
          uniform vec3 giBoundsMin, giBoundsSize, giHalfTexel, giDims, giStep;
          uniform float giIntensity, giNormalBias, giBackWeight, giValidThreshold, giGain;
          uniform float giCheap;
          ${SH_GLSL}
          // ★ THE HARDWARE TRILINEAR FETCH CANNOT ASK WHETHER A PROBE CAN SEE THE SURFACE,
          // AND THAT IS WHY CORNERS USED TO GLOW (n018). A single texture() call blends the
          // eight surrounding probes by distance alone, so a wall near a corner takes a
          // quarter of its light from probes on the far side of the perpendicular wall.
          // Real corners are DARKER because they see less sky, so the error is not just
          // wrong, it is inverted — and no value of giNormalBias fixes it, because that dial
          // trades the walls against the floor (measured: wall corner/mid 1.45 -> 1.20 as
          // the floor edge/mid went 1.51 -> 2.05).
          // So gather the eight explicitly and weight each one by whether the surface is
          // facing it. texelFetch, not texture(), because we want the raw probe, not the
          // filter. Cost is 32 reads per fragment against 4, on textures of 11x7x12.
          vec3 giVolume( vec3 wpos, vec3 wn ) {
            vec3 p = wpos + wn * giNormalBias;
            // Probe INDEX space: 0 on the first probe, dims-1 on the last. The grid spans
            // the bounds exactly, so this is a plain scale with no texel-centre fudge.
            vec3 gp = clamp( ( p - giBoundsMin ) / giBoundsSize, vec3( 0.0 ), vec3( 1.0 ) )
                    * ( giDims - 1.0 );
            // ★ THE CHEAP PATH: one hardware trilinear fetch per SH band instead of the
            //   eight-neighbour gather — 4 texture reads a fragment against 32. This is the
            //   OLD sampler, cost and all, which is what an honest A/B of the gather needs
            //   (giBackWeight = 0 gives its picture and keeps its cost — see the uniform).
            //   The textures are LinearFilter, and the grid spans its bounds exactly, so the
            //   texel-centre mapping is ( index + 0.5 ) / dims.
            //   ⚠ It is a WORSE picture, deliberately: it cannot ask whether a probe can see
            //   the surface, which is the corner glow the gather exists to remove.
            if ( giCheap > 0.5 ) {
              vec3 uvw = ( gp + 0.5 ) / giDims;
              vec3 t0 = texture( giSH0, uvw ).rgb;
              vec3 t1 = texture( giSH1, uvw ).rgb;
              vec3 t2 = texture( giSH2, uvw ).rgb;
              vec3 t3 = texture( giSH3, uvw ).rgb;
              return max( giSHIrradiance( wn, t0, t1, t2, t3 ), vec3( 0.0 ) ) * giIntensity;
            }

            vec3 base = floor( gp );
            vec3 frac = gp - base;
            ivec3 last = ivec3( giDims ) - ivec3( 1 );

            // Two accumulations off the SAME eight fetches: one that trusts every probe,
            // one that only trusts probes standing in the room. The first is the fallback
            // for a surface with no valid neighbour at all — better slightly wrong light
            // than a black patch.
            vec3 a0 = vec3( 0.0 ), a1 = vec3( 0.0 ), a2 = vec3( 0.0 ), a3 = vec3( 0.0 );
            vec3 v0 = vec3( 0.0 ), v1 = vec3( 0.0 ), v2 = vec3( 0.0 ), v3 = vec3( 0.0 );
            float wsum = 0.0, vsum = 0.0;

            for ( int i = 0; i < 8; i++ ) {
              vec3 off = vec3( float( i & 1 ), float( ( i >> 1 ) & 1 ), float( ( i >> 2 ) & 1 ) );
              ivec3 idx = clamp( ivec3( base + off ), ivec3( 0 ), last );

              // The trilinear weight this corner would have had on its own.
              vec3 t = mix( 1.0 - frac, frac, off );
              float w = t.x * t.y * t.z;

              // Measured from the SURFACE, not from the biased sample point — the bias is
              // there to escape the wall, and reusing it here would hide the very geometry
              // relationship we are trying to read.
              vec3 toProbe = giBoundsMin + vec3( idx ) * giStep - wpos;
              float len = length( toProbe );
              float ndl = len > 1e-4 ? dot( wn, toProbe / len ) : 1.0;
              // WRAPPED, not clamped. A hard clamp drops a whole cell to zero the moment it
              // crosses the horizon, which puts back the dark rim the normal bias exists to
              // remove; and the 0.05 floor keeps a fully back-facing cell dim rather than
              // black, so a surface in a tight corner still has something to interpolate.
              float wrap = ( ndl + 1.0 ) * 0.5;
              w *= mix( 1.0, wrap * wrap + 0.05, giBackWeight );

              vec4 s0 = texelFetch( giSH0, idx, 0 );
              vec3 s1 = texelFetch( giSH1, idx, 0 ).rgb;
              vec3 s2 = texelFetch( giSH2, idx, 0 ).rgb;
              vec3 s3 = texelFetch( giSH3, idx, 0 ).rgb;

              // ★ THE NORMAL WEIGHT ABOVE CANNOT REJECT A PROBE THAT IS SIDEWAYS FROM THE
              // SURFACE, AND THAT IS THE BRIGHT BAND ALONG EVERY WALL/FLOOR JUNCTION. The
              // probe half a metre BEHIND a wall is at the same height as the floor in front
              // of it, so the floor's normal barely disfavours it while trilinear still hands
              // it most of the weight — measured 55% of the light 15 cm from the wall, off a
              // probe 3.4x brighter than the one in the room. Sharpening the cosine does not
              // touch it (exponent 2 to 16 moved the glow 2.50 to 2.43).
              // So the bake asks each probe a different question: how much open sky can you
              // see? A probe in the room sees none — the glazing is geometry, so even a
              // skylight ray stops. A probe out past a wall sees most of the hemisphere.
              // Measured here: in-room probes 0.00, the one behind that wall 0.31, fully
              // outside 0.77-0.79. That separates cleanly where no normal test could.
              float valid = giValidThreshold <= 0.0 ? 1.0
                          : clamp( ( giValidThreshold - s0.a ) / 0.15, 0.0, 1.0 );
              float wv = w * valid;

              a0 += s0.rgb * w;  a1 += s1 * w;  a2 += s2 * w;  a3 += s3 * w;
              v0 += s0.rgb * wv; v1 += s1 * wv; v2 += s2 * wv; v3 += s3 * wv;
              wsum += w; vsum += wv;
            }

            // Normalising by the weights is what keeps this a brightness-neutral change:
            // reweighting redistributes where the light comes from, it does not add any.
            if ( wsum <= 1e-6 ) return vec3( 0.0 );
            vec3 c0 = a0 / wsum, c1 = a1 / wsum, c2 = a2 / wsum, c3 = a3 / wsum;
            // Fall back to the unfiltered answer where nothing valid is in reach, and ramp
            // rather than switch so the changeover cannot show up as a seam.
            float t = smoothstep( 0.0, 0.02 * wsum, vsum );
            if ( t > 0.0 ) {
              float vinv = 1.0 / max( vsum, 1e-6 );
              c0 = mix( c0, v0 * vinv, t ); c1 = mix( c1, v1 * vinv, t );
              c2 = mix( c2, v2 * vinv, t ); c3 = mix( c3, v3 * vinv, t );
            }
            // Band-1 SH can ring negative on the dark side of a strong gradient. Left
            // alone that subtracts light and punches black holes in shadowed geometry.
            return max( giSHIrradiance( wn, c0, c1, c2, c3 ), vec3( 0.0 ) ) * giIntensity;
          }`)
        // lights_fragment_maps is where the lightmap and light probes are added to
        // `irradiance`, and lights_fragment_end consumes it — so this is the one spot
        // that reaches diffuse indirect without touching direct light or specular.
        .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
          #if defined( RE_IndirectDiffuse )
            irradiance += giVolume( vGIWorldPos, inverseTransformDirection( geometryNormal, viewMatrix ) ) * giGain;
          #endif`);
    };
    // Without this, three reuses a cached program from an unpatched material with the
    // same feature set and the volume silently does nothing on some meshes.
    const prevKey = material.customProgramCacheKey;
    material.customProgramCacheKey = function () {
      return (prevKey ? prevKey.call(this) : '') + '|gi-volume-v3';
    };
    material.needsUpdate = true;
  }

  // ── bake ───────────────────────────────────────────────────────────────────
  const cubeRT = new THREE.WebGLCubeRenderTarget(cubeSize, {
    type: THREE.HalfFloatType,        // the sky through a window is far above 1.0
    format: THREE.RGBAFormat,         // readRenderTargetPixels needs RGBA
    colorSpace: THREE.LinearSRGBColorSpace,
    generateMipmaps: false,
  });
  // far must clear the sky dome or probes see a hole where the sky should be; near must
  // be small or a probe standing close to a wall clips through it and sees the far side.
  const cubeCam = new THREE.CubeCamera(0.05, 1000, cubeRT);

  const probePos = new THREE.Vector3();
  // Reused across every probe — a bake is thousands of iterations and these would
  // otherwise be thousands of allocations feeding the garbage collector mid-render.
  const shOut = Array.from({ length: NUM_SH }, () => new THREE.Vector3());
  const readBuf = new Uint16Array(cubeSize * cubeSize * 4);
  let baking = false;

  /**
   * Check our fast synchronous projector against three's shipped one on the CURRENT probe
   * cubemap. Returns the largest absolute difference per coefficient. Anything above ~1e-3
   * means a convention drifted and the volume's brightness cannot be trusted.
   */
  async function verifyProjection() {
    projectCubeSH(renderer, cubeRT, readBuf, shOut, NUM_SH);
    const ref = await LightProbeGenerator.fromCubeRenderTarget(renderer, cubeRT);
    return shOut.map((v, c) => ({
      coeff: c,
      ours: v.toArray().map((n) => +n.toFixed(5)),
      three: ref.sh.coefficients[c].toArray().map((n) => +n.toFixed(5)),
      maxDiff: +Math.max(
        Math.abs(v.x - ref.sh.coefficients[c].x),
        Math.abs(v.y - ref.sh.coefficients[c].y),
        Math.abs(v.z - ref.sh.coefficients[c].z)).toFixed(6),
    }));
  }

  // ── probe validity ─────────────────────────────────────────────────────────
  // "Is this probe standing in the room?", answered as "how much open sky can it see
  // directly?". Ray a probe in 16 even directions and count the ones that hit nothing.
  //
  // It works because the GLAZING IS GEOMETRY: a ray leaving a probe in the room through a
  // skylight still hits the pane, so an indoor probe scores a clean 0. Measured on this
  // building — in-room 0.00, a probe half a metre behind a wall 0.31, fully outdoors
  // 0.77-0.79. (If glass is ever removed from the model rather than made non-casting, the
  // indoor score stops being 0 and this threshold wants re-checking.)
  //
  // Sixteen rays over 924 probes costs ~10 s, so it is chunked and yielded like the bake.
  const _fibDirs = Array.from({ length: 16 }, (_, i) => {
    const y = 1 - (i + 0.5) * 2 / 16;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = Math.PI * (1 + Math.sqrt(5)) * i;
    return new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r);
  });
  const _raycaster = new THREE.Raycaster();

  function visibleAncestors(o) {
    for (let n = o; n; n = n.parent) if (!n.visible) return false;
    return true;
  }

  async function bakeValidity({ onProgress = null, budgetMs = 12 } = {}) {
    // The sky dome is a ShaderMaterial and so are the light shafts. Include the dome and
    // NOTHING escapes — every probe scores 0 and the test silently becomes a no-op.
    const meshes = [];
    scene.traverse((o) => {
      if (o.isMesh && visibleAncestors(o)) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        if (!mats.some((m) => m && m.isShaderMaterial)) meshes.push(o);
      }
    });
    _raycaster.far = 60;

    const p = new THREE.Vector3();
    let i = 0, chunkStart = performance.now();
    for (let iz = 0; iz < dims.z; iz++) {
      for (let iy = 0; iy < dims.y; iy++) {
        for (let ix = 0; ix < dims.x; ix++, i++) {
          probeWorldPos(ix, iy, iz, p);
          let escaped = 0;
          for (const d of _fibDirs) {
            _raycaster.set(p, d);
            if (!_raycaster.intersectObjects(meshes, false).length) escaped++;
          }
          // Alpha of coefficient 0 was already there and unused, so this costs no bytes.
          data[0][i * 4 + 3] = THREE.DataUtils.toHalfFloat(escaped / _fibDirs.length);
          if (performance.now() - chunkStart > budgetMs) {
            if (onProgress) onProgress({ done: i + 1, total: probeCount, phase: 'validity', pass: 1, passes: 1 });
            await yieldToBrowser();
            chunkStart = performance.now();
          }
        }
      }
    }
    textures[0].needsUpdate = true;
    return { probes: probeCount };
  }

  function probeWorldPos(ix, iy, iz, out) {
    return out.set(
      bounds.min.x + ix * step.x,
      bounds.min.y + iy * step.y,
      bounds.min.z + iz * step.z,
    );
  }

  function uploadAll() {
    for (const t of textures) t.needsUpdate = true;
  }

  /**
   * @param {object}   o
   * @param {number}   o.bounces  how many times light is allowed to bounce (1 = direct only)
   * @param {Object3D[]} o.exclude objects hidden during the bake — additive fakes like the
   *                     light shafts and dust would be integrated as if they were real light
   * @param {function} o.onProgress ({done, total, phase, pass, passes, bounce, bounces}) => void
   *                     phase is 'validity' or 'bounce'. ⚠ bounce/bounces are present ONLY
   *                     on the 'bounce' phase — a consumer that interpolates them
   *                     unconditionally prints "bounce undefined/undefined" and computes a
   *                     NaN width, which is exactly what shipped. Use pass/passes, which
   *                     both phases always carry.
   * @param {number}   o.budgetMs  probe work per chunk; the bake yields between chunks so
   *                     the tab stays answerable instead of hanging for ten seconds
   */
  async function bake({ bounces = 2, exclude = [], onProgress = null, budgetMs = 12 } = {}) {
    if (baking) return;
    baking = true;

    const hidden = exclude.map((o) => [o, o.visible]);
    for (const [o] of hidden) o.visible = false;

    // ★ THE SINGLE BIGGEST COST IN THE BAKE, AND IT IS INVISIBLE.
    // Every renderer.render() re-renders the shadow map, and a probe is SIX renders. At
    // 800 probes x 2 bounces that is 9,600 shadow passes over the whole building at
    // 4096x4096 — minutes of work for an answer that never changes, because the sun does
    // not move during a bake. Render it once and reuse it: autoUpdate off, needsUpdate on
    // for the first frame only. Without this the bake looks like an infinite hang.
    const prevAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;

    // Probes must not see the sky dome's own tone-mapped brightness through the composer,
    // and must not see themselves — but they DO need to see the sky through the windows,
    // which is where most of this room's light comes from. So the sky stays.
    const prevIntensity = uniforms.giIntensity.value;
    const t0 = performance.now();

    try {
      // Validity FIRST, so bounce 2 — which gathers the volume through this same shader —
      // is itself gathered with the wall-cavity probes already rejected.
      await bakeValidity({
        budgetMs,
        onProgress: onProgress
          ? (p) => onProgress({ ...p, pass: 1, passes: bounces + 1 })
          : null,
      });

      for (let b = 0; b < bounces; b++) {
        // Pass 0 sees no volume at all, so it captures direct light only. Later passes
        // read the previous pass, which is what turns this into multi-bounce.
        uniforms.giIntensity.value = b === 0 ? 0 : 1;

        let i = 0;
        let chunkStart = performance.now();
        for (let iz = 0; iz < dims.z; iz++) {
          for (let iy = 0; iy < dims.y; iy++) {
            for (let ix = 0; ix < dims.x; ix++, i++) {
              probeWorldPos(ix, iy, iz, probePos);
              cubeCam.position.copy(probePos);
              cubeCam.updateMatrixWorld(true);
              cubeCam.update(renderer, scene);

              projectCubeSH(renderer, cubeRT, readBuf, shOut, NUM_SH);

              const o = i * 4;
              for (let c = 0; c < NUM_SH; c++) {
                data[c][o + 0] = THREE.DataUtils.toHalfFloat(shOut[c].x);
                data[c][o + 1] = THREE.DataUtils.toHalfFloat(shOut[c].y);
                data[c][o + 2] = THREE.DataUtils.toHalfFloat(shOut[c].z);
                // NOT coefficient 0's alpha — bakeValidity() lives there and ran first,
                // so that the second bounce is gathered through the validity test too.
                if (c > 0) data[c][o + 3] = 0;
              }

              if (performance.now() - chunkStart > budgetMs) {
                if (onProgress) onProgress({ done: i + 1, total: probeCount, phase: 'bounce',
                                            bounce: b + 1, bounces, pass: b + 2, passes: bounces + 1 });
                await yieldToBrowser();
                chunkStart = performance.now();
              }
            }
          }
        }
        // Only upload once the whole pass is written, so a pass never reads a grid that
        // is half this bounce and half the last one.
        uploadAll();
        if (onProgress) onProgress({ done: probeCount, total: probeCount, phase: 'bounce',
                                     bounce: b + 1, bounces, pass: b + 2, passes: bounces + 1 });
      }
    } finally {
      uniforms.giIntensity.value = prevIntensity;
      for (const [o, v] of hidden) o.visible = v;
      renderer.shadowMap.autoUpdate = prevAuto;
      renderer.shadowMap.needsUpdate = true;   // the live camera needs a fresh one
      baking = false;
    }

    return { probes: probeCount, ms: Math.round(performance.now() - t0) };
  }

  // ── persistence ────────────────────────────────────────────────────────────
  // A published loop should not re-bake on every page load. Bake once with ?gibake=1,
  // save this blob next to the .glb, and ship it.
  // ver 2 carries probe validity in coefficient 0's alpha. A ver-1 file has zeros there,
  // which would read as "every probe is outside the room" — so it is rejected rather than
  // loaded, and the loop re-bakes. Bump this whenever the meaning of a channel changes.
  const FORMAT_VERSION = 2;

  function serialise() {
    const header = { ver: FORMAT_VERSION, dims: dims.toArray(), min: bounds.min.toArray(), size: size.toArray(), numSH: NUM_SH };
    const json = new TextEncoder().encode(JSON.stringify(header));
    const pad = (4 - (json.length % 4)) % 4;
    const out = new Uint8Array(4 + json.length + pad + NUM_SH * probeCount * 8);
    new DataView(out.buffer).setUint32(0, json.length + pad, true);
    out.set(json, 4);
    let off = 4 + json.length + pad;
    for (let c = 0; c < NUM_SH; c++) {
      out.set(new Uint8Array(data[c].buffer), off);
      off += data[c].byteLength;
    }
    return out;
  }

  function load(buffer) {
    const u8 = new Uint8Array(buffer);
    const jsonLen = new DataView(u8.buffer, u8.byteOffset).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(u8.subarray(4, 4 + jsonLen)).replace(/\0+$/, ''));
    if (header.dims.join(',') !== dims.toArray().join(',')) {
      console.warn('[gi] cached volume does not match this grid — re-bake');
      return false;
    }
    if ((header.ver ?? 1) !== FORMAT_VERSION) {
      console.warn(`[gi] cached volume is format v${header.ver ?? 1}, this build wants v${FORMAT_VERSION} — re-bake`);
      return false;
    }
    let off = 4 + jsonLen;
    for (let c = 0; c < NUM_SH; c++) {
      data[c].set(new Uint16Array(u8.buffer.slice(u8.byteOffset + off, u8.byteOffset + off + data[c].byteLength)));
      off += data[c].byteLength;
    }
    uploadAll();
    return true;
  }

  function dispose() {
    for (const t of textures) t.dispose();
    cubeRT.dispose();
  }

  return {
    dims, probeCount, step, bounds, uniforms, textures,
    patch, bake, serialise, load, dispose, verifyProjection,
    get baking() { return baking; },
    setIntensity: (v) => { uniforms.giIntensity.value = v; },
    setNormalBias: (v) => { uniforms.giNormalBias.value = v; },
    // 0 = plain trilinear WEIGHTS (the old sampler's picture, at the gather's cost — see
    // setCheap for the cost A/B), 1 = full visibility weight.
    setBackWeight: (v) => { uniforms.giBackWeight.value = v; },
    // 1 = the hardware trilinear path: 4 texture reads a fragment instead of 32. The old
    // sampler's COST as well as its picture, which is what BUD3 needs to attribute the
    // gather on a phone. Off in the shipped build.
    setCheap: (v) => { uniforms.giCheap.value = v ? 1 : 0; },
    // How much sky a probe may see and still count as being in the room. 0 disables.
    setValidThreshold: (v) => { uniforms.giValidThreshold.value = v; },
    probeWorldPos: (ix, iy, iz) => probeWorldPos(ix, iy, iz, new THREE.Vector3()),
  };
}
