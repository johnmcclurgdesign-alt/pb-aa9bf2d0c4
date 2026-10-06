// THE SHADER GATE — four rules over every GLSL block this repo authors.
//
// Rule 0 guards the one syntax error that keeps costing a debugging round: GLSL lives in JS
// template literals, and a backtick inside a GLSL comment CLOSES the literal. The SyntaxError
// points at the next GLSL word — "Unexpected identifier 'phi'" — which is nowhere near the
// backtick, so it reads as a shader problem rather than a quoting one. It has happened twice.
//
// Rules 1–3 (CMP2, 2026-09-13, #125) guard PORTABILITY, and each exists because a Loop shipped
// the mistake and a different GPU drew a different picture (loops-docs 30-engines/web/00-status.md
// §5). All three are static properties of our own source, so they are a grep, not a device leg:
//
//   1. smoothstep(edge0, edge1, x) is UNDEFINED when edge0 >= edge1 — not "reversed", not
//      "clamped the other way". Vibes VC6: a light pool rendered correctly previewed alone and
//      INVERTED inside the full scene, same machine, same GPU. Write 1.0 - smoothstep(lo,hi,x).
//   2. sin()/cos()/tan() precision is UNDEFINED outside a small range (GLSL ES §8.1).
//      Vibes VC-059: a curtain drew as a checkerboard on an Apple TV 4K 1st gen (A10X) and
//      correctly on a 3rd gen (A15) — a phase that reached ±77.5 rad. An argument that names a
//      screen or world coordinate must be wrapped into (-pi, pi] first, in plain float
//      arithmetic. wrapPhase(x) (tools/looks.js COMMON) is that wrap and satisfies this rule.
//      The fract(sin(dot(...))) hash idiom is deliberately out of range and wrapping it
//      DESTROYS the hash; it does not name a screen symbol directly, so it does not trip here.
//      Its real hazard is unbounded GROWTH, bounded at the call site instead (tools/lens.js).
//   3. A raw epoch in a float uniform. Date.now()/1000 is ~1.79e9, where float32's ULP is
//      ~213 SECONDS: the uniform cannot represent the current second at all. The failure is
//      slow — the picture holds for a minute and then corrupts as real time walks the mantissa.
//
//   node tools/check-shaders.mjs
//   node tools/check-shaders.mjs --selftest     # plants all three and requires each to be caught
//
// Exits non-zero and names the file and line for every hit.
//
// vendor/ is excluded. It is three.js's own source, not ours — sweeping it would report
// hundreds of hits in code we do not author and cannot change
// (docs/lessons/the-sweep-target-is-the-shipping-graph-not-the-payload.md).

import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve, extname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SELFTEST = process.argv.includes('--selftest');
const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));

const SKIP_DIRS = new Set(['.git', 'node_modules', 'assets', 'vendor', 'build', 'release', '.work', '.variants']);

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (['.js', '.mjs', '.html'].includes(extname(e.name))) yield p;
  }
}

// A shader block is a template literal that opens after any of three things. Rather than parse
// JS, scan for each and read to the closing backtick:
//   1. a /* glsl */ marker
//   2. a vertexShader: / fragmentShader: property
//   3. a const whose NAME says GLSL or shader. CMP2 found tools/screen-content.js declaring
//      `export const SCREEN_CONTENT_GLSL = ...` — ZERO recognised blocks, so the gate had been
//      blind to the whole screens shader, rule 0 included, for as long as it has existed. A
//      check that cannot SEE a file reports success for it.
const OPENERS = [
  /\/\*\s*glsl\s*\*\/\s*`/g,
  /(?:vertexShader|fragmentShader)\s*:\s*`/g,
  /\b\w*(?:GLSL|Glsl|glsl|SHADER|Shader)\w*\s*=\s*`/g,
];

/** Every GLSL block in src, as { start, end } offsets into src. */
function shaderBlocks(src) {
  const out = [];
  for (const re of OPENERS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const start = m.index + m[0].length;
      let i = start, depth = 0;
      for (; i < src.length; i++) {
        const c = src[i];
        if (c === '\\') { i++; continue; }
        if (c === '$' && src[i + 1] === '{') { depth++; i++; continue; }
        if (c === '}' && depth > 0) { depth--; continue; }
        if (c === '`' && depth === 0) break;
      }
      out.push({ start, end: i });
      re.lastIndex = i + 1;
    }
  }
  // A block can match more than one opener (a /* glsl */ marker on a const named *_GLSL),
  // so dedupe by start offset or every hit inside it is reported twice.
  const seen = new Set();
  return out.filter((b) => (seen.has(b.start) ? false : seen.add(b.start)))
            .sort((a, b) => a.start - b.start);
}

/** The text of a call's arguments, given the offset of its '('. */
function argsAt(src, openParen) {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return src.slice(openParen + 1, i); }
  }
  return null;
}

/** Split on top-level commas only. */
function splitArgs(s) {
  const out = []; let depth = 0, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(last, i)); last = i + 1; }
  }
  out.push(s.slice(last));
  return out.map((x) => x.trim());
}

/** Blank GLSL comments in place (offsets preserved) so a rule never fires on prose. */
function decomment(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
          .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

const NUM = /^[-+]?(?:\d+\.?\d*|\.\d+)$/;

// An edge written as a simple affine function of ONE identifier: ident, ident*k, k*ident,
// ident-k, ident+k. Returns { id, m, c } meaning m*id + c, or null if it is anything else.
// This exists because the two reversals that actually shipped here were SYMBOLIC, not literal:
// smoothstep(rad, rad * 0.55, d) in tools/lens.js and smoothstep(radius, radius - 0.12, ...)
// in tools/looks.js. A rule that only reads literal edges leaves the shipping form uncovered.
function affine(expr) {
  const e = expr.trim();
  let m;
  if (/^[A-Za-z_]\w*$/.test(e)) return { id: e, m: 1, c: 0 };
  if ((m = e.match(/^([A-Za-z_]\w*)\s*\*\s*([-+]?[\d.]+)$/))) return { id: m[1], m: parseFloat(m[2]), c: 0 };
  if ((m = e.match(/^([-+]?[\d.]+)\s*\*\s*([A-Za-z_]\w*)$/))) return { id: m[2], m: parseFloat(m[1]), c: 0 };
  if ((m = e.match(/^([A-Za-z_]\w*)\s*([-+])\s*([\d.]+)$/))) {
    return { id: m[1], m: 1, c: (m[2] === '-' ? -1 : 1) * parseFloat(m[3]) };
  }
  return null;
}

/**
 * Is smoothstep(a, b, ...) descending — i.e. a >= b, which the GLSL spec leaves UNDEFINED?
 * Two forms are decidable statically; anything else is left alone rather than guessed at.
 */
function descendingEdges(a, b) {
  if (NUM.test(a) && NUM.test(b)) return parseFloat(a) >= parseFloat(b);
  const fa = affine(a), fb = affine(b);
  // Same identifier, and a >= b for every positive value of it (radii and distances are
  // positive here). Both conditions must hold, so an ascending pair like
  // (radius - 0.14, radius) is correctly left alone.
  if (fa && fb && fa.id === fb.id) return fa.m >= fb.m && fa.c >= fb.c;
  return false;
}

// Symbols whose magnitude is a screen or world coordinate — the ones §5 names.
const BIG_ARG = /\b(uResolution|gl_FragCoord|vWorldPosition|worldPos|wPos|vWorldPos)\b/;

/** Run every rule over one file. Returns [{ rule, line, text }]. */
function checkFile(src) {
  const hits = [];
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  const textOf = (i) => {
    const nl = src.indexOf('\n', i);
    return src.slice(src.lastIndexOf('\n', i) + 1, nl < 0 ? src.length : nl).trim();
  };

  // ---- rule 0: a backtick inside a GLSL comment closed the literal early ------------------
  for (const { end } of shaderBlocks(src)) {
    const endLine = src.slice(src.lastIndexOf('\n', end) + 1, end);
    if (endLine.includes('//')) {
      hits.push({ rule: 'backtick-in-glsl-comment', line: lineOf(end), text: `${endLine.trim()}\`` });
    }
  }

  // ---- rules 1 and 2 apply INSIDE shader blocks only ---------------------------------------
  for (const { start, end } of shaderBlocks(src)) {
    // Keep offsets aligned with src so line numbers stay true: blank everything outside.
    const masked = ' '.repeat(start) + decomment(src.slice(start, end));
    let m;

    const ss = /\bsmoothstep\s*\(/g;
    while ((m = ss.exec(masked))) {
      const open = m.index + m[0].length - 1;
      const args = argsAt(masked, open);
      if (!args) continue;
      const a = splitArgs(args);
      if (a.length < 2) continue;
      if (descendingEdges(a[0], a[1])) {
        hits.push({ rule: 'reversed-smoothstep', line: lineOf(m.index), text: textOf(m.index) });
      }
    }

    // A trig argument rarely names uResolution directly — the BLUEPRINT look wrote
    //   vec2 p = vUv * uResolution;  ...  sin((p.x * 0.6 + p.y * 0.6) * 0.5)
    // and reached ~1,800 rad through `p`. So taint locals assigned FROM a screen or world
    // symbol and treat them as that symbol. Only MULTIPLICATION taints: `vec2 px = 1.0 /
    // uResolution` is a pixel size, which is tiny, and tainting it would be a false positive.
    const tainted = new Set();
    const decl = /\b(?:float|vec2|vec3|vec4)\s+(\w+)\s*=\s*([^;]*);/g;
    let d;
    while ((d = decl.exec(masked))) {
      const [, name, rhs] = d;
      const namesBig = BIG_ARG.test(rhs) || [...tainted].some((t) => new RegExp(`\\b${t}\\b`).test(rhs));
      const divides = /\/\s*(?:uResolution|gl_FragCoord)/.test(rhs);
      if (namesBig && !divides) tainted.add(name);
    }
    const isBig = (arg) => BIG_ARG.test(arg) || [...tainted].some((t) => new RegExp(`\\b${t}\\b`).test(arg));

    const trig = /\b(sin|cos|tan)\s*\(/g;
    while ((m = trig.exec(masked))) {
      const open = m.index + m[0].length - 1;
      const arg = argsAt(masked, open);
      if (arg == null) continue;
      if (isBig(arg) && !/\bwrapPhase\s*\(/.test(arg)) {
        hits.push({ rule: 'unwrapped-trig-argument', line: lineOf(m.index), text: textOf(m.index) });
      }
    }
  }

  // ---- rule 3 applies to the JS side: a uniform written from a raw epoch --------------------
  const js = decomment(src);
  const uni = /\.value\s*=\s*([^;\n]*)/g;
  let m;
  while ((m = uni.exec(js))) {
    if (/\bDate\.now\s*\(\s*\)/.test(m[1])) {
      hits.push({ rule: 'epoch-in-float-uniform', line: lineOf(m.index), text: textOf(m.index) });
    }
  }
  return hits;
}

const RULE_TEXT = {
  'backtick-in-glsl-comment': 'shader literal ends inside a GLSL comment — a backtick in the comment closed it early',
  'reversed-smoothstep': 'smoothstep(edge0, edge1, x) with edge0 >= edge1 is UNDEFINED — write 1.0 - smoothstep(lo, hi, x)',
  'unwrapped-trig-argument': 'sin/cos/tan on a screen or world coordinate — wrap into (-pi, pi] first (wrapPhase)',
  'epoch-in-float-uniform': 'a raw epoch in a float uniform — float32 ULP at 1.79e9 is ~213 s; wrap before it crosses to the GPU',
};

// This file CONTAINS deliberate specimens of all three violations — the selftest's plants are
// string literals in it — so it must not sweep itself, exactly as a linter excludes its own
// fixtures. The plants are still proved: the selftest writes them to a temp fixture and runs
// the real sweep over that.
const SELF = resolve(fileURLToPath(import.meta.url));

async function sweep(root) {
  const all = [];
  for await (const file of walk(root)) {
    if (resolve(file) === SELF) continue;
    const src = await readFile(file, 'utf8');
    for (const h of checkFile(src)) all.push({ ...h, file: relative(root, file) });
  }
  return all;
}

// ---------------------------------------------------------------------------- selftest
//
// THE SELFTEST NAMES ITS OWN VICTIM. It writes a fixture it fully controls rather than picking
// "the first file that looks like X" out of the repo — a selftest that chooses its victim by a
// property of the FILE goes red the day a new file has that property, which has now happened
// twice here (docs/lessons/a-selftest-must-name-its-victim-precisely.md).

const CLEAN_FIXTURE = [
  'const FRAG = /* glsl */`',
  '  uniform vec2 uResolution;',
  '  uniform float uTime;',
  '  varying vec2 vUv;',
  '  float wrapPhase(float x) { return x - 6.28318530718 * floor(x / 6.28318530718 + 0.5); }',
  '  void main() {',
  '    float rad = 0.4, d = length(vUv - 0.5);',
  '    vec2 sp = vUv * uResolution;',
  '    float g = sin(wrapPhase(sp.x * 0.6 + sp.y * 0.6));',
  '    float fade = 1.0 - smoothstep(0.2, 0.8, vUv.x);',
  '    float disc = 1.0 - smoothstep(rad * 0.55, rad, d);',
  '    float w = sin(wrapPhase(vUv.y * uResolution.y * 1.4));',
  '    gl_FragColor = vec4(vec3(fade * w * disc * g), 1.0);',
  '  }',
  '`;',
  'material.uniforms.uTime.value = clock.getElapsedTime() % 86400;',
  '',
].join('\n');

const PLANTS = {
  'reversed-smoothstep': [
    'float fade = 1.0 - smoothstep(0.2, 0.8, vUv.x);',
    'float fade = smoothstep(0.8, 0.2, vUv.x);',
  ],
  'unwrapped-trig-argument': [
    'float w = sin(wrapPhase(vUv.y * uResolution.y * 1.4));',
    'float w = sin(vUv.y * uResolution.y * 1.4);',
  ],
  // the TAINTED-LOCAL form — the site #125 named in BLUEPRINT, where the argument never
  // mentions uResolution at all
  'unwrapped-trig-argument-tainted': [
    'float g = sin(wrapPhase(sp.x * 0.6 + sp.y * 0.6));',
    'float g = sin(sp.x * 0.6 + sp.y * 0.6);',
  ],
  'epoch-in-float-uniform': [
    'material.uniforms.uTime.value = clock.getElapsedTime() % 86400;',
    'material.uniforms.uTime.value = Date.now() / 1000;',
  ],
  // the SYMBOLIC reversal — the form that actually shipped (tools/lens.js:108)
  'reversed-smoothstep-symbolic': [
    'float disc = 1.0 - smoothstep(rad * 0.55, rad, d);',
    'float disc = smoothstep(rad, rad * 0.55, d);',
  ],
};

async function selftest() {
  const dir = await mkdtemp(join(tmpdir(), 'dp-shader-selftest-'));
  let failures = 0;
  try {
    await writeFile(join(dir, 'fixture.js'), CLEAN_FIXTURE);
    const clean = await sweep(dir);
    if (clean.length) {
      console.error('FAIL  selftest: the clean fixture is not clean —', clean.map((h) => `${h.rule}@${h.line}`).join(', '));
      failures++;
    } else {
      console.log('ok    selftest: the clean fixture passes every rule');
    }

    for (const [key, [from, to]] of Object.entries(PLANTS)) {
      const rule = key.replace(/-(symbolic|tainted)$/, '');
      if (!CLEAN_FIXTURE.includes(from)) {
        console.error(`FAIL  selftest: plant '${key}' names a line the fixture does not contain`);
        failures++; continue;
      }
      await writeFile(join(dir, 'fixture.js'), CLEAN_FIXTURE.replace(from, to));
      const hits = await sweep(dir);
      const caught = hits.filter((h) => h.rule === rule);
      const others = hits.filter((h) => h.rule !== rule);
      if (caught.length === 1 && others.length === 0) {
        console.log(`ok    selftest: plant '${key}' fails on the NAMED rule  (fixture.js:${caught[0].line})`);
      } else {
        console.error(`FAIL  selftest: plant '${key}' -> ${caught.length} on the named rule, ${others.length} on others`);
        failures++;
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  if (failures) {
    console.error(`\nSHADER SELFTEST FAILED — ${failures} case(s) did not behave`);
    process.exit(1);
  }
  console.log('\nSHADER SELFTEST PASS — every rule was watched failing on a planted violation');
}

// ---------------------------------------------------------------------------- main

if (SELFTEST) {
  await selftest();
} else {
  const hits = await sweep(REPO);
  if (hits.length) {
    const byRule = new Map();
    for (const h of hits) byRule.set(h.rule, [...(byRule.get(h.rule) ?? []), h]);
    for (const [rule, list] of byRule) {
      console.error(`\n${rule}: ${RULE_TEXT[rule]}`);
      for (const h of list) console.error(`  ${h.file}:${h.line}: ${h.text}`);
    }
    console.error(`\n${hits.length} shader portability violation(s) across ${byRule.size} rule(s).`);
    process.exit(1);
  }
  console.log('shader blocks clean — no backticks in GLSL comments, no reversed smoothstep, no unwrapped trig, no epoch uniform');
}
