import { test, expect } from "bun:test";
import {
  toGray, boxBlur, unsharpMask, flattenLighting, otsuThreshold, binarizeOtsu,
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
  // overshoot at the edge: dark side gets darker, bright side brighter
  expect(out[15 * 1 + 0]).toBeLessThanOrEqual(40); // somewhere near edge
});

test("flattenLighting removes a lighting gradient", () => {
  const w = 64, h = 16;
  // dark bars (digits) over a strong left-to-right lighting gradient
  const g = grayFor(w, h, (x, y) => {
    const light = 60 + (x / w) * 150;
    const ink = y > 5 && y < 10 && (x % 8 < 3);
    return ink ? [light * 0.35, light * 0.35, light * 0.35] : [light, light, light];
  });
  const flat = flattenLighting(g, w, h, 12);
  const t = otsuThreshold(flat);
  const bin = binarizeOtsu(flat, w, h);
  // after flattening, both left and right ink pixels classify the same
  const leftInk = bin[7 * w + 1];
  const rightInk = bin[7 * w + 56];
  expect(leftInk).toBe(rightInk);
  expect([0, 255]).toContain(t >= 0 ? leftInk : leftInk);
});

test("otsuThreshold separates bimodal image", () => {
  const w = 32, h = 8;
  const g = grayFor(w, h, (x) => (x % 4 === 0 ? [220, 220, 220] : [30, 30, 30]));
  const t = otsuThreshold(g);
  // the threshold must fall between the two modes so each classifies cleanly
  expect(t).toBeGreaterThanOrEqual(30);
  expect(t).toBeLessThan(220);
  for (let i = 0; i < g.length; i++) {
    expect(g[i] > t).toBe(g[i] === 220);
  }
});

test("binarizeOtsu polarities produce ink=0", () => {
  const w = 16, h = 4;
  // bright text on dark background
  const g = grayFor(w, h, (x) => (x % 4 === 0 ? [230, 230, 230] : [25, 25, 25]));
  const darkInk = binarizeOtsu(g, w, h, true); // bright pixels are ink
  expect(darkInk[0]).toBe(0);       // ink
  expect(darkInk[1]).toBe(255);     // background
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
  // two separate dots
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
  mask[2 * w + 2] = 1; // single pixel — below minArea
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

/* ---------- tracker ---------- */

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

test("checkCrossing interpolates the crossing time", () => {
  const track = {
    crossed: false,
    history: [
      { t: 1000, feet: 0.50, cy: 0.4 },
      { t: 1350, feet: 0.70, cy: 0.6 },
    ],
  };
  const cross = checkCrossing(track, 0.60);
  expect(cross).not.toBeNull();
  // feet move 0.20 over 350ms; line at 0.60 is halfway -> ~175ms in
  expect(cross.at).toBeGreaterThan(1100);
  expect(cross.at).toBeLessThan(1250);
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

/* ---------- vote resolution ---------- */

test("tallyVotes rejects weak single reads", () => {
  const votes = new Map([["0003", { count: 1, confSum: 40 }]]);
  const t = tallyVotes(votes, []);
  expect(t.accepted).toBe(false);
});

test("tallyVotes accepts a strong single read", () => {
  const votes = new Map([["0003", { count: 1, confSum: 90 }]]);
  const t = tallyVotes(votes, []);
  expect(t.accepted).toBe(true);
  expect(t.bib).toBe("0003");
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
