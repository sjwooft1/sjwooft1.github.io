/* ============================================================
   Start-gun sensor.

   The starter fires a pistol once; from then on a microphone on the
   finish-line device listens for *that* bang. Volume alone is not enough —
   a dropped hurdle, a car door or a shout is loud too — so the recording
   gives us a level and a coarse spectral shape, and a noise has to clear
   the learned level *and* resemble that shape before it counts as the gun.

   The maths is pure so it can be tested without a microphone; GunSensor
   only owns the mic and the polling loop.
   ============================================================ */

export const BANDS = 8; // spectrum buckets compared against the recorded gun
const POLL_MS = 40;
const TOLERANCE = 0.4; // spectral distance still counted as "the same bang"
const BASELINE_RISE = 3; // must be this many times the room's own noise floor
const SETTLE_MS = 350; // ignore the first frames after arming

/** Energy per spectrum bucket. A pistol is broadband; a voice is not. */
export function bandEnergy(spectrum, bands = BANDS) {
  const out = new Array(bands).fill(0);
  const n = spectrum.length;
  for (let i = 0; i < n; i++) {
    const band = Math.min(bands - 1, Math.floor((i / n) * bands));
    out[band] += spectrum[i];
  }
  return out;
}

/** Bucket energies as fractions of the whole, so loudness drops out. */
export function normalise(bands) {
  const sum = bands.reduce((a, b) => a + b, 0);
  if (!sum) return bands.map(() => 1 / bands.length);
  return bands.map((v) => v / sum);
}

/** 0 for an identical profile, 1 for no overlap at all. */
export function spectralDistance(a, b) {
  if (!a || !b) return 1;
  let diff = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) diff += Math.abs(a[i] - b[i]);
  return Math.min(1, diff / 2);
}

/** Root-mean-square of a time-domain window. */
export function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * Is this frame the gun? Loud enough, sudden against the room, and the same
 * shape as the bang that was recorded.
 */
export function looksLikeGun({
  level = 0,
  baseline = 0,
  peak = 0,
  threshold = 0.6,
  profile = null,
  reference = null,
  tolerance = TOLERANCE,
} = {}) {
  if (!reference || !profile) return false;
  if (level < peak * threshold) return false;
  if (level < baseline * BASELINE_RISE) return false;
  return spectralDistance(profile, reference) <= tolerance;
}

export class GunSensor {
  /**
   * opts:
   *   onFire({ level, at })   — the gun was heard
   *   onStatus({ state, ... }) — idle | learning | ready | armed | fired
   *   onLevel(level)          — live level while listening
   */
  constructor(opts = {}) {
    this.onFire = opts.onFire || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.onLevel = opts.onLevel || (() => {});

    this.reference = null; // { peak, profile }
    this.state = "idle";
    this.threshold = 0.6;
    this.tolerance = TOLERANCE;

    this.analyser = null;
    this.ctx = null;
    this.stream = null;
    this._timer = null;
    this._armAt = 0;
    this._baseline = null;
    this._samples = null;
    this._spectrum = null;
  }

  setThreshold(fraction) {
    this.threshold = Math.min(0.95, Math.max(0.4, Number(fraction) || 0.6));
  }

  async _open() {
    if (this.analyser) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("This browser can't open a microphone");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      // Loudness has to be the real loudness: let the browser "help" and the
      // bang gets levelled out to sound like everything else.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    source.connect(this.analyser);
    this._samples = new Float32Array(this.analyser.fftSize);
    this._spectrum = new Uint8Array(this.analyser.frequencyBinCount);
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  _read() {
    this.analyser.getFloatTimeDomainData(this._samples);
    this.analyser.getByteFrequencyData(this._spectrum);
    const level = rms(this._samples);
    const baseline = this._baseline == null ? level : this._baseline;
    this._baseline = this._baseline == null ? level : this._baseline * 0.93 + level * 0.07;
    return { level, baseline, profile: normalise(bandEnergy(this._spectrum)) };
  }

  /** Listen to the real gun once and remember its bang. */
  async record(ms = 1600) {
    this.stop();
    await this._open();
    this.state = "learning";
    this.onStatus({ state: "learning" });
    this._baseline = null;

    let best = null;
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const frame = this._read();
      if (!best || frame.level > best.level) best = frame;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }

    if (!best || !(best.level > 0.002)) {
      this.state = "idle";
      this.onStatus({ state: "idle", error: "nothing audible" });
      return null;
    }

    this.reference = { peak: best.level, profile: best.profile };
    this.state = "ready";
    this.onStatus({ state: "ready", peak: best.level });
    return this.reference;
  }

  async arm() {
    if (!this.reference) throw new Error("Record the gun first");
    await this._open();
    this._baseline = null;
    this._armAt = Date.now();
    this.state = "armed";
    this.onStatus({ state: "armed" });
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => this._tick(), POLL_MS);
  }

  _tick() {
    if (this.state !== "armed" || !this.analyser) return;
    const frame = this._read();
    this.onLevel(frame.level);
    if (Date.now() - this._armAt < SETTLE_MS) return;

    const heard = looksLikeGun({
      level: frame.level,
      baseline: frame.baseline,
      peak: this.reference.peak,
      threshold: this.threshold,
      profile: frame.profile,
      reference: this.reference.profile,
      tolerance: this.tolerance,
    });
    if (!heard) return;

    this.state = "fired";
    this.stop();
    this.onStatus({ state: "fired", level: frame.level });
    this.onFire({ level: frame.level, at: Date.now() });
  }

  /** Release the microphone. The recorded bang is kept, so it can re-arm. */
  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.ctx) {
      try { this.ctx.close(); } catch {}
      this.ctx = null;
    }
    this.analyser = null;
    if (this.state !== "fired") this.state = "idle";
  }

  destroy() {
    this.stop();
    this.reference = null;
  }
}
