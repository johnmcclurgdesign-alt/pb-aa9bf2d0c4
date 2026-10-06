// tools/jar-contents.js — what is inside jar number N.
//
// ENV-008, the odd-jar variant system. The DATA is assets/dripping-pickle/
// jar-contents.json; this is the one function that reads it, and it is shared
// by the loop and by `node tools/jar-rarity.mjs` on purpose:
//
//   ★ A RARITY CLAIM VERIFIED AGAINST A SECOND IMPLEMENTATION IS NOT VERIFIED.
//   If the auditor rolls its own dice, it proves the *table* is well formed and
//   says nothing about the jars a viewer actually sees. The check has to run the
//   shipping selector over the shipping data, which is why this file has no
//   three.js import and no DOM in it.
//
// Two properties the rest of the row leans on:
//
// - It is a PURE FUNCTION OF THE JAR'S GLOBAL INDEX. Not of a local RNG, not of
//   frame order, not of when a viewer opened the page. Two clients that agree
//   about the clock therefore agree about every jar on the belt, which is what
//   PLAN §3's shared-time rule and the DP-W4 determinism check will want. There
//   is no state to resynchronise on resume — the answer is recomputed.
// - Rarity is declared as a MEAN INTERVAL IN HOURS and converted here using the
//   belt's own jar rate. Declaring weights instead would mean a change to belt
//   speed or jar pitch silently re-tunes the whole ladder: the same weight table
//   reads "twice a shift" at one speed and "never" at another.

// ── hashing ────────────────────────────────────────────────────────────────
// A 32-bit integer hash (Murmur3 finaliser over a salted index). It has to be
// exactly reproducible in two runtimes, so everything is forced through |0 and
// >>> 0 rather than trusting JS number semantics at the boundaries.
export function hash32(n, salt = 0) {
  let h = (n | 0) ^ (salt | 0);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// A stable 32-bit hash of a string, so the salt can be a readable name in the
// data file rather than a magic number.
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// hash32 → [0, 1). Two different streams off one index need two different
// salts; reusing one salt for content and label correlates them, which is
// exactly the "content predictability" half of the naturalness law.
const unit = (n, salt) => hash32(n, salt) / 4294967296;

// ── the ladder ─────────────────────────────────────────────────────────────

/**
 * Compile the JSON into a lookup table: cumulative probabilities per jar,
 * with the baseline soaking up whatever is left.
 *
 * @param data       the parsed jar-contents.json
 * @param jarsPerHour measured from the live belt (3600 * speed / pitch).
 *                    Falls back to the value recorded in the data file.
 */
export function compileLadder(data, jarsPerHour = data.belt.jarsPerHour) {
  const salt = hashString(data.salt);
  const odd = data.contents.filter((c) => c.tier !== 'baseline');
  const baseline = data.contents.find((c) => c.tier === 'baseline');
  if (!baseline) throw new Error('jar-contents.json has no baseline content');

  let acc = 0;
  const table = odd.map((c) => {
    if (!(c.meanIntervalHours > 0)) {
      throw new Error(`jar content "${c.id}" is not baseline and declares no meanIntervalHours`);
    }
    // One jar in (rate × hours) is this content.
    const p = 1 / (jarsPerHour * c.meanIntervalHours);
    acc += p;
    return { content: c, p, cumulative: acc };
  });

  if (acc >= 1) throw new Error(`odd-jar probabilities sum to ${acc} — the ladder is over-subscribed`);

  return { salt, table, baseline, oddProbability: acc, jarsPerHour, labels: data.labels };
}

/** What is in jar `index`. Pure; same index always gives the same answer. */
export function contentFor(index, ladder) {
  const r = unit(index, ladder.salt);
  for (const row of ladder.table) if (r < row.cumulative) return row.content;
  return ladder.baseline;
}

/**
 * Which label variant jar `index` carries — a SEPARATE hash stream from the
 * content, so an odd jar is not also flagged by a label a viewer could learn
 * to spot. The jar with the severed hand wears an ordinary Dill Spears label,
 * which is the whole joke and also the naturalness law.
 */
export function labelFor(index, ladder) {
  const n = ladder.labels.variants.length;
  return Math.floor(unit(index, ladder.salt ^ 0x5bf03635) * n) % n;
}

/**
 * How hard this jar rings as it crosses a seam, 0..1. A third stream: with one
 * shared stream every odd jar would clink identically and the belt would tell
 * you where to look.
 */
export function clinkFor(index, ladder) {
  return unit(index, ladder.salt ^ 0x27d4eb2f);
}
