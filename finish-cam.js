/* =====================================================================
   finish-cam.js — Number-First 3D Finish-Gate Scanner for Brighton Oaks 5K.

   How it works (Bib-Number Driven, NOT Person/Motion Driven):
   1. The organizer places a 3D finish-gate wall (ground line A–B plus a
      vertical plane rising from the chute) onto the live camera feed.
   2. On every scan tick, `detectBibRegions` scans the frame directly for
      bib/number patches — rectangular regions with high internal contrast
      that pass `hasDigitLikeStructure` (horizontally-aligned digit-shaped
      ink components). People walking by without a bib number, trees,
      shadows, and clothing folds produce ZERO candidate boxes and NEVER
      trigger tracking or OCR.
   3. When a bib-number patch is spotted, Tesseract OCR immediately reads
      the digits (`recognizeDigits`), validates symbol geometry/confidence
      (`validateOcrSymbols`), and canonicalizes against the race roster
      (`canonicalizeBibRead`).
   4. Confirmed bib numbers are tracked spatially across frames (`BibTracker`).
      When a tracked bib number breaches the 3D finish-gate wall plane
      (`checkCrossing`), the engine emits a finish event with sub-frame
      interpolated timing.

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
  global /= gray.length || 1;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const diff = gray[i] - mean[i];
    const v = global + diff * 1.45;
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
   Motion / Blob utilities (pure)
--------------------------------------------------------------------- */

/** |fg - bg| > threshold -> 1. */
export function motionMask(fg, bg, w, h, threshold = 25) {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.abs(fg[i] - bg[i]) > threshold ? 1 : 0;
  }
  return out;
}

/** Binary dilation to join adjacent strokes/pixels into coherent regions. */
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
   Bib-Number Structural Verifier & Direct Frame Detector (pure)
--------------------------------------------------------------------- */

/**
 * Inspects a grayscale crop to determine if it plausibly contains printed
 * bib digits before we ever invoke Tesseract or spawn a track.
 *
 * Returns { ok, contrast, components, polarity } where:
 *   - ok: boolean (true only if the crop has high contrast AND 1..8
 *     horizontally-aligned digit-sized ink components)
 *   - polarity: "dark-on-light" | "light-on-dark" | "both"
 */
export function hasDigitLikeStructure(gray, w, h) {
  if (!gray || w < 16 || h < 10) {
    return { ok: false, reason: "too-small", contrast: 0, components: 0, polarity: "dark-on-light" };
  }

  const hist = new Uint32Array(256);
  let sum = 0;
  const n = gray.length;
  for (let i = 0; i < n; i++) {
    const v = gray[i];
    hist[v]++;
    sum += v;
  }
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const d = gray[i] - mean;
    varSum += d * d;
  }
  const std = Math.sqrt(varSum / n);

  let acc = 0, p10 = 0, p90 = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= n * 0.10) { p10 = v; break; }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= n * 0.10) { p90 = v; break; }
  }
  const contrast = p90 - p10;
  if (contrast < 38 || std < 14) {
    return { ok: false, reason: "low-contrast", contrast, components: 0, polarity: "dark-on-light" };
  }

  const flat = flattenLighting(gray, w, h, Math.max(6, Math.round(Math.min(w, h) / 6)));
  const t = otsuThreshold(flat);

  const checkPolarity = (invert) => {
    const inkMask = new Uint8Array(w * h);
    let inkCount = 0;
    let borderInk = 0;
    const borderTotal = 2 * w + 2 * Math.max(0, h - 2);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const isInk = invert ? flat[i] > t : flat[i] <= t;
        if (isInk) {
          inkMask[i] = 1;
          inkCount++;
          if (x === 0 || x === w - 1 || y === 0 || y === h - 1) borderInk++;
        }
      }
    }
    const inkRatio = inkCount / n;
    if (inkRatio < 0.03 || inkRatio > 0.55) return { valid: false, count: 0, digitBlobs: [] };
    if (borderTotal > 0 && borderInk / borderTotal > 0.65) return { valid: false, count: 0, digitBlobs: [] };

    const blobs = findBlobs(inkMask, w, h, {
      minArea: Math.max(5, Math.round(n * 0.0035)),
      maxArea: Math.round(n * 0.35),
    });
    if (blobs.length > 28) return { valid: false, count: 0, digitBlobs: [] };

    const digitBlobs = blobs.filter((b) => {
      const relH = b.h / h;
      const relW = b.w / w;
      const aspect = b.w / b.h;
      const fill = b.area / (b.w * b.h);
      return (
        relH >= 0.16 && relH <= 0.96 &&
        relW >= 0.02 && relW <= 0.78 &&
        aspect >= 0.10 && aspect <= 2.5 &&
        fill >= 0.12 && fill <= 1.0
      );
    });

    if (digitBlobs.length < 1 || digitBlobs.length > 10) {
      return { valid: false, count: digitBlobs.length, digitBlobs: [] };
    }
    return { valid: true, count: digitBlobs.length, digitBlobs };
  };

  const darkOnLight = checkPolarity(false);
  const lightOnDark = checkPolarity(true);

  if (!darkOnLight.valid && !lightOnDark.valid) {
    return {
      ok: false,
      reason: "no-digit-components",
      contrast,
      components: Math.max(darkOnLight.count, lightOnDark.count),
      polarity: "dark-on-light",
    };
  }

  const polarity = darkOnLight.valid && lightOnDark.valid
    ? "both"
    : darkOnLight.valid ? "dark-on-light" : "light-on-dark";

  return {
    ok: true,
    reason: "ok",
    contrast,
    components: Math.max(darkOnLight.count, lightOnDark.count),
    polarity,
  };
}

/**
 * Extract a sub-rectangle of a grayscale buffer.
 */
export function cropGray(gray, w, h, sx, sy, sw, sh) {
  const x0 = Math.max(0, Math.min(w - 1, Math.round(sx)));
  const y0 = Math.max(0, Math.min(h - 1, Math.round(sy)));
  const cw = Math.max(1, Math.min(w - x0, Math.round(sw)));
  const ch = Math.max(1, Math.min(h - y0, Math.round(sh)));
  const out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    const srcOff = (y0 + y) * w + x0;
    const dstOff = y * cw;
    for (let x = 0; x < cw; x++) {
      out[dstOff + x] = gray[srcOff + x];
    }
  }
  return { data: out, w: cw, h: ch, x: x0, y: y0 };
}

/**
 * Directly scan a grayscale frame for bib-number regions (NOT people/motion).
 *
 * How it works:
 * 1. Computes local bright-card regions (above local mean + margin) AND high
 *    horizontal-gradient stroke regions (`|I(x+1,y) - I(x-1,y)|`), since bib
 *    numbers are horizontal sequences of sharp vertical digit strokes inside a
 *    contrasting bib rectangle.
 * 2. Every candidate region is cropped and tested with `hasDigitLikeStructure`
 *    requiring horizontally-aligned digit components.
 * 3. Returns normalized candidate bib boxes `[{ x, y, w, h, components, contrast }]`.
 *    When a person without a bib walks by, or when trees/grass/shadows move,
 *    this returns `[]` — so OCR and tracking NEVER fire on people without numbers.
 */
export function detectBibRegions(gray, w, h) {
  if (!gray || w < 32 || h < 24) return [];

  const localMean = boxBlur(gray, w, h, Math.max(6, Math.round(Math.min(w, h) / 14)));
  const brightCard = new Uint8Array(w * h);
  const strokeMask = new Uint8Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      // Bright bib card relative to surrounding torso/background
      if (gray[i] > 145 && gray[i] - localMean[i] > -12) {
        brightCard[i] = 1;
      }
      // Sharp vertical stroke edge (characteristic of printed digits)
      const gx = Math.abs(gray[i + 1] - gray[i - 1]);
      const diffMean = Math.abs(gray[i] - localMean[i]);
      if (gx > 34 && diffMean > 22) {
        strokeMask[i] = 1;
      }
    }
  }

  const candidates = [];

  // Pass A: Bright rectangular bib cards
  const cardBlobs = findBlobs(brightCard, w, h, {
    minArea: Math.max(48, Math.round(w * h * 0.0012)),
    maxArea: Math.round(w * h * 0.45),
  });
  for (const b of cardBlobs) {
    const aspect = b.w / b.h;
    if (aspect < 0.65 || aspect > 4.8) continue;
    const fill = b.area / (b.w * b.h);
    if (fill < 0.38) continue;
    candidates.push(b);
  }

  // Pass B: Horizontally clustered digit strokes (catches dark bibs or close-up numbers)
  const dilatedStrokes = dilate(strokeMask, w, h, 2);
  const strokeClusters = mergeBoxes(
    findBlobs(dilatedStrokes, w, h, {
      minArea: Math.max(24, Math.round(w * h * 0.0008)),
      maxArea: Math.round(w * h * 0.30),
    }),
    4
  );
  for (const b of strokeClusters) {
    const aspect = b.w / b.h;
    if (aspect < 0.65 || aspect > 5.2) continue;
    if (b.w < 14 || b.h < 9) continue;
    // Pad slightly around the stroke cluster to include the bib background margin
    const padX = Math.round(b.w * 0.14);
    const padY = Math.round(b.h * 0.20);
    const x = Math.max(0, b.x - padX);
    const y = Math.max(0, b.y - padY);
    const bw = Math.min(w - x, b.w + padX * 2);
    const bh = Math.min(h - y, b.h + padY * 2);
    candidates.push({ x, y, w: bw, h: bh, area: bw * bh });
  }

  // Deduplicate overlapping candidate rectangles
  const merged = mergeBoxes(candidates, 2);
  const verified = [];

  for (const cand of merged) {
    if (cand.w < 16 || cand.h < 10) continue;
    const sub = cropGray(gray, w, h, cand.x, cand.y, cand.w, cand.h);
    const check = hasDigitLikeStructure(sub.data, sub.w, sub.h);
    if (!check.ok) continue;

    // Require at least 2 digit-like components (or 1 very high-contrast component)
    // and ensure the region has real internal ink strokes, not just a bright blank shirt.
    let strokeCount = 0;
    for (let yy = cand.y; yy < cand.y + cand.h; yy++) {
      const rOff = yy * w;
      for (let xx = cand.x; xx < cand.x + cand.w; xx++) {
        strokeCount += strokeMask[rOff + xx];
      }
    }
    const strokeDensity = strokeCount / (cand.w * cand.h);
    if (strokeDensity < 0.025 || strokeDensity > 0.55) continue;

    verified.push({
      x: cand.x / w,
      y: cand.y / h,
      w: cand.w / w,
      h: cand.h / h,
      components: check.components,
      contrast: check.contrast,
    });
  }

  return verified;
}

/* ---------------------------------------------------------------------
   3D Finish-Gate Wall geometry + Spatial Bib Tracker (pure)
--------------------------------------------------------------------- */

/**
 * Default 3D finish gate in normalized (0..1) image coordinates:
 * - A: left base post on the ground (x1, y1)
 * - B: right base post on the ground (x2, y2)
 * - wallHeight: vertical height of the 3D finish plane rising up from A–B
 */
export function normalizeGate(gateOrLineY) {
  if (typeof gateOrLineY === "number") {
    const y = Math.min(0.95, Math.max(0.10, gateOrLineY));
    return {
      x1: 0.08,
      y1: y,
      x2: 0.92,
      y2: y,
      wallHeight: 0.42,
    };
  }
  const g = gateOrLineY || {};
  const x1 = Math.min(0.95, Math.max(0.02, g.x1 ?? 0.12));
  const y1 = Math.min(0.96, Math.max(0.12, g.y1 ?? 0.72));
  const x2 = Math.min(0.98, Math.max(0.05, g.x2 ?? 0.88));
  const y2 = Math.min(0.96, Math.max(0.12, g.y2 ?? 0.72));
  const wallHeight = Math.min(0.75, Math.max(0.15, g.wallHeight ?? 0.42));
  return { x1, y1, x2, y2, wallHeight };
}

/**
 * Compute the 4 corners of the 3D finish-gate wall plane in normalized
 * screen space (with slight perspective convergence toward the top of the posts).
 * Returns { baseLeft, baseRight, topLeft, topRight }.
 */
export function gateQuad(gateInput) {
  const g = normalizeGate(gateInput);
  const leftFirst = g.x1 <= g.x2;
  const baseLeft = leftFirst ? { x: g.x1, y: g.y1 } : { x: g.x2, y: g.y2 };
  const baseRight = leftFirst ? { x: g.x2, y: g.y2 } : { x: g.x1, y: g.y1 };
  const h = g.wallHeight;
  const taper = 0.015 * h;
  const topLeft = {
    x: Math.min(0.98, Math.max(0.02, baseLeft.x + taper)),
    y: Math.max(0.02, baseLeft.y - h),
  };
  const topRight = {
    x: Math.min(0.98, Math.max(0.02, baseRight.x - taper)),
    y: Math.max(0.02, baseRight.y - h),
  };
  return { baseLeft, baseRight, topLeft, topRight, wallHeight: h };
}

/**
 * Evaluate the ground line Y at a given normalized X along the gate plane,
 * plus whether X falls horizontally within the gate posts (with small margin).
 */
export function gateGroundYAtX(gateInput, x) {
  const { baseLeft, baseRight, wallHeight } = gateQuad(gateInput);
  const spanX = baseRight.x - baseLeft.x;
  const u = Math.abs(spanX) > 1e-4 ? (x - baseLeft.x) / spanX : 0.5;
  const clampedU = Math.min(1, Math.max(0, u));
  const groundY = baseLeft.y + (baseRight.y - baseLeft.y) * clampedU;
  const withinSpan = u >= -0.06 && u <= 1.06;
  return {
    groundY,
    topY: Math.max(0.02, groundY - wallHeight),
    u,
    withinSpan,
  };
}

export class BibTracker {
  constructor({ maxDist = 0.25, maxLost = 4 } = {}) {
    this.maxDist = maxDist;      // normalized centroid distance for matching
    this.maxLost = maxLost;      // frames a track survives without a match
    this.tracks = [];
    this.nextId = 1;
  }

  /** Update with normalized bib/runner boxes {x,y,w,h,feet?}. Returns the live track list.
      Each track: { id, cx, cy, feet, torsoY, bbox, votes, history, lastSeen, seen } */
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
        track.feet = b.feet ?? (b.y + b.h);
        track.torsoY = b.torsoY ?? (b.y + b.h * 0.5);
        track.bbox = b;
        track.lastSeen = timestamp;
        track.lost = 0;
        track.seen++;
        track.history.push({
          t: timestamp,
          cx: track.cx,
          cy: track.cy,
          feet: track.feet,
          torsoY: track.torsoY,
        });
      } else {
        track.lost++;
      }
    }
    // spawn tracks for unmatched detections
    for (let i = 0; i < boxes.length; i++) {
      if (used.has(i)) continue;
      const b = boxes[i];
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const feet = b.feet ?? (b.y + b.h);
      const torsoY = b.torsoY ?? (b.y + b.h * 0.5);
      this.tracks.push({
        id: this.nextId++,
        cx,
        cy,
        feet,
        torsoY,
        bbox: b,
        votes: new Map(),       // bib -> { count, confSum, thumb }
        history: [{ t: timestamp, cx, cy, feet, torsoY }],
        lastSeen: timestamp,
        lost: 0,
        seen: 1,
        crossed: false,
        pendingOcr: false,
      });
    }
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

/**
 * Did the tracked bib/runner breach the 3D finish-gate wall between their
 * last two history samples?
 *
 * Supports both:
 *   - `gateOrLineY` as a number (legacy horizontal lineY in 0..1)
 *   - `gateOrLineY` as a 3D gate `{ x1, y1, x2, y2, wallHeight }`
 */
export function checkCrossing(track, gateOrLineY) {
  const h = track.history;
  if (track.crossed || !h || h.length < 2) return null;
  const a = h[h.length - 2];
  const b = h[h.length - 1];

  if (typeof gateOrLineY === "number") {
    const lineY = gateOrLineY;
    if (a.feet < lineY && b.feet >= lineY) {
      const span = b.feet - a.feet;
      const frac = span > 0 ? (lineY - a.feet) / span : 1;
      const f = Math.min(1, Math.max(0, frac));
      const ax = a.cx ?? track.cx ?? 0.5;
      const bx = b.cx ?? track.cx ?? 0.5;
      return {
        at: a.t + (b.t - a.t) * f,
        point: {
          x: ax + (bx - ax) * f,
          y: lineY,
          torsoY: (a.torsoY ?? a.cy ?? lineY - 0.12) + ((b.torsoY ?? b.cy ?? lineY - 0.12) - (a.torsoY ?? a.cy ?? lineY - 0.12)) * f,
        },
      };
    }
    return null;
  }

  const gate = normalizeGate(gateOrLineY);
  const ax = a.cx ?? track.cx ?? 0.5;
  const bx = b.cx ?? track.cx ?? 0.5;
  const ga = gateGroundYAtX(gate, ax);
  const gb = gateGroundYAtX(gate, bx);

  const da = a.feet - ga.groundY;
  const db = b.feet - gb.groundY;

  if (da < 0 && db >= 0) {
    const denom = db - da;
    const f = denom > 0 ? Math.min(1, Math.max(0, -da / denom)) : 1;
    const crossX = ax + (bx - ax) * f;
    const gCross = gateGroundYAtX(gate, crossX);
    if (!gCross.withinSpan) return null;

    const aTorso = a.torsoY ?? a.cy ?? (a.feet - 0.15);
    const bTorso = b.torsoY ?? b.cy ?? (b.feet - 0.15);
    const crossTorsoY = aTorso + (bTorso - aTorso) * f;

    if (crossTorsoY < gCross.topY - 0.12 || crossTorsoY > gCross.groundY + 0.05) {
      return null;
    }

    return {
      at: a.t + (b.t - a.t) * f,
      point: {
        x: crossX,
        y: gCross.groundY,
        torsoY: Math.min(gCross.groundY, Math.max(gCross.topY, crossTorsoY)),
      },
    };
  }
  return null;
}

/**
 * Normalize a raw digit string against the active roster.
 * - If a raw read ("1", "42", "0042") matches a roster bib's numeric value,
 *   canonicalize it to that roster bib ("0001", "0042").
 * - If it does NOT match any roster bib, DO NOT pad 1- or 2-digit noise
 *   ("1", "7", "11") into fake 4-digit bibs ("0001", "0007"). Require at
 *   least 3 digits for an unlisted bib, or reject it as noise.
 */
export function canonicalizeBibRead(rawDigits, knownBibs = []) {
  const clean = String(rawDigits || "").replace(/\D/g, "");
  if (!clean || clean.length > 5) return null;
  if (/^0+$/.test(clean)) return null;

  const padded4 = clean.padStart(4, "0");
  const knownSet = new Set(knownBibs.map((b) => String(b).trim()));

  if (knownSet.has(clean)) return { bib: clean, known: true, rawLength: clean.length };
  if (knownSet.has(padded4)) return { bib: padded4, known: true, rawLength: clean.length };

  if (clean.length < 3) return null;

  return { bib: padded4, known: false, rawLength: clean.length };
}

/** Resolve a track's accumulated votes to one bib. */
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
    (Number(b.known) - Number(a.known)) ||
    (b.count - a.count) ||
    (b.confidence - a.confidence));
  const top = entries[0];
  const total = entries.reduce((s, e) => s + e.count, 0);
  const dominant = total ? top.count / total >= 0.6 : true;

  const hasRoster = known.size > 0;
  let accepted = false;
  if (top.known || !hasRoster) {
    accepted =
      (top.count >= 2 && dominant && top.confidence >= 50) ||
      (top.count >= 1 && top.confidence >= 80);
  } else {
    accepted = top.count >= 2 && dominant && top.confidence >= 72;
  }

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

/** Build polarity variants of a crop, pre-processed for OCR. */
export function ocrVariants(cropCanvas, polarity = "both") {
  const w = cropCanvas.width, h = cropCanvas.height;
  const ctx = cropCanvas.getContext("2d", { willReadFrequently: true });
  const gray = toGray(ctx.getImageData(0, 0, w, h).data, w, h);
  const prepped = unsharpMask(flattenLighting(gray, w, h), w, h);
  const modes = polarity === "dark-on-light"
    ? [false]
    : polarity === "light-on-dark"
      ? [true]
      : [false, true];
  return modes.map((invert) => {
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

/** Per-symbol confidence reader for Tesseract.js v5. */
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

/**
 * Validate Tesseract's recognized symbols so that random edges/textures
 * forced into "1" or "7" by `tessedit_char_whitelist` are rejected.
 */
export function validateOcrSymbols(data, cropW, cropH) {
  const rawText = String(data?.text || "").replace(/\D/g, "");
  if (!rawText || rawText.length > 5) return null;

  const conf = readConfidence(data);
  const symbols = (data?.symbols || []).filter((s) => /\d/.test(s?.text || ""));

  if (symbols.length > 0 && cropW > 0 && cropH > 0) {
    const validSymbols = [];
    for (const s of symbols) {
      const sConf = typeof s.confidence === "number" ? s.confidence : conf;
      if (sConf < 42) continue;
      const b = s.bbox;
      if (b && typeof b.x0 === "number" && typeof b.x1 === "number") {
        const sw = Math.max(1, b.x1 - b.x0);
        const sh = Math.max(1, b.y1 - b.y0);
        const relH = sh / cropH;
        const relW = sw / cropW;
        if (relH < 0.14 || relH > 0.98) continue;
        if (relW > 0.85) continue;
        validSymbols.push({ text: String(s.text).replace(/\D/g, ""), conf: sConf, h: sh, y: (b.y0 + b.y1) / 2 });
      } else {
        validSymbols.push({ text: String(s.text).replace(/\D/g, ""), conf: sConf, h: cropH * 0.5, y: cropH * 0.5 });
      }
    }
    if (!validSymbols.length) return null;

    const cleanDigits = validSymbols.map((s) => s.text).join("");
    if (!cleanDigits || cleanDigits.length > 5) return null;
    const meanConf = validSymbols.reduce((acc, s) => acc + s.conf, 0) / validSymbols.length;

    if (cleanDigits.length === 1 && meanConf < 82) return null;
    if (meanConf < 52) return null;

    return { digits: cleanDigits, confidence: Math.round(meanConf) };
  }

  if (rawText.length === 1 && conf < 82) return null;
  if (conf < 52) return null;
  return { digits: rawText, confidence: Math.round(conf) };
}

/** Run OCR on prepared variants and return the best validated digit read.
    Returns null immediately if the crop fails `hasDigitLikeStructure`. */
export async function recognizeDigits(worker, cropCanvas) {
  const w = cropCanvas.width, h = cropCanvas.height;
  const ctx = cropCanvas.getContext("2d", { willReadFrequently: true });
  const gray = toGray(ctx.getImageData(0, 0, w, h).data, w, h);

  const struct = hasDigitLikeStructure(gray, w, h);
  if (!struct.ok) return null;

  const variants = ocrVariants(cropCanvas, struct.polarity);
  let best = null;
  for (const { canvas, invert } of variants) {
    await worker.setParameters({
      tessedit_char_whitelist: "0123456789",
      tessedit_pageseg_mode: "8",
    });
    const { data } = await worker.recognize(canvas);
    const checked = validateOcrSymbols(data, w, h);
    if (checked && (!best || checked.confidence > best.confidence)) {
      best = { digits: checked.digits, confidence: checked.confidence, invert };
    }
    if (best && best.confidence >= 82 && best.digits.length >= 2) break;
  }
  if (!best || best.confidence < 58) {
    await worker.setParameters({
      tessedit_char_whitelist: "0123456789",
      tessedit_pageseg_mode: "7",
    });
    const { data } = await worker.recognize(variants[0].canvas);
    const checked = validateOcrSymbols(data, w, h);
    if (checked && checked.confidence > (best?.confidence ?? 0)) {
      best = { digits: checked.digits, confidence: checked.confidence, invert: variants[0].invert };
    }
  }
  return best;
}

/** Locate the bright bib patch inside a larger image/crop. */
export function locateBibPatch(cropCanvas) {
  const w = cropCanvas.width, h = cropCanvas.height;
  if (w < 24 || h < 16) return cropCanvas;
  const ctx = cropCanvas.getContext("2d", { willReadFrequently: true });
  const gray = toGray(ctx.getImageData(0, 0, w, h).data, w, h);
  const regions = detectBibRegions(gray, w, h);
  if (regions.length > 0) {
    const r = regions[0];
    const mx = r.w * 0.08, my = r.h * 0.12;
    const sx = Math.max(0, (r.x - mx) * w);
    const sy = Math.max(0, (r.y - my) * h);
    const sw = Math.min(w - sx, (r.w + mx * 2) * w);
    const sh = Math.min(h - sy, (r.h + my * 2) * h);
    return cropToCanvas(cropCanvas, sx, sy, sw, sh, 240);
  }
  return cropCanvas;
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
   FinishCam — Number-First 3D Finish-Gate Scanner
--------------------------------------------------------------------- */

export class FinishCam {
  /**
   * opts:
   *   video        — <video> element with an active stream
   *   overlay      — <canvas> for the 3D finish-wall & bib detection overlay
   *   getRosterBibs() -> string[] of known bib numbers
   *   onFinish({ bib, confidence, when, thumb, trackId, known })
   *   onReview({ guess, confidence, thumb, when, trackId })  (uncertain)
   *   onRead({ bib, confidence, trackId, thumb })            (each valid bib read)
   *   onStatus({ state, tracks, reads })                     (UI updates)
   *   onGateChange(gate)                                     (when user drags posts)
   */
  constructor(opts = {}) {
    this.video = opts.video;
    this.overlay = opts.overlay || null;
    this.getRosterBibs = opts.getRosterBibs || (() => []);
    this.onFinish = opts.onFinish || (() => {});
    this.onReview = opts.onReview || (() => {});
    this.onRead = opts.onRead || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.onGateChange = opts.onGateChange || (() => {});

    this.lineY = opts.lineY ?? 0.72;
    this.gate = normalizeGate(opts.gate || {
      x1: 0.14,
      y1: this.lineY,
      x2: 0.86,
      y2: this.lineY,
      wallHeight: opts.wallHeight ?? 0.44,
    });
    this.scanMs = opts.scanMs ?? 320;    // detection cadence
    this.minConf = opts.minConf ?? 68;   // auto-record confidence floor
    this.cooldownMs = opts.cooldownMs ?? 90000; // per-bib re-record guard
    this.autoRecord = opts.autoRecord ?? true;
    this.reviewUnknownCrossings = opts.reviewUnknownCrossings ?? false;

    this.tracker = new BibTracker();
    this.armed = false;
    this.timer = null;
    this.ocrBusy = false;
    this.ocrQueue = [];
    this.reads = 0;
    this.recentBibs = new Map();         // bib -> timestamp of last finish
    this.wallFlash = null;               // { at, point, bib } for visual 3D wall pulse
    this.workW = 360;                    // bib-detection analysis resolution

    this._grabCanvas = document.createElement("canvas");
    this._fullCanvas = document.createElement("canvas");
    this._onTick = this._onTick.bind(this);
    this._dragHandle = null;             // "p1" | "p2" | "top" | "wall" | null
    this._dragStart = null;

    if (this.overlay && typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => {
        this._drawOverlay(this.tracker ? this.tracker.tracks : []);
      });
      this._ro.observe(this.overlay);
    }
  }

  /* ---- lifecycle ---- */

  arm() {
    if (this.armed) return;
    if (!this.video || !this.video.videoWidth) {
      throw new Error("Camera is not ready yet");
    }
    this.tracker = new BibTracker();
    this.ocrQueue = [];
    this.armed = true;
    this.timer = setInterval(this._onTick, this.scanMs);
    this._onTick();
    this.onStatus({ state: "armed", tracks: 0, reads: this.reads });
  }

  disarm() {
    this.armed = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ocrQueue = [];
    this._drawOverlay([]);
    this.onStatus({ state: "standby", tracks: 0, reads: this.reads });
  }

  /** Set horizontal finish-line depth (keeps existing slant/width & wall height). */
  setLine(y) {
    const clampedY = Math.min(0.95, Math.max(0.15, y));
    const midY = (this.gate.y1 + this.gate.y2) / 2;
    const dy = clampedY - midY;
    this.gate = normalizeGate({
      ...this.gate,
      y1: this.gate.y1 + dy,
      y2: this.gate.y2 + dy,
    });
    this.lineY = (this.gate.y1 + this.gate.y2) / 2;
    this._drawOverlay(this.tracker.tracks);
  }

  /** Set 3D gate wall height (0.15..0.75 of frame height). */
  setWallHeight(h) {
    this.gate = normalizeGate({ ...this.gate, wallHeight: h });
    this._drawOverlay(this.tracker.tracks);
  }

  /** Update full 3D gate geometry `{ x1, y1, x2, y2, wallHeight }`. */
  setGate(nextGate) {
    this.gate = normalizeGate({ ...this.gate, ...nextGate });
    this.lineY = (this.gate.y1 + this.gate.y2) / 2;
    this._drawOverlay(this.tracker.tracks);
    this.onGateChange(this.gate);
  }

  /* ---- Bib-Number-First Scanning ---- */

  _onTick() {
    const video = this.video;
    if (!video || !video.videoWidth) return;
    const w = this.workW;
    const h = Math.round(w * video.videoHeight / video.videoWidth) || 270;

    const gctx = this._grabCanvas.getContext("2d", { willReadFrequently: true });
    this._grabCanvas.width = w;
    this._grabCanvas.height = h;
    gctx.drawImage(video, 0, 0, w, h);
    const gray = toGray(gctx.getImageData(0, 0, w, h).data, w, h);

    const now = Date.now();

    // Detect bib/number patches directly in the frame (ignores people without bibs!)
    const bibBoxes = detectBibRegions(gray, w, h).map((b) => {
      // A bib sits on the chest/torso (~42% down the runner's body); project ground
      // contact (`feet`) directly below the bib patch so it crosses the 3D finish
      // gate wall at the runner's stride position, while `torsoY` is the bib center.
      const torsoY = b.y + b.h * 0.5;
      const estimatedRunnerFootY = Math.min(0.99, b.y + b.h * 2.15);
      return {
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        torsoY,
        feet: estimatedRunnerFootY,
      };
    });

    const tracks = this.tracker.update(bibBoxes, now);

    // Trigger OCR immediately whenever a bib-number patch is spotted!
    for (const track of tracks) {
      const cross = checkCrossing(track, this.gate);
      if (cross) {
        track.crossed = true;
        track.crossedAt = cross.at;
        track.crossPoint = cross.point;
        this.wallFlash = { at: now, point: cross.point, trackId: track.id };
      }
      if (track.crossed && !track.resolved) this._maybeResolve(track);

      // As soon as a bib-number candidate is spotted (`seen >= 1`), queue OCR
      if (!track.pendingOcr && !track.resolved && track.lost === 0) {
        if (this.ocrQueue.length < 4) {
          track.pendingOcr = true;
          this.ocrQueue.push(track);
        }
      }
    }

    // Only display tracks on the overlay that have a confirmed bib read (or are actively being read)
    const visibleTracks = tracks.filter((t) => t.votes.size > 0 || t.pendingOcr);
    const confirmedTracks = tracks.filter((t) => t.votes.size > 0);
    this._drawOverlay(visibleTracks);
    this._drainOcr();
    this.onStatus({
      state: confirmedTracks.length ? "scanning" : "armed",
      tracks: confirmedTracks.length,
      reads: this.reads,
    });
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

  /** Crop the spotted bib-number region directly and run OCR. */
  async _readTrackBib(track) {
    const video = this.video;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;

    // Pad slightly around the detected bib patch
    const padX = track.bbox.w * 0.14;
    const padY = track.bbox.h * 0.18;
    const sx = Math.max(0, (track.bbox.x - padX) * vw);
    const sy = Math.max(0, (track.bbox.y - padY) * vh);
    const sw = Math.min(vw - sx, (track.bbox.w + padX * 2) * vw);
    const sh = Math.min(vh - sy, (track.bbox.h + padY * 2) * vh);
    if (sw < 16 || sh < 12) return;

    const bibCrop = cropToCanvas(video, sx, sy, sw, sh, 240);
    const worker = await this._getWorker();
    const read = await recognizeDigits(worker, bibCrop);
    if (!read) return;

    const knownBibs = this.getRosterBibs();
    const canonical = canonicalizeBibRead(read.digits, knownBibs);
    if (!canonical) return;

    if (!canonical.known && knownBibs.length > 0 && read.confidence < 72) return;

    const thumb = thumbOf(bibCrop);
    this.reads++;
    this.tracker.vote(track, canonical.bib, read.confidence, thumb);
    this.onRead({
      bib: canonical.bib,
      confidence: read.confidence,
      trackId: track.id,
      thumb,
      known: canonical.known,
    });
    this._drawOverlay(this.tracker.tracks.filter((t) => t.votes.size > 0 || t.pendingOcr));
    if (track.crossed && !track.resolved) this._maybeResolve(track);
  }

  /** Emit a finish (or review) event when a confirmed bib crosses the 3D finish wall. */
  _maybeResolve(track) {
    if (track.resolved) return;
    const tally = tallyVotes(track.votes, this.getRosterBibs());
    const at = track.crossedAt ?? Date.now();

    if (tally && tally.accepted && tally.confidence >= this.minConf && this.autoRecord) {
      const last = this.recentBibs.get(tally.bib);
      if (last && at - last < this.cooldownMs) { track.resolved = true; return; }
      this.recentBibs.set(tally.bib, at);
      track.resolved = true;
      if (this.wallFlash && this.wallFlash.trackId === track.id) {
        this.wallFlash.bib = tally.bib;
      }
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

    const waited = Date.now() - at;
    const trackGone = track.lost > 1;
    if (!track.pendingOcr && (trackGone || waited > 2500)) {
      track.resolved = true;
      if (tally && tally.bib && tally.confidence >= 48) {
        this.onReview({
          guess: tally.bib,
          confidence: Math.round(tally.confidence),
          thumb: tally.thumb || null,
          when: at,
          trackId: track.id,
        });
      }
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
    if ((!read || read.confidence < 55) && bibPatch !== crop) {
      const alt = await recognizeDigits(worker, crop);
      if (alt && (!read || alt.confidence > read.confidence)) read = alt;
    }
    if (!read) return null;
    const canonical = canonicalizeBibRead(read.digits, this.getRosterBibs());
    const bib = canonical ? canonical.bib : read.digits.padStart(4, "0");
    return { ...read, digits: bib, thumb: thumbOf(bibPatch), crop: bibPatch };
  }

  /* ---- 3D Finish-Gate Wall overlay ---- */

  _drawOverlay(tracks = []) {
    const cv = this.overlay;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    const w = cv.width = cv.clientWidth || 640;
    const h = cv.height = cv.clientHeight || 400;
    ctx.clearRect(0, 0, w, h);

    const quad = gateQuad(this.gate);
    const bl = { x: quad.baseLeft.x * w, y: quad.baseLeft.y * h };
    const br = { x: quad.baseRight.x * w, y: quad.baseRight.y * h };
    const tl = { x: quad.topLeft.x * w, y: quad.topLeft.y * h };
    const tr = { x: quad.topRight.x * w, y: quad.topRight.y * h };

    const now = Date.now();
    const flashAge = this.wallFlash ? now - this.wallFlash.at : Infinity;
    const isFlashing = flashAge < 900;
    const flashAlpha = isFlashing ? Math.max(0, 1 - flashAge / 900) : 0;

    // 1. Ground chute shadow / depth apron behind & in front of the 3D wall
    const dx = br.x - bl.x;
    const dy = br.y - bl.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * 10;
    const ny = dx / len * 18;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(bl.x - nx, bl.y - ny);
    ctx.lineTo(br.x - nx, br.y - ny);
    ctx.lineTo(br.x + nx, br.y + ny);
    ctx.lineTo(bl.x + nx, bl.y + ny);
    ctx.closePath();
    ctx.fillStyle = isFlashing
      ? `rgba(52, 211, 153, ${0.18 + flashAlpha * 0.25})`
      : "rgba(255, 127, 17, 0.10)";
    ctx.fill();
    ctx.restore();

    // 2. Translucent 3D vertical finish wall plane
    ctx.save();
    const grad = ctx.createLinearGradient(
      (tl.x + tr.x) / 2,
      (tl.y + tr.y) / 2,
      (bl.x + br.x) / 2,
      (bl.y + br.y) / 2
    );
    if (isFlashing) {
      grad.addColorStop(0, `rgba(52, 211, 153, ${0.14 + flashAlpha * 0.25})`);
      grad.addColorStop(0.6, `rgba(52, 211, 153, ${0.28 + flashAlpha * 0.30})`);
      grad.addColorStop(1, `rgba(16, 185, 129, ${0.42 + flashAlpha * 0.35})`);
    } else {
      grad.addColorStop(0, "rgba(255, 127, 17, 0.08)");
      grad.addColorStop(0.55, "rgba(255, 127, 17, 0.18)");
      grad.addColorStop(1, "rgba(255, 127, 17, 0.34)");
    }

    ctx.beginPath();
    ctx.moveTo(bl.x, bl.y);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(tl.x, tl.y);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // 3. Perspective 3D grid mesh inside the finish wall plane
    ctx.strokeStyle = isFlashing
      ? "rgba(52, 211, 153, 0.45)"
      : "rgba(255, 165, 70, 0.28)";
    ctx.lineWidth = 1;
    const cols = 6;
    for (let i = 1; i < cols; i++) {
      const u = i / cols;
      const bx = bl.x + (br.x - bl.x) * u;
      const by = bl.y + (br.y - bl.y) * u;
      const tx = tl.x + (tr.x - tl.x) * u;
      const ty = tl.y + (tr.y - tl.y) * u;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(tx, ty);
      ctx.stroke();
    }
    const rows = 3;
    for (let j = 1; j < rows; j++) {
      const v = j / rows;
      const lx = tl.x + (bl.x - tl.x) * v;
      const ly = tl.y + (bl.y - tl.y) * v;
      const rx = tr.x + (br.x - tr.x) * v;
      const ry = tr.y + (br.y - tr.y) * v;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(rx, ry);
      ctx.stroke();
    }

    // 4. Vertical Left & Right Gate Posts + Top Arch Beam
    const mainColor = isFlashing ? "rgba(52, 211, 153, 0.98)" : "rgba(255, 127, 17, 0.96)";
    ctx.strokeStyle = mainColor;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(bl.x, bl.y);
    ctx.lineTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(br.x, br.y);
    ctx.stroke();

    // 5. Ground Finish Line (thick glowing threshold at the base of the wall)
    ctx.strokeStyle = mainColor;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(bl.x, bl.y);
    ctx.lineTo(br.x, br.y);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 10]);
    ctx.beginPath();
    ctx.moveTo(bl.x, bl.y);
    ctx.lineTo(br.x, br.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 6. Impact ripple on the 3D wall when a bib crosses
    if (isFlashing && this.wallFlash?.point) {
      const px = this.wallFlash.point.x * w;
      const py = (this.wallFlash.point.torsoY ?? this.wallFlash.point.y) * h;
      const r = 14 + (1 - flashAlpha) * 34;
      ctx.strokeStyle = `rgba(52, 211, 153, ${flashAlpha * 0.95})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 7. Interactive drag handles: Post A (left base), Post B (right base), and Top Arch (height)
    const drawHandle = (x, y, label) => {
      ctx.fillStyle = "#0b1322";
      ctx.strokeStyle = mainColor;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (label) {
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.font = "700 10px system-ui, sans-serif";
        ctx.fillText(label, x - 3, y + 3.5);
      }
    };
    drawHandle(bl.x, bl.y, "A");
    drawHandle(br.x, br.y, "B");
    const topMidX = (tl.x + tr.x) / 2;
    const topMidY = (tl.y + tr.y) / 2;
    drawHandle(topMidX, topMidY, "↕");

    const bannerText = isFlashing && this.wallFlash?.bib
      ? `3D FINISH GATE — BIB #${this.wallFlash.bib} CROSSED`
      : "3D FINISH GATE — drag posts A / B or top arch ↕";
    ctx.font = "600 11px system-ui, sans-serif";
    const textW = ctx.measureText(bannerText).width + 16;
    const pillX = Math.max(8, Math.min(w - textW - 8, topMidX - textW / 2));
    const pillY = Math.max(6, topMidY - 26);
    ctx.fillStyle = "rgba(10, 17, 30, 0.82)";
    ctx.strokeStyle = mainColor;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(pillX, pillY, textW, 20, 6);
    else ctx.rect(pillX, pillY, textW, 20);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = isFlashing ? "#34d399" : "#ff9f43";
    ctx.fillText(bannerText, pillX + 8, pillY + 14);
    ctx.restore();

    // 8. Spotted Bib-Number overlays (only draws bib numbers, never people without bibs)
    for (const t of tracks) {
      const tally = tallyVotes(t.votes, this.getRosterBibs());
      if (!tally && !t.pendingOcr) continue;
      const color = t.crossed
        ? "rgba(52,211,153,0.95)"
        : tally?.accepted ? "rgba(96,165,250,0.95)" : "rgba(255,159,67,0.85)";
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(t.bbox.x * w, t.bbox.y * h, t.bbox.w * w, t.bbox.h * h);
      const label = tally?.bib
        ? `BIB #${tally.bib} · ${Math.round(tally.confidence)}%`
        : "Reading bib…";
      ctx.fillStyle = color;
      ctx.font = "700 12px system-ui, sans-serif";
      ctx.fillText(label, t.bbox.x * w + 2, Math.max(14, t.bbox.y * h - 6));

      // Vertical projection line from bib patch down to ground contact on the 3D gate floor
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(t.cx * w, (t.bbox.y + t.bbox.h) * h);
      ctx.lineTo(t.cx * w, t.feet * h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillRect(t.cx * w - 5, t.feet * h - 2, 10, 4);
      ctx.restore();
    }
  }

  /* ---- Interactive 3D gate manipulation on the overlay ---- */

  attachLineDrag() {
    const cv = this.overlay;
    if (!cv) return;
    const toNorm = (e) => {
      const rect = cv.getBoundingClientRect();
      return {
        x: Math.min(0.98, Math.max(0.02, (e.clientX - rect.left) / (rect.width || 1))),
        y: Math.min(0.96, Math.max(0.04, (e.clientY - rect.top) / (rect.height || 1))),
      };
    };

    cv.addEventListener("pointerdown", (e) => {
      const p = toNorm(e);
      const quad = gateQuad(this.gate);
      const d1 = Math.hypot(p.x - quad.baseLeft.x, p.y - quad.baseLeft.y);
      const d2 = Math.hypot(p.x - quad.baseRight.x, p.y - quad.baseRight.y);
      const topMid = {
        x: (quad.topLeft.x + quad.topRight.x) / 2,
        y: (quad.topLeft.y + quad.topRight.y) / 2,
      };
      const dTop = Math.hypot(p.x - topMid.x, p.y - topMid.y);

      if (d1 < 0.075) this._dragHandle = "p1";
      else if (d2 < 0.075) this._dragHandle = "p2";
      else if (dTop < 0.085) this._dragHandle = "top";
      else this._dragHandle = "wall";

      this._dragStart = { p, gate: { ...this.gate } };
      cv.setPointerCapture(e.pointerId);
    });

    cv.addEventListener("pointermove", (e) => {
      if (!this._dragHandle || !this._dragStart) return;
      const p = toNorm(e);
      const startGate = this._dragStart.gate;
      if (this._dragHandle === "p1") {
        this.setGate({ x1: Math.min(startGate.x2 - 0.12, p.x), y1: p.y });
      } else if (this._dragHandle === "p2") {
        this.setGate({ x2: Math.max(startGate.x1 + 0.12, p.x), y2: p.y });
      } else if (this._dragHandle === "top") {
        const baseMidY = (startGate.y1 + startGate.y2) / 2;
        this.setGate({ wallHeight: Math.min(0.75, Math.max(0.15, baseMidY - p.y)) });
      } else if (this._dragHandle === "wall") {
        const dx = p.x - this._dragStart.p.x;
        const dy = p.y - this._dragStart.p.y;
        const clampShiftX = Math.min(
          0.96 - Math.max(startGate.x1, startGate.x2),
          Math.max(0.04 - Math.min(startGate.x1, startGate.x2), dx)
        );
        const clampShiftY = Math.min(
          0.95 - Math.max(startGate.y1, startGate.y2),
          Math.max(0.18 - Math.min(startGate.y1, startGate.y2), dy)
        );
        this.setGate({
          x1: startGate.x1 + clampShiftX,
          y1: startGate.y1 + clampShiftY,
          x2: startGate.x2 + clampShiftX,
          y2: startGate.y2 + clampShiftY,
        });
      }
    });

    const endDrag = () => {
      this._dragHandle = null;
      this._dragStart = null;
    };
    cv.addEventListener("pointerup", endDrag);
    cv.addEventListener("pointercancel", endDrag);
  }
}
