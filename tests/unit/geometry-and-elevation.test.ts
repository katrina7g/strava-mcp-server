import { describe, expect, it } from "vitest";
import { elevationGainMeters } from "../../src/elevation.js";
import { simplify, simplifyToLimit, type LonLat } from "../../src/geometry.js";

describe("Route simplification by tolerance", () => {
  it("keeps every point when none exceeds the tolerance", () => {
    // A straight line: no interior point deviates from the endpoint segment.
    const line: LonLat[] = Array.from({ length: 20 }, (_, index) => ({ longitude: -122 + index * 0.0001, latitude: 47 }));
    expect(simplify(line, 5)).toEqual([line[0], line[line.length - 1]]);
  });

  it("keeps a point that deviates from the line by more than the tolerance", () => {
    const points: LonLat[] = [
      { longitude: -122, latitude: 47 },
      { longitude: -122, latitude: 47.01 }, // roughly 1.1km off the straight line below
      { longitude: -121.99, latitude: 47 },
    ];
    const result = simplify(points, 5);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(points[0]);
    expect(result[2]).toEqual(points[2]);
  });

  it("always retains the first and last point regardless of tolerance", () => {
    const points: LonLat[] = Array.from({ length: 50 }, (_, index) => ({ longitude: -122 + index * 0.00001, latitude: 47 + index * 0.00001 }));
    const result = simplify(points, 10_000);
    expect(result[0]).toEqual(points[0]);
    expect(result.at(-1)).toEqual(points.at(-1));
  });

  it("doubles the tolerance until the result fits the point cap and reports it", () => {
    // A jagged path so a small tolerance keeps far more than maxPoints.
    const points: LonLat[] = Array.from({ length: 200 }, (_, index) => ({
      longitude: -122 + index * 0.0001,
      latitude: 47 + (index % 2 === 0 ? 0.001 : -0.001),
    }));
    const { points: reduced, toleranceMeters } = simplifyToLimit(points, 10, 1);
    expect(reduced.length).toBeLessThanOrEqual(10);
    expect(toleranceMeters).toBeGreaterThan(1);
  });
});

describe("elevationGainMeters", () => {
  it("absorbs jitter within the noise band and credits a climb past it", () => {
    expect(elevationGainMeters([10, 10.4, 10, 10.4, 20], 1)).toBeCloseTo(10, 9);
  });

  it("does not zero out a gradual climb whose individual steps are all sub-threshold", () => {
    // Every consecutive delta is 0.5m, well under a 1m threshold. A naive
    // per-step gate ("only count a step that alone exceeds the threshold")
    // reports 0 for this whole series — the bug this module replaces.
    // Hysteresis still credits each 1.5m excursion once it clears the
    // baseline, landing on 4.5m; the final 0.5m tail from the last captured
    // baseline (4.5) to the series end (5.0) has not yet cleared the
    // threshold and is legitimately not yet counted.
    const gradual = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
    expect(elevationGainMeters(gradual, 1)).toBeCloseTo(4.5, 9);
    expect(elevationGainMeters(gradual, 1)).toBeGreaterThan(0);
  });

  it("ignores null altitude samples rather than treating a gap as a drop", () => {
    expect(elevationGainMeters([10, null, null, 20], 1)).toBeCloseTo(10, 9);
  });

  it("returns null when no sample has an altitude at all", () => {
    expect(elevationGainMeters([null, null], 1)).toBeNull();
  });

  it("counts a climb even when a later equal descent returns to the start", () => {
    // Elevation gain is cumulative ascent, not net displacement: a 10m climb
    // followed by a 10m descent still gained 10m over the course.
    expect(elevationGainMeters([10, 20, 10], 1)).toBeCloseTo(10, 9);
  });
});
