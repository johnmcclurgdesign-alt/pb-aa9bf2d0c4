// Traceability for the KN1 knowledge split: prove nothing was CUT when the engineering log
// moved out of CLAUDE.md into docs/lessons/.
//
// The log was 3,184 lines of traps that each cost a day. A migration that loses one of them
// loses it SILENTLY — the new file reads beautifully, every gate stays green, and the fact is
// gone until somebody rediscovers it the expensive way. So this check does not ask whether the
// new tree looks right; it asks, of every line of the ORIGINAL file, "where did this go?".
//
//   node tools/check-lessons.mjs          # the three tiers below, against the pinned baseline
//   node tools/check-lessons.mjs --list   # also print every destination file and its line count
//   node tools/check-lessons.mjs --selftest   # plant four omissions; each MUST be caught
//
// Tier 1  every `## ` / `### ` heading of the baseline has a destination — the heading line
//         itself survives somewhere, or a lesson's `source:` field names the section.
// Tier 2  every ★ line of the baseline appears VERBATIM in a docs/lessons file. ★ marks a
//         load-bearing trap; CLAUDE.md is not an acceptable home for one any more.
// Tier 3  every other non-blank line of the baseline appears verbatim in docs/lessons OR in
//         the current CLAUDE.md. Deliberate rewrites go in docs/lessons/.migration-exceptions
//         with a reason, and a stale entry there is itself an error.
// Tier 4  index integrity, which keeps earning its keep after the migration: README.md links
//         every lesson file, every link resolves, and the frontmatter is well formed.
//
// Matching is whitespace-normalised and list-marker-insensitive, so re-indenting a bullet or
// unwrapping it into a paragraph is fine; rewording is not. That is the point.
//
// Exits non-zero with the unaccounted-for lines named, and their baseline line numbers.

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const LESSONS = join(ROOT, 'docs', 'lessons');
const EXCEPTIONS = join(LESSONS, '.migration-exceptions');

// The pre-KN1 CLAUDE.md, pinned to the commit that still held it. A ref like `sprint/001`
// would follow the branch: after the split lands, the check would read the NEW file as its
// own baseline and pass trivially, which is the one failure mode a traceability check must
// not have. `df7bf59` is the BUG1 merge — the last commit with the whole log in one file.
const BASELINE_REF = 'df7bf59';
const BASELINE_PATH = 'CLAUDE.md';

const TYPES = new Set(['trap', 'measurement', 'method', 'rule']);

// ---------------------------------------------------------------- normalisation

// Collapse whitespace, drop a leading list marker or blockquote. Everything else — case,
// punctuation, emphasis, backticks, the em dashes — has to match, because a number or a
// file path that drifted is exactly what this check exists to catch.
function norm(line) {
  return line
    .normalize('NFC')
    .replace(/ /g, ' ')
    .replace(/^\s*(?:[-*+]\s+|>\s+)/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// A line with no letters or digits (`---`, `| --- | --- |`, ` ``` `) carries no fact, and
// asking where it went produces noise rather than signal.
function isStructural(line) {
  return !/[0-9A-Za-z]/.test(line);
}

// ---------------------------------------------------------------- inputs

function baselineText() {
  if (process.env.KN1_BASELINE_FILE) return readFileSync_(process.env.KN1_BASELINE_FILE);
  return execFileSync('git', ['-C', ROOT, 'show', `${BASELINE_REF}:${BASELINE_PATH}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readFileSync_(p) {
  return execFileSync('cat', [p], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

async function lessonFiles() {
  const out = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  }
  if (existsSync(LESSONS)) await walk(LESSONS);
  return out.sort();
}

function frontmatter(src) {
  if (!src.startsWith('---\n')) return null;
  const end = src.indexOf('\n---', 4);
  if (end < 0) return null;
  const fm = {};
  for (const line of src.slice(4, end).split('\n')) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    // A value carrying ": " is double-quoted (the convention the app repo's lessons use), so
    // unquote before comparing — otherwise an escaped quote inside a heading defeats tier 1.
    if (v.startsWith('"') && v.endsWith('"') && v.length > 1) {
      v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    fm[m[1]] = v;
  }
  return fm;
}

// ---------------------------------------------------------------- the check

async function run({ list = false, quiet = false } = {}) {
  const problems = [];
  const note = (s) => { if (!quiet) console.log(s); };

  const baseline = baselineText().split('\n');
  const files = await lessonFiles();
  const readmePath = join(LESSONS, 'README.md');

  // Destination sets. `lessonLines` is every line of every lessons file; `anyLines` adds the
  // current CLAUDE.md, which is a legitimate home for anything that was never a ★.
  const lessonLines = new Set();
  const perFile = [];
  for (const f of files) {
    const src = await readFile(f, 'utf8');
    const lines = src.split('\n');
    for (const l of lines) lessonLines.add(norm(l));
    perFile.push([relative(ROOT, f), lines.length]);
  }
  const anyLines = new Set(lessonLines);
  const claudeNow = existsSync(join(ROOT, 'CLAUDE.md'))
    ? await readFile(join(ROOT, 'CLAUDE.md'), 'utf8')
    : '';
  for (const l of claudeNow.split('\n')) anyLines.add(norm(l));

  // Every `source:` field, joined — tier 1 asks whether a section is NAMED by some lesson.
  const sources = [];
  for (const f of files) {
    const fm = frontmatter(await readFile(f, 'utf8'));
    if (fm?.source) sources.push(norm(fm.source));
  }
  const sourceBlob = sources.join('\n');

  // Exceptions: raw baseline lines deliberately not moved verbatim. `#!` comments carry why.
  const exceptions = new Set();
  const exceptionRaw = [];
  if (existsSync(EXCEPTIONS)) {
    for (const line of (await readFile(EXCEPTIONS, 'utf8')).split('\n')) {
      if (!line.trim() || line.startsWith('#!')) continue;
      exceptions.add(norm(line));
      exceptionRaw.push(line);
    }
  }

  // ---- tier 1: headings
  const headings = [];
  baseline.forEach((line, i) => {
    const m = /^(#{1,3})\s+(.*\S)\s*$/.exec(line);
    if (m && m[1].length >= 2) headings.push({ n: i + 1, text: m[2], line });
  });
  const headingMisses = headings.filter(
    (h) => !anyLines.has(norm(h.line)) && !sourceBlob.includes(norm(h.text)),
  );
  note(`tier 1  headings: ${headings.length - headingMisses.length}/${headings.length} placed`);
  for (const h of headingMisses) problems.push(`tier 1  line ${h.n}  no destination for heading: ${h.text}`);

  // ---- tier 2: ★ lines, which must live in docs/lessons
  const stars = [];
  baseline.forEach((line, i) => { if (line.includes('★')) stars.push({ n: i + 1, line }); });
  const starMisses = stars.filter((s) => !lessonLines.has(norm(s.line)));
  note(`tier 2  ★ lines: ${stars.length - starMisses.length}/${stars.length} in docs/lessons`);
  for (const s of starMisses) {
    problems.push(`tier 2  line ${s.n}  ★ line not found in any docs/lessons file: ${s.line.trim().slice(0, 100)}`);
  }

  // ---- tier 3: everything else
  const content = [];
  baseline.forEach((line, i) => {
    if (!line.trim() || isStructural(line) || line.includes('★')) return;
    if (/^#{1,3}\s/.test(line)) return; // counted by tier 1
    content.push({ n: i + 1, line });
  });
  const contentMisses = content.filter(
    (c) => !anyLines.has(norm(c.line)) && !exceptions.has(norm(c.line)),
  );
  note(`tier 3  content lines: ${content.length - contentMisses.length}/${content.length} placed` +
       (exceptions.size ? `, ${exceptions.size} declared exception(s)` : ', no exceptions declared'));
  for (const c of contentMisses.slice(0, 60)) {
    problems.push(`tier 3  line ${c.n}  no destination: ${c.line.trim().slice(0, 100)}`);
  }
  if (contentMisses.length > 60) {
    problems.push(`tier 3  …and ${contentMisses.length - 60} more unaccounted-for lines`);
  }

  // A stale exception is an error: it claims a baseline line was deliberately rewritten, and
  // if that line is no longer in the baseline the claim is about nothing.
  const baselineNorm = new Set(baseline.map(norm));
  for (const raw of exceptionRaw) {
    if (!baselineNorm.has(norm(raw))) {
      problems.push(`tier 3  stale exception (no such baseline line): ${raw.trim().slice(0, 90)}`);
    }
  }

  // ---- tier 4: index integrity and frontmatter
  const readme = existsSync(readmePath) ? await readFile(readmePath, 'utf8') : '';
  const linked = new Set(
    [...readme.matchAll(/\]\(([^)\s]+\.md)\)/g)].map((m) => m[1].replace(/^\.\//, '')),
  );
  let unlisted = 0;
  let badFm = 0;
  for (const f of files) {
    const rel = relative(LESSONS, f);
    if (rel === 'README.md') continue;
    if (!linked.has(rel)) { problems.push(`tier 4  not listed in docs/lessons/README.md: ${rel}`); unlisted++; }
    const src = await readFile(f, 'utf8');
    const fm = frontmatter(src);
    const slug = rel.replace(/\.md$/, '').split('/').pop();
    if (!fm) { problems.push(`tier 4  no frontmatter: ${rel}`); badFm++; continue; }
    for (const k of ['name', 'description', 'type', 'source']) {
      if (!fm[k]) { problems.push(`tier 4  frontmatter missing \`${k}\`: ${rel}`); badFm++; }
    }
    if (fm.name && fm.name !== slug) {
      problems.push(`tier 4  frontmatter name \`${fm.name}\` does not match the filename: ${rel}`);
      badFm++;
    }
    if (fm.type && !TYPES.has(fm.type)) {
      problems.push(`tier 4  type \`${fm.type}\` is not one of ${[...TYPES].join(' | ')}: ${rel}`);
      badFm++;
    }
  }
  for (const l of linked) {
    if (!existsSync(join(LESSONS, l))) problems.push(`tier 4  README.md links a file that does not exist: ${l}`);
  }
  note(`tier 4  lessons: ${files.length - 1} file(s), ${unlisted} unlisted, ${badFm} frontmatter problem(s)`);

  if (list) {
    note('');
    for (const [f, n] of perFile) note(`  ${String(n).padStart(5)}  ${f}`);
  }

  return problems;
}

// ---------------------------------------------------------------- selftest
//
// A check nobody has watched fail is a check that reports success when it is broken (the
// budget rig passed itself on "0 calls" — BUG1). Each case plants ONE omission and the check
// must catch it; a case that passes is a tier that is not doing its job.
async function selftest() {
  const files = (await lessonFiles()).filter((f) => !f.endsWith('README.md'));
  if (!files.length) {
    console.error('selftest: no lesson files to mutate — run the check itself first');
    process.exit(2);
  }
  const base = await run({ quiet: true });
  if (base.length) {
    console.error(`selftest: the tree is already failing (${base.length} problem(s)) — fix that first`);
    process.exit(2);
  }

  const cases = [];
  // 1. a ★ line deleted from a lesson (tier 2)
  // ⚠ IT HAS TO BE A ★ LINE OF THE BASELINE, NOT ANY ★ LINE. Tier 2 asks where the pre-KN1
  //   log's 188 ★ entries went, so deleting a ★ a LATER row wrote is not an omission and
  //   nothing is reported — correctly. The first version of this picked the first file
  //   containing a ★ at all, and it passed for exactly as long as no new lesson sorted ahead
  //   of the migrated ones. ART1 added `a-blender-emission-colour-is-linear.md`, which does,
  //   and the selftest went red on its own instrument rather than on the tree.
  const baselineStars = new Set(
    baselineText().split('\n').filter((l) => l.includes('★')).map(norm));
  const starFile = await (async () => {
    for (const f of files) {
      const lines = (await readFile(f, 'utf8')).split('\n');
      if (lines.some((l) => l.includes('★') && baselineStars.has(norm(l)))) return f;
    }
    return null;
  })();
  if (starFile) {
    cases.push({
      name: 'a ★ line deleted from a lesson',
      file: starFile,
      // Drop only the baseline's ★ lines: a file can carry both kinds.
      mutate: (s) => s.split('\n')
        .filter((l) => !(l.includes('★') && baselineStars.has(norm(l)))).join('\n'),
      expect: /tier 2/,
    });
  }
  // 2. a whole lesson file emptied (tier 2 or 3, plus the index)
  cases.push({
    name: 'a whole lesson file emptied',
    file: files[Math.floor(files.length / 2)],
    mutate: () => '---\nname: x\ndescription: x\ntype: trap\nsource: x\n---\n',
    expect: /tier [234]/,
  });
  // 3. a measured number reworded (tier 3) — the failure mode a "looks complete" review misses
  // ⚠ SAME RULE AS CASE 1: THE NUMBER HAS TO SIT ON A LINE OF THE BASELINE. Tier 3 asks where the
  //   pre-KN1 log's content lines went, so rewording a number a LATER row measured is correctly
  //   silent. The first version picked the first file containing `**<digits>` at all; CMP1 added
  //   `a-binding-with-no-extensions-readies-a-flat-room.md` (with **1,808** in it), which sorts
  //   ahead of every migrated file, and this case went red on its own instrument — the second
  //   time in two days the selftest chose its victim by a property of the file rather than of
  //   the baseline (a-selftest-must-name-its-victim-precisely).
  const baselineLines = new Set(baselineText().split('\n').map(norm));
  const numPick = await (async () => {
    for (const f of files) {
      const lines = (await readFile(f, 'utf8')).split('\n');
      const line = lines.find((l) => /\*\*[\d.]+/.test(l) && baselineLines.has(norm(l)));
      if (line) return { file: f, line };
    }
    return null;
  })();
  if (numPick) {
    cases.push({
      name: 'a measured number reworded inside a lesson',
      file: numPick.file,
      // Reword the number on THAT line only: a file can carry both kinds.
      mutate: (s) => s.split('\n').map((l) => l === numPick.line
        ? l.replace(/(\*\*)([\d.]+)/, (_, a, b) => `${a}${Number(b) + 1}`) : l).join('\n'),
      expect: /tier [23]/,
    });
  }
  // 4. a lesson dropped from the index (tier 4)
  cases.push({
    name: 'a lesson dropped from the index',
    file: join(LESSONS, 'README.md'),
    mutate: (s) => {
      const rel = relative(LESSONS, files[0]);
      return s.split('\n').filter((l) => !l.includes(`(${rel})`)).join('\n');
    },
    expect: /tier 4/,
  });

  let failed = 0;
  for (const c of cases) {
    const original = await readFile(c.file, 'utf8');
    await writeFile(c.file, c.mutate(original));
    let problems = [];
    try {
      problems = await run({ quiet: true });
    } finally {
      await writeFile(c.file, original);
    }
    const caught = problems.some((p) => c.expect.test(p));
    console.log(`  ${caught ? 'ok   ' : 'FAIL '} ${c.name} — ${problems.length} problem(s) reported` +
                (caught ? '' : `, none matching ${c.expect}`));
    if (!caught) failed++;
  }

  const after = await run({ quiet: true });
  if (after.length) {
    console.error(`selftest: the tree did not come back clean (${after.length} problem(s)) — restore failed`);
    process.exit(2);
  }
  console.log(`  ok    the tree is clean again after every mutation`);

  if (failed) {
    console.error(`\nSELFTEST FAILED — ${failed} planted omission(s) went unnoticed`);
    process.exit(1);
  }
  console.log(`\nSELFTEST OK — ${cases.length} planted omissions, all caught`);
}

// ---------------------------------------------------------------- main

const args = process.argv.slice(2);
if (args.includes('--selftest')) {
  await selftest();
} else {
  const problems = await run({ list: args.includes('--list') });
  if (problems.length) {
    console.error(`\nLESSONS CHECK FAILED — ${problems.length} problem(s)\n`);
    for (const p of problems) console.error('  ' + p);
    console.error(`\nbaseline: ${BASELINE_REF}:${BASELINE_PATH} (the pre-KN1 log)`);
    process.exit(1);
  }
  console.log('\nLESSONS OK — every heading, every ★ line and every content line of the pre-KN1 log has a home');
}
