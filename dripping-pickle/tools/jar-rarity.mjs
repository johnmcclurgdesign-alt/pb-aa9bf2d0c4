#!/usr/bin/env node
// tools/jar-rarity.mjs — is the odd-jar ladder actually as rare as it claims?
//
// ENV-008's gate is "odd-jar rarity verifiable from the data set". This is that
// verification, and it earns its keep in two halves that fail differently:
//
//   1. DECLARED — reads assets/dripping-pickle/jar-contents.json and prints what
//      the table says: expected sightings per 30-minute dwell, per day, per week.
//      Catches a number typed with the wrong number of zeros.
//   2. OBSERVED — runs tools/jar-contents.js, the selector THE LOOP SHIPS, over a
//      week of jars and counts what comes out. Catches the case where the table
//      is right and the code disagrees with it — which no amount of staring at
//      JSON will find.
//
// ★ IT DELIBERATELY DOES NOT ROLL ITS OWN DICE. A verifier with its own RNG
//   proves the table is well formed and says nothing about the jars a viewer
//   sees. Importing the shipping selector is the entire point of the check.
//
// Exit code is non-zero when observed and declared disagree beyond sampling
// noise, so this can gate a run.
//
//   node tools/jar-rarity.mjs            — the report
//   node tools/jar-rarity.mjs --weeks 8  — a longer observation window

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compileLadder, contentFor, labelFor } from './jar-contents.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const data = JSON.parse(readFileSync(join(repo, 'assets/dripping-pickle/jar-contents.json'), 'utf8'));

const argWeeks = Number(process.argv[process.argv.indexOf('--weeks') + 1]);
const WEEKS = Number.isFinite(argWeeks) && argWeeks > 0 ? argWeeks : 4;

const ladder = compileLadder(data);
const rate = ladder.jarsPerHour;

// The belt's own arithmetic, restated from the data so a bad jarsPerHour is
// visible rather than assumed.
const derived = 3600 * data.belt.speed / data.belt.pitch;
const rateOk = Math.abs(derived - rate) < 1;

console.log(`\njar-contents.json v${data.version} — salt "${data.salt}"`);
console.log(`belt: ${data.belt.speed} m/s / ${data.belt.pitch} m pitch = ${derived.toFixed(1)} jars per hour` +
            `${rateOk ? '' : `  ⚠ data file records ${rate}`}`);
console.log(`${data.contents.length} contents, ${data.labels.variants.length} label variants\n`);

// ── 1. declared ────────────────────────────────────────────────────────────
const hdr = ['content', 'tier', 'mean gap', 'per 30 min', 'per day', 'per week'];
const rows = ladder.table.map(({ content: c, p }) => [
  c.id,
  c.tier,
  `${c.meanIntervalHours} h`,
  (p * rate * 0.5).toFixed(4),
  (p * rate * 24).toFixed(3),
  (p * rate * 24 * 7).toFixed(2),
]);
const w = hdr.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (r) => r.map((c, i) => (i ? c.padStart(w[i]) : c.padEnd(w[i]))).join('  ');
console.log(line(hdr));
console.log(w.map((n) => '─'.repeat(n)).join('  '));
for (const r of rows) console.log(line(r));

const oddPerHalfHour = ladder.oddProbability * rate * 0.5;
console.log(`\nany odd jar: 1 in ${Math.round(1 / ladder.oddProbability).toLocaleString()} jars ` +
            `· one every ${(1 / (ladder.oddProbability * rate)).toFixed(1)} h ` +
            `· ${(100 * (1 - Math.exp(-oddPerHalfHour))).toFixed(0)}% chance in a 30-minute dwell`);

// ── 2. observed ────────────────────────────────────────────────────────────
// Run the shipping selector over WEEKS of belt traffic.
const N = Math.round(rate * 24 * 7 * WEEKS);
const seen = new Map();
const labelCounts = new Array(data.labels.variants.length).fill(0);
for (let i = 0; i < N; i++) {
  const id = contentFor(i, ladder).id;
  seen.set(id, (seen.get(id) || 0) + 1);
  labelCounts[labelFor(i, ladder)]++;
}

console.log(`\nobserved — tools/jar-contents.js over ${N.toLocaleString()} jars (${WEEKS} weeks of belt):`);
let bad = 0;
for (const { content: c, p } of ladder.table) {
  const got = seen.get(c.id) || 0;
  const want = p * N;
  // Poisson: the standard deviation of a count is its own square root. Four of
  // those is a wide band on purpose — this check is looking for a selector that
  // is wrong by an order of magnitude, not for a fair-coin test.
  const tol = Math.max(4 * Math.sqrt(want), 3);
  const ok = Math.abs(got - want) <= tol;
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${c.id.padEnd(14)} ${String(got).padStart(6)} seen, ` +
              `${want.toFixed(1).padStart(8)} expected`);
}
const baselineSeen = seen.get(ladder.baseline.id) || 0;
console.log(`  ok   ${ladder.baseline.id.padEnd(14)} ${String(baselineSeen).padStart(6)} seen ` +
            `(${(100 * baselineSeen / N).toFixed(3)}%)`);

// Labels must be flat AND uncorrelated with content — an odd jar wearing a
// label a viewer could learn to spot gives the whole ladder away, and that is
// the content-predictability half of the naturalness law, not a nicety.
const expect = N / labelCounts.length;
const labelSpread = Math.max(...labelCounts.map((c) => Math.abs(c - expect) / expect));
const oddLabels = new Array(labelCounts.length).fill(0);
let oddTotal = 0;
for (let i = 0; i < N; i++) {
  if (contentFor(i, ladder).tier === 'baseline') continue;
  oddLabels[labelFor(i, ladder)]++; oddTotal++;
}
const oddExpect = oddTotal / oddLabels.length;
const oddSpread = Math.max(...oddLabels.map((c) => Math.abs(c - oddExpect) / oddExpect));
console.log(`\nlabels: ${labelCounts.length} variants, worst deviation from flat ${(100 * labelSpread).toFixed(2)}%`);
console.log(`labels on ODD jars only (${oddTotal}): worst deviation ${(100 * oddSpread).toFixed(1)}%` +
            ` — an odd jar must not be wearing a tell`);
if (labelSpread > 0.02) { console.log('FAIL label distribution is not flat'); bad++; }
// oddTotal is small, so its band is wide; 60% of a ~50-sample bucket is noise.
if (oddSpread > 0.6) { console.log('FAIL odd-jar labels correlate with content'); bad++; }

console.log(bad ? `\n${bad} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(bad ? 1 : 0);
