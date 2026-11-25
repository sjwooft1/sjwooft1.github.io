import { describe, expect, test } from "bun:test";
import {
  columnMotion,
  crossedLine,
  dominantBlob,
  frameNoise,
  motionThreshold,
  stepTrack,
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

describe("frameNoise / motionThreshold", () => {
  test("a still scene sits on the floor", () => {
    const bg = frame(null);
    expect(frameNoise(bg, bg)).toBe(0);
    expect(motionThreshold(0)).toBe(14);
  });

  test("a scene that flickers raises the bar instead of faking movement", () => {
    const bg = frame(null);
    const windy = frame(null, 6, 128 + 6); // every pixel nudged 6 levels
    expect(frameNoise(bg, windy)).toBe(6);
    expect(motionThreshold(6)).toBe(21);
  });

  test("the bar never runs away with itself", () => {
    expect(motionThreshold(200)).toBe(46);
  });

  test("a quiet scene still sees a real runner against the raised bar", () => {
    const bg = frame(null);
    const cur = frame(40);
    const threshold = motionThreshold(frameNoise(bg, cur));
    const cols = columnMotion(bg, cur, W, H, undefined, threshold);
    expect(dominantBlob(cols, { minColumn: 6, minWidth: 3 }).width).toBe(6);
  });
});

describe("stepTrack — a runner walking across the frame", () => {
  /* Drives the same tracker CrossingCam._tick uses: one entry per frame, the
     body's centre (or null when nothing was found) and the time. */
  const LINE = 50;
  function run(xs, opts = {}, stepMs = 90) {
    let track = null;
    const crossings = [];
    xs.forEach((x, i) => {
      const at = i * stepMs;
      const center = x == null ? null : x + 3; // centre of the 6px body
      const r = stepTrack(track, center, at, { linePx: LINE, minTravelPx: 5, ...opts });
      track = r.track;
      if (r.cross) crossings.push({ ...r.cross, frame: i });
    });
    return crossings;
  }

  const approach = (from, to, step) => {
    const xs = [];
    for (let x = from; step > 0 ? x <= to : x >= to; x += step) xs.push(x);
    return xs;
  };

  test("fires exactly once, in the right direction", () => {
    const crossings = run(approach(20, 80, 2));
    expect(crossings.length).toBe(1);
    expect(crossings[0].direction).toBe("ltr");
  });

  test("stamps a time within one frame of the real crossing", () => {
    const crossing = run(approach(20, 80, 2))[0];
    // centre is x+3, so it crosses 50 between x=46 (49) and x=48 (51)
    const trueAt = 14 * 90 - 45; // halfway between the two samples
    expect(Math.abs(crossing.at - trueAt)).toBeLessThan(90);
  });

  test("fires when travelling right-to-left too", () => {
    const crossings = run(approach(80, 20, -2));
    expect(crossings.length).toBe(1);
    expect(crossings[0].direction).toBe("rtl");
  });

  test("a runner who stops short never records a finish", () => {
    expect(run(approach(20, 44, 2))).toEqual([]);
  });

  test("a stationary object never records a finish", () => {
    const parked = Array.from({ length: 200 }, () => 60);
    expect(run(parked)).toEqual([]);
  });

  test("two runners in a row are two crossings", () => {
    const gaps = [20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 80];
    const none = [null, null, null]; // the runner leaves the frame between the two
    const crossings = run([...gaps, ...none, ...gaps]);
    expect(crossings.length).toBe(2);
  });

  test("a runner hidden for a couple of frames is still one finish", () => {
    // 46 (just before the line) → two frames with no body → 55 (clearly past)
    const crossings = run([46, null, null, 55]);
    expect(crossings.length).toBe(1);
    expect(crossings[0].direction).toBe("ltr");
    expect(crossings[0].at).toBeGreaterThan(0);
    expect(crossings[0].at).toBeLessThan(3 * 90);
  });

  test("a track lost for longer than the hold is dropped, not stamped late", () => {
    const gone = Array.from({ length: 8 }, () => null);
    const crossings = run([30, ...gone, 60]);
    expect(crossings).toEqual([]);
  });

  test("a runner first seen right at the line still gets a time", () => {
    // The detection starts one frame before the crossing: the old travel
    // gate threw this away, which is exactly how a fast leader got missed.
    const crossings = run([46, 52], { minTravelPx: 0 });
    expect(crossings.length).toBe(1);
  });
});
