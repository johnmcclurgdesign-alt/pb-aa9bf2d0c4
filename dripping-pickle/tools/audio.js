// tools/audio.js — the Loop's sound: buses, a synthesised bed, spatial one-shots, the drip.
//
// DP-W7 (AUD-001…004). Everything continuous is SYNTHESISED here and logged as `original`; the
// only recordings that ship are five CC0 files (the cat, the mouse, the radio, the drip). That
// split is not taste — PLAN §3 allows royalty_free/cc_zero/original ONLY, and the prototype set's
// conveyor bed and radio hum are both CC-BY 4.0, i.e. attribution-required, i.e. unusable here.
// Synthesising them also costs no payload and lets the belt bed follow the conveyor's own speed.
//
// ★ WEB AUDIO STARTS SUSPENDED AND A SUSPENDED CONTEXT LOOKS EXACTLY LIKE A BROKEN MIX. Every
//   browser blocks audio until a user gesture, so `ctx.state` is 'suspended' at load, every
//   `start()` is accepted, every cue logs, and NOTHING is heard — the same failure shape as the
//   event engine's recorder. `unlocked` is the flag to read; `pending` is what was asked for
//   before the gesture and gets started on it. Never report "audio wired" from a green log.
//
// ★ AN AMBIENT SOUND'S TIMING IS WALL CLOCK. The drip is scheduled against the shared clock in
//   unix seconds (so two devices drip together), never against accumulated frame `dt` — this Loop
//   targets 30 FPS on a phone and a hidden pane stops rAF outright.
//
// ★ AND A LOOPED BUFFER MUST NOT LOOP ON ITS OWN EDGES. Synthesised loops are crossfaded here
//   (`seamless`), and DECODED loops get loopStart/loopEnd pulled a millisecond inside the buffer,
//   because AAC carries encoder delay and padding that reads as a click once a minute forever.
//
// ★ LOUDNESS IS A CONFORMANCE CLAIM, AND THIS IS HOW IT IS MADE (AUD1, #140). Target: loops-docs
//   10-platform/30 §6 — integrated −23 LUFS ± 1, short-term (3 s) max ≤ −15 LUFS, true peak
//   ≤ −3 dBTP, over ≥ 180 s at the room camera in its resting state. Instrument: `measure()` below —
//   an AudioWorklet on `output` (after the limiter) feeding tools/loudness.js, which is BS.1770-4:
//   K-weighted PER CHANNEL and summed (never a mono down-mix), 400 ms blocks at 75 % overlap from
//   gapless 100 ms sub-blocks, −70 / −10 gates, 4× oversampled true peak. Gate:
//   `node tools/check-loudness.mjs` (wet) · `--dry` (createConvolver stripped) · `--runs 3` (until it
//   repeats) · `--shell-gain` · `--selftest` (known answers + a plant per target). Every number this
//   Loop reported before AUD1 came from an AnalyserNode that averaged L and R and read the mix
//   ~4.5 dB low; none of them is comparable with a number from here. Lesson: the-loudness-instrument.

import { roll as rollHash } from './events/roll.js';
import { summarise, SUB_BLOCK_SEC } from './loudness.js';

// ── the slot table — the manifest, in code ─────────────────────────────────────────────────────
// `gain` is this slot's own trim, applied under its bus. Levels here were set from the measured
// loudness table (window.__audio.report()), not by ear in isolation: the Godot manifest's own note
// is that every level it ever shipped was set against silence, and its two known offenders (the
// conveyor and the cat) are exactly the two that got a bed-relative fit here.
export const SLOTS = {
  // `ref` is the distance in METRES at which this source reads as "here"; beyond it the level,
  // the top end and the dry/wet ratio all fall away together (see AIR, below). It is a property
  // of the SOURCE, not a mix trim: a conveyor is a big machine you hear across a room (ref 4.5),
  // a purring cat is an intimate sound that dies within a couple of paces (ref 0.9). Getting
  // these wrong is what makes a spatialised scene still sound flat — everything at ref 2 means
  // everything fades at the same rate and the room has no depth.
  // `rolloff` steepens or softens that fall; `wet` scales how much of the room's tail it feeds.

  // ── the bed: always on ──
  // room_hum is the ONLY non-spatial source, and deliberately: it is the room itself, it has no
  // location, and giving it one would make the whole world swing when the camera turns.
  room_hum:      { bus: 'bed',     kind: 'loop',    gain: 0.13, voice: 'roomHum',    wet: 0.3 },
  // the plant next door, through brick. It HAS a direction — the far wall — and it is already
  // dull, so its own lowpass does the work its distance would otherwise have to.
  factory_wall:  { bus: 'bed',     kind: 'loop',    gain: 0.26, voice: 'factoryWall', spatial: true, ref: 8,   rolloff: 0.40, wet: 1.4 },
  belt_run:      { bus: 'machine', kind: 'loop',    gain: 0.19, voice: 'beltRun',    spatial: true, ref: 1.8, rolloff: 1.0, wet: 1.1 },
  hvac_air:      { bus: 'machine', kind: 'loop',    gain: 0.16, voice: 'hvacAir',    spatial: true, ref: 1.2, rolloff: 1.0, wet: 1.0 },
  crt_hum:       { bus: 'machine', kind: 'loop',    gain: 0.07, voice: 'crtHum',     spatial: true, ref: 1.6, rolloff: 1.0, wet: 0.5 },
  cat_purr:      { bus: 'npc',     kind: 'loop',    gain: 0.22, src: 'cat_purr.wav', spatial: true, ref: 0.7, rolloff: 1.1, wet: 0.4 },

  // ── one-shots the world makes ──
  drip:          { bus: 'bed',     kind: 'oneshot', gain: 0.40, src: 'ambient_drip.wav', spatial: true, ref: 1.2, rolloff: 1.0, wet: 1.6 },
  jar_clink:     { bus: 'machine', kind: 'oneshot', gain: 0.60, voice: 'jarClink',   spatial: true, ref: 1.5, rolloff: 1.0, wet: 1.3 },
  // The tap is the same glass struck harder and closer — one voice, two slots, so a mix note
  // about knocks does not silently re-level every seam crossing on the belt.
  jar_knock:     { bus: 'machine', kind: 'oneshot', gain: 0.75, voice: 'jarClink',   spatial: true, ref: 1.5, rolloff: 1.0, wet: 1.1, rate: 0.92 },
  belt_stall:    { bus: 'machine', kind: 'oneshot', gain: 0.40, voice: 'beltStall',  spatial: true, ref: 2.0, rolloff: 1.0, wet: 1.2 },

  // ── one-shots the event library names (the ids are the contract, see the sink) ──
  static_burst:  { bus: 'screen',  kind: 'oneshot', gain: 1.00, src: 'radio_static_tune.wav', spatial: true, ref: 1.6, rolloff: 1.0, wet: 0.8 },
  fitting_buzz:  { bus: 'machine', kind: 'oneshot', gain: 0.50, voice: 'fittingBuzz', spatial: true, ref: 1.4, rolloff: 1.0, wet: 1.2 },
  relay_wake:    { bus: 'screen',  kind: 'oneshot', gain: 0.70, voice: 'relayWake',  spatial: true, ref: 1.6, rolloff: 1.0, wet: 0.7 },
  relay_close:   { bus: 'screen',  kind: 'oneshot', gain: 0.60, voice: 'relayClose', spatial: true, ref: 1.6, rolloff: 1.0, wet: 0.7 },
  cat_hunt:      { bus: 'npc',     kind: 'oneshot', gain: 0.20, src: 'cat_meow.wav', spatial: true, ref: 1.0, rolloff: 1.1, wet: 1.0, rate: 0.86 },
  cat_wake:      { bus: 'npc',     kind: 'oneshot', gain: 0.17, src: 'cat_meow.wav', spatial: true, ref: 1.0, rolloff: 1.1, wet: 1.0 },
  mouse_scurry:  { bus: 'npc',     kind: 'oneshot', gain: 0.70, voice: 'mouseSkitter', spatial: true, ref: 0.6, rolloff: 1.2, wet: 0.7 },
  mouse_bolt:    { bus: 'npc',     kind: 'oneshot', gain: 0.55, src: 'mouse_squeak.wav', spatial: true, ref: 0.6, rolloff: 1.2, wet: 0.7 },

  // ── what an interaction makes (DP-W8) ──
  // The radio is a small speaker on a shelf, so its `ref` is short — it does not carry the room
  // the way the belt does, and a viewer at the loop camera should hear it as something playing
  // over there rather than as a soundtrack. `wet` is high for its size: a tinny box in a brick
  // warehouse is mostly what the room does with it.
  radio_station: { bus: 'bed',     kind: 'loop',    gain: 0.42, voice: 'radioStation', spatial: true, ref: 1.1, rolloff: 1.15, wet: 1.5 },
  radio_tune:    { bus: 'machine', kind: 'oneshot', gain: 0.55, voice: 'radioTune',    spatial: true, ref: 1.1, rolloff: 1.15, wet: 1.0 },
  // A jar hitting a concrete floor is the loudest thing in this Loop, and it should be: it is the
  // rarest. Gain is against the same peak-normalised ladder as everything else — read it off
  // report(), never guess it.
  jar_smash:     { bus: 'machine', kind: 'oneshot', gain: 0.85, voice: 'jarSmash',     spatial: true, ref: 2.2, rolloff: 1.0, wet: 1.5 },
  // The dial's own click. Quiet, close, and dry — a switch you pressed, not an event in the room.
  dial_click:    { bus: 'machine', kind: 'oneshot', gain: 0.45, voice: 'radioTune',    spatial: true, ref: 1.0, rolloff: 1.2, wet: 0.5, rate: 1.9 },
};

/** Bus defaults. A bus is a coarse handle over a family, so a mix note ("the machines are loud")
 *  is one number rather than six. Overridable per-run from the url (?mixbed= etc). */
// ★ TWO DIFFERENT KNOBS, AND CONFLATING THEM IS HOW A CATALOGUE ENDS UP UNEVEN. `BUSES` is the
// BALANCE between families and is a taste decision that belongs to this Loop; `MASTER_TRIM` is
// CALIBRATION — the single number that puts this Loop's output on the platform's loudness target
// so a viewer moving from one Loop to the next does not reach for the volume. Re-fitting the
// balance must not change the calibration and vice versa, so they are separate on purpose.
//
// The target is **-23 LUFS integrated** over the steady state, with short-term never above
// -15 LUFS and true peak at or under -3 dBTP. That is EBU R128's reference level, chosen because
// it is a real published standard rather than a number invented here, and because a Loop is
// ambient furniture rather than foreground speech — a podcast masters to about -16 LUFS, and a
// room you leave running for hours should sit clearly below that while still being present.
// loops-docs 10-platform/30 §6 carries the standard and the measurement method.
export const BUSES = { bed: 1.0, machine: 0.94, npc: 1.0, screen: 0.89 };

// Fitted by measurement, not by ear: four consecutive 15 s windows at the loop camera measured
// -10.8 / -10.7 / -11.3 / -11.4 LUFS with the buses above at unity, so this is the 12 dB that
// lands the steady state on -23.
//
// ★ RE-MEASURE AND RE-FIT THIS WHENEVER THE BALANCE OR THE DISTANCE MODEL MOVES, AND DO IT AFTER
//   THE BEDS HAVE FINISHED FADING IN. The first attempt carried a trim of 3.81 fitted against a
//   measurement taken BEFORE the reference distances were re-fitted — nearly 12 dB hot, with
//   one-shots peaking at +2 dBFS into the limiter. It was caught because repeated measurements
//   climbed (-19.6, -16.4, -14.6) rather than repeating, which is the tell that the thing being
//   measured had not settled: the fade-in was frame-driven at the time and had not finished.
//   A calibration carried over from a different mix is just a number nobody has checked.
export const MASTER_TRIM = 0.96;

// ── deterministic noise ────────────────────────────────────────────────────────────────────────
// Synthesised buffers are built from a SEEDED generator so the bed is bit-identical on every
// device and every reload — the same reason the jars' contents are a pure function of their index.
function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Crossfade the last `x` seconds over the head and trim, so the buffer loops with no seam. */
function seamless(buf, x) {
  const sr = buf.sampleRate, n = Math.floor(x * sr), out = buf.length - n;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const t = i / n;                       // equal-power, so the noise floor does not dip
      d[i] = d[i] * Math.sin(t * Math.PI / 2) + d[out + i] * Math.cos(t * Math.PI / 2);
    }
  }
  const trimmed = new AudioBuffer({ length: out, sampleRate: sr, numberOfChannels: buf.numberOfChannels });
  for (let c = 0; c < buf.numberOfChannels; c++) trimmed.copyToChannel(buf.getChannelData(c).subarray(0, out), c);
  return trimmed;
}

/** Scale a rendered buffer so its peak sits at `peak`. Applied to every synthesised voice. */
function normalise(buf, peak) {
  let m = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  }
  if (!(m > 0)) return buf;
  const k = peak / m;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
  return buf;
}

// ── the voices ─────────────────────────────────────────────────────────────────────────────────
// Each renders ONE mono buffer, once, at load. Playback is then a BufferSource + gain + panner,
// which is what keeps a room full of sound off the frame budget: no voice builds a filter graph
// per fire. Loop voices declare `xfade`, the tail length crossfaded back over the head.
const VOICES = {
  // Aging electrics: mains hum and its octave under a lowpassed brown-noise floor. Felt, not heard.
  roomHum: { seconds: 6, xfade: 1.0, render(ctx, sr, len) {
    const rnd = mulberry32(0x4d0f11);
    const src = ctx.createBufferSource(); src.buffer = brown(sr, len, rnd); src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 180;
    const g = ctx.createGain(); g.gain.value = 0.5;
    src.connect(lp).connect(g).connect(ctx.destination);
    for (const [f, a] of [[60, 0.05], [120, 0.028], [180, 0.010]]) {
      const o = ctx.createOscillator(); o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = a;
      // a slow beat between the two mains partials, so the hum never sits perfectly still
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.1666;   // 6 s = the loop length
      const lg = ctx.createGain(); lg.gain.value = a * 0.35;
      lfo.connect(lg).connect(og.gain); lfo.start();
      o.connect(og).connect(ctx.destination); o.start();
    }
    src.start();
  } },

  // The factory itself, heard THROUGH the wall: everything above 200 Hz is gone, and what is left
  // is slow swell rather than detail. Anything articulate here would put the plant in the room.
  factoryWall: { seconds: 12, xfade: 2.0, render(ctx, sr, len) {
    const rnd = mulberry32(0x51ac02);
    const src = ctx.createBufferSource(); src.buffer = brown(sr, len, rnd); src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 150; lp.Q.value = 0.9;
    const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 220;
    const g = ctx.createGain(); g.gain.value = 0.85;
    // two swells over the 12 s loop, at incommensurate rates so the repeat is hard to hear
    for (const [f, a] of [[1 / 12, 0.30], [1 / 4, 0.12]]) {
      const lfo = ctx.createOscillator(); lfo.frequency.value = f;
      const lg = ctx.createGain(); lg.gain.value = a;
      lfo.connect(lg).connect(g.gain); lfo.start();
    }
    src.connect(lp).connect(lp2).connect(g).connect(ctx.destination); src.start();
  } },

  // The belt: a motor an octave below the room, the rubber surface as filtered noise, and a seam
  // thump. ★ THE THUMP PERIOD MUST DIVIDE THE LOOP LENGTH or the crossfade lands mid-thump and
  // the bed tocks once per loop — which reads as a broken sample, not as a rhythm.
  beltRun: { seconds: 4, xfade: 0.6, render(ctx, sr, len) {
    const rnd = mulberry32(0x8e11c3);
    const motor = ctx.createOscillator(); motor.type = 'sawtooth'; motor.frequency.value = 47;
    const mlp = ctx.createBiquadFilter(); mlp.type = 'lowpass'; mlp.frequency.value = 220; mlp.Q.value = 3;
    const mg = ctx.createGain(); mg.gain.value = 0.22;
    motor.connect(mlp).connect(mg).connect(ctx.destination); motor.start();

    const surf = ctx.createBufferSource(); surf.buffer = white(sr, len, rnd); surf.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.7;
    const sg = ctx.createGain(); sg.gain.value = 0.05;
    surf.connect(bp).connect(sg).connect(ctx.destination); surf.start();

    for (let t = 0; t < 4; t += 0.5) {           // 0.5 s divides 4 s exactly
      const o = ctx.createOscillator(); o.frequency.setValueAtTime(95, t);
      o.frequency.exponentialRampToValueAtTime(55, t + 0.09);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.2);
    }
  } },

  hvacAir: { seconds: 5, xfade: 1.0, render(ctx, sr, len) {
    const rnd = mulberry32(0x2fa771);
    const src = ctx.createBufferSource(); src.buffer = white(sr, len, rnd); src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 620; bp.Q.value = 0.55;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
    const g = ctx.createGain(); g.gain.value = 0.5;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.4;      // 5 s / 2 wobbles
    const lg = ctx.createGain(); lg.gain.value = 0.08;
    lfo.connect(lg).connect(g.gain); lfo.start();
    src.connect(bp).connect(lp).connect(g).connect(ctx.destination); src.start();
  } },

  // A tube's flyback whine plus its mains hum. The whine is at 15.7 kHz on purpose — half the
  // room cannot hear it at all and a phone speaker reproduces none of it, so it is trimmed to be
  // an accent on the near screens rather than a level anyone has to defend.
  crtHum: { seconds: 2, xfade: 0.4, render(ctx, sr, len) {
    for (const [f, a, type] of [[120, 0.055, 'sine'], [240, 0.014, 'sine'], [15734, 0.010, 'sine']]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = a;
      o.connect(g).connect(ctx.destination); o.start();
    }
    const rnd = mulberry32(0x9c31);
    const n = ctx.createBufferSource(); n.buffer = white(sr, len, rnd); n.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000;
    const g = ctx.createGain(); g.gain.value = 0.012;
    n.connect(hp).connect(g).connect(ctx.destination); n.start();
  } },

  // ── the transistor radio (INT-002, DP-W8) ────────────────────────────────────────────────
  // ★ SYNTHESISED, AND NOT BY PREFERENCE. Every piece of music in the prototype's audio folder
  // is either CC-BY (attribution) or a Suno track whose own manifest wants a commercial licence,
  // and PLAN §3 allows royalty_free / cc_zero / original only. The radio pool is a Beta row
  // (AUD-B01 / #56); until it lands, what the radio plays has to be original. Josh's call, and
  // the same one DP-W7 made for every continuous source.
  //
  // ★ AND IT IS A SMALL SPEAKER IN A PLASTIC BOX BEFORE IT IS MUSIC. The whole read comes from
  // the band limit, not from the notes: a 1960s transistor set rolls off below ~400 Hz and above
  // ~3 kHz, so anything played through it arrives thin and mid-forward. A wide, clean pad here
  // would read as a Loop playing music at you rather than as a radio on a shelf across the room.
  //
  // The progression is four bars of 4 s in a 16 s loop, which is the divides-the-loop-length rule
  // DP-W7 paid for on the belt's seam thump: any repeating element inside a synthesised loop must
  // have a period that divides it, or the crossfade lands mid-event and the bed ticks once a pass.
  radioStation: { seconds: 16, xfade: 0.9, render(ctx, sr, len) {
    const BAR = 4;
    // A minor-ish wander that never resolves anywhere memorable. A hook would be a hook, and a
    // room somebody leaves running for hours does not want one.
    const chords = [[220, 261.63, 329.63], [196, 246.94, 293.66],
                    [174.61, 220, 261.63], [196, 233.08, 293.66]];
    // the radio's own voice: one band, everything through it
    const band = ctx.createBiquadFilter(); band.type = 'bandpass';
    band.frequency.value = 1150; band.Q.value = 0.72;
    const shelf = ctx.createBiquadFilter(); shelf.type = 'highshelf';
    shelf.frequency.value = 3000; shelf.gain.value = -14;
    band.connect(shelf).connect(ctx.destination);
    for (let bar = 0; bar < 4; bar++) {
      const t = bar * BAR;
      for (const f of chords[bar]) {
        // two oscillators a few cents apart per note — the beating is what makes a cheap
        // speaker sound like a cheap speaker rather than like an organ patch
        for (const detune of [-4, 5]) {
          const o = ctx.createOscillator(); o.type = 'triangle';
          o.frequency.value = f; o.detune.value = detune;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(0.085, t + 0.35);
          g.gain.setValueAtTime(0.085, t + BAR - 0.6);
          g.gain.linearRampToValueAtTime(0.0001, t + BAR - 0.02);
          o.connect(g).connect(band); o.start(t); o.stop(t + BAR);
        }
      }
      // a soft root pulse on the beat, well inside the bar so nothing crosses the seam
      for (let beat = 0; beat < 4; beat++) {
        const t2 = t + beat;
        if (t2 > len / sr - 0.5) break;
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(chords[bar][0] * 0.5, t2);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t2);
        g.gain.exponentialRampToValueAtTime(beat === 0 ? 0.07 : 0.035, t2 + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.30);
        o.connect(g).connect(band); o.start(t2); o.stop(t2 + 0.35);
      }
    }
    // the carrier the station rides on — always there, and the reason it reads as RECEIVED
    const rnd = mulberry32(0x2b17f5);
    const hiss = ctx.createBufferSource(); hiss.buffer = white(sr, len, rnd); hiss.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
    const hg = ctx.createGain(); hg.gain.value = 0.020;
    hiss.connect(hp).connect(hg).connect(ctx.destination); hiss.start();
  } },

  // Finding the station: a tuning sweep across the band and the set settling. Played on the
  // toggle in BOTH directions — a radio switched off does not fade, it stops.
  radioTune: { seconds: 1.1, render(ctx, sr) {
    const rnd = mulberry32(0x77c410);
    const n = ctx.createBufferSource(); n.buffer = white(sr, Math.floor(1.05 * sr), rnd);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 6;
    bp.frequency.setValueAtTime(2600, 0);
    bp.frequency.exponentialRampToValueAtTime(700, 0.75);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, 0);
    g.gain.exponentialRampToValueAtTime(0.22, 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, 0.95);
    n.connect(bp).connect(g).connect(ctx.destination); n.start();
    // the click of the switch itself, which is most of what a viewer credits the tap with
    const c = ctx.createOscillator(); c.type = 'square'; c.frequency.value = 900;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.10, 0); cg.gain.exponentialRampToValueAtTime(0.0001, 0.035);
    c.connect(cg).connect(ctx.destination); c.start(); c.stop(0.05);
  } },

  // A jar leaving the belt (Gate A §8.4). NOT a louder clink: a clink is a body ringing and this
  // is a body ceasing to exist, so it is a broadband burst with shards after it rather than
  // partials with a decay.
  jarSmash: { seconds: 1.3, render(ctx, sr) {
    const rnd = mulberry32(0x3f9a21);
    const n = ctx.createBufferSource(); n.buffer = white(sr, Math.floor(0.35 * sr), rnd);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.55, 0); g.gain.exponentialRampToValueAtTime(0.0001, 0.32);
    n.connect(hp).connect(g).connect(ctx.destination); n.start();
    // the floor takes the weight first
    const th = ctx.createOscillator(); th.frequency.setValueAtTime(150, 0);
    th.frequency.exponentialRampToValueAtTime(52, 0.14);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.30, 0); tg.gain.exponentialRampToValueAtTime(0.0001, 0.22);
    th.connect(tg).connect(ctx.destination); th.start(); th.stop(0.25);
    // …then the pieces settle, over most of a second
    for (let i = 0; i < 9; i++) {
      const t = 0.10 + rnd() * 0.85;
      const o = ctx.createOscillator();
      o.frequency.value = 2400 + rnd() * 4200;
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(0.020 + rnd() * 0.035, t + 0.003);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.06 + rnd() * 0.10);
      o.connect(og).connect(ctx.destination); o.start(t); o.stop(t + 0.2);
    }
  } },

  // Glass: three INHARMONIC partials. Harmonic ones read as a bell or a note, and a note in a
  // room of jars reads as music — the clink has to be an object, not a pitch.
  jarClink: { seconds: 0.55, render(ctx) {
    for (const [f, a, d] of [[2180, 0.30, 0.34], [3170, 0.16, 0.22], [4655, 0.09, 0.14]]) {
      const o = ctx.createOscillator(); o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(a, 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, d);
      o.connect(g).connect(ctx.destination); o.start(); o.stop(0.55);
    }
    const rnd = mulberry32(0x7711aa);
    const t = ctx.createBufferSource(); t.buffer = white(ctx.sampleRate, Math.floor(0.02 * ctx.sampleRate), rnd);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 4000;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.10, 0); g.gain.exponentialRampToValueAtTime(0.0001, 0.02);
    t.connect(hp).connect(g).connect(ctx.destination); t.start();
  } },

  // The belt losing power: the motor falls away over the brake ramp and the mechanism clunks.
  beltStall: { seconds: 1.8, render(ctx, sr) {
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(47, 0); o.frequency.exponentialRampToValueAtTime(11, 1.1);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(260, 0); lp.frequency.exponentialRampToValueAtTime(90, 1.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.30, 0); g.gain.setValueAtTime(0.30, 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, 1.3);
    o.connect(lp).connect(g).connect(ctx.destination); o.start(); o.stop(1.4);

    const rnd = mulberry32(0x5a11f0);
    const clunk = ctx.createOscillator(); clunk.frequency.setValueAtTime(120, 0.02);
    clunk.frequency.exponentialRampToValueAtTime(48, 0.16);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, 0.02); cg.gain.exponentialRampToValueAtTime(0.42, 0.03);
    cg.gain.exponentialRampToValueAtTime(0.0001, 0.28);
    clunk.connect(cg).connect(ctx.destination); clunk.start(0.02); clunk.stop(0.4);

    const rat = ctx.createBufferSource(); rat.buffer = white(sr, Math.floor(0.25 * sr), rnd);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1600; bp.Q.value = 1.2;
    const rg = ctx.createGain(); rg.gain.setValueAtTime(0.16, 0.02); rg.gain.exponentialRampToValueAtTime(0.0001, 0.26);
    rat.connect(bp).connect(rg).connect(ctx.destination); rat.start(0.02);
  } },

  // A failing fitting: mains-frequency buzz, gated, so it stutters rather than drones.
  fittingBuzz: { seconds: 0.8, render(ctx) {
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 120;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1300; bp.Q.value = 2.2;
    const g = ctx.createGain(); g.gain.value = 0.0001;
    const rnd = mulberry32(0x3b0c19);
    let t = 0;
    while (t < 0.7) {                       // irregular gate — a steady one reads as a synth
      const on = 0.012 + rnd() * 0.05, off = 0.01 + rnd() * 0.06;
      g.gain.setValueAtTime(0.22 * (0.5 + rnd() * 0.5), t);
      g.gain.setValueAtTime(0.0001, t + on);
      t += on + off;
    }
    o.connect(bp).connect(g).connect(ctx.destination); o.start(); o.stop(0.8);
  } },

  // A CRT coming up: the relay closes, the EHT rises, the raster settles.
  relayWake: { seconds: 1.3, render(ctx, sr) {
    const rnd = mulberry32(0x1177de);
    const cl = ctx.createBufferSource(); cl.buffer = white(sr, Math.floor(0.03 * sr), rnd);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
    const cg = ctx.createGain(); cg.gain.setValueAtTime(0.5, 0); cg.gain.exponentialRampToValueAtTime(0.0001, 0.03);
    cl.connect(hp).connect(cg).connect(ctx.destination); cl.start();

    const w = ctx.createOscillator();
    w.frequency.setValueAtTime(380, 0.03); w.frequency.exponentialRampToValueAtTime(15734, 0.85);
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(0.0001, 0.03); wg.gain.exponentialRampToValueAtTime(0.10, 0.20);
    wg.gain.exponentialRampToValueAtTime(0.012, 1.1);
    w.connect(wg).connect(ctx.destination); w.start(0.03); w.stop(1.25);

    const th = ctx.createOscillator(); th.frequency.setValueAtTime(90, 0.04);
    const tg = ctx.createGain(); tg.gain.setValueAtTime(0.18, 0.04); tg.gain.exponentialRampToValueAtTime(0.0001, 0.35);
    th.connect(tg).connect(ctx.destination); th.start(0.04); th.stop(0.4);
  } },

  // And going down: the discharge tick, then the whine falling away with the picture.
  relayClose: { seconds: 1.1, render(ctx, sr) {
    const rnd = mulberry32(0x22ea31);
    const cl = ctx.createBufferSource(); cl.buffer = white(sr, Math.floor(0.02 * sr), rnd);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2600;
    const cg = ctx.createGain(); cg.gain.setValueAtTime(0.45, 0); cg.gain.exponentialRampToValueAtTime(0.0001, 0.02);
    cl.connect(hp).connect(cg).connect(ctx.destination); cl.start();

    const w = ctx.createOscillator();
    w.frequency.setValueAtTime(9000, 0.01); w.frequency.exponentialRampToValueAtTime(210, 0.75);
    const wg = ctx.createGain(); wg.gain.setValueAtTime(0.10, 0.01); wg.gain.exponentialRampToValueAtTime(0.0001, 0.85);
    w.connect(wg).connect(ctx.destination); w.start(0.01); w.stop(0.95);
  } },

  // Claws on boards: a burst of tiny ticks, not a rodent voice — the squeak is a separate slot
  // and using it for movement is what makes a mouse read as cartoon.
  mouseSkitter: { seconds: 0.7, render(ctx, sr) {
    const rnd = mulberry32(0x6c14b2);
    let t = 0;
    while (t < 0.62) {
      const n = ctx.createBufferSource(); n.buffer = white(sr, Math.floor(0.006 * sr), rnd);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = 2600 + rnd() * 2600; bp.Q.value = 1.6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.16 + rnd() * 0.16, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
      n.connect(bp).connect(g).connect(ctx.destination); n.start(t);
      t += 0.028 + rnd() * 0.035;
    }
  } },
};

function white(sr, len, rnd) {
  const b = new AudioBuffer({ length: len, sampleRate: sr, numberOfChannels: 1 });
  const d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = rnd() * 2 - 1;
  return b;
}
function brown(sr, len, rnd) {
  const b = new AudioBuffer({ length: len, sampleRate: sr, numberOfChannels: 1 });
  const d = b.getChannelData(0);
  let v = 0;
  for (let i = 0; i < len; i++) { v = (v + (rnd() * 2 - 1) * 0.02); v = Math.max(-1, Math.min(1, v * 0.997)); d[i] = v * 3.2; }
  return b;
}

// ── the room's acoustics ───────────────────────────────────────────────────────────────────────
// ★ DISTANCE IS NOT A VOLUME KNOB, AND TREATING IT AS ONE IS WHY A SPATIALISED SCENE STILL SOUNDS
//   FLAT. Three things change with distance in a real room and all three have to move together:
//   the sound gets quieter, it gets DULLER (air and every surface between absorb the top end
//   first), and it gets WETTER (the direct path falls off with distance while the room's
//   reflections do not, so the ratio tips). Level alone reads as "someone turned it down".
//
// The model, per emitter, from its distance `d` to the listener and its own reference distance:
//   level  = ref / (ref + rolloff * max(0, d - ref))     — inverse-square-ish, the Web Audio curve
//   cutoff = 19000 * (ref / d)^0.62                      — clamped; the dull-with-distance term
//   wet    = wetNear + (wetFar - wetNear) * clamp(d / farRef)
//
// ★ AND IT IS EVALUATED IN JS AND WRITTEN STRAIGHT TO `.value`, NEVER SCHEDULED. loops-docs
//   10-platform/30 §4b: an AudioParam ramp per frame accumulates for the whole life of a Loop, and
//   a Loop is left running for hours. Every continuous quantity here is smoothed on the JS side
//   (one-pole, frame-rate independent) and assigned. Nothing this module does per frame is queued.
const AIR = { refCut: 19000, cutExp: 0.62, minCut: 620, wetNear: 0.05, wetFar: 0.30, farRef: 9 };

/** One-pole smoothing that does not change character with frame rate. */
const approach = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / Math.max(tau, 1e-3)));

// ── the engine ─────────────────────────────────────────────────────────────────────────────────

/**
 * @param {object}   o
 * @param {string}   o.assetBase  where the five CC0 files live
 * @param {object}   [o.query]    URLSearchParams — ?vol=, ?mixbed=…, ?reverb=, ?hrtf=1
 */
export function createAudio({ assetBase, query = new URLSearchParams() }) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC({ latencyHint: 'interactive' });

  // A limiter, not a mixing tool: the bed plus a takeover plus a hunt plus a jar tap can coincide,
  // and a Loop that plays forever must never be the thing that clips.
  const limiter = ctx.createDynamicsCompressor();
  // ⚠ AUD1 (2026-10-06) corrected two claims this comment used to make. (1) "Threshold sits above
  //   the fitted mix's peaks (−8.5 dBFS measured)": that was a SAMPLED peak, through a mono
  //   down-mix, before this node — the real output's true peak read −1.6 dBTP, so this was working
  //   on every transient. (2) "In normal running it does nothing at all": a DynamicsCompressorNode
  //   applies automatic makeup gain, (1 / full-range gain)^0.6 by the Web Audio spec, which for these
  //   settings is +1.95 dB on EVERYTHING — measured: a −20.35 dBFS tone through master read −18.4
  //   LUFS after it. Harmless, because measure() now taps after this node and the calibration
  //   absorbs it; but it is not transparent, and attack 4 ms lets a hard transient through, which
  //   is why the dry graph (no reverb to soften its one-shots) could not be calibrated (#139).
  limiter.threshold.value = -6; limiter.knee.value = 6; limiter.ratio.value = 8;
  limiter.attack.value = 0.004; limiter.release.value = 0.18;

  const master = ctx.createGain();
  const volOf = (v) => v * parseFloat(query.get('vol') ?? '1') * MASTER_TRIM;
  master.gain.value = volOf(1);
  // `output` is a unity gain and does nothing to the sound: it is the one node every sample passes
  // on its way to the speakers, so measure() taps HERE — after the limiter, which is what a viewer
  // hears and where true peak is decided — rather than at `master` as it did before AUD1.
  const output = ctx.createGain();
  master.connect(limiter).connect(output).connect(ctx.destination);

  const buses = {};
  for (const [id, g] of Object.entries(BUSES)) {
    const n = ctx.createGain();
    n.gain.value = parseFloat(query.get(`mix${id}`) ?? String(g));
    n.connect(master);
    buses[id] = n;
  }

  // ── the room's tail ──
  // ★ A ROOM YOU CAN INHABIT HAS A TAIL. Without one every source is a dot in a void and the ear
  //   reads the whole scene as headphones-on-a-desk rather than as a place. This is a brick
  //   warehouse with a pitched roof: long-ish, dark, no early sparkle. The impulse is SYNTHESISED
  //   (loops-docs §4: ship the code, not the waveform) — two decorrelated noise channels under an
  //   exponential decay, a handful of discrete early reflections, and a lowpass, because brick and
  //   timber eat the top end on every bounce.
  // ★ FEATURE-DETECTED, AND THE DETECT STAYS EVEN NOW THAT THE NODE EXISTS (#120).
  //   `ConvolverNode` was absent from the Apple TV binding, and an unguarded
  //   `ctx.createConvolver()` threw a TypeError inside createAudio() — which the scene caught
  //   into its "no Web Audio" branch, so the television played a SILENT ROOM rather than a dry
  //   one (collectivus#122). The binding gained the node at app row TVB3 (2026-09-13), and
  //   loops-docs 30-engines/web/00-status.md §6 item 3 is explicit that this changes nothing
  //   here: it reaches a television only in the build that carries TVB3, every installed build
  //   before that one still has `createConvolver === undefined`, and a Loop that deletes its
  //   detect goes straight back to throwing at module scope on every one of them.
  //   ⚠ Two further ways to be wrong that the detect alone does not catch, both checked here:
  //   the binding REFUSES an impulse response over 10 seconds (the node then outputs silence)
  //   — buildIR() renders 1.9 s — and a convolver created per voice costs megabytes per voice
  //   — this is ONE shared convolver for the whole mix, built once.
  const hasConvolver = typeof ctx.createConvolver === 'function';
  const reverb = hasConvolver ? ctx.createConvolver() : null;
  if (reverb) {
    // ★ `normalize` DEFAULTS TO TRUE AND ITS SCALING IS NOT SOMETHING YOU CAN REASON ABOUT. It
    //   rescales by the impulse's own energy, so a sparse tail like this one is boosted by an
    //   amount that depends on the IR you happened to render — which makes the send gains
    //   meaningless and the measured loudness unstable between edits. Off, with the impulse
    //   normalised by hand below, so the send is the only thing that sets how wet the room is.
    reverb.normalize = false;
  }
  const reverbReturn = ctx.createGain();
  reverbReturn.gain.value = parseFloat(query.get('reverb') ?? '1');
  if (reverb) reverb.connect(reverbReturn).connect(master);
  // Dry path: the return is left unconnected rather than removed, so setReverb() and every
  // caller that reads api.reverb keep working and simply move a gain nothing feeds.

  function buildIR(seconds = 1.9, decay = 2.6) {
    const sr = ctx.sampleRate, n = Math.floor(seconds * sr);
    const ir = new AudioBuffer({ length: n, sampleRate: sr, numberOfChannels: 2 });
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      const rnd = mulberry32(c ? 0x51f2a1 : 0x21bd07);
      // a dark diffuse tail: noise under an exponential, with the top rolled off as it decays
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const env = Math.pow(1 - t, decay);
        lp += ((rnd() * 2 - 1) - lp) * (0.42 - 0.30 * t);   // the tail gets darker as it dies
        d[i] = lp * env;
      }
      // early reflections: a pitched roof and two brick walls, at plausible path differences
      for (const [ms, amp] of [[11, 0.42], [17, 0.33], [26, 0.28], [37, 0.22], [51, 0.16]]) {
        const at = Math.floor((ms + (c ? 2.3 : 0)) * 0.001 * sr);
        if (at < n) d[at] += amp * (c ? -1 : 1);
      }
      d[0] += 0.0;                                          // no direct path: this is a send
    }
    // hand-normalised, since the convolver's own normalisation is off
    let peak = 0;
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    }
    const k = 0.5 / Math.max(peak, 1e-6);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= k;
    }
    return ir;
  }

  const buffers = new Map();          // slot id -> AudioBuffer
  const emitters = new Map();         // key -> live looping emitter
  const log = [];
  let unlocked = ctx.state === 'running';
  let paused = false;
  let soloed = null;                  // measurement: the only slot allowed to sound
  const pending = [];                 // asked for before the gesture

  const ready = (async () => {
    if (reverb) {
      reverb.buffer = buildIR();
    } else {
      // ONCE, by construction — this block runs a single time inside `ready`.
      log.push({ t: Math.round(performance.now()), id: 'audio:no-convolver',
                 note: 'ConvolverNode absent — the room runs DRY; every wet send is connected to nothing' });
      console.warn('audio: no ConvolverNode on this platform — running dry, the wet sends go nowhere');
    }
    const jobs = [];
    for (const [id, s] of Object.entries(SLOTS)) {
      if (s.voice) {
        const v = VOICES[s.voice];
        if (!v) throw new Error(`audio: slot ${id} names unknown voice ${s.voice}`);
        jobs.push((async () => {
          const sr = ctx.sampleRate;
          const secs = v.seconds + (v.xfade ?? 0);
          const off = new OfflineAudioContext(1, Math.ceil(secs * sr), sr);
          v.render(off, sr, Math.ceil(secs * sr));
          let buf = await off.startRendering();
          if (v.xfade) buf = seamless(buf, v.xfade);
          // ★ NORMALISE, DON'T TRUST THE ARITHMETIC. A voice is a stack of oscillators and
          // filters whose peak nobody can predict on paper: `factory_wall` measured +7.5 dBFS
          // and was CLIPPING inside its own buffer, which reads as a distorted room rather than
          // as a loud one, and no slot gain can undo it. The slot table is the mix; this is the
          // guard rail, and it makes every voice's shipped gain mean the same thing.
          normalise(buf, 0.89);
          buffers.set(id, buf);
        })());
      } else if (s.src) {
        jobs.push((async () => {
          const bytes = await fetch(assetBase + s.src).then((r) => {
            if (!r.ok) throw new Error(`${s.src}: ${r.status}`);
            return r.arrayBuffer();
          });
          // Recordings are peak-normalised too, and that is what makes the slot table a MIX
          // rather than a list of apologies for whatever level each file happened to arrive at.
          // Sourced levels are arbitrary — these five came from three different places — so
          // without this, `gain` means something different on every row and no ladder is legible.
          buffers.set(id, normalise(await ctx.decodeAudioData(bytes), 0.89));
        })());
      }
    }
    const settled = await Promise.allSettled(jobs);
    const bad = settled.filter((r) => r.status === 'rejected');
    if (bad.length) console.warn(`audio: ${bad.length} slot(s) failed to build:`, bad.map((b) => b.reason?.message ?? b.reason));
    return buffers.size;
  })();

  // ── unlocking ──
  // Chrome and Safari both refuse to start a context without a gesture. Resume is attempted once
  // straight away (a reload inside an already-interacted tab can succeed), and otherwise on the
  // first real gesture, at which point everything asked for meanwhile is started.
  function flush() {
    unlocked = ctx.state === 'running';
    if (!unlocked) return;
    while (pending.length) {
      const p = pending.shift();
      if (p.kind === 'loop') startLoop(p.id, p.opts); else fire(p.id, p.opts);
    }
  }
  ctx.resume().then(flush).catch(() => {});
  const gesture = () => { ctx.resume().then(flush).catch(() => {}); };
  for (const ev of ['pointerdown', 'touchend', 'keydown']) {
    window.addEventListener(ev, gesture, { passive: true });
  }

  // ── the listener ──
  const lis = { x: 0, y: 0, z: 0 };
  function listenerFrom(camera) {
    const m = camera.matrixWorld.elements;
    lis.x = m[12]; lis.y = m[13]; lis.z = m[14];
    const l = ctx.listener;
    // plain `.value` writes, not setValueAtTime — see the note at AIR
    if (l.positionX) {
      l.positionX.value = lis.x; l.positionY.value = lis.y; l.positionZ.value = lis.z;
      l.forwardX.value = -m[8]; l.forwardY.value = -m[9]; l.forwardZ.value = -m[10];
      l.upX.value = m[4]; l.upY.value = m[5]; l.upZ.value = m[6];
    } else {
      l.setPosition(lis.x, lis.y, lis.z);
      l.setOrientation(-m[8], -m[9], -m[10], m[4], m[5], m[6]);
    }
  }

  const dist = (p) => Math.hypot(p.x - lis.x, p.y - lis.y, p.z - lis.z);

  /** The three distance terms, from a distance and a slot's reference distance. */
  function acoustics(d, slot) {
    const ref = slot.ref ?? 2, rolloff = slot.rolloff ?? 1;
    const level = ref / (ref + rolloff * Math.max(0, d - ref));
    const cutoff = Math.min(19000, Math.max(AIR.minCut, AIR.refCut * Math.pow(ref / Math.max(d, 0.2), AIR.cutExp)));
    const wet = (slot.wet ?? 1) * (AIR.wetNear + (AIR.wetFar - AIR.wetNear) * Math.min(1, d / AIR.farRef));
    return { level, cutoff, wet };
  }

  // ── building a voice ───────────────────────────────────────────────────────────────────────
  // source → gain → [lowpass → panner] → bus, plus a tap into the room's convolver. The send is
  // taken PRE-PAN, mono, because a room's reflections are diffuse: panning the tail would glue
  // the reverb to the source and undo the thing it is there for.
  function makeVoice(slot, opts) {
    const g = ctx.createGain();
    g.gain.value = (slot.gain ?? 1) * (opts.gain ?? 1) * (soloAllows(slot.__id) ? 1 : 0);
    const node = { g, lp: null, panner: null, send: null, slot, base: g.gain.value };
    let tail = g;
    if (slot.spatial) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 19000; lp.Q.value = 0.4;
      const p = ctx.createPanner();
      // equalpower, not HRTF: HRTF convolves per source and this room runs a dozen at once on a
      // phone. ?hrtf=1 switches it for a headphone check — the difference is front/back and
      // elevation, neither of which this fixed, level, forward-facing camera can use.
      p.panningModel = query.get('hrtf') === '1' ? 'HRTF' : 'equalpower';
      // The DISTANCE curve is ours, applied on `g` above, so the panner is told not to apply one
      // of its own — two models fighting is how a source ends up inaudible at 4 m.
      p.distanceModel = 'linear'; p.refDistance = 1; p.maxDistance = 100000; p.rolloffFactor = 0;
      g.connect(lp).connect(p);
      node.lp = lp; node.panner = p; tail = p;
    }
    tail.connect(buses[slot.bus] ?? master);
    if (slot.wet !== 0) {
      const send = ctx.createGain();
      send.gain.value = 0;
      // Built either way so node.send exists and every wet-level write stays valid; with no
      // convolver it simply connects to nothing. A send that is not there is a branch in
      // every caller — a send that goes nowhere is not.
      g.connect(send);
      if (reverb) send.connect(reverb);
      node.send = send;
    }
    return node;
  }

  const soloAllows = (id) => !soloed || soloed === id;

  function setPos(node, v) {
    if (!node.panner) return;
    const p = node.panner;
    if (p.positionX) { p.positionX.value = v.x; p.positionY.value = v.y; p.positionZ.value = v.z; }
    else p.setPosition(v.x, v.y, v.z);
  }

  /** Apply the distance terms for a position. `instant` skips smoothing (one-shots, first frame). */
  function place(node, pos, dt, instant) {
    if (!node.panner) {
      if (node.send) node.send.gain.value = node.g.gain.value * AIR.wetNear;
      return;
    }
    setPos(node, pos);
    const a = acoustics(dist(pos), node.slot);
    node.level = instant ? a.level : approach(node.level ?? a.level, a.level, dt, 0.12);
    node.cut = instant ? a.cutoff : approach(node.cut ?? a.cutoff, a.cutoff, dt, 0.12);
    node.g.gain.value = node.base * node.level * (soloAllows(node.slot.__id) ? 1 : 0);
    node.lp.frequency.value = node.cut;
    if (node.send) node.send.gain.value = node.base * node.level * a.wet;
  }

  /** Fire a one-shot. Returns the source, or null if the slot is unknown or not built yet. */
  function fire(id, opts = {}) {
    const slot = SLOTS[id];
    if (!slot) return null;
    if (!unlocked || paused) { if (!paused && pending.length < 24) pending.push({ kind: 'shot', id, opts }); return null; }
    const buf = buffers.get(id);
    if (!buf) return null;
    slot.__id = id;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (slot.rate ?? 1) * (opts.rate ?? 1);
    const node = makeVoice(slot, opts);
    src.connect(node.g);
    if (opts.position) place(node, opts.position, 0, true);
    src.start(ctx.currentTime + (opts.delay ?? 0));
    // ★ LET A FINISHED ONE-SHOT GO. loops-docs §4b: a stopped source still parented in the graph
    // still costs, and this Loop fires thousands an hour. Disconnect on `ended` so the whole
    // chain — gain, filter, panner, send — is collectable.
    src.onended = () => {
      try { src.disconnect(); node.g.disconnect(); node.lp?.disconnect(); node.panner?.disconnect(); node.send?.disconnect(); } catch { /* already gone */ }
    };
    log.push({ t: Math.round(performance.now()), id, gain: +(node.g.gain.value).toFixed(4), d: opts.position ? +dist(opts.position).toFixed(2) : null });
    if (log.length > 200) log.shift();
    return src;
  }

  /**
   * Start (or re-target) a looping emitter. Idempotent per key.
   * @param {object} [opts.follow] () => {x,y,z} — a moving source is re-placed every update
   * @param {string} [opts.key]    a second emitter of the same slot (three screens, one hum)
   */
  function startLoop(id, opts = {}) {
    const slot = SLOTS[id];
    if (!slot || slot.kind !== 'loop') return null;
    const key = opts.key ? `${id}#${opts.key}` : id;
    if (!unlocked || paused) {
      if (!paused && !pending.some((p) => p.key === key)) pending.push({ kind: 'loop', id, opts, key });
      return null;
    }
    const live = emitters.get(key);
    if (live) { if (opts.follow) live.follow = opts.follow; if (opts.position) live.position = opts.position; return live; }
    const buf = buffers.get(id);
    if (!buf) return null;
    slot.__id = id;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    // ★ pull the loop points a millisecond inside the buffer. Harmless on the WAVs that ship
    // today; load-bearing the moment anyone swaps in an AAC or MP3, whose encoder delay and
    // padding tick once per pass, forever.
    const pad = 0.001;
    src.loopStart = pad;
    src.loopEnd = Math.max(pad * 2, buf.duration - pad);
    // start each loop at a random offset so two emitters of the same slot (the three CRTs) are
    // not phase-locked — identical buffers in lockstep read as one loud source, not as three
    src.start(0, Math.random() * buf.duration);
    const node = makeVoice(slot, opts);
    src.connect(node.g);
    node.src = src;
    node.key = key;
    node.follow = opts.follow ?? null;
    node.position = opts.position ?? null;
    node.rateScale = 1;
    // ★ A FADE AND A STOP ARE SCHEDULED; ONLY CONTINUOUS QUANTITIES ARE PER-FRAME. The rule
    // loops-docs 10-platform/30 §4b sets is "no per-frame automation", not "no automation" — and
    // driving a fade from frames instead has a worse failure: a hidden pane or a backgrounded app
    // stops rAF, so a bed asked to stop would keep playing at its last level indefinitely. These
    // are two events per emitter for its whole life, which accumulates to nothing.
    node.fadeMul = 1;
    if (node.position || node.follow) place(node, node.position ?? node.follow(), 0, true);
    {
      const t = ctx.currentTime, target = Math.max(node.g.gain.value, 0.0002);
      node.g.gain.setValueAtTime(0.0001, t);
      node.g.gain.exponentialRampToValueAtTime(target, t + (opts.fade ?? 1.5));
      node.fadeUntil = t + (opts.fade ?? 1.5);
    }
    emitters.set(key, node);
    return node;
  }

  function stopLoop(id, { key = null, fade = 0.4 } = {}) {
    const k = key ? `${id}#${key}` : id;
    const node = emitters.get(k);
    if (!node) { for (let i = pending.length - 1; i >= 0; i--) if (pending[i].key === k) pending.splice(i, 1); return; }
    emitters.delete(k);
    const t = ctx.currentTime;
    node.g.gain.cancelScheduledValues(t);
    node.g.gain.setValueAtTime(Math.max(node.g.gain.value, 0.0001), t);
    node.g.gain.exponentialRampToValueAtTime(0.0001, t + fade);
    if (node.send) {
      node.send.gain.cancelScheduledValues(t);
      node.send.gain.setValueAtTime(Math.max(node.send.gain.value, 0.0001), t);
      node.send.gain.exponentialRampToValueAtTime(0.0001, t + fade);
    }
    // stopped by the AUDIO CLOCK, so it stops even if no frame is ever drawn again
    try { node.src.stop(t + fade + 0.05); } catch { /* already stopped */ }
    node.src.onended = () => {
      try { node.g.disconnect(); node.lp?.disconnect(); node.panner?.disconnect(); node.send?.disconnect(); } catch { /* gone */ }
    };
  }

  // ── per frame ──────────────────────────────────────────────────────────────────────────────
  function update(dt, camera) {
    if (camera) listenerFrom(camera);
    const step = Math.min(dt || 0.016, 0.1);
    for (const node of emitters.values()) {
      // While the start ramp is still running the scheduler owns this gain — writing `.value`
      // under it would cancel the fade in and land the bed at full level on its first frame.
      const fading = node.fadeUntil !== undefined && ctx.currentTime < node.fadeUntil;
      const pos = node.follow ? node.follow() : node.position;
      node.base = (node.slot.gain ?? 1) * (node.userGain ?? 1);
      if (fading) { if (pos) { setPos(node, pos); } continue; }
      if (pos) place(node, pos, step, false);
      else {
        node.g.gain.value = node.base * (soloAllows(node.slot.__id) ? 1 : 0);
        if (node.send) node.send.gain.value = node.g.gain.value * AIR.wetNear;
      }
      if (node.rateTarget !== undefined) {
        node.rateScale = approach(node.rateScale, node.rateTarget, step, 0.25);
        node.src.playbackRate.value = node.rateScale;
      }
    }
  }

  // ── lifecycle ──
  // ★ PAUSED LOOP = SILENT LOOP (PLAN §3, loops-docs 10-platform/30 §2). The ramp is what makes it
  // read as the room going away rather than as the audio breaking; suspend() after it is what
  // makes the silence cost nothing. ★ AND RESUME MUST BELIEVE THE PROMISE, NOT THE REQUEST: that
  // doc's §2 records a measured iPhone case where WebKit had suspended the context itself, the
  // gain was restored, the readout said PLAYING and the room stayed silent for the session.
  function pause() {
    if (paused) return;
    paused = true;
    clearTimeout(retryT); retryT = 0; retries = 0;
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(0, t + 0.06);
    setTimeout(() => { if (paused) ctx.suspend().catch(() => {}); }, 90);
  }
  let userVol = 1;
  let shellGain = 1;          // the viewer's own level, from the shell's mute message
  let muted = false;
  let retryT = 0, retries = 0, resumeAskedAt = 0;
  const level = () => volOf(userVol) * (muted ? 0 : shellGain);

  // ★ BELIEVING THE PROMISE TELLS YOU IT FAILED; IT DOES NOT PUT THE SOUND BACK. That is #101,
  //   and it is the half DP-W7 left out. The context comes back from a background in WebKit's
  //   `interrupted` state, `resume()` settles without reaching `running`, this code correctly
  //   recorded "still paused" — and then stopped. Silent for the rest of the session, which is
  //   exactly what Josh heard on the iPad at Gate B with the shell's own log showing the
  //   foreground pair delivered.
  //
  // ★ AND THE ONLY FALLBACK IT HAD IS STRUCTURALLY DEAD INSIDE THE APP. The gesture listeners
  //   above (`pointerdown`/`touchend`/`keydown`) can never fire there: loops-docs
  //   10-platform/00-input.md, 2026-09-13 — "a web Loop's `document` never receives a native
  //   pointerdown/click/touchstart at all, under any circumstance", so nothing the shell
  //   synthesises is a user-activation gesture and `AudioContext.resume()` by gesture is
  //   listed as unreachable. A browser tab can be rescued by the viewer clicking; a Loop
  //   cannot. So the retry is the whole recovery, and it has to be on a timer.
  //
  // An interruption ends when iOS says it ends, so this retries indefinitely on a backoff
  // capped at 2 s — one promise every two seconds against a Loop that runs forever — and stops
  // the moment it succeeds or something pauses again.
  // ★ AND "running" IS NOT PROOF OF SOUND AFTER A BACKGROUND (W9 iPad leg, 2026-09-24, #101). On
  //   three home-swipes the page went hidden → visible, the context resumed to `running`, the Loop's
  //   own level monitor saw the graph flowing at −6.3 dB — and Josh heard sound on one return of
  //   three, late. WebKit leaves the output route dead after an interruption while the context
  //   reports running, so believing the promise cannot catch it. After a HIDE, the resume is
  //   KICKED: suspend and resume again to make WebKit reopen the output, then start a one-sample
  //   silent buffer, the classic unlock nudge. Every kicked return is logged, so a device leg can
  //   read what the context did instead of inferring it from silence.
  let kickPending = false;
  function kickOutput() {
    return ctx.suspend().catch(() => {}).then(() => ctx.resume()).then(() => {
      try {
        const b = ctx.createBuffer(1, 1, ctx.sampleRate), src = ctx.createBufferSource();
        src.buffer = b; src.connect(ctx.destination); src.start();
      } catch { /* a nudge, never a reason to fail */ }
    });
  }
  function tryResume() {
    retryT = 0;
    const kick = kickPending;
    return ctx.resume().then(() => (kick && ctx.state === 'running' ? kickOutput() : null)).then(() => {
      paused = ctx.state !== 'running';        // what it actually did, not what was asked
      if (paused) { scheduleRetry(); return false; }
      if (kick) {
        kickPending = false;
        window.collectivus?.log?.(`audio: back from hidden — kicked, ctx ${ctx.state} after ${Math.round(performance.now() - resumeAskedAt)} ms, ${retries} refused`);
      }
      const tookRetries = retries;             // read it BEFORE the reset, or the line lies
      retries = 0;
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(0, t);
      master.gain.linearRampToValueAtTime(level(), t + 0.25);
      flush();
      if (resumeAskedAt) {
        const ms = Math.round(performance.now() - resumeAskedAt);
        resumeAskedAt = 0;
        // Through the bridge, not console.log: a Loop's console never reaches a device (BUD2).
        if (ms > 400) window.collectivus?.log?.(
          `audio: context came back after ${ms} ms and ${tookRetries} refused attempt${tookRetries === 1 ? '' : 's'}`);
      }
      return true;
    }).catch(() => { scheduleRetry(); return false; });
  }
  function scheduleRetry() {
    if (!paused || retryT) return;
    retries += 1;
    const wait = Math.min(2000, 250 * Math.pow(2, Math.min(retries - 1, 3)));
    retryT = setTimeout(() => { if (paused) tryResume(); }, wait);
  }
  /** @param {{afterHide?: boolean}} [o]  true when the page is coming back from hidden: kick the output */
  function resume({ afterHide = false } = {}) {
    if (afterHide) kickPending = true;
    if (!paused) {
      if (!afterHide) return Promise.resolve(false);
      resumeAskedAt = performance.now();
      return tryResume();
    }
    clearTimeout(retryT); retryT = 0; retries = 0;
    resumeAskedAt = performance.now();
    return tryResume();
  }

  // ── silence, which is NOT pause (bridge v2, loops-docs 30-audio §2b) ──────────────────────
  // ★ UNDER WKWebView THE SHELL CANNOT SILENCE A WEB AUDIO GRAPH AT ALL. It mutes <video> and
  //   <audio> elements and that is the whole of its reach, so on iPhone, iPad and Mac a Loop
  //   without this handler keeps talking under an open settings panel — and sounds correct on
  //   a television, where the binding owns the output stage. This Loop had no handler.
  // ★ AND UN-MUTING MUST RESUME THE CONTEXT, NOT JUST RESTORE THE GAIN: a viewer can background
  //   the app while the panel is open, so the un-mute would otherwise write a gain onto a
  //   context that never woke up, and report success. Same defect as #101, by another door.
  // The clock and the render loop are untouched on purpose — a Loop that stops stepping is
  // desynced from anyone watching alongside it, which is the whole reason mute is not pause.
  function setMuted(on, gain) {
    muted = !!on;
    if (gain != null && Number.isFinite(gain)) shellGain = Math.max(0, Math.min(1, gain));
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(paused ? 0 : level(), t + 0.06);
    if (!muted && !paused && ctx.state !== 'running') ctx.resume().catch(() => {});
    return { muted, shellGain };
  }

  function dispose() {
    for (const k of [...emitters.keys()]) {
      const node = emitters.get(k);
      emitters.delete(k);
      try { node.src.stop(); } catch { /* gone */ }
    }
    for (const ev of ['pointerdown', 'touchend', 'keydown']) window.removeEventListener(ev, gesture);
    setTimeout(() => ctx.close().catch(() => {}), 200);
  }

  // ── measurement ────────────────────────────────────────────────────────────────────────────
  // ★ A MIX IS JUDGED ON WHAT IS ACTUALLY COMING OUT, NOT ON THE NUMBERS THAT WENT IN, AND A
  //   SPATIAL MIX IS JUDGED FROM A POSITION. `report()` is the ladder as authored; `measure()`
  //   K-weights the real master over a window; `solo()` mutes everything else so a single
  //   source's RECEIVED level can be measured from where the camera actually is — which is the
  //   only way to check that moving the camera changed what a listener hears.
  function slotLoudness() {
    const rows = [];
    for (const [id, s] of Object.entries(SLOTS)) {
      const b = buffers.get(id);
      if (!b) { rows.push({ id, bus: s.bus, built: false }); continue; }
      const d = b.getChannelData(0);
      let sum = 0, peak = 0;
      for (let i = 0; i < d.length; i++) { sum += d[i] * d[i]; peak = Math.max(peak, Math.abs(d[i])); }
      const rms = Math.sqrt(sum / d.length);
      const trim = (s.gain ?? 1) * (BUSES[s.bus] ?? 1);
      rows.push({
        id, bus: s.bus, kind: s.kind, seconds: +b.duration.toFixed(2),
        source: s.src ? 'cc0 recording' : 'synth',
        dbfsRms: +(20 * Math.log10(Math.max(rms, 1e-9))).toFixed(1),
        dbfsPeak: +(20 * Math.log10(Math.max(peak, 1e-9))).toFixed(1),
        mixedRms: +(20 * Math.log10(Math.max(rms * trim, 1e-9))).toFixed(1),
        built: true,
      });
    }
    return rows.sort((a, b) => (b.mixedRms ?? -999) - (a.mixedRms ?? -999));
  }

  /** The RMS of a slot's buffer in dBFS — the level its material contributes before any trim. */
  const rmsCache = new Map();
  function bufferRmsDb(id) {
    if (rmsCache.has(id)) return rmsCache.get(id);
    const b = buffers.get(id);
    if (!b) return -120;
    const d = b.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
    const v = 20 * Math.log10(Math.max(Math.sqrt(sum / d.length), 1e-9));
    rmsCache.set(id, v);
    return v;
  }

  /**
   * What each live emitter is doing RIGHT NOW, from where the camera is: distance, the distance
   * terms, and — the number that matters — `receivedDb`, the dry level actually arriving at the
   * listener (material RMS + slot gain + distance + bus). ★ THIS IS THE READOUT TO FIT THE MIX
   * AGAINST, not the slot table: a slot's `gain` says nothing about what a listener hears until
   * it is put through a distance, and every source in this room sits at a different one.
   */
  function field() {
    const out = [];
    for (const [key, n] of emitters) {
      const pos = n.follow ? n.follow() : n.position;
      const id = n.slot.__id;
      const busDb = 20 * Math.log10(Math.max(buses[n.slot.bus]?.gain.value ?? 1, 1e-6));
      const gainDb = 20 * Math.log10(Math.max(n.g.gain.value, 1e-9));
      out.push({
        key, bus: n.slot.bus,
        metres: pos ? +dist(pos).toFixed(2) : null,
        receivedDb: +(bufferRmsDb(id) + gainDb + busDb).toFixed(1),
        levelDb: +(20 * Math.log10(Math.max(n.level ?? 1, 1e-6))).toFixed(1),
        cutoffHz: n.cut ? Math.round(n.cut) : null,
        gain: +(n.g.gain.value).toFixed(4),
        sendGain: n.send ? +(n.send.gain.value).toFixed(4) : 0,
      });
    }
    return out.sort((a, b) => b.receivedDb - a.receivedDb);
  }

  /** The same arithmetic for a one-shot that is not currently playing: what it WOULD arrive at
   *  from `metres` away. The ladder for sounds that only exist for half a second. */
  function received(id, metres) {
    const slot = SLOTS[id];
    if (!slot) return null;
    const a = acoustics(metres, slot);
    const busDb = 20 * Math.log10(Math.max(buses[slot.bus]?.gain.value ?? 1, 1e-6));
    return +(bufferRmsDb(id) + 20 * Math.log10(Math.max((slot.gain ?? 1) * (slot.spatial ? a.level : 1), 1e-9)) + busDb).toFixed(1);
  }

  // ★ THE INSTRUMENT IS loops-docs 10-platform/30 §6's, AND IT WAS NOT UNTIL AUD1 (#140). The
  //   pre-AUD1 version polled an AnalyserNode every 100 ms, which (1) read 46 ms of each 100 —
  //   54 % of the audio was never sampled; (2) DOWN-MIXED STEREO TO (L+R)/2 before measuring, so it
  //   read a decorrelated stereo bed 6 dB low and a centred source 3 dB low; (3) tapped `master`,
  //   before the limiter; (4) defaulted to 20 s; (5) never computed short-term; (6) called a sample
  //   peak `truePeakDbfs`. Every loudness number this Loop reported before AUD1 — DP-W7's −23.4,
  //   CMP2's −23.0 / −29.4, W9's −23.1 — came from that, and none is comparable with this one.
  //
  //   Now: an AudioWorklet on `output` sees every quantum the context renders; tools/loudness.js
  //   K-weights each channel with BS.1770's own filters, builds 400 ms blocks at 75 % overlap from
  //   gapless 100 ms sub-blocks, gates (−70 abs, −10 rel), takes the 3 s short-term maximum and a
  //   4× oversampled true peak. The tap counts its own frames against the context's clock, so a
  //   render dropout (headless Chromium skipping ahead under load) is reported as `dropoutSec`,
  //   never silently folded in. A window under 180 s, or one that dropped over 5 % of itself, says
  //   in `note` that it is NOT a conformance measurement. The gate is tools/check-loudness.mjs (wet, --dry, --selftest).
  //
  //   ⚠ AudioWorklet never exists on Apple TV (loops-docs web/05-apple-tv §6): measure in a browser.
  //   ⚠ Wall clock: a 180 s window takes 180 s of running audio. A paused or suspended context
  //     renders nothing, so the call fails fast rather than waiting on a clock that is not moving.
  let meterLoaded = null;
  /** BS.1770 / R128 loudness of the real output over `seconds` (default 180, the §6 minimum). */
  async function measure(seconds = 180) {
    if (!ctx.audioWorklet || typeof AudioWorkletNode !== 'function') {
      return { error: 'no AudioWorklet on this platform — measure in a browser (Apple TV never has it)' };
    }
    if (ctx.state !== 'running') return { error: `the context is ${ctx.state}, not running — unlock or resume it first` };
    // Relative to THIS module, as a string: `new URL()` is one of the globals the Apple TV binding lacks.
    meterLoaded ??= ctx.audioWorklet.addModule(import.meta.url.replace(/[^/?#]*([?#].*)?$/, 'loudness-worklet.js'));
    await meterLoaded;
    const tap = new AudioWorkletNode(ctx, 'dp-loudness', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    // A node nothing pulls is never processed; a zero gain to the destination makes the render
    // thread pull the tap every quantum without adding a sample to what anyone hears.
    const pull = ctx.createGain();
    pull.gain.value = 0;
    output.connect(tap);
    tap.connect(pull).connect(ctx.destination);

    const want = Math.round(seconds / SUB_BLOCK_SEC);
    const subs = [];
    let span = null;
    const finished = await new Promise((done) => {
      // a wall-clock guard: if the context stops rendering, sub-blocks stop arriving
      const guard = setTimeout(() => done(false), (seconds * 1.25 + 10) * 1000);
      tap.port.onmessage = (e) => {
        for (const s of e.data.subs) if (subs.length < want) subs.push(s);
        span = e.data;
        if (subs.length >= want) { clearTimeout(guard); done(true); }
      };
    });
    tap.port.postMessage('stop');
    output.disconnect(tap); tap.disconnect(); pull.disconnect();

    // The tap counted `frames` from its first quantum to `endFrame`; the difference is frames the
    // context's clock skipped without rendering anything — a dropout, reported, not a missed sample.
    const dropoutFrames = span ? Math.max(0, span.endFrame - span.startFrame - span.frames) : 0;
    const r = summarise(subs, { requestedSec: seconds, dropoutFrames, sampleRate: ctx.sampleRate });
    return {
      ...r,
      ...(finished ? {} : { note: `NOT a conformance measurement: the context stopped rendering after ${r.seconds} s` , conformance: false, pass: false }),
      sampleRate: ctx.sampleRate,
      // where the context's clock jumped: [atFrame, framesSkipped], first 64
      gaps: span?.gaps ?? [],
      tap: 'output (after the limiter)',
      convolver: hasConvolver,
      shellGain, muted,
    };
  }

  return {
    ctx, buses, log, slots: SLOTS, reverb: reverbReturn,
    get unlocked() { return unlocked; },
    get paused() { return paused; },
    get built() { return buffers.size; },
    get listener() { return { ...lis }; },
    ready,
    fire, startLoop, stopLoop, update, listenerFrom,
    loop: (id, key) => emitters.get(key ? `${id}#${key}` : id) ?? null,
    /** a bed that follows a system (the belt under a stall) — a multiplier on its own gain */
    setLoopGain(id, mul, key) {
      const n = emitters.get(key ? `${id}#${key}` : id);
      if (n) n.userGain = mul;
    },
    setLoopRate(id, rate, key) {
      const n = emitters.get(key ? `${id}#${key}` : id);
      if (n) n.rateTarget = Math.max(rate, 0.02);
    },
    setBus(id, v) { if (buses[id]) buses[id].gain.value = v; },
    setVolume(v) { userVol = v; if (!paused) master.gain.value = level(); },
    setMuted,
    get muted() { return muted; },
    get shellGain() { return shellGain; },
    /** how many times the resume has been refused since the last successful one (#101) */
    get resumeRetries() { return retries; },
    get contextState() { return ctx.state; },
    setReverb(v) { reverbReturn.gain.value = v; },
    /** measurement only: mute everything but one slot, so its RECEIVED level can be measured */
    solo(id) { soloed = id; },
    unsolo() { soloed = null; },
    get soloed() { return soloed; },
    pause, resume, dispose,
    report: slotLoudness, field, received, measure,
    /** measurement only: the node measure() taps (after the limiter) — the gate plants violations here */
    output,
  };
}

// ── the drip ───────────────────────────────────────────────────────────────────────────────────
// AUD-002, the signature sound. Two things make it read as a room rather than as a metronome:
// the interval is random and so is WHERE it lands, drawn from the run seed so every device in the
// world drips together.
//
// ★ IT IS SCHEDULED IN WINDOWS, NOT AS A RUNNING SUM. "Interval n is a random draw" means the time
//   of drip n is the sum of n draws, so a device joining after two days would have to replay every
//   drip to know when the next one is. One drip per fixed window, at a drawn phase inside it, is
//   O(1) from any join point and still random in both time and place. The phase is clamped away
//   from the window edges so two drips cannot land back to back across a boundary.
//
// ★ AND IT IS NOT AN EVENT. At a ~22 s mean it would fire 160 times an hour on its own, which is
//   most of the library's whole density budget (8–240/h) spent on a sound with no state and no
//   exclusivity. The bed schedules it; the scheduler is for things that take the world over.
//
// ★ `runAt(nowSec)` → { runSeed, epoch } follows the run of show ACROSS its window edges (W9). A drip
//   keyed to the seed and epoch it opened with keeps the old evening after the run-of-show window
//   turns, while a device opened after the edge hears the new one. Omit it for a fixed run.
export function createDripScheduler({ audio, points, runSeed, windowSec = 22, epoch = 0, runAt = null }) {
  let lastWindow = null;
  let armed = null;                     // { at, point } — the drip this window is waiting on
  const fired = [];

  return {
    get pending() { return armed; },
    log: fired,
    /** call every frame with the shared clock in SECONDS (fractional is fine) */
    tick(nowSec) {
      if (!points.length) return;
      if (runAt) ({ runSeed, epoch } = runAt(nowSec));
      const w = Math.floor((nowSec - epoch) / windowSec);
      // Keyed by the run too: a new run-of-show window is a new drip window even when w repeats.
      const key = runSeed + ':' + w;
      if (key !== lastWindow) {
        lastWindow = key;
        const phase = 0.15 + rollHash(runSeed, 'ambient_drip', 'drip', w, '#t') * 0.7;
        const pi = Math.min(points.length - 1, Math.floor(rollHash(runSeed, 'ambient_drip', 'drip', w, '#p') * points.length));
        armed = { at: epoch + (w + phase) * windowSec, point: points[pi], w };
      }
      if (armed && nowSec >= armed.at) {
        const w2 = armed.w;
        // pitch and level vary per drip: one recording played identically 160 times an hour is
        // the thing a listener starts to hear as a sample rather than as water.
        audio.fire('drip', {
          position: armed.point,
          rate: 0.86 + rollHash(runSeed, 'ambient_drip', 'drip', w2, '#r') * 0.34,
          gain: 0.72 + rollHash(runSeed, 'ambient_drip', 'drip', w2, '#g') * 0.5,
        });
        fired.push({ at: armed.at, w: w2, point: armed.point });
        if (fired.length > 60) fired.shift();
        armed = null;
      }
    },
  };
}
