import { describe, expect, test } from "bun:test";
import {
  columnMotion,
  crossedLine,
  dominantBlob,
  toGray,
} from "../crossing-cam.js";

/* A synthetic frame: a background of `bg` grey with a `width`-px wide dark
   runner standing at column `x`. Frames are Float32Array grey buffers, the
   same shape CrossingCam feeds the detectors. */
const W = 100;
const H = 40;
function frame(x, width = 6, bg = 128) {
  const g = new Float32Array(W * H).fill(bg);
  if (x == null) return g;
  for (let y = 0; y < H; y++) {
    for (let cx = x; cx < x + width; cx++) {
      if (cx >= 0 && cx < W) g[y * W + cx] = 30;
    }
  }
  return g;
}

describe("toGray", () => {
  test("weights channels the way the eye does", () => {
    expect(toGray(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1)[0]).toBeCloseTo(76.2, 1);
    expect(toGray(new Uint8ClampedArray([0, 0, 255, 255]), 1, 1)[0]).toBeCloseTo(29.1, 1);
    expect(toGray(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1)[0]).toBe(0);
  });
});

describe("columnMotion", () => {
  test("only the columns the runner occupies report movement", () => {
    const cols = columnMotion(frame(null), frame(40), W, H);
    const bandRows = Math.ceil(H * 0.98) - Math.floor(H * 0.06);
    expect(cols[39]).toBe(0);
    expect(cols[40]).toBe(bandRows);
    expect(cols[45]).toBe(bandRows);
    expect(cols[46]).toBe(0);
  });

  test("a change below the noise threshold is ignored", () => {
    const prev = frame(null);
    const cur = frame(null, 6, 128 + 10); // whole-frame lighting nudge
    expect(columnMotion(prev, cur, W, H).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe("dominantBlob", () => {
  test("picks the heaviest run and reports its centre", () => {
    const cols = new Float32Array(W);
    for (let x = 10; x < 16; x++) cols[x] = 20;  // small passer-by
    for (let x = 60; x < 76; x++) cols[x] = 60;  // the actual runner
    const blob = dominantBlob(cols, { minColumn: 6, minWidth: 3 });
    expect(blob.start).toBe(60);
    expect(blob.end).toBe(76);
    expect(blob.width).toBe(16);
    expect(blob.center).toBeCloseTo(68, 5);
  });

  test("bridges a narrow gap inside one body", () => {
    const cols = new Float32Array(W);
    for (let x = 30; x < 45; x++) cols[x] = 40;
    cols[37] = 0; // a dark seam
    const blob = dominantBlob(cols, { minColumn: 6, minWidth: 3, maxGap: 2 });
    expect(blob.start).toBe(30);
    expect(blob.end).toBe(45);
  });

  test("ignores runs narrower than minWidth", () => {
    const cols = new Float32Array(W);
    cols[50] = 99;
    expect(dominantBlob(cols, { minColumn: 6, minWidth: 3 })).toBe(null);
  });

  test("an empty frame has no blob", () => {
    expect(dominantBlob(new Float32Array(W))).toBe(null);
  });
});

describe("crossedLine", () => {
  test("interpolates the moment between two samples", () => {
    // 10 -> 30 in 100 ms, line at 20 => exactly halfway
    const c = crossedLine(10, 30, 20, 1000, 1100);
    expect(c.direction).toBe("ltr");
    expect(c.at).toBeCloseTo(1050, 6);
  });

  test("works right-to-left", () => {
    const c = crossedLine(80, 20, 50, 5000, 5100);
    expect(c.direction).toBe("rtl");
    expect(c.at).toBeCloseTo(5050, 6);
  });

  test("staying on one side is not a crossing", () => {
    expect(crossedLine(10, 40, 50, 0, 100)).toBe(null);
    expect(crossedLine(80, 60, 50, 0, 100)).toBe(null);
  });

  test("landing exactly on the line still counts", () => {
    const c = crossedLine(49, 50, 50, 0, 100);
    expect(c).not.toBe(null);
    expect(c.direction).toBe("ltr");
    expect(c.at).toBe(100);
  });

  test("a stationary object never crosses", () => {
    expect(crossedLine(50, 50, 50, 0, 100)).toBe(null);
    expect(crossedLine(49, 49, 50, 0, 100)).toBe(null);
  });
});

describe("a runner walking across the frame", () => {
  /* Mirrors the per-tick bookkeeping in CrossingCam._tick: a track keeps the
     previous centre/time, fires once on a crossing, then waits for a fresh
     approach. */
  function runSequence(xs, lineX = 50, stepMs = 90) {
    // Same background bookkeeping as CrossingCam._tick: only static pixels
    // learn the scene, and anything different for ABSORB_TICKS is absorbed.
    const bg = frame(null);
    const still = new Uint8Array(W * H);
    let track = null;
    const crossings = [];
    xs.forEach((x, i) => {
      const cur = frame(x);
      const cols = columnMotion(bg, cur, W, H);
      for (let p = 0; p < bg.length; p++) {
        const d = cur[p] - bg[p];
        if (d > -24 && d < 24) { bg[p] += d * 0.15; still[p] = 0; }
        else if (++still[p] >= 25) { bg[p] += d * 0.15; still[p] = 0; }
      }
      const blob = dominantBlob(cols, { minColumn: 6, minWidth: 3 });
      const t = i * stepMs;
      if (!blob) track = null;
      else if (!track) track = { first: blob.center, prev: blob.center, prevAt: t };
      else {
        const c = crossedLine(track.prev, blob.center, lineX, track.prevAt, t);
        track.prev = blob.center;
        track.prevAt = t;
        if (c && Math.abs(blob.center - track.first) >= 0.05 * W) {
          crossings.push({ ...c, frame: i });
          track = null;
        }
      }
    });
    return crossings;
  }

  const approach = (from, to, step) => {
    const xs = [];
    for (let x = from; step > 0 ? x <= to : x >= to; x += step) xs.push(x);
    return xs;
  };

  test("fires exactly once, in the right direction", () => {
    const crossings = runSequence(approach(20, 80, 2));
    expect(crossings.length).toBe(1);
    expect(crossings[0].direction).toBe("ltr");
  });

  test("stamps a time within one frame of the real crossing", () => {
    const crossing = runSequence(approach(20, 80, 2))[0];
    // centre is x+3, so it crosses 50 between x=46 (49) and x=48 (51)
    const trueAt = 14 * 90 - 45; // halfway between the two samples
    expect(Math.abs(crossing.at - trueAt)).toBeLessThan(90);
  });

  test("fires when travelling right-to-left too", () => {
    const crossings = runSequence(approach(80, 20, -2));
    expect(crossings.length).toBe(1);
    expect(crossings[0].direction).toBe("rtl");
  });

  test("a runner who stops short never records a finish", () => {
    expect(runSequence(approach(20, 44, 2))).toEqual([]);
  });

  test("a stationary object beside the line never records a finish", () => {
    // Same parked blob 200 frames running, with the line well clear of it.
    const parked = Array.from({ length: 200 }, () => 60);
    expect(runSequence(parked)).toEqual([]);
  });

  test("two runners in a row are two crossings", () => {
    const gaps = [20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 80];
    const none = [null, null, null]; // the runner leaves the frame between the two
    const crossings = runSequence([...gaps, ...none, ...gaps]);
    expect(crossings.length).toBe(2);
  });
});
