/* =====================================================================
   finish-cam.js — spatial finish-line scanner for the Brighton Oaks 5K.

   How it works:
   1. The camera watches the finish straight. A background model finds
      moving runners (motion blobs) and a lightweight tracker follows
      each one across frames with a stable ID.
   2. Each tracked runner's chest region (where the bib lives) is read
      with a multi-pass OCR pipeline — lighting flattening, unsharp
      masking, Otsu binarization in both polarities — and reads are
      voted on across frames.
   3. When a tracked runner's feet cross the configured finish line the
      engine emits a finish event with a sub-frame interpolated time.

   Pure helpers are exported for unit tests; the FinishCam class wires
   them to a <video> element for live scanning.
===================================================================== */

/* ---------------------------------------------------------------------
   Image utilities (pure — operate on grayscale Uint8Array buffers)
--------------------------------------------------------------------- */

/** RGBA ImageData buffer -> grayscale luminance */
export function toGray(rgba, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000 | 0;
  }
  return g;
}

/** Fast box blur via summed-area table. Returns Float32Array. */
export function boxBlur(gray, w, h, r) {
  const S = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      S[(y + 1) * (w + 1) + (x + 1)] = S[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        S[(y1 + 1) * (w + 1) + (x1 + 1)] - S[y0 * (w + 1) + (x1 + 1)] -
        S[(y1 + 1) * (w + 1) + x0] + S[y0 * (w + 1) + x0];
      out[y * w + x] = sum / area;
    }
  }
  return out;
}

/** Unsharp mask — crisps digit edges before thresholding. */
export function unsharpMask(gray, w, h, amount = 1.1, radius = 2) {
  const blur = boxBlur(gray, w, h, radius);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const v = gray[i] + amount * (gray[i] - blur[i]);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
  }
  return out;
}

/** Flatten lighting gradients (shadows across the bib) by subtracting a
    wide local mean and re-centering on the global mean. */
export function flattenLighting(gray, w, h, radius = 12) {
  const mean = boxBlur(gray, w, h, radius);
  let global = 0;
  for (let i = 0; i < gray.length; i++) global += gray[i];
  global /= gray.length;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const v = global + (gray[i] - mean[i]) * 1.5;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
  }
  return out;
}

/** Classic Otsu threshold over a grayscale buffer. */
export function otsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let sumB = 0, wB = 0, best = -1, bestT = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; bestT = t; }
  }
  return bestT;
}

/** Otsu binarize. Output convention: 255 = paper/background, 0 = ink.
    invert=true treats *bright* pixels as ink (bright digits on dark). */
export function binarizeOtsu(gray, w, h, invert = false) {
  const t = otsuThreshold(gray);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const bright = gray[i] > t;
    out[i] = (bright !== invert) ? 255 : 0;
  }
  return out;
}

/* ---------------------------------------------------------------------
   Motion detection + blob extraction (pure)
--------------------------------------------------------------------- */

/** |fg - bg| > threshold -> 1. */
export function motionMask(fg, bg, w, h, threshold = 25) {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.abs(fg[i] - bg[i]) > threshold ? 1 : 0;
  }
  return out;
}

/** Binary dilation to join speckle into coherent regions. */
export function dilate(mask, w, h, r = 2) {
  if (r <= 0) return mask;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) out[yy * w + xx] = 1;
      }
    }
  }
  return out;
}

/** Connected components (4-neighbour) -> bounding boxes in pixel space. */
export function findBlobs(mask, w, h, { minArea = 40, maxArea = Infinity } = {}) {
  const seen = new Uint8Array(w * h);
  const boxes = [];
  const stack = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    let minX = w, minY = h, maxX = 0, maxY = 0, area = 0;
    while (stack.length) {
      const j = stack.pop();
      area++;
      const x = j % w, y = (j / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[j - 1] && !seen[j - 1]) { seen[j - 1] = 1; stack.push(j - 1); }
      if (x < w - 1 && mask[j + 1] && !seen[j + 1]) { seen[j + 1] = 1; stack.push(j + 1); }
      if (y > 0 && mask[j - w] && !seen[j - w]) { seen[j - w] = 1; stack.push(j - w); }
      if (y < h - 1 && mask[j + w] && !seen[j + w]) { seen[j + w] = 1; stack.push(j + w); }
    }
    if (area < minArea || area > maxArea) continue;
    boxes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area });
  }
  return boxes;
}

/** Merge boxes that overlap or sit within `gap` px of each other. */
export function mergeBoxes(boxes, gap = 8) {
  const out = boxes.map((b) => ({ ...b }));
  let merged = true;
  while (merged) {
    merged = false;
    outer:
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j];
        const near =
          a.x - gap <= b.x + b.w && b.x - gap <= a.x + a.w &&
          a.y - gap <= b.y + b.h && b.y - gap <= a.y + a.h;
        if (!near) continue;
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        const x2 = Math.max(a.x + a.w, b.x + b.w), y2 = Math.max(a.y + a.h, b.y + b.h);
        out[i] = { x, y, w: x2 - x, h: y2 - y, area: a.area + b.area };
        out.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------------
   Spatial tracker (pure) — tracks are in normalized 0..1 coordinates
--------------------------------------------------------------------- */

export class BibTracker {
  constructor({ maxDist = 0.22, maxLost = 4 } = {}) {
    this.maxDist = maxDist;      // normalized centroid distance for matching
    this.maxLost = maxLost;      // frames a track survives without a match
    this.tracks = [];
    this.nextId = 1;
  }

  /** Update with normalized boxes {x,y,w,h}. Returns the live track list.
      Each track: { id, cx, cy, feet, bbox, votes, history, lastSeen, seen } */
  update(boxes, timestamp) {
    const used = new Set();
    for (const track of this.tracks) {
      let best = -1, bestD = this.maxDist;
      for (let i = 0; i < boxes.length; i++) {
        if (used.has(i)) continue;
        const b = boxes[i];
        const dx = (b.x + b.w / 2) - track.cx;
        const dy = (b.y + b.h / 2) - track.cy;
        const d = Math.hypot(dx, dy);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) {
        used.add(best);
        const b = boxes[best];
        track.cx = b.x + b.w / 2;
        track.cy = b.y + b.h / 2;
        track.feet = b.y + b.h;            // bottom edge = runner's feet
        track.bbox = b;
        track.lastSeen = timestamp;
        track.lost = 0;
        track.seen++;
        track.history.push({ t: timestamp, feet: track.feet, cy: track.cy });
      } else {
        track.lost++;
      }
    }
    // spawn tracks for unmatched detections
    for (let i = 0; i < boxes.length; i++) {
      if (used.has(i)) continue;
      const b = boxes[i];
      this.tracks.push({
        id: this.nextId++,
        cx: b.x + b.w / 2,
        cy: b.y + b.h / 2,
        feet: b.y + b.h,
        bbox: b,
        votes: new Map(),       // bib -> { count, confSum, thumb }
        history: [{ t: timestamp, feet: b.y + b.h, cy: b.y + b.h / 2 }],
        lastSeen: timestamp,
        lost: 0,
        seen: 1,
        crossed: false,
        pendingOcr: false,
      });
    }
    // retire stale tracks — unresolved crossings get a longer grace period
    // so late OCR reads can still settle them
    this.tracks = this.tracks.filter((t) =>
      t.lost <= (t.crossed && !t.resolved ? this.maxLost * 4 : this.maxLost));
    return this.tracks;
  }

  /** Record an OCR vote for a track. */
  vote(track, bib, confidence, thumb) {
    if (!bib) return;
    const v = track.votes.get(bib) || { count: 0, confSum: 0 };
    v.count++;
    v.confSum += confidence;
    if (thumb && !v.thumb) v.thumb = thumb;
    track.votes.set(bib, v);
  }
}

/** Did the track's feet cross `lineY` between its last two history
    samples? Returns { at } with a sub-frame interpolated timestamp, or null. */
export function checkCrossing(track, lineY) {
  const h = track.history;
  if (track.crossed || h.length < 2) return null;
  const a = h[h.length - 2], b = h[h.length - 1];
  if (a.feet < lineY && b.feet >= lineY) {
    const span = b.feet - a.feet;
    const frac = span > 0 ? (lineY - a.feet) / span : 1;
    return { at: a.t + (b.t - a.t) * Math.min(1, Math.max(0, frac)) };
  }
  return null;
}

/** Resolve a track's accumulated votes to one bib.
    votes: Map bib -> { count, confSum }. */
export function tallyVotes(votes, knownBibs = []) {
  const known = new Set(knownBibs);
  const entries = [...votes.entries()].map(([bib, v]) => ({
    bib,
    count: v.count,
    confidence: v.count ? v.confSum / v.count : 0,
    known: known.has(bib),
    thumb: v.thumb,
  }));
  if (!entries.length) return null;
  entries.sort((a, b) =>
    (b.count - a.count) ||
    (b.confidence - a.confidence) ||
    (Number(b.known) - Number(a.known)));
  const top = entries[0];
  const total = entries.reduce((s, e) => s + e.count, 0);
  const dominant = total ? top.count / total >= 0.6 : true;
  const accepted =
    (top.count >= 2 && dominant && top.confidence >= 50) ||
    (top.count >= 1 && top.confidence >= 82);
  return { ...top, accepted, total };
}

/* ---------------------------------------------------------------------
   OCR pipeline helpers (DOM — canvas based)
--------------------------------------------------------------------- */

/** Draw a sub-rectangle of a source (video/image/canvas) into a fresh
    canvas, with optional upscale. */
export function cropToCanvas(source, sx, sy, sw, sh, minW = 220) {
  const canvas = document.createElement("canvas");
  const scale = sw * 2 < minW ? Math.min(4, Math.ceil(minW / Math.max(1, sw))) : 1;
  canvas.width = Math.max(8, Math.round(sw * scale));
  canvas.height = Math.max(8, Math.round(sh * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Build both polarity variants of a crop, pre-processed for OCR.
    Returns [{ canvas, invert }] with ink dark on white paper. */
export function ocrVariants(cropCanvas) {
  const w = cropCanvas.width, h = cropCanvas.height;
  const ctx = cropCanvas.getContext("2d", { willReadFrequently: true });
  const gray = toGray(ctx.getImageData(0, 0, w, h).data, w, h);
  const prepped = unsharpMask(flattenLighting(gray, w, h), w, h);
  return [false, true].map((invert) => {
    const bin = binarizeOtsu(prepped, w, h, invert);
    const out = document.createElement("canvas");
    out.width = w; out.height = h;
    const octx = out.getContext("2d");
    const img = octx.createImageData(w, h);
    for (let i = 0, p = 0; i < bin.length; i++, p += 4) {
      img.data[p] = img.data[p + 1] = img.data[p + 2] = bin[i];
      img.data[p + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    return { canvas: out, invert };
  });
}

/** Tesseract.js v5 reports 0 for data.confidence / word confidence on
    single-word crops — per-symbol confidence is the reliable one. */
export function readConfidence(data) {
  const symbols = data?.symbols || [];
  const withConf = symbols.filter((s) => typeof s.confidence === "number");
  if (withConf.length) {
    return withConf.reduce((s, x) => s + x.confidence, 0) / withConf.length;
  }
  const words = (data?.words || []).filter((w) => typeof w.confidence === "number" && w.confidence > 0);
  if (words.length) {
    return words.reduce((s, w) => s + w.confidence, 0) / words.length;
  }
  return data?.confidence ?? 0;
}

/** Run OCR on prepared variants and return the best digit read. */
export async function recognizeDigits(worker, cropCanvas) {
  const variants = ocrVariants(cropCanvas);
  let best = null;
  for (const { canvas, invert } of variants) {
    await worker.setParameters({
      tessedit_char_whitelist: "0123456789",
      tessedit_pageseg_mode: "8", // single word
    });
    const { data } = await worker.recognize(canvas);
    const digits = String(data.text || "").replace(/\D/g, "");
    const conf = readConfidence(data);
    if (digits && (!best || conf > best.confidence)) {
      best = { digits, confidence: Math.round(conf), invert };
    }
    if (best && best.confidence >= 80) break;
  }
  if (!best || best.confidence < 25) {
    // one retry as a single line — helps when the crop catches two numbers
    await worker.setParameters({
      tessedit_char_whitelist: "0123456789",
      tessedit_pageseg_mode: "7",
    });
    const { data } = await worker.recognize(variants[0].canvas);
    const digits = String(data.text || "").replace(/\D/g, "");
    const conf = readConfidence(data);
    if (digits && conf > (best?.confidence ?? 0)) {
      best = { digits, confidence: Math.round(conf), invert: false };
    }
  }
  return best;
}

/** Locate the bright bib patch inside a chest-band crop and return a
    tight crop of just the bib. Bibs are bright rectangles on the torso,
    so we threshold for bright regions and pick the best bib-shaped blob.
    Falls back to the full crop when nothing bib-like is found. */
export function locateBibPatch(cropCanvas) {
  const w = cropCanvas.width, h = cropCanvas.height;
  if (w < 24 || h < 16) return cropCanvas;
  const ctx = cropCanvas.getContext("2d", { willReadFrequently: true });
  const gray = toGray(ctx.getImageData(0, 0, w, h).data, w, h);
  const t = otsuThreshold(gray);
  const bright = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) bright[i] = gray[i] > t ? 1 : 0;
  const mask = dilate(bright, w, h, Math.max(2, Math.round(Math.min(w, h) / 36)));
  const blobs = findBlobs(mask, w, h, {
    minArea: Math.round(w * h * 0.03),
    maxArea: Math.round(w * h * 0.9),
  });
  let best = null, bestScore = 0;
  for (const b of blobs) {
    const aspect = b.w / b.h;
    if (aspect < 0.8 || aspect > 5.5) continue;
    const fill = b.area / (b.w * b.h);
    const score = fill * (1 - Math.abs(aspect - 2.2) / 6);
    if (score > bestScore) { bestScore = score; best = b; }
  }
  if (!best) return cropCanvas;
  const mx = best.w * 0.08, my = best.h * 0.14;
  const sx = Math.max(0, best.x - mx);
  const sy = Math.max(0, best.y - my);
  const sw = Math.min(w - sx, best.w + mx * 2);
  const sh = Math.min(h - sy, best.h + my * 2);
  return cropToCanvas(cropCanvas, sx, sy, sw, sh, 240);
}

/** Small JPEG thumbnail data-URL of a canvas (for feeds/review rows). */
export function thumbOf(canvas, width = 96) {
  const t = document.createElement("canvas");
  const scale = Math.min(1, width / canvas.width);
  t.width = Math.max(1, Math.round(canvas.width * scale));
  t.height = Math.max(1, Math.round(canvas.height * scale));
  t.getContext("2d").drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL("image/jpeg", 0.7);
}

/* ---------------------------------------------------------------------
   FinishCam — live scanning against a <video> element
--------------------------------------------------------------------- */

export class FinishCam {
  /**
   * opts:
   *   video        — <video> element with an active stream
   *   overlay      — <canvas> for the detection overlay (optional)
   *   getRosterBibs() -> string[] of known bib numbers
   *   onFinish({ bib, confidence, when, thumb, trackId, known })
   *   onReview({ guess, confidence, thumb, when, trackId })  (uncertain)
   *   onRead({ bib, confidence, trackId, thumb })            (each vote)
   *   onStatus({ state, tracks, reads })                     (UI updates)
   */
  constructor(opts = {}) {
    this.video = opts.video;
    this.overlay = opts.overlay || null;
    this.getRosterBibs = opts.getRosterBibs || (() => []);
    this.onFinish = opts.onFinish || (() => {});
    this.onReview = opts.onReview || (() => {});
    this.onRead = opts.onRead || (() => {});
    this.onStatus = opts.onStatus || (() => {});

    this.lineY = opts.lineY ?? 0.62;     // normalized finish-line height
    this.scanMs = opts.scanMs ?? 350;    // detection cadence
    this.minConf = opts.minConf ?? 65;   // auto-record confidence floor
    this.cooldownMs = opts.cooldownMs ?? 90000; // per-bib re-record guard
    this.autoRecord = opts.autoRecord ?? true;

    this.tracker = new BibTracker();
    this.bg = null;                      // background model (grayscale)
    this.bgW = 0; this.bgH = 0;
    this.armed = false;
    this.timer = null;
    this.ocrBusy = false;
    this.ocrQueue = [];
    this.reads = 0;
    this.recentBibs = new Map();         // bib -> timestamp of last finish
    this.workW = 320;                    // motion-analysis resolution

    this._grabCanvas = document.createElement("canvas");
    this._fullCanvas = document.createElement("canvas");
    this._onTick = this._onTick.bind(this);
    this._dragging = false;
  }

  /* ---- lifecycle ---- */

  arm() {
    if (this.armed) return;
    if (!this.video || !this.video.videoWidth) {
      throw new Error("Camera is not ready yet");
    }
    this.armed = true;
    this.timer = setInterval(this._onTick, this.scanMs);
    this._onTick();
    this.onStatus({ state: "armed", tracks: this.tracker.tracks.length, reads: this.reads });
  }

  disarm() {
    this.armed = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onStatus({ state: "standby", tracks: 0, reads: this.reads });
  }

  setLine(y) {
    this.lineY = Math.min(0.95, Math.max(0.05, y));
    this._drawOverlay([]);
  }

  /* ---- scanning ---- */

  _onTick() {
    const video = this.video;
    if (!video || !video.videoWidth) return;
    const w = this.workW;
    const h = Math.round(w * video.videoHeight / video.videoWidth) || 240;

    const gctx = this._grabCanvas.getContext("2d", { willReadFrequently: true });
    this._grabCanvas.width = w;
    this._grabCanvas.height = h;
    gctx.drawImage(video, 0, 0, w, h);
    const gray = toGray(gctx.getImageData(0, 0, w, h).data, w, h);

    const now = Date.now();
    if (!this.bg || this.bgW !== w) {
      this.bg = gray;
      this.bgW = w; this.bgH = h;
      return;
    }

    const mask = dilate(motionMask(gray, this.bg, w, h, 22), w, h, 3);
    const boxes = mergeBoxes(
      findBlobs(mask, w, h, {
        minArea: Math.round(w * h * 0.006),
        maxArea: Math.round(w * h * 0.6),
      }),
      6
    );

    // slow background adaptation where nothing moves
    const alpha = 0.05;
    for (let i = 0; i < gray.length; i++) {
      if (!mask[i]) this.bg[i] += alpha * (gray[i] - this.bg[i]);
    }

    const norm = boxes.map((b) => ({ x: b.x / w, y: b.y / h, w: b.w / w, h: b.h / h }));
    const tracks = this.tracker.update(norm, now);

    // finish-line crossings + OCR scheduling
    for (const track of tracks) {
      const cross = checkCrossing(track, this.lineY);
      if (cross) {
        track.crossed = true;
        track.crossedAt = cross.at;
      }
      if (track.crossed && !track.resolved) this._maybeResolve(track);
      // keep reading crossed tracks too — a late vote can still settle them
      if (!track.pendingOcr && track.seen >= 2 && !track.resolved) {
        const nearLine = track.feet > this.lineY - 0.45 || track.crossed;
        if (nearLine && this.ocrQueue.length < 3) {
          track.pendingOcr = true;
          this.ocrQueue.push(track);
        }
      }
    }

    this._drawOverlay(tracks);
    this._drainOcr();
    this.onStatus({ state: "scanning", tracks: tracks.length, reads: this.reads });
  }

  _drainOcr() {
    if (this.ocrBusy || !this.ocrQueue.length || !this.armed) return;
    const track = this.ocrQueue.shift();
    this.ocrBusy = true;
    this._readTrackBib(track)
      .catch((e) => console.warn("ocr read failed", e))
      .finally(() => {
        track.pendingOcr = false;
        this.ocrBusy = false;
        if (track.crossed && !track.resolved) this._maybeResolve(track);
      });
  }

  /** Crop the chest region of a tracked runner and OCR it. */
  async _readTrackBib(track) {
    const video = this.video;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    // chest zone: middle band of the bounding box, padded horizontally
    const padX = track.bbox.w * 0.15;
    const sx = Math.max(0, (track.bbox.x - padX) * vw);
    const sy = Math.max(0, (track.bbox.y + track.bbox.h * 0.12) * vh);
    const sw = Math.min(vw - sx, (track.bbox.w + padX * 2) * vw);
    const sh = Math.min(vh - sy, track.bbox.h * 0.55 * vh);
    if (sw < 16 || sh < 12) return;
    const crop = cropToCanvas(video, sx, sy, sw, sh, 240);
    const bibPatch = locateBibPatch(crop);
    const thumb = thumbOf(bibPatch);
    const worker = await this._getWorker();
    let read = await recognizeDigits(worker, bibPatch);
    // fall back to the full chest band if the patch read is weak
    if ((!read || read.confidence < 45) && bibPatch !== crop) {
      const alt = await recognizeDigits(worker, crop);
      if (alt && (!read || alt.confidence > read.confidence)) read = alt;
    }
    if (!read) return;
    this.reads++;
    this.tracker.vote(track, read.digits.padStart(4, "0"), read.confidence, thumb);
    this.onRead({
      bib: read.digits.padStart(4, "0"),
      confidence: read.confidence,
      trackId: track.id,
      thumb,
    });
    // a confident vote can settle a runner already across the line
    if (track.crossed && !track.resolved) this._maybeResolve(track);
  }

  /** Emit a finish (or review) event for a crossed track.
      Waits for in-flight OCR reads; forces a review after a grace period. */
  _maybeResolve(track) {
    if (track.resolved) return;
    const tally = tallyVotes(track.votes, this.getRosterBibs());
    const at = track.crossedAt ?? Date.now();

    if (tally && tally.accepted && tally.confidence >= this.minConf && this.autoRecord) {
      const last = this.recentBibs.get(tally.bib);
      if (last && at - last < this.cooldownMs) { track.resolved = true; return; }
      this.recentBibs.set(tally.bib, at);
      track.resolved = true;
      this.onFinish({
        bib: tally.bib,
        confidence: Math.round(tally.confidence),
        when: at,
        thumb: tally.thumb,
        trackId: track.id,
        known: tally.known,
      });
      return;
    }

    // force a review only once reads stop coming (track gone) or the
    // grace period expires — until then keep gathering votes
    const waited = Date.now() - at;
    const trackGone = track.lost > 1;
    if (!track.pendingOcr && (trackGone || waited > 3500)) {
      track.resolved = true;
      this.onReview({
        guess: tally?.bib || null,
        confidence: tally ? Math.round(tally.confidence) : 0,
        thumb: tally?.thumb || null,
        when: at,
        trackId: track.id,
      });
    }
  }

  async _getWorker() {
    if (this._worker) return this._worker;
    if (!window.Tesseract) throw new Error("Tesseract library not loaded");
    this._worker = await window.Tesseract.createWorker("eng", 1, {
      logger: () => {},
    });
    await this._worker.setParameters({
      tessedit_char_whitelist: "0123456789",
      tessedit_pageseg_mode: "8",
    });
    return this._worker;
  }

  /* ---- manual single-shot read (capture button / uploads) ---- */

  async readOnce(source) {
    const sw = source.videoWidth || source.naturalWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.height;
    if (!sw || !sh) return null;
    const crop = cropToCanvas(source, 0, 0, sw, sh, 640);
    const bibPatch = locateBibPatch(crop);
    const worker = await this._getWorker();
    let read = await recognizeDigits(worker, bibPatch);
    if ((!read || read.confidence < 45) && bibPatch !== crop) {
      const alt = await recognizeDigits(worker, crop);
      if (alt && (!read || alt.confidence > read.confidence)) read = alt;
    }
    return read ? { ...read, thumb: thumbOf(bibPatch), crop: bibPatch } : null;
  }

  /* ---- overlay ---- */

  _drawOverlay(tracks) {
    const cv = this.overlay;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    const w = cv.width = cv.clientWidth || 640;
    const h = cv.height = cv.clientHeight || 400;
    ctx.clearRect(0, 0, w, h);

    // finish line
    const y = this.lineY * h;
    ctx.strokeStyle = "rgba(255,127,17,0.95)";
    ctx.lineWidth = 3;
    ctx.setLineDash([14, 9]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(255,127,17,0.95)";
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillText("FINISH LINE — drag to reposition", 10, y - 8);

    // tracked runners
    for (const t of tracks) {
      const tally = tallyVotes(t.votes, this.getRosterBibs());
      const color = t.crossed
        ? "rgba(52,211,153,0.95)"
        : tally?.accepted ? "rgba(96,165,250,0.95)" : "rgba(255,255,255,0.55)";
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(t.bbox.x * w, t.bbox.y * h, t.bbox.w * w, t.bbox.h * h);
      const label = tally?.bib
        ? `#${tally.bib} · ${Math.round(tally.confidence)}%`
        : `runner ${t.id}`;
      ctx.fillStyle = color;
      ctx.fillText(label, t.bbox.x * w + 4, t.bbox.y * h - 6);
      // feet marker
      ctx.fillRect(t.cx * w - 4, t.feet * h - 2, 8, 4);
    }
  }

  /* ---- drag-to-position the finish line on the overlay ---- */

  attachLineDrag() {
    const cv = this.overlay;
    if (!cv) return;
    const toY = (e) => {
      const rect = cv.getBoundingClientRect();
      return (e.clientY - rect.top) / rect.height;
    };
    cv.addEventListener("pointerdown", (e) => {
      this._dragging = true;
      cv.setPointerCapture(e.pointerId);
      this.setLine(toY(e));
    });
    cv.addEventListener("pointermove", (e) => {
      if (this._dragging) this.setLine(toY(e));
    });
    cv.addEventListener("pointerup", () => { this._dragging = false; });
  }
}
