import { test, expect } from "bun:test";
import {
  toGray, boxBlur, unsharpMask, flattenLighting, otsuThreshold, binarizeOtsu,
  hasDigitLikeStructure, detectBibRegions, validateOcrSymbols, canonicalizeBibRead,
  normalizeGate, gateQuad, gateGroundYAtX,
  motionMask, dilate, findBlobs, mergeBoxes,
  BibTracker, checkCrossing, tallyVotes,
} from "../finish-cam.js";

/* ---------- image helpers ---------- */

function rgbaFor(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const p = (y * w + x) * 4;
      data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
    }
  }
  return data;
}

function grayFor(w, h, fn) {
  return toGray(rgbaFor(w, h, fn), w, h);
}

test("toGray computes luminance", () => {
  const g = toGray(rgbaFor(2, 1, (x) => (x ? [255, 255, 255] : [0, 0, 0])), 2, 1);
  expect(g[0]).toBe(0);
  expect(g[1]).toBe(255);
});

test("boxBlur preserves constant images", () => {
  const w = 16, h = 16;
  const g = grayFor(w, h, () => [100, 100, 100]);
  const blur = boxBlur(g, w, h, 3);
  for (let i = 0; i < blur.length; i++) expect(Math.abs(blur[i] - 100)).toBeLessThan(1);
});

test("unsharpMask sharpens edges without clipping", () => {
  const w = 32, h = 8;
  const g = grayFor(w, h, (x) => (x < 16 ? [40, 40, 40] : [215, 215, 215]));
  const out = unsharpMask(g, w, h);
  expect(Math.min(...out)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...out)).toBeLessThanOrEqual(255);
  expect(out[15 * 1 + 0]).toBeLessThanOrEqual(40);
});

test("flattenLighting removes a lighting gradient", () => {
  const w = 64, h = 16;
  const g = grayFor(w, h, (x, y) => {
    const light = 60 + (x / w) * 150;
    const ink = y > 5 && y < 10 && (x % 8 < 3);
    return ink ? [light * 0.35, light * 0.35, light * 0.35] : [light, light, light];
  });
  const flat = flattenLighting(g, w, h, 12);
  const t = otsuThreshold(flat);
  const bin = binarizeOtsu(flat, w, h);
  const leftInk = bin[7 * w + 1];
  const rightInk = bin[7 * w + 56];
  expect(leftInk).toBe(rightInk);
  expect([0, 255]).toContain(t >= 0 ? leftInk : leftInk);
});

test("otsuThreshold separates bimodal image", () => {
  const w = 32, h = 8;
  const g = grayFor(w, h, (x) => (x % 4 === 0 ? [220, 220, 220] : [30, 30, 30]));
  const t = otsuThreshold(g);
  expect(t).toBeGreaterThanOrEqual(30);
  expect(t).toBeLessThan(220);
  for (let i = 0; i < g.length; i++) {
    expect(g[i] > t).toBe(g[i] === 220);
  }
});

test("binarizeOtsu polarities produce ink=0", () => {
  const w = 16, h = 4;
  const g = grayFor(w, h, (x) => (x % 4 === 0 ? [230, 230, 230] : [25, 25, 25]));
  const darkInk = binarizeOtsu(g, w, h, true);
  expect(darkInk[0]).toBe(0);
  expect(darkInk[1]).toBe(255);
});

/* ---------- anti-hallucination structural pre-filter ---------- */

test("hasDigitLikeStructure rejects uniform / low-contrast crops", () => {
  const w = 80, h = 40;
  // Smooth gradient / blank wall / shirt without numbers
  const g = grayFor(w, h, (x, y) => {
    const v = 110 + ((x + y) % 14);
    return [v, v, v];
  });
  const res = hasDigitLikeStructure(g, w, h);
  expect(res.ok).toBe(false);
  expect(res.reason).toBe("low-contrast");
});

test("hasDigitLikeStructure rejects noisy speckle / foliage textures", () => {
  const w = 96, h = 48;
  // High-contrast checkerboard / leaf speckle (dozens of tiny blobs)
  const g = grayFor(w, h, (x, y) => {
    const spot = (x % 5 === 0) && (y % 4 === 0);
    return spot ? [20, 20, 20] : [230, 230, 230];
  });
  const res = hasDigitLikeStructure(g, w, h);
  expect(res.ok).toBe(false);
});

test("hasDigitLikeStructure accepts crisp printed digits on a white bib", () => {
  const w = 120, h = 50;
  // White bib background with 4 distinct dark vertical digit blocks
  const g = grayFor(w, h, (x, y) => {
    const inBandY = y >= 12 && y <= 38;
    const d1 = x >= 18 && x <= 28;
    const d2 = x >= 38 && x <= 50;
    const d3 = x >= 60 && x <= 72;
    const d4 = x >= 82 && x <= 94;
    const isInk = inBandY && (d1 || d2 || d3 || d4);
    return isInk ? [20, 20, 20] : [240, 240, 240];
  });
  const res = hasDigitLikeStructure(g, w, h);
  expect(res.ok).toBe(true);
  expect(res.components).toBe(4);
});

test("validateOcrSymbols rejects low-confidence 1-digit noise and accepts real multi-digit reads", () => {
  // Single digit "1" at 65% confidence (classic tree-trunk / fold hallucination) -> rejected
  const noise = validateOcrSymbols({
    text: "1\n",
    symbols: [{ text: "1", confidence: 65, bbox: { x0: 10, y0: 5, x1: 18, y1: 35 } }],
  }, 100, 40);
  expect(noise).toBeNull();

  // 4-digit read "0042" at 78% confidence with proper symbol heights -> accepted
  const real = validateOcrSymbols({
    text: "0042",
    symbols: [
      { text: "0", confidence: 76, bbox: { x0: 10, y0: 8, x1: 24, y1: 32 } },
      { text: "0", confidence: 80, bbox: { x0: 28, y0: 8, x1: 42, y1: 32 } },
      { text: "4", confidence: 79, bbox: { x0: 46, y0: 8, x1: 60, y1: 32 } },
      { text: "2", confidence: 77, bbox: { x0: 64, y0: 8, x1: 78, y1: 32 } },
    ],
  }, 100, 40);
  expect(real).not.toBeNull();
  expect(real.digits).toBe("0042");
  expect(real.confidence).toBe(78);
});

test("canonicalizeBibRead matches roster bibs and refuses to pad 1-2 digit unknown noise", () => {
  const roster = ["0001", "0002", "0042"];
  // Known bib "1" -> "0001"
  expect(canonicalizeBibRead("1", roster)).toEqual({ bib: "0001", known: true, rawLength: 1 });
  // Known bib "0042" -> "0042"
  expect(canonicalizeBibRead("0042", roster)).toEqual({ bib: "0042", known: true, rawLength: 4 });
  // Unknown 1-digit noise "7" -> null (never padded to "0007"!)
  expect(canonicalizeBibRead("7", roster)).toBeNull();
  // Unknown 2-digit noise "11" -> null
  expect(canonicalizeBibRead("11", roster)).toBeNull();
  // Explicit 4-digit unlisted bib "0105" -> allowed as unknown
  expect(canonicalizeBibRead("0105", roster)).toEqual({ bib: "0105", known: false, rawLength: 4 });
});

/* ---------- motion + blobs ---------- */

test("motionMask detects changed pixels", () => {
  const w = 8, h = 8;
  const a = grayFor(w, h, () => [50, 50, 50]);
  const b = grayFor(w, h, (x, y) => (x > 3 && y > 3 ? [200, 200, 200] : [50, 50, 50]));
  const mask = motionMask(a, b, w, h, 25);
  expect(mask[7 * w + 7]).toBe(1);
  expect(mask[0]).toBe(0);
});

test("dilate grows regions and findBlobs returns bounding boxes", () => {
  const w = 40, h = 40;
  let mask = new Uint8Array(w * h);
  mask[5 * w + 5] = 1;
  mask[30 * w + 30] = 1;
  mask = dilate(mask, w, h, 2);
  const blobs = findBlobs(mask, w, h, { minArea: 4 });
  expect(blobs.length).toBe(2);
  for (const b of blobs) {
    expect(b.w).toBeGreaterThanOrEqual(5);
    expect(b.h).toBeGreaterThanOrEqual(5);
  }
});

test("findBlobs filters by area", () => {
  const w = 20, h = 20;
  const mask = new Uint8Array(w * h);
  mask[2 * w + 2] = 1;
  for (let y = 10; y < 16; y++) for (let x = 10; x < 16; x++) mask[y * w + x] = 1;
  const blobs = findBlobs(mask, w, h, { minArea: 10 });
  expect(blobs.length).toBe(1);
  expect(blobs[0].x).toBe(10);
  expect(blobs[0].y).toBe(10);
});

test("mergeBoxes joins nearby boxes", () => {
  const merged = mergeBoxes([
    { x: 0, y: 0, w: 10, h: 10, area: 50 },
    { x: 14, y: 2, w: 10, h: 10, area: 50 },
  ], 6);
  expect(merged.length).toBe(1);
  expect(merged[0].x).toBe(0);
  expect(merged[0].w).toBe(24);
});

/* ---------- direct bib-number detection (number-first, never people-first) ---------- */

test("detectBibRegions spots a printed bib with digits in the frame", () => {
  const w = 240, h = 180;
  const g = grayFor(w, h, (x, y) => {
    const shirt = 118 + Math.round(8 * Math.sin(y / 22));
    const inBib = x >= 80 && x < 160 && y >= 60 && y < 110;
    if (inBib) {
      const rx = x - 80, ry = y - 60;
      const digit = ry >= 10 && ry < 40 && (
        (rx >= 8 && rx < 18) || (rx >= 28 && rx < 38) ||
        (rx >= 48 && rx < 58) || (rx >= 68 && rx < 78)
      );
      return digit ? [22, 22, 22] : [242, 242, 242];
    }
    return [shirt, shirt, shirt];
  });
  const regions = detectBibRegions(g, w, h);
  expect(regions.length).toBeGreaterThanOrEqual(1);
  // at least one region must cover the bib center (0.5, ~0.47 normalized)
  const hit = regions.some((r) =>
    Math.abs(r.x + r.w / 2 - 0.5) < 0.12 && Math.abs(r.y + r.h / 2 - 85 / h) < 0.12);
  expect(hit).toBe(true);
});

test("detectBibRegions ignores a person in a plain shirt (no bib number)", () => {
  const w = 240, h = 180;
  const g = grayFor(w, h, (x, y) => {
    // bright plain shirt (no text at all) on a dark background
    const inShirt = x >= 60 && x < 180 && y >= 20 && y < 160;
    const v = inShirt ? 220 + ((x * 7 + y * 3) % 11) - 5 : 60 + ((x + y) % 7);
    return [v, v, v];
  });
  expect(detectBibRegions(g, w, h).length).toBe(0);
});

test("detectBibRegions ignores foliage speckle / camera noise", () => {
  const w = 240, h = 180;
  const g = grayFor(w, h, (x, y) => {
    const spot = (x % 5 === 0) && (y % 4 === 0);
    return spot ? [20, 20, 20] : [230, 230, 230];
  });
  expect(detectBibRegions(g, w, h).length).toBe(0);
});

test("detectBibRegions ignores vertical-edge textures (fences, trunks, folds)", () => {
  const w = 240, h = 180;
  const g = grayFor(w, h, (x) => (x % 7 < 3 ? [60, 60, 60] : [210, 210, 210]));
  expect(detectBibRegions(g, w, h).length).toBe(0);
});

/* ---------- tracker + 3D finish-gate wall ---------- */

function box(x, y, w = 0.1, h = 0.2) {
  return { x, y, w, h };
}

test("tracker assigns stable IDs across frames", () => {
  const t = new BibTracker();
  t.update([box(0.1, 0.1)], 1000);
  t.update([box(0.12, 0.15)], 1350);
  expect(t.tracks.length).toBe(1);
  expect(t.tracks[0].seen).toBe(2);
  expect(t.tracks[0].id).toBe(1);
});

test("tracker spawns separate tracks for distant runners", () => {
  const t = new BibTracker();
  t.update([box(0.1, 0.1), box(0.8, 0.1)], 1000);
  expect(t.tracks.length).toBe(2);
});

test("tracker retires lost tracks only after maxLost", () => {
  const t = new BibTracker({ maxLost: 2 });
  t.update([box(0.1, 0.1)], 1000);
  t.update([], 1350);
  t.update([], 1700);
  expect(t.tracks.length).toBe(1);
  t.update([], 2050);
  expect(t.tracks.length).toBe(0);
});

test("tracker vote accumulates and pads bibs", () => {
  const t = new BibTracker();
  const tracks = t.update([box(0.5, 0.5)], 1000);
  t.vote(tracks[0], "0002", 80);
  t.vote(tracks[0], "0002", 90);
  t.vote(tracks[0], "0007", 40);
  const tally = tallyVotes(tracks[0].votes, ["0002", "0007"]);
  expect(tally.bib).toBe("0002");
  expect(tally.count).toBe(2);
  expect(tally.accepted).toBe(true);
});

test("checkCrossing interpolates crossing time for both legacy lineY and 3D gate wall", () => {
  const track = {
    crossed: false,
    history: [
      { t: 1000, cx: 0.5, feet: 0.50, cy: 0.4, torsoY: 0.38 },
      { t: 1350, cx: 0.5, feet: 0.70, cy: 0.6, torsoY: 0.58 },
    ],
  };
  const cross = checkCrossing(track, 0.60);
  expect(cross).not.toBeNull();
  expect(cross.at).toBeGreaterThan(1100);
  expect(cross.at).toBeLessThan(1250);

  // Slanted 3D finish-gate wall (left post at y=0.55, right post at y=0.75 -> at x=0.5, groundY=0.65)
  const slantedGate = normalizeGate({ x1: 0.1, y1: 0.55, x2: 0.9, y2: 0.75, wallHeight: 0.45 });
  const cross3D = checkCrossing(track, slantedGate);
  expect(cross3D).not.toBeNull();
  expect(cross3D.point.x).toBeCloseTo(0.5, 2);
  expect(cross3D.point.y).toBeCloseTo(0.65, 2);
  // 0.65 is 75% of the way from 0.50 to 0.70 -> ~1262.5ms
  expect(cross3D.at).toBeGreaterThan(1240);
  expect(cross3D.at).toBeLessThan(1285);
});

test("checkCrossing rejects motion outside the 3D gate posts", () => {
  const gate = normalizeGate({ x1: 0.25, y1: 0.65, x2: 0.75, y2: 0.65, wallHeight: 0.40 });
  const bystander = {
    crossed: false,
    history: [
      { t: 1000, cx: 0.05, feet: 0.55, torsoY: 0.40 },
      { t: 1350, cx: 0.05, feet: 0.75, torsoY: 0.60 },
    ],
  };
  expect(checkCrossing(bystander, gate)).toBeNull();
});

test("checkCrossing ignores recrossing and non-crossings", () => {
  const track = {
    crossed: true,
    history: [{ t: 1, feet: 0.5 }, { t: 2, feet: 0.9 }],
  };
  expect(checkCrossing(track, 0.6)).toBeNull();

  const track2 = {
    crossed: false,
    history: [{ t: 1, feet: 0.1 }, { t: 2, feet: 0.2 }],
  };
  expect(checkCrossing(track2, 0.6)).toBeNull();
});

test("gateQuad and gateGroundYAtX compute 3D wall geometry", () => {
  const quad = gateQuad({ x1: 0.1, y1: 0.70, x2: 0.9, y2: 0.70, wallHeight: 0.40 });
  expect(quad.baseLeft.y).toBeCloseTo(0.70, 3);
  expect(quad.topLeft.y).toBeCloseTo(0.30, 3);
  const mid = gateGroundYAtX(quad, 0.5);
  expect(mid.withinSpan).toBe(true);
});

/* ---------- vote resolution ---------- */

test("tallyVotes rejects weak single reads", () => {
  const votes = new Map([["0003", { count: 1, confSum: 40 }]]);
  const t = tallyVotes(votes, []);
  expect(t.accepted).toBe(false);
});

test("tallyVotes accepts a strong single read when on roster or no roster loaded", () => {
  const votes = new Map([["0003", { count: 1, confSum: 90 }]]);
  const t = tallyVotes(votes, ["0003"]);
  expect(t.accepted).toBe(true);
  expect(t.bib).toBe("0003");
});

test("tallyVotes requires multi-frame consensus for unknown bibs when a roster exists", () => {
  // Single frame of unknown bib "0999" when roster has ["0001"] -> NOT auto-accepted
  const singleUnknown = new Map([["0999", { count: 1, confSum: 85 }]]);
  expect(tallyVotes(singleUnknown, ["0001"]).accepted).toBe(false);

  // Two consistent frames >= 72% confidence -> accepted
  const doubleUnknown = new Map([["0999", { count: 2, confSum: 160 }]]);
  expect(tallyVotes(doubleUnknown, ["0001"]).accepted).toBe(true);
});

test("tallyVotes majority wins over one-off high-conf noise", () => {
  const votes = new Map([
    ["0011", { count: 3, confSum: 210 }],
    ["0017", { count: 1, confSum: 95 }],
  ]);
  const t = tallyVotes(votes, []);
  expect(t.bib).toBe("0011");
  expect(t.accepted).toBe(true);
});

test("tallyVotes returns null with no votes", () => {
  expect(tallyVotes(new Map(), [])).toBeNull();
});

test("tallyVotes flags roster-known bibs", () => {
  const votes = new Map([["0005", { count: 2, confSum: 160 }]]);
  const t = tallyVotes(votes, ["0005"]);
  expect(t.known).toBe(true);
});
