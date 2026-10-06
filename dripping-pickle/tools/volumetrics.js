// Raymarched light shafts — the real thing, with no geometry at all.
//
// WHAT IT IS. For every pixel on screen, walk along the ray from the camera out to whatever
// the depth buffer says is there. At each step, look that point up in the SUN'S SHADOW MAP
// and ask "is this bit of air in sunlight?". Add up the lit steps. That sum is the shaft.
//
// It is the same question a shadow already answers — "can this point see the sun" — asked
// about the empty air instead of about a surface.
//
// WHY IT BEATS THE CARDS. The card version paints beams onto quads, and every artifact we
// chased came from that: silhouettes, striping between neighbours, a straight slice where a
// quad passed through the floor, and the whole thing changing as you turned your head. None
// of it exists here, because there is nothing to see the edge of.
// It is also more correct in ways that are hard to fake:
//   - the beams are shaped by the REAL glazing bars, because the shadow map already
//     contains them. Nobody has to decide where a beam goes.
//   - geometry occludes them for free; the march stops at the depth buffer.
//   - looking toward the sun makes them glow and looking away makes them vanish, which is
//     the thing that actually reads as light in air (the phase function below).
//   - it runs inside the composer on LINEAR HDR, so the light ADDS the way light does. The
//     cards write display-referred colour and get tone-mapped twice.
//
// COST. STEPS samples per pixel. The honest levers are STEPS and rendering at half
// resolution; the failure mode of too few steps is banding, which is why the march start is
// dithered per pixel — it trades banding for fine noise, which the eye forgives.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */`
  #include <packing>

  uniform sampler2D tDiffuse;      // what the scene rendered
  uniform sampler2D tDepth;        // scene depth, from the pre-pass
  uniform sampler2D tShadow;       // the sun's shadow map
  uniform mat4 uShadowMatrix;      // world -> shadow clip
  uniform mat4 uInvViewProj;       // clip -> world, to rebuild the ray
  uniform vec3 uCamPos;
  uniform vec3 uSunDir;            // direction the light TRAVELS
  uniform vec3 uColor;
  uniform vec2 uCamNF;
  uniform float uDensity, uMaxDist, uG, uShadowBias;

  varying vec2 vUv;

  // Henyey-Greenstein. g near 0 scatters evenly; g toward 1 throws light forward, so beams
  // flare when you look into the sun and fade when you look away. That asymmetry is most of
  // what makes air read as air rather than as fog.
  float phase(float cosT, float g) {
    float g2 = g * g;
    float d = 1.0 + g2 - 2.0 * g * cosT;
    return (1.0 - g2) / (12.5663706 * pow(max(d, 1e-4), 1.5));
  }

  // Interleaved gradient noise — one multiply and a fract, and it is stable under motion.
  float dither(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }

  vec3 worldFromDepth(vec2 uv, float depth) {
    vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 w = uInvViewProj * ndc;
    return w.xyz / w.w;
  }

  void main() {
    vec4 scene = texture2D(tDiffuse, vUv);
    float depth = texture2D(tDepth, vUv).x;

    // March to the surface in front of us, or to uMaxDist if we are looking at sky.
    vec3 target = worldFromDepth(vUv, depth);
    vec3 ray = target - uCamPos;
    float dist = length(ray);
    vec3 dir = ray / max(dist, 1e-5);
    if (depth >= 1.0) dist = uMaxDist;
    dist = min(dist, uMaxDist);

    float stepLen = dist / float(STEPS);
    // Start each pixel at a different point inside its first step. Without this the steps
    // line up across the screen and you get concentric banding instead of a beam.
    vec3 p = uCamPos + dir * (stepLen * dither(gl_FragCoord.xy));

    float acc = 0.0;
    for (int i = 0; i < STEPS; i++) {
      vec4 sc = uShadowMatrix * vec4(p, 1.0);
      sc.xyz /= sc.w;
      // Outside the shadow camera there is no information, so treat it as unlit rather
      // than as lit — guessing "lit" fills the whole room with haze.
      bool inside = all(greaterThanEqual(sc.xyz, vec3(0.0))) && all(lessThanEqual(sc.xyz, vec3(1.0)));
      if (inside) {
        float d = unpackRGBAToDepth(texture2D(tShadow, sc.xy));
        acc += step(sc.z - uShadowBias, d);
      }
      p += dir * stepLen;
    }

    float cosT = dot(dir, -uSunDir);
    float inscatter = acc * stepLen * uDensity * phase(cosT, uG);

    gl_FragColor = vec4(scene.rgb + uColor * inscatter, scene.a);
  }
`;

export class VolumetricLightPass extends Pass {
  /**
   * @param {object} o
   * @param {THREE.Texture} o.depthTexture scene depth, rendered before this pass
   * @param {function} o.getCamera        the live camera (the glTF one replaces the placeholder)
   * @param {number}   o.steps            samples per pixel; banding below ~24
   */
  constructor({ depthTexture, getCamera, steps = 48, color = 0xf0ece6 } = {}) {
    super();
    this.getCamera = getCamera;
    this.light = null;
    this.needsSwap = true;

    this.uniforms = {
      tDiffuse:      { value: null },
      tDepth:        { value: depthTexture },
      tShadow:       { value: null },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uInvViewProj:  { value: new THREE.Matrix4() },
      uCamPos:       { value: new THREE.Vector3() },
      uSunDir:       { value: new THREE.Vector3(0, -1, 0) },
      uColor:        { value: new THREE.Color(color) },
      uCamNF:        { value: new THREE.Vector2(0.1, 500) },
      uDensity:      { value: 0.02 },
      uMaxDist:      { value: 40 },
      uG:            { value: 0.72 },
      uShadowBias:   { value: 0.0008 },
    };

    this.material = new THREE.ShaderMaterial({
      defines: { STEPS: steps },
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  /** Point the pass at the sun. Its shadow map is the whole input, so it must cast one. */
  setLight(light) {
    this.light = light;
    return this;
  }

  setSteps(n) {
    this.material.defines.STEPS = Math.max(4, Math.round(n));
    this.material.needsUpdate = true;
  }

  render(renderer, writeBuffer, readBuffer) {
    const cam = this.getCamera();
    const u = this.uniforms;

    // The shadow map only exists once the renderer has drawn a shadow pass, and the light
    // may not have been wired up yet on the first frames — pass the scene through untouched
    // rather than rendering a black screen.
    if (!this.light || !this.light.shadow || !this.light.shadow.map) {
      if (this.renderToScreen) { renderer.setRenderTarget(null); }
      else { renderer.setRenderTarget(writeBuffer); if (this.clear) renderer.clear(); }
      this.material.uniforms.tDiffuse.value = readBuffer.texture;
      // straight copy: density 0 makes the march contribute nothing
      const d = u.uDensity.value; u.uDensity.value = 0;
      this.fsQuad.render(renderer);
      u.uDensity.value = d;
      return;
    }

    u.tDiffuse.value = readBuffer.texture;
    u.tShadow.value = this.light.shadow.map.texture;
    u.uShadowMatrix.value.copy(this.light.shadow.matrix);
    u.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
    u.uCamNF.value.set(cam.near, cam.far);
    // clip -> world, so a depth sample can be turned back into a point in the room
    u.uInvViewProj.value
      .multiplyMatrices(cam.matrixWorld, cam.projectionMatrixInverse);
    // direction the light travels
    u.uSunDir.value
      .subVectors(this.light.target.getWorldPosition(new THREE.Vector3()),
                  this.light.getWorldPosition(new THREE.Vector3()))
      .normalize();

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this.fsQuad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}
