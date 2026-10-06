// tools/loudness-worklet.js — the gapless tap for audio.js measure() (AUD1, #140).
//
// Runs on the audio render thread, so it sees EVERY 128-frame quantum the context renders — the
// property an AnalyserNode polled on a timer cannot have (the pre-AUD1 measure() read ~46 ms of
// every 100 ms and never saw the rest). The meter itself is tools/loudness.js, shared with the
// gate's Node self-test; this file only feeds it and posts each completed 100 ms sub-block, plus a
// running frame count and every jump in `currentFrame`, so a render dropout is counted, not assumed.
//
// ⚠ Measurement only. It is loaded by measure() on demand and never by the Loop's own boot, and it
//   cannot run on Apple TV: AudioWorklet will never exist on that binding (loops-docs
//   30-engines/web/05-apple-tv.md §6). Measure in a browser.
import { LoudnessMeter } from './loudness.js';

class DpLoudness extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is the AudioWorkletGlobalScope's own global — the context's rate.
    this.meter = new LoudnessMeter({ sampleRate, channels: 2 });
    this.subs = [];
    this.stopped = false;
    this.startFrame = null;              // the context frame this tap first saw
    this.nextFrame = null;               // where the next quantum should start if none was skipped
    this.gaps = [];                      // [atFrame, framesSkipped] — where the context's clock jumped
    this.port.onmessage = (e) => { if (e.data === 'stop') this.stopped = true; };
  }

  process(inputs) {
    if (this.stopped) return false;
    if (this.startFrame === null) this.startFrame = currentFrame;
    else if (currentFrame !== this.nextFrame && this.gaps.length < 64) this.gaps.push([this.nextFrame, currentFrame - this.nextFrame]);
    this.nextFrame = currentFrame + 128;
    const input = inputs[0];
    // An input with no connection arrives as zero channels: that is silence, and it is counted.
    const L = input[0] ?? new Float32Array(128), R = input[1] ?? input[0] ?? L;
    this.meter.process([L, R], this.subs);
    if (this.subs.length) {
      this.port.postMessage({ subs: this.subs, frames: this.meter.frames, startFrame: this.startFrame, endFrame: currentFrame + 128, gaps: this.gaps });
      this.subs = [];
    }
    return true;
  }
}

registerProcessor('dp-loudness', DpLoudness);
