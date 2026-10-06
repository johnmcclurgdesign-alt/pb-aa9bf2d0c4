// tools/events/roll.js — the seed hash. A WIRE CONTRACT, not an implementation detail.
//
// loops-docs 10-platform/55-run-of-show-manifest.md §3 fixes this digit for digit so a Swift or
// Unreal Loop computes bit-identical rolls from the same manifest. The Godot prior art seeded from
// GDScript's engine-internal hash(), which is why it could never have shared a world with another
// runtime — two engines would have diverged on second one, silently, with every check green.
//
//     roll(runSeed, id, salt, second, stream) =
//         fmix32( fnv1a32( "<runSeed>|<id><stream>|<salt>|<second>" ) ) / 2^32
//
// `stream` is "" for the fire roll, "#gap" for the cooldown jitter, "#draw<n>" for draw n.
//
// ★ DO NOT DROP THE FINALIZER. FNV-1a alone is uniform but LOCALLY CORRELATED: the second is the
// last field of the string, so consecutive seconds differ only in their final bytes and FNV's
// remaining rounds never diffuse those into the high bits that /2^32 weights most. Measured on the
// reference Loop without fmix32: mean |Δ| between adjacent seconds 0.040 (random pairs give 0.333)
// and a world that went dead for 1190 s against a 55 s authored mean gap — while passing every
// uniformity test. tools/events-determinism.mjs measures decorrelation on every run.
//
// No DOM, no three.js, no I/O: the loop, the simulator and the determinism check all import this
// one file, so there is exactly one implementation to be wrong.

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a, 32-bit, over the UTF-8 bytes of `text`. Test vectors: "" → 2166136261, "a" → 3826002220.
 *
 * ★ THE ASCII FAST PATH IS LOAD-BEARING. A cold join replays a whole validity window before the
 * first frame, and `new TextEncoder().encode()` per call allocates per roll — measured 200 ms on a
 * Mac for a 24 h replay, seconds on a phone. Below 0x80 a UTF-8 byte IS the code unit, so the fast
 * path hashes the same bytes; the determinism check asserts the two paths agree on a corpus that
 * includes non-ASCII rather than taking it on trust.
 */
export function fnv1a32(text) {
  let h = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0x7f) return fnv1a32Utf8(text);
    h ^= c;
    // Math.imul, not `*`: h * FNV_PRIME exceeds 2^53 and silently loses the low bits, which would
    // make this disagree with a correct 32-bit implementation in another language.
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/** The reference path over real UTF-8 bytes. Correct for any input, allocating. */
export function fnv1a32Utf8(text) {
  let h = FNV_OFFSET;
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/** MurmurHash3's 32-bit finalizer, all operations 32-bit unsigned. */
export function fmix32(h) {
  h = h >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** The uniform in [0, 1) for one (event, second, stream). The string layout is the contract. */
export function roll(runSeed, id, salt, second, stream = '') {
  return fmix32(fnv1a32(`${runSeed}|${id}${stream}|${salt}|${second}`)) / 4294967296;
}

// ── the same hash without the allocation ───────────────────────────────────────────────────────
// The prefix "<runSeed>|<id><stream>|<salt>|" is constant for an (event, stream) pair, so its FNV
// state is computed once and the seconds' decimal digits are folded in from there. The contract is
// over the BYTES; nothing requires them to exist as one string. Bit-identical by construction and
// asserted against roll() by the determinism check on every run — if the fast path ever diverged,
// every device using it would silently leave the shared world with every other check green.

/** FNV-1a state after the constant prefix. Reusable across every second. */
export function prefixState(runSeed, id, salt, stream = '') {
  return fnv1a32(`${runSeed}|${id}${stream}|${salt}|`);
}

/** Continue a prefix state with the decimal ASCII of `second` (a whole, non-negative integer —
 *  anything else would hash different bytes than roll() does), then finalize. */
export function rollFromPrefix(state, second) {
  if (!(second >= 0) || second !== Math.floor(second)) {
    throw new Error(`rollFromPrefix: second must be a whole non-negative integer, got ${second}`);
  }
  let h = state >>> 0;
  let divisor = 1;
  while (second / divisor >= 10) divisor *= 10;
  while (divisor >= 1) {
    const digit = Math.floor(second / divisor) % 10;
    h ^= 0x30 + digit;
    h = Math.imul(h, FNV_PRIME) >>> 0;
    divisor /= 10;
  }
  return fmix32(h) / 4294967296;
}
