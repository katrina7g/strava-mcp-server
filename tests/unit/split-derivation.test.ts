import { describe, expect, it } from "vitest";
import { deriveSplits, INTERVAL_METERS, type SplitPoint } from "../../src/splits.js";

/** A steady track: one point per second, `metersPerSecond` apart. */
function steadyTrack(count: number, metersPerSecond: number, overrides: Partial<SplitPoint> = {}): SplitPoint[] {
  return Array.from({ length: count }, (_unused, index) => ({
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + index * 1000).toISOString(),
    distanceMeters: index * metersPerSecond,
    altitudeMeters: null, heartRate: null, cadence: null, powerWatts: null,
    ...overrides,
  }));
}

describe("split derivation", () => {
  it("cuts kilometre splits at exact boundaries and keeps a partial final split", () => {
    // 2,500 m at 2 m/s: two whole kilometres and a 500 m remainder.
    const { splits, totalDistanceMeters } = deriveSplits(steadyTrack(1_251, 2), "km", "supplied");

    expect(totalDistanceMeters).toBe(2_500);
    expect(splits).toHaveLength(3);
    expect(splits.map((split) => split.startDistanceMeters)).toEqual([0, 1_000, 2_000]);
    expect(splits.map((split) => split.complete)).toEqual([true, true, false]);
    expect(splits[2]!.distanceMeters).toBe(500);
    // 1,000 m at 2 m/s is 500 s, and pace is reported per kilometre.
    expect(splits[0]!.elapsedSeconds).toBeCloseTo(500, 6);
    expect(splits[0]!.paceSecondsPerKm).toBeCloseTo(500, 6);
  });

  it("allocates a boundary-spanning segment to both splits so no time is lost", () => {
    // Sparse sampling: 400 m every 200 s, so segments straddle the 1 km mark.
    const points: SplitPoint[] = [0, 400, 800, 1_200, 1_600, 2_000].map((distance, index) => ({
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + index * 200_000).toISOString(),
      distanceMeters: distance, altitudeMeters: null, heartRate: null, cadence: null, powerWatts: null,
    }));
    const { splits } = deriveSplits(points, "km", "supplied");

    const totalElapsed = splits.reduce((total, split) => total + (split.elapsedSeconds ?? 0), 0);
    expect(splits).toHaveLength(2);
    // Sparse sampling at running speed is moving time, not a stop, but the
    // holes in the recording are still reported.
    expect(splits.every((split) => split.pausedSeconds === 0)).toBe(true);
    expect(splits[0]!.recordingGapCount).toBeGreaterThan(0);
    // The 800-1,200 m segment donates half its 200 s to each side.
    expect(splits[0]!.elapsedSeconds).toBeCloseTo(500, 6);
    expect(splits[1]!.elapsedSeconds).toBeCloseTo(500, 6);
    expect(totalElapsed).toBeCloseTo(1_000, 6);
  });

  it("counts a stop as paused time rather than slow running", () => {
    const points: SplitPoint[] = [
      { timestamp: "2026-01-01T00:00:00.000Z", distanceMeters: 0, altitudeMeters: null, heartRate: null, cadence: null, powerWatts: null },
      { timestamp: "2026-01-01T00:04:00.000Z", distanceMeters: 480, altitudeMeters: null, heartRate: null, cadence: null, powerWatts: null },
      // Two minutes standing still at 480 m.
      { timestamp: "2026-01-01T00:06:00.000Z", distanceMeters: 480, altitudeMeters: null, heartRate: null, cadence: null, powerWatts: null },
      { timestamp: "2026-01-01T00:10:20.000Z", distanceMeters: 1_000, altitudeMeters: null, heartRate: null, cadence: null, powerWatts: null },
    ];
    const { splits } = deriveSplits(points, "km", "supplied");

    expect(splits).toHaveLength(1);
    expect(splits[0]!.pauseCount).toBe(1);
    expect(splits[0]!.pausedSeconds).toBeCloseTo(120, 6);
    expect(splits[0]!.elapsedSeconds).toBeCloseTo(620, 6);
    expect(splits[0]!.movingSeconds).toBeCloseTo(500, 6);
    // Moving pace, so the stop does not make the kilometre look slower.
    expect(splits[0]!.paceSecondsPerKm).toBeCloseTo(500, 6);
  });

  it("reports which metrics a split actually carries", () => {
    const withHeartRate = steadyTrack(1_001, 1, { heartRate: 150 });
    const withoutAny = steadyTrack(1_001, 1);

    const present = deriveSplits(withHeartRate, "km", "supplied").splits[0]!;
    const absent = deriveSplits(withoutAny, "km", "supplied").splits[0]!;

    expect(present.metricsAvailable).toContain("heartRate");
    expect(present.averageHeartRate).toBe(150);
    expect(present.maxHeartRate).toBe(150);
    // An absent metric is named nowhere and left null, never reported as zero.
    expect(absent.metricsAvailable).not.toContain("heartRate");
    expect(absent.averageHeartRate).toBeNull();
    expect(absent.averageCadence).toBeNull();
  });

  it("derives mile intervals from the same track", () => {
    const { splits, intervalMeters } = deriveSplits(steadyTrack(1_611, 1), "mile", "supplied");

    expect(intervalMeters).toBe(INTERVAL_METERS.mile);
    expect(splits).toHaveLength(2);
    expect(splits[0]!.complete).toBe(true);
    expect(splits[0]!.endDistanceMeters).toBeCloseTo(1_609.344, 3);
  });

  it("derives nothing without a usable distance source", () => {
    const withheld = deriveSplits(steadyTrack(1_001, 1), "km", "none");

    expect(withheld.splits).toEqual([]);
    expect(withheld.withheldReason).toContain("No usable distance source");
  });

  it("separates elevation gain from loss over one split", () => {
    const climbAndDescend = steadyTrack(1_001, 1).map((point, index) => ({
      ...point, altitudeMeters: index < 500 ? index * 0.1 : (1_000 - index) * 0.1,
    }));
    const [split] = deriveSplits(climbAndDescend, "km", "supplied").splits;

    expect(split!.elevationGainMeters).toBeGreaterThan(40);
    expect(split!.elevationLossMeters).toBeGreaterThan(40);
    expect(split!.metricsAvailable).toContain("elevation");
  });
});
