// Budget rig, in-page half — draw calls, resident texture bytes, and the pixel floor.
//
// The other half is tools/budget-check.mjs (payload size, vendoring, provenance), which runs
// on disk. These three cannot: a draw count is a property of a frame, resident texture memory
// is a property of what the GPU actually holds, and "is there a picture" can only be answered
// by looking at one.
//
// Wired into a loop behind ?budget=1 so it can measure the CLEAN app entry — the thing that
// actually ships — rather than a dev build with different passes in the chain.
//
//   http://localhost:5173/loops/dripping-pickle/?budget=1
//   await window.__budget.run()      -> { pass, checks: [...] }
//
// ★ THE RIG MUST BE ABLE TO FAIL, AND YOU HAVE TO SEE IT FAIL BEFORE YOU TRUST A GREEN.
//   Every threshold here can be forced from the url so a violation can be PLANTED and the red
//   observed — ?budget=1&bmaxdraws=1 &bmaxvram=1 &bminlit=0.99. A rig nobody has watched fail
//   is a rig that reports success when it is broken.

/** Bytes a texture occupies once resident. Same model as tools/glb-vram.mjs — argue with it there. */
const MIP = 4 / 3;

/** Below this, the rig has measured a quad or nothing at all, not a frame. See the draw-call
 *  check for why it refuses rather than passes. Any real frame of any Loop clears it easily. */
const MIN_PLAUSIBLE_DRAWS = 8;

// ★ THE BLOCK SIZE IS READ FROM THE FORMAT, NOT ASSUMED (BUD1, 2026-09-10). This used to charge
//   a flat 1 byte/pixel for every compressed texture, which is ASTC 4x4. The Loop ships ASTC 6x6
//   (0.444 bytes/pixel) and the rig over-reported the budget by 2.25x — a number that is merely
//   pessimistic, never alarming, so it would have survived indefinitely. Built by SCANNING three's
//   own exports rather than typing constants, so a version bump cannot silently desync it.
//   Every ASTC block is 16 bytes; ETC2 RGB8/RGB8A1 and EAC R11 are 8 over a 4x4 block, and
//   ETC2 RGBA8 / EAC RG11 are 16.
const BLOCK_BPP = new Map();
function learnFormats(THREE) {
  if (BLOCK_BPP.size || !THREE) return;
  for (const [name, value] of Object.entries(THREE)) {
    const astc = /^RGBA_ASTC_(\d+)x(\d+)_Format$/.exec(name);
    if (astc) { BLOCK_BPP.set(value, 16 / (Number(astc[1]) * Number(astc[2]))); continue; }
    if (/^(RGB_ETC2|RGB_ETC1|RGB_PVRTC_4BPPV1|RGBA_PVRTC_4BPPV1|RED_RGTC1)_Format$/.test(name)) BLOCK_BPP.set(value, 0.5);
    else if (/^(RGBA_ETC2_EAC|RED_GREEN_RGTC2|RGBA_BPTC)_Format$/.test(name)) BLOCK_BPP.set(value, 1);
  }
}

function textureBytes(tex) {
  const img = tex.image;
  if (!img) return 0;
  // A compressed texture stays compressed on the GPU at one block per bw x bh texels;
  // everything else — PNG, JPEG, WebP alike — decodes to RGBA8 at 4.
  const w = img.width ?? img.displayWidth ?? 0;
  const h = img.height ?? img.displayHeight ?? 0;
  if (!w || !h) return 0;
  // ⚠ An unknown compressed format falls back to 1 (ASTC 4x4), the pessimistic answer — a budget
  //   that guesses low is a budget that passes a Loop a phone cannot render.
  const bpp = tex.isCompressedTexture ? (BLOCK_BPP.get(tex.format) ?? 1) : 4;
  // generateMipmaps is the default for glTF material textures; when it is off, do not charge
  // for mips. Over-counting is the safe direction for a budget, under-counting is not.
  const mip = tex.generateMipmaps === false ? 1 : MIP;
  return w * h * bpp * mip;
}

/**
 * @param {object} o
 * @param {THREE.WebGLRenderer} o.renderer
 * @param {THREE.Scene}         o.scene
 * @param {object}              o.budgets   parsed budgets.json
 * @param {object}              [o.three]   the THREE namespace, so compressed-format block sizes
 *                                          can be READ rather than assumed. Without it every
 *                                          compressed texture is charged at ASTC 4x4.
 * @param {URLSearchParams}     [o.query]   threshold overrides, for planting violations
 */
export function createBudgetRig({ renderer, scene, budgets, three, query = new URLSearchParams(location.search) }) {
  learnFormats(three);
  const num = (key, fallback) => {
    const v = query.get(key);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  const LIMITS = {
    maxDraws:   num('bmaxdraws', budgets.drawCalls.max),
    phoneKnee:  num('bknee',     budgets.drawCalls.phoneKnee),
    maxVram:    num('bmaxvram',  budgets.residentTextureBytes.maxBytes),
    minLit:     num('bminlit',   budgets.pixelFloor.minLitFraction),
    lumaFloor:  num('bluma',     budgets.pixelFloor.lumaFloor),
    minMeanLuma:num('bmeanluma', budgets.pixelFloor.minMeanLuma),
  };

  const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

  /**
   * Draw calls for ONE WHOLE FRAME.
   *
   * ★ READING renderer.info.render.calls DIRECTLY REPORTS 1, AND THAT PASSES EVERY BUDGET.
   *   `info` auto-resets on each render() call, and the last thing this scene renders is a
   *   full-screen composer quad — so a naive read measures the quad, not the room. autoReset
   *   off + a reset at one frame boundary and a read at the next is what counts the depth
   *   prepass, the AO's props pass, the shadow map, the beauty render and every composer pass.
   */
  function frameDraws({ timeoutMs = 5000 } = {}) {
    return new Promise((resolve) => {
      const prevAuto = renderer.info.autoReset;
      renderer.info.autoReset = false;
      let done = false;
      const finish = (v) => { if (done) return; done = true; renderer.info.autoReset = prevAuto; resolve(v); };
      // ★ A HIDDEN OR BACKGROUNDED TAB STOPS requestAnimationFrame, AND THE FIRST VERSION OF
      //   THIS JUST HUNG THERE FOREVER. A rig that hangs is worse than one that fails: it
      //   reads as a slow machine rather than as an unanswerable question. If no frame is
      //   drawn there is no draw count, and saying so is the honest result.
      setTimeout(() => finish({ error: `no frame was drawn within ${timeoutMs} ms — the tab is ` +
        `hidden or backgrounded, so requestAnimationFrame is not running. Bring the page to the ` +
        `front and re-run; a budget measured on a tab that never painted means nothing.` }), timeoutMs);
      requestAnimationFrame(() => {
        renderer.info.reset();
        requestAnimationFrame(() => {
          const { calls, triangles } = renderer.info.render;
          finish({ calls, triangles });
        });
      });
    });
  }

  /** Every unique texture reachable from the scene graph's materials, plus the environment. */
  function residentTextures() {
    const seen = new Set();
    const rows = [];
    const take = (tex, owner) => {
      if (!tex || !tex.isTexture || seen.has(tex)) return;
      seen.add(tex);
      const bytes = textureBytes(tex);
      if (bytes > 0) rows.push({ name: tex.name || owner || '(unnamed)', bytes });
    };
    scene.traverse((o) => {
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m) continue;
        for (const key of Object.keys(m)) {
          const v = m[key];
          if (v && v.isTexture) take(v, `${m.name || o.name}.${key}`);
        }
        // Custom ShaderMaterials hold their maps in uniforms, where the loop above cannot see
        // them — the GI volume and the shafts' depth texture both live here.
        if (m.uniforms) {
          for (const [k, u] of Object.entries(m.uniforms)) {
            if (u && u.value && u.value.isTexture) take(u.value, `${m.name || o.name}.uniforms.${k}`);
          }
        }
        // ★ AND PATCHED MATERIALS CARRY UNIFORM BAGS (TV1, 2026-10-06). The screens' __scr and the
        //   chalkboard's __chalk hold the textures their onBeforeCompile shaders sample — the
        //   mission pages, the glyph atlas, the board's writing. The canvas pages they replaced
        //   lived in __scr too and this rig never saw them; it counts what the bags hold now.
        for (const bag of ['__scr', '__chalk']) {
          if (!m[bag]) continue;
          for (const [k, u] of Object.entries(m[bag])) {
            if (u && u.value && u.value.isTexture) take(u.value, `${m.name || o.name}.${bag}.${k}`);
          }
        }
      }
    });
    take(scene.environment, 'scene.environment');
    take(scene.background, 'scene.background');
    rows.sort((a, b) => b.bytes - a.bytes);
    return { rows, total: rows.reduce((s, r) => s + r.bytes, 0) };
  }

  /**
   * The picture itself. Reads the canvas back and measures how much of it is lit.
   *
   * ★ THIS IS THE CHECK THAT CATCHES THE FAILURE THE OTHERS CANNOT SEE (WG1m): a frame with a
   *   full draw count, every texture resident and every budget green, that renders BLACK.
   *   Cadence and counts cannot tell you there is an image. Only pixels can.
   */
  async function pixelFloor({ timeoutMs = 5000 } = {}) {
    const src = renderer.domElement;
    if (!src.width || !src.height) {
      return { error: `canvas is ${src.width}x${src.height} — nothing was drawn to measure. ` +
                      `A hidden or zero-size viewport produces a meaningless green; show the page and re-run.` };
    }

    // ★ READ THE CANVAS IN THE SAME FRAME THE SCENE DREW IT, OR IT COMES BACK BLACK — AND A
    //   BLACK READING IS INDISTINGUISHABLE FROM THE BUG THIS CHECK EXISTS TO CATCH. The
    //   renderer is built without preserveDrawingBuffer, so the drawing buffer is valid only
    //   until the browser composites; sample it a tick later and you get a cleared buffer.
    //   First run of this check reported 0.0% lit on a 1280x720 canvas that was visibly a fully
    //   rendered room. Fixing it by lowering the floor would have been the disaster: the rig
    //   would then pass a genuinely black frame forever.
    //   Registering from INSIDE a rAF callback puts this after the scene's own callback for the
    //   next frame, so the scene has already rendered when this runs.
    const shot = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), timeoutMs);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          clearTimeout(t);
          const w = 256, h = Math.max(1, Math.round(256 * src.height / src.width));
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(src, 0, 0, w, h);
          resolve({ data: ctx.getImageData(0, 0, w, h).data, w, h });
        });
      });
    });
    if (!shot) {
      return { error: `no frame was drawn within ${timeoutMs} ms — the tab is hidden or ` +
                      `backgrounded. There is no picture to measure; bring the page to the front.` };
    }

    const { data: d, w, h } = shot;
    let lit = 0, sum = 0;
    const n = w * h;
    for (let i = 0; i < n; i++) {
      // Rec. 709 luma on the sRGB values the canvas presents — the same thing an eye judges.
      const l = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
      sum += l;
      if (l > LIMITS.lumaFloor) lit++;
    }
    return { litFraction: lit / n, meanLuma: sum / n, sampled: n, canvas: [src.width, src.height] };
  }

  /** PLT-002 regression guard: the shipping entry must carry no reviewer tooling. */
  function devChrome() {
    const loaded = performance.getEntriesByType('resource')
      .map((e) => e.name)
      .filter((u) => /\/tools\/(feedback|flycam)\.js|TransformControls/.test(u));
    const panels = ['looks', 'fbk'].filter((id) => document.getElementById(id));
    return { modules: loaded.map((u) => u.split('/').pop()), panels };
  }

  /** Nothing may be fetched from another origin at runtime — PLT-001's live half. */
  function network() {
    const here = location.origin + '/';
    const foreign = performance.getEntriesByType('resource')
      .map((e) => e.name)
      .filter((u) => !u.startsWith(here) && !u.startsWith('blob:') && !u.startsWith('data:'));
    return { foreign };
  }

  async function run({ quiet = false } = {}) {
    const checks = [];
    const add = (name, pass, detail, limit) => checks.push({ name, pass, detail, limit });

    const frame = await frameDraws();
    const { calls, triangles, error: frameError } = frame;
    if (frameError) {
      add('draw calls', false, frameError, `≤ ${LIMITS.maxDraws}`);
    } else if (calls < MIN_PLAUSIBLE_DRAWS) {
      // ★ A COUNT THIS LOW IS NOT A MEASUREMENT, AND IT USED TO PASS. `0 calls` and `1 calls`
      //   both sailed under a `≤ 180` limit and reported GREEN — and `1` is the exact number
      //   BUD1 already documented as the trap here, because the last thing a composer scene
      //   draws is one full-screen quad. Seen twice in BUG1 while re-measuring: the rig
      //   answered "0 calls, 0 triangles" and then "1 calls, 1 triangles" on a page that a
      //   hand-rolled frame-boundary sample measured at 233 calls / 1,410,909 triangles
      //   twenty-two times in a row. The frame-boundary read needs consecutive PAINTED frames,
      //   which a preview pane that only composites while it is being screenshotted does not
      //   reliably give — so the honest answer is to refuse a verdict, never to pass one. This
      //   is the "a rig nobody has watched fail" rule applied to the rig's own instrument.
      add('draw calls', false,
        `${calls} calls, ${triangles.toLocaleString()} triangles — REFUSING a verdict: a whole `
        + `frame cannot be ${calls} call(s). The frame-boundary read needs two consecutive `
        + `painted frames; front the tab and re-run autorun().`,
        `≤ ${LIMITS.maxDraws}`);
    } else {
      add('draw calls', calls <= LIMITS.maxDraws,
        `${calls} calls, ${triangles.toLocaleString()} triangles per frame`, `≤ ${LIMITS.maxDraws}`);
    }
    if (!frameError && calls > LIMITS.phoneKnee) {
      checks.push({ name: 'draw calls (phone knee)', pass: true, warn: true,
        detail: `${calls} calls is past the A14 60 FPS knee of ${LIMITS.phoneKnee}`,
        limit: `warn > ${LIMITS.phoneKnee}` });
    }

    const vram = residentTextures();
    add('resident texture bytes', vram.total <= LIMITS.maxVram,
      `${mb(vram.total)} across ${vram.rows.length} textures` +
      (vram.rows.length ? ` — largest: ${vram.rows.slice(0, 3).map(r => `${r.name} ${mb(r.bytes)}`).join(', ')}` : ''),
      `≤ ${mb(LIMITS.maxVram)}`);

    const px = await pixelFloor();
    if (px.error) {
      add('pixel colour floor', false, px.error, `≥ ${LIMITS.minLit}`);
    } else {
      add('pixel colour floor',
        px.litFraction >= LIMITS.minLit && px.meanLuma >= LIMITS.minMeanLuma,
        `${(px.litFraction * 100).toFixed(1)}% of the frame above luma ${LIMITS.lumaFloor}, ` +
        `mean luma ${px.meanLuma.toFixed(3)}, canvas ${px.canvas.join('x')}`,
        `≥ ${(LIMITS.minLit * 100).toFixed(0)}% lit and mean ≥ ${LIMITS.minMeanLuma}`);
    }

    const chrome = devChrome();
    add('no dev chrome', chrome.modules.length === 0 && chrome.panels.length === 0,
      chrome.modules.length || chrome.panels.length
        ? `loaded ${chrome.modules.join(', ') || '—'}; panels ${chrome.panels.join(', ') || '—'}`
        : 'no reviewer modules loaded, no panels in the DOM',
      'none');

    const net = network();
    add('no runtime network', net.foreign.length === 0,
      net.foreign.length ? `${net.foreign.length} foreign request(s): ${net.foreign.slice(0, 3).join(', ')}`
                         : 'every request served from this origin',
      'none');

    const pass = checks.every((c) => c.pass);
    if (!quiet) {
      console.log(`\nBUDGET RIG — ${pass ? 'PASS' : 'FAIL'}`);
      for (const c of checks) {
        const tag = c.warn ? 'WARN' : c.pass ? ' ok ' : 'FAIL';
        console.log(`  [${tag}] ${c.name.padEnd(26)} ${c.detail}   (${c.limit})`);
      }
    }
    return { pass, checks, vramRows: vram.rows.slice(0, 20) };
  }

  /**
   * Run as soon as the page has actually been PAINTING for a while, and stash the verdict.
   *
   * ★ CALLING run() FROM A CONSOLE OR AN AUTOMATION EVAL LANDS BETWEEN PAINTS, AND ON A HIDDEN
   *   OR BACKGROUNDED TAB IT LANDS WHERE THERE ARE NO PAINTS AT ALL — every frame-dependent
   *   check then times out and the rig reports FAIL for the environment rather than for the
   *   build. Counting frames self-synchronises with visibility: the count only advances while
   *   the browser is actually drawing, so by the time it reaches `afterFrames` there is a real
   *   frame to measure. A harness reads window.__budget.result whenever it likes.
   */
  function autorun({ afterFrames = 8 } = {}) {
    const tick = () => {
      api.frames++;
      if (api.frames < afterFrames) { requestAnimationFrame(tick); return; }
      api.running = true;
      run().then((r) => { api.result = r; api.running = false; });
    };
    requestAnimationFrame(tick);
  }


  /**
   * What is actually IN USE and IN VIEW — the baseline a re-dress is judged against.
   *
   * ★ AN ID PASS, NOT A BOUNDING BOX. A bbox says an object is "on screen" while every one of
   *   its pixels is behind a wall; that is how a sofa, a refrigerator and three boxes carried
   *   84.8 MB of texture into a payload nobody could ever see them in (BUD1, 2026-09-10). This
   *   gives each visible mesh a unique flat colour, renders once per pose, and counts the pixels
   *   that survive depth. What it reports is what the frame contains.
   *
   * ⚠ IT IS NOT THE WHOLE TEST FOR DROPPING SOMETHING. A mesh that paints nothing can still cast
   *   a shadow you can see, and this pass has no shadows in it. Confirm any candidate by hiding
   *   it and differencing a LIT frame — and prove your differ works first, with two controls:
   *   hiding a mesh that IS in the picture must move thousands of pixels, and changing nothing
   *   must move zero. (A composited grab that reuses a cached beauty target reports zero for
   *   everything, which is exactly what the second control catches.)
   *
   * @param {object}  [o]
   * @param {number}  [o.width]  render width; the aspect should match the shipping frame
   * @param {boolean} [o.hideMovers] hide skinned/instanced meshes (the cat, the mouse, the jars)
   *                                 so a static prop is not credited to whatever walked in front
   * @returns {{meshes: Array, groups: Array, painted: number, of: number}}
   */
  function census({ width = 1280, hideMovers = true } = {}) {
    if (!three) throw new Error('census needs the THREE namespace — pass `three` to createBudgetRig');
    const camera = scene.getObjectByProperty('isCamera', true) || cameraFallback();
    if (!camera) throw new Error('census: no camera in the scene');
    const height = Math.max(1, Math.round(width / (camera.aspect || 16 / 9)));

    const meshes = [];
    scene.traverse((o) => { if ((o.isMesh || o.isSkinnedMesh || o.isInstancedMesh) && o.visible) meshes.push(o); });
    const movers = hideMovers ? meshes.filter((o) => o.isSkinnedMesh || o.isInstancedMesh) : [];
    const saved = meshes.map((m) => m.material);
    const cmWas = three.ColorManagement.enabled;
    const bgWas = scene.background;
    const clearWas = renderer.getClearColor(new three.Color()).clone(), alphaWas = renderer.getClearAlpha();
    const rt = new three.WebGLRenderTarget(width, height, { type: three.UnsignedByteType });
    const buf = new Uint8Array(width * height * 4);
    try {
      three.ColorManagement.enabled = false;          // or the id colour is converted on upload
      movers.forEach((o) => { o.visible = false; });
      meshes.forEach((m, i) => {
        const id = i + 1;
        const mat = new three.MeshBasicMaterial({ fog: false, toneMapped: false });
        mat.color.setRGB(((id >> 16) & 255) / 255, ((id >> 8) & 255) / 255, (id & 255) / 255);
        const s = Array.isArray(saved[i]) ? saved[i][0] : saved[i];
        // Carry side and depth behaviour across, or glass starts occluding and the answer changes.
        if (s) { mat.side = s.side; mat.depthWrite = s.depthWrite; mat.depthTest = s.depthTest; }
        m.material = mat;
      });
      scene.background = null;
      renderer.setClearColor(0x000000, 1);
      renderer.setRenderTarget(rt);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(rt, 0, 0, width, height, buf);
    } finally {
      meshes.forEach((m, i) => { if (m.material && m.material.dispose) m.material.dispose(); m.material = saved[i]; });
      movers.forEach((o) => { o.visible = true; });
      three.ColorManagement.enabled = cmWas;
      scene.background = bgWas;
      renderer.setRenderTarget(null);
      renderer.setClearColor(clearWas, alphaWas);
      rt.dispose();
    }

    const counts = new Map();
    for (let p = 0; p < buf.length; p += 4) {
      const id = (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2];
      if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }

    // Roll a mesh up to the prop it belongs to; glTF props are groups of primitives.
    const groupOf = (o) => { let n = o, best = null; while (n) { if (n.name && /^Prop_/.test(n.name)) best = n.name; n = n.parent; } return best || o.name || '(unnamed)'; };
    const texOf = (o) => {
      const out = new Set();
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m) continue;
        for (const k of Object.keys(m)) { const v = m[k]; if (v && v.isTexture) out.add(v); }
      }
      return out;
    };
    const groups = new Map();
    for (const o of meshes) {
      const key = groupOf(o);
      let g = groups.get(key);
      if (!g) { g = { name: key, px: 0, tris: 0, tex: new Set() }; groups.set(key, g); }
      const geo = o.geometry;
      if (geo) {
        const n = geo.index ? geo.index.count / 3 : (geo.attributes.position ? geo.attributes.position.count / 3 : 0);
        g.tris += n * (o.isInstancedMesh ? o.count : 1);
      }
      texOf(o).forEach((t) => g.tex.add(t));
    }
    for (const [id, n] of counts) {
      const g = groups.get(groupOf(meshes[id - 1]));
      if (g) g.px += n;
    }
    const rows = [...groups.values()].map((g) => ({
      name: g.name, px: g.px, tris: Math.round(g.tris), textures: g.tex.size,
      textureMB: +([...g.tex].reduce((s, t) => s + textureBytes(t), 0) / (1024 * 1024)).toFixed(2),
    })).sort((a, b) => a.px - b.px || b.textureMB - a.textureMB);

    return { meshes: meshes.length, painted: counts.size, of: meshes.length, width, height, groups: rows };
  }

  function cameraFallback() {
    let cam = null;
    scene.traverse((o) => { if (o.isCamera && !cam) cam = o; });
    return cam;
  }

  // `frames` is exposed because a harness needs to tell "not painted yet" from "measured and
  // green" — on a hidden tab those look identical from the outside.
  const api = { run, autorun, frameDraws, residentTextures, pixelFloor, census, limits: LIMITS,
                result: null, frames: 0, running: false };
  window.__budget = api;
  return api;
}
