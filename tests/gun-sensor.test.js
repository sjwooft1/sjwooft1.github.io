import { describe, expect, test } from "bun:test";
import {
  bandEnergy,
  looksLikeGun,
  normalise,
  rms,
  spectralDistance,
} from "../gun-sensor.js";

/** A flat, broadband spectrum — what a pistol sounds like. */
const bang = () => new Array(8).fill(1).map((_, i) => 200 - i * 4);
/** Energy only at the bottom of the spectrum — a voice, a hum, a rumble. */
const hum = () => [220, 60, 8, 2, 1, 0, 0, 0];

describe("bandEnergy", () => {
  test("spreads the spectrum across the buckets", () => {
    const spectrum = new Uint8Array([10, 10, 20, 20, 30, 30, 40, 40]);
    expect(bandEnergy(spectrum, 4)).toEqual([20, 40, 60, 80]);
  });

  test("a silent frame has no energy in any band", () => {
    expect(bandEnergy(new Uint8Array(64), 8)).toEqual(new Array(8).fill(0));
  });
});

describe("normalise", () => {
  test("turns energies into fractions that add up to one", () => {
    const n = normalise([1, 1, 2, 4]);
    expect(n.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(n[3]).toBeCloseTo(0.5, 6);
  });

  test("an empty profile is flat rather than NaN", () => {
    expect(normalise([0, 0, 0, 0])).toEqual([0.25, 0.25, 0.25, 0.25]);
  });
});

describe("spectralDistance", () => {
  test("identical shapes are zero apart", () => {
    expect(spectralDistance(normalise(bang()), normalise(bang()))).toBe(0);
  });

  test("a low rumble is far from the bang", () => {
    expect(spectralDistance(normalise(bang()), normalise(hum()))).toBeGreaterThan(0.4);
  });

  test("missing profiles count as no match", () => {
    expect(spectralDistance(null, normalise(bang()))).toBe(1);
  });
});

describe("rms", () => {
  test("reads the level of a tone", () => {
    expect(rms(new Float32Array(64).fill(0.5))).toBeCloseTo(0.5, 6);
    expect(rms(new Float32Array(64))).toBe(0);
  });
});

describe("looksLikeGun", () => {
  const reference = normalise(bang());
  const quiet = { baseline: 0.01, peak: 0.8, threshold: 0.6 };

  test("the recorded bang, at full level, is the gun", () => {
    expect(looksLikeGun({ ...quiet, level: 0.8, profile: reference, reference })).toBe(true);
  });

  test("a noise well below the learned level is not", () => {
    expect(looksLikeGun({ ...quiet, level: 0.3, profile: reference, reference })).toBe(false);
  });

  test("something loud with the wrong shape is not the gun", () => {
    expect(
      looksLikeGun({ ...quiet, level: 0.9, profile: normalise(hum()), reference })
    ).toBe(false);
  });

  test("a loud noise that is not sudden (a constant roar) is not the gun", () => {
    expect(
      looksLikeGun({ ...quiet, level: 0.8, baseline: 0.79, profile: reference, reference })
    ).toBe(false);
  });

  test("the threshold slider decides how loud counts", () => {
    const level = 0.45; // under 60% of the 0.8 peak, over 50% of it
    expect(looksLikeGun({ ...quiet, level, profile: reference, reference, threshold: 0.6 })).toBe(false);
    expect(looksLikeGun({ ...quiet, level, profile: reference, reference, threshold: 0.5 })).toBe(true);
  });

  test("nothing is the gun until one has been recorded", () => {
    expect(looksLikeGun({ ...quiet, level: 1, profile: reference, reference: null })).toBe(false);
  });
});
