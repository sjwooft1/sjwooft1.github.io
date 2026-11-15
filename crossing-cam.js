/* ============================================================
   Finish-line crossing detection — the two-device timing rig.

   Device A starts the race. Device B films the finish line side-on,
   and this module answers one question only: *did somebody cross the
   line, and at what moment?* Bib numbers are deliberately not part of
   it — the organizer writes those down and matches them afterwards, so
   an unreadable or misread number can never corrupt a recorded time.

   The maths (motion profile, blob pick, crossing interpolation) is pure
   so it can be unit-tested; only `CrossingCam` touches the DOM.
   ============================================================ */

/* Vertical slice of the frame that is watched. Runners cross anywhere in
   the middle of the picture, so ignore the sky/top edge and the strip of
   foreground that a tripod usually catches. */
const BAND = { y0: 0.06, y1: 0.98 };

/* The strip that actually decides the finish: a finish is the moment the
   athlete's *chest* breaks the line, so only a horizontal band at chest
   height is watched. A trailing foot, a swinging hand or a head bobbing
   above the band cannot stamp a time on its own, and the timestamp is the
   moment the torso arrives rather than whenever a limb happens to reach
   the line. Defaults suit a phone at chest height ~10 ft from the line;
   the organizer nudges it with the chest sliders until the band sits on
   the bib. */
export const CHEST_BAND = { y0: 0.36, y1: 0.62 };
const MOTION_DIFF = 24; // grey levels of change that count as movement
const ABSORB_TICKS = 25; // ~2.3 s of unchanging difference = a parked object
const CHEST_FILL = 0.3; // share of the chest strip a body must cover to count

/** Grayscale copy of an RGBA buffer (floats, for smooth background blending). */
export function toGray(rgba, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = rgba[p] * 0.299 + rgba[p + 1] * 0.587 + rgba[p + 2] * 0.114;
  }
  return out;
}

/**
 * Per-column count of pixels that changed between two grayscale frames.
 * A runner crossing the frame shows up as a tall, narrow ridge of columns.
 */
export function columnMotion(prev, cur, w, h, band = BAND, threshold = MOTION_DIFF) {
  const cols = new Float32Array(w);
  const y0 = Math.max(0, Math.floor(h * band.y0));
  const y1 = Math.min(h, Math.ceil(h * band.y1));
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const d = cur[i] - prev[i];
      if (d > threshold || d < -threshold) cols[x]++;
    }
  }
  return cols;
}

/**
 * Heaviest contiguous run of active columns — i.e. one runner rather than
 * "somewhere in this crowd". Small gaps (a dark jacket seam, a gap between
 * legs) are tolerated so a single body does not split into two blobs.
 */
export function dominantBlob(cols, { minColumn = 6, minWidth = 3, maxGap = 2 } = {}) {
  let best = null;
  let start = -1;
  let mass = 0;
  let lastActive = -1;
  let gap = 0;

  const commit = () => {
    if (start >= 0 && lastActive - start + 1 >= minWidth) {
      let weighted = 0;
      for (let x = start; x <= lastActive; x++) weighted += (x + 0.5) * cols[x];
      const width = lastActive - start + 1;
      if (mass > 0 && (!best || mass > best.mass)) {
        best = { start, end: lastActive + 1, width, mass, center: weighted / mass };
      }
    }
    start = -1;
    mass = 0;
    lastActive = -1;
    gap = 0;
  };

  for (let x = 0; x < cols.length; x++) {
    if (cols[x] >= minColumn) {
      if (start < 0) start = x;
      mass += cols[x];
      lastActive = x;
      gap = 0;
    } else if (start >= 0) {
      gap++;
      if (gap > maxGap) commit();
    }
  }
  commit();
  return best;
}

/**
 * Did the tracked object pass the line between two samples? Returns the
 * interpolated moment (finer than the frame interval) plus the direction.
 * A sample sitting exactly on the line counts as crossed, which is what
 * keeps a runner landing on the pixel from being silently skipped.
 */
export function crossedLine(prevCenter, center, lineX, prevAt, now) {
  if (prevCenter == null || center == null) return null;
  const a = prevCenter - lineX;
  const b = center - lineX;
  if (a === 0 && b === 0) return null;
  if (a * b > 0) return null; // both samples clearly on the same side
  const span = center - prevCenter;
  if (!span) return null;
  const frac = Math.min(1, Math.max(0, -a / span));
  return {
    at: prevAt + (now - prevAt) * frac,
    direction: span > 0 ? "ltr" : "rtl",
    travel: Math.abs(span),
  };
}

/**
 * Camera driver. Watches a video element, keeps a slowly-adapting background
 * model, and fires `onCross({ at, direction, x })` once per runner.
 *
 * opts:
 *   video, overlay          — elements
 *   now()                   — clock used for timestamps (pass the shared
 *                             race clock so two devices agree)
 *   onCross({ at, direction, x })
 *   onStatus({ state, motion, crossings })
 *   onLineChange(lineX)
 */
export class CrossingCam {
  constructor(opts = {}) {
    this.video = opts.video || null;
    this.overlay = opts.overlay || null;
    this.now = opts.now || (() => Date.now());
    this.onCross = opts.onCross || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.onLineChange = opts.onLineChange || (() => {});

    this.direction = opts.direction || "either";
    this.lineX = opts.lineX ?? 0.5;
    this.sensitivity = opts.sensitivity ?? 1; // >1 = more sensitive
    this.band = { ...(opts.band || CHEST_BAND) };

    this.workW = opts.workW ?? 240;      // analysis width (cheap but ample)
    this.intervalMs = opts.intervalMs ?? 90;
    this.minTravel = opts.minTravel ?? 0.05; // of frame width, before a crossing counts
    this.cooldownMs = opts.cooldownMs ?? 1200;

    this.armed = false;
    this.crossings = 0;

    this._timer = null;
    this._bg = null;
    this._track = null;
    this._busyUntil = 0;
    this._flashAt = -Infinity;
    this._blob = null;
    this._canvas = null;
    this.photoWidth = opts.photoWidth ?? 960;     // identification quality
    this.photoQuality = opts.photoQuality ?? 0.72;
    this.labelFor = opts.labelFor || null;        // (at) => caption burned into the photo

    this._shot = null;      // scratch canvas for the "at the line" frame
    this._preCanvas = null; // roll buffer for the "approaching" frame
    this._preAt = 0;
    this._tick = this._tick.bind(this);

    if (this.overlay && typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => this._drawOverlay(this._blob));
      this._ro.observe(this.overlay);
    }
  }

  /* ---- lifecycle ---- */

  arm() {
    if (this.armed) return;
    if (!this.video || !this.video.videoWidth) throw new Error("Camera is not ready yet");
    this._bg = null;
    this._still = null;
    this._track = null;
    this._busyUntil = 0;
    this._preCanvas = null;
    this._preAt = 0;
    this.armed = true;
    this._timer = setInterval(this._tick, this.intervalMs);
    this._tick();
    this.onStatus({ state: "armed", motion: 0, crossings: this.crossings });
  }

  disarm() {
    this.armed = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._bg = null;
    this._still = null;
    this._track = null;
    this._blob = null;
    this._preCanvas = null;
    this._preAt = 0;
    this._drawOverlay(null);
    this.onStatus({ state: "standby", motion: 0, crossings: this.crossings });
  }

  destroy() {
    this.disarm();
    if (this._ro) this._ro.disconnect();
  }

  setLine(x) {
    this.lineX = Math.min(0.95, Math.max(0.05, Number(x) || 0.5));
    this._drawOverlay(this._blob);
  }

  setDirection(d) {
    this.direction = d === "ltr" || d === "rtl" ? d : "either";
  }

  setSensitivity(s) {
    this.sensitivity = Math.min(3, Math.max(0.3, Number(s) || 1));
  }

  /**
   * Where the chest is. `center` is the height of the strap line as a
   * fraction of the frame (0.49 = just below the middle), `thickness` how
   * much of the body around it counts as chest.
   */
  setBand(center, thickness) {
    const c = Math.min(0.9, Math.max(0.1, Number(center) || 0.49));
    const t = Math.min(0.7, Math.max(0.08, Number(thickness) || 0.26));
    const y0 = Math.max(0, Math.min(1 - t, c - t / 2));
    this.band = { y0, y1: y0 + t };
    this._drawOverlay(this._blob);
  }

  /** Click or drag anywhere on the preview to put the line on the real one. */
  attachLineDrag() {
    const cv = this.overlay;
    if (!cv) return;
    let dragging = false;
    const move = (ev) => {
      const box = this._videoBox();
      if (!box.w) return;
      const rect = cv.getBoundingClientRect();
      this.setLine((ev.clientX - rect.left - box.x) / box.w);
      this.onLineChange(this.lineX);
    };
    cv.addEventListener("pointerdown", (ev) => {
      dragging = true;
      try { cv.setPointerCapture(ev.pointerId); } catch {}
      move(ev);
    });
    cv.addEventListener("pointermove", (ev) => { if (dragging) move(ev); });
    const stop = () => { dragging = false; };
    cv.addEventListener("pointerup", stop);
    cv.addEventListener("pointercancel", stop);
    cv.addEventListener("pointerleave", stop);
  }

  /* ---- detection ---- */

  /** Public single-frame grab (used by the practice "simulate" button). */
  snapshot(at = null) {
    return this._snapshot(this.photoWidth, this.photoQuality, at);
  }

  /**
   * Grab the current video frame, with the finish line drawn onto it, as a
   * JPEG data URL. These photos are the record of *who* crossed, so they are
   * captured at `photoWidth` (960px reads a bib at a finish line) and the
   * line plus the race time are burned in — a reviewer can always see where
   * the line was, not just where the camera pointed.
   */
  _snapshot(width = this.photoWidth, quality = this.photoQuality, at = null) {
    const v = this.video;
    if (!v || !v.videoWidth) return null;
    if (!this._shot) this._shot = document.createElement("canvas");
    this._drawShot(v, this._shot, width, at);
    return this._encode(this._shot, quality);
  }

  /** Paint one video frame into `canvas`, then annotate it. */
  _drawShot(video, canvas, width, at) {
    const w = Math.max(1, Math.min(width, video.videoWidth || width));
    const h = Math.max(1, Math.round((w * (video.videoHeight || w * 0.75)) / (video.videoWidth || w)));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, w, h);
    this._annotate(ctx, w, h, at);
    return canvas;
  }

  /** Chest strip + dashed finish line + race-time caption, scaled to the photo. */
  _annotate(ctx, w, h, at) {
    const bTop = Math.round(this.band.y0 * h);
    const bBot = Math.round(this.band.y1 * h);
    const lx = Math.round(this.lineX * w);
    ctx.save();
    // the chest strip the finish was triggered by
    ctx.strokeStyle = "rgba(255, 127, 17, 0.55)";
    ctx.lineWidth = Math.max(1, Math.round(w / 640));
    ctx.beginPath();
    ctx.moveTo(0, bTop);
    ctx.lineTo(w, bTop);
    ctx.moveTo(0, bBot);
    ctx.lineTo(w, bBot);
    ctx.stroke();
    // the finish line itself
    ctx.strokeStyle = "rgba(52, 211, 153, 0.92)";
    ctx.lineWidth = Math.max(2, Math.round(w / 240));
    const dash = Math.max(6, Math.round(w / 45));
    ctx.setLineDash([dash, Math.round(dash * 0.7)]);
    ctx.beginPath();
    ctx.moveTo(lx, 0);
    ctx.lineTo(lx, h);
    ctx.stroke();
    ctx.restore();

    const text = this.labelFor && at != null ? this.labelFor(at) : null;
    if (!text) return;
    const pad = Math.max(6, Math.round(w / 70));
    const fs = Math.max(12, Math.round(w / 26));
    ctx.save();
    ctx.font = `700 ${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textBaseline = "top";
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(4, 8, 16, 0.72)";
    ctx.fillRect(pad, pad, tw + pad * 2, fs * 1.6);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, pad * 2, pad + fs * 0.28);
    ctx.restore();
  }

  /** Keep the roll buffer roughly 300 ms fresh while a runner is in view. */
  _refreshPre(now) {
    if (this._preCanvas && now - this._preAt < 300) return;
    this._preAt = now;
    if (!this._preCanvas) this._preCanvas = document.createElement("canvas");
    this._drawShot(this.video, this._preCanvas, this.photoWidth, null);
  }

  /** Stamp the race time onto an already-drawn frame (the roll buffer). */
  _label(canvas, at) {
    if (canvas && at != null) {
      this._annotate(canvas.getContext("2d"), canvas.width, canvas.height, at);
    }
    return canvas;
  }

  _encode(canvas, quality = this.photoQuality) {
    if (!canvas) return null;
    try {
      return canvas.toDataURL("image/jpeg", quality);
    } catch {
      return null;
    }
  }

  _tick() {
    const video = this.video;
    if (!video || !video.videoWidth) return;
    if (!this._canvas) this._canvas = document.createElement("canvas");

    const w = this.workW;
    const h = Math.max(24, Math.round((w * video.videoHeight) / video.videoWidth));
    const cv = this._canvas;
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    const gray = toGray(ctx.getImageData(0, 0, w, h).data, w, h);

    if (!this._bg) {
      this._bg = gray.slice();
      this._drawOverlay(null);
      return;
    }

    const now = this.now();
    const cols = columnMotion(this._bg, gray, w, h, this.band);

    // Background bookkeeping. Only *unchanged* pixels learn the new scene, so
    // a runner never paints a ghost trail behind themselves — a trail would
    // drag the measured centroid backwards and stamp an early finish. A pixel
    // that stays different for ABSORB_TICKS without ever going quiet is not
    // motion at all (a parked pram, a bin, somebody waiting), so it is absorbed
    // instead of masking the next runner.
    if (!this._still) this._still = new Uint8Array(this._bg.length);
    for (let i = 0; i < this._bg.length; i++) {
      const d = gray[i] - this._bg[i];
      if (d > -MOTION_DIFF && d < MOTION_DIFF) {
        this._bg[i] += d * 0.15;
        this._still[i] = 0;
      } else if (++this._still[i] >= ABSORB_TICKS) {
        this._bg[i] += d * 0.15;
        this._still[i] = 0;
      }
    }

    const bandPx = Math.round(h * (this.band.y1 - this.band.y0));
    const minColumn = Math.max(3, Math.round((bandPx * 0.05) / Math.max(0.4, this.sensitivity)));
    let blob = dominantBlob(cols, { minColumn, minWidth: Math.max(3, Math.round(w * 0.02)) });
    // A torso fills most of the chest strip. A hand or a foot passing through
    // it only lights up a sliver, so it is dropped rather than tracked.
    if (blob && blob.mass < CHEST_FILL * bandPx * blob.width) blob = null;
    this._blob = blob;

    if (!blob) {
      this._track = null;
      this._drawOverlay(null);
      this.onStatus({ state: this.armed ? "armed" : "standby", motion: 0, crossings: this.crossings });
      return;
    }

    const linePx = this.lineX * w;
    if (!this._track) {
      this._track = { first: blob.center, prev: blob.center, prevAt: now, ticks: 1 };
      this._refreshPre(now); // the runner's approach, captured before the line
      this._drawOverlay(blob);
      this.onStatus({ state: "watching", motion: blob.mass, crossings: this.crossings });
      return;
    }

    const cross = crossedLine(this._track.prev, blob.center, linePx, this._track.prevAt, now);
    this._track.prev = blob.center;
    this._track.prevAt = now;
    this._track.ticks++;

    const travelled = Math.abs(blob.center - this._track.first);
    const directionOk = this.direction === "either" || cross?.direction === this.direction;
    let fired = false;

    if (cross && directionOk && travelled >= this.minTravel * w && now >= this._busyUntil) {
      fired = true;
      this._busyUntil = now + this.cooldownMs;
      this._track = null; // one crossing per runner; wait for a fresh approach
      this.crossings++;
      this._flashAt = now;
      const fresh = this._preCanvas && now - this._preAt < 1200;
      const frames = [
        fresh ? this._encode(this._label(this._preCanvas, cross.at), this.photoQuality) : null,
        this._snapshot(this.photoWidth, this.photoQuality, cross.at),
      ].filter(Boolean);
      this._preCanvas = null;
      this._preAt = 0;
      this.onCross({ at: cross.at, direction: cross.direction, x: blob.center / w, frames });
    }

    // Refresh the roll buffer only on a tick that did *not* cross, so the
    // "approaching" photo is always from a genuinely earlier moment.
    if (!fired) this._refreshPre(now);

    this._drawOverlay(blob);
    this.onStatus({ state: "watching", motion: blob.mass, crossings: this.crossings });
  }

  /* ---- overlay ---- */

  /**
   * CSS-pixel box the overlay covers. Measured from the *stage*, never from
   * the canvas itself: a canvas with no layout size reports its own width
   * attribute as its rect, so measuring it while resizing it grows without
   * bound (that is how it reached the browser's canvas-area limit).
   */
  _stageBox() {
    const host = this.overlay && this.overlay.parentElement;
    const rect = (host || this.overlay)?.getBoundingClientRect();
    return rect ? { width: rect.width, height: rect.height } : { width: 0, height: 0 };
  }

  /** Displayed rectangle of the video inside the stage (object-fit: contain). */
  _videoBox() {
    const rect = this._stageBox();
    if (!this.overlay || !rect.width || !rect.height) return { x: 0, y: 0, w: 0, h: 0 };
    const vw = this.video?.videoWidth || 4;
    const vh = this.video?.videoHeight || 3;
    const scale = Math.min(rect.width / vw, rect.height / vh);
    const w = vw * scale;
    const h = vh * scale;
    return { x: (rect.width - w) / 2, y: (rect.height - h) / 2, w, h };
  }

  _drawOverlay(blob) {
    const cv = this.overlay;
    if (!cv) return;
    const rect = this._stageBox();
    if (!rect.width || !rect.height) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let pw = Math.round(rect.width * dpr);
    let ph = Math.round(rect.height * dpr);
    const MAX_AREA = 4e6; // hard ceiling well under the browser's canvas limit
    if (pw * ph > MAX_AREA) {
      const k = Math.sqrt(MAX_AREA / (pw * ph));
      pw = Math.max(1, Math.floor(pw * k));
      ph = Math.max(1, Math.floor(ph * k));
    }
    if (cv.width !== pw || cv.height !== ph) {
      cv.width = pw;
      cv.height = ph;
    }
    const ctx = cv.getContext("2d");
    ctx.setTransform(pw / rect.width, 0, 0, ph / rect.height, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const box = this._videoBox();
    if (!box.w) return;

    // the chest strip — only a body filling this band can stamp a finish
    const bandTop = box.y + box.h * this.band.y0;
    const bandH = box.h * (this.band.y1 - this.band.y0);
    ctx.fillStyle = "rgba(255,127,17,0.09)";
    ctx.fillRect(box.x, bandTop, box.w, bandH);
    ctx.save();
    ctx.strokeStyle = "rgba(255,127,17,0.45)";
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(box.x, bandTop);
    ctx.lineTo(box.x + box.w, bandTop);
    ctx.moveTo(box.x, bandTop + bandH);
    ctx.lineTo(box.x + box.w, bandTop + bandH);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.fillStyle = "rgba(255,127,17,0.9)";
    ctx.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.fillText("CHEST", box.x + 6, bandTop + bandH + 13);
    ctx.restore();

    // detected runner
    if (blob && this._canvas) {
      const sx = box.w / this._canvas.width;
      ctx.fillStyle = "rgba(52,211,153,0.22)";
      ctx.strokeStyle = "rgba(52,211,153,0.9)";
      ctx.lineWidth = 2;
      const bx = box.x + blob.start * sx;
      const bw = Math.max(2, blob.width * sx);
      ctx.fillRect(bx, bandTop, bw, bandH);
      ctx.strokeRect(bx, bandTop, bw, bandH);
    }

    // the finish line
    const lx = box.x + this.lineX * box.w;
    const flash = this.now() - this._flashAt < 600;
    ctx.save();
    ctx.strokeStyle = flash ? "#ffffff" : this.armed ? "#34d399" : "#94a3b8";
    ctx.lineWidth = flash ? 4 : 2;
    ctx.setLineDash(flash ? [] : [10, 7]);
    ctx.beginPath();
    ctx.moveTo(lx, box.y);
    ctx.lineTo(lx, box.y + box.h);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = flash ? "#ffffff" : this.armed ? "#34d399" : "#94a3b8";
    ctx.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.fillText("FINISH", lx, box.y + 16);
    ctx.restore();
  }
}
