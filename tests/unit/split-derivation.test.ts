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

  it("counts one pause per stop, not one per sample taken during it", () => {
    // A device sampling every second through a 90 s stop emits 90 stationary
    // segments. They describe one interruption, not ninety.
    const points: SplitPoint[] = [];
    let time = Date.UTC(2026, 0, 1); let distance = 0;
    const push = (moving: boolean) => {
      points.push({ timestamp: new Date(time).toISOString(), distanceMeters: distance, altitudeMeters: null, heartRate: null, cadence: null, powerWatts: null });
      time += 1_000; if (moving) distance += 2;
    };
    for (let i = 0; i < 200; i += 1) push(true);
    for (let i = 0; i < 90; i += 1) push(false);
    for (let i = 0; i < 300; i += 1) push(true);
    const [split] = deriveSplits(points, "km", "supplied").splits;

    expect(split!.pauseCount).toBe(1);
    expect(split!.pausedSeconds).toBeCloseTo(90, 6);
    // 590 points give 589 segments; 90 of them are the stop.
    expect(split!.elapsedSeconds).toBeCloseTo(589, 6);
    expect(split!.movingSeconds).toBeCloseTo(499, 6);
  });

  it("counts two stops separately when movement resumes between them", () => {
    const points: SplitPoint[] = [];
    let time = Date.UTC(2026, 0, 1); let distance = 0;
    const push = (moving: boolean) => {
      points.push({ timestamp: new Date(time).toISOString(), distanceMeters: distance, altitudeMeters: null, heartRate: null, cadence: null, powerWatts: null });
      time += 1_000; if (moving) distance += 2;
    };
    for (let i = 0; i < 100; i += 1) push(true);
    for (let i = 0; i < 40; i += 1) push(false);
    for (let i = 0; i < 100; i += 1) push(true);
    for (let i = 0; i < 40; i += 1) push(false);
    for (let i = 0; i < 300; i += 1) push(true);
    const [split] = deriveSplits(points, "km", "supplied").splits;

    expect(split!.pauseCount).toBe(2);
    expect(split!.pausedSeconds).toBeCloseTo(80, 6);
  });

  it("ignores a brief dip below the pause threshold", () => {
    // Speed wobbles under 0.5 m/s for a single sample at a time, twenty times
    // over. That is a noisy fix or a shuffling stride, not twenty stops.
    const points: SplitPoint[] = [];
    let time = Date.UTC(2026, 0, 1); let distance = 0;
    for (let index = 0; index < 600; index += 1) {
      points.push({ timestamp: new Date(time).toISOString(), distanceMeters: distance, altitudeMeters: null, heartRate: null, cadence: null, powerWatts: null });
      time += 1_000;
      distance += index % 30 === 0 ? 0.2 : 2;
    }
    const [split] = deriveSplits(points, "km", "supplied").splits;

    expect(split!.pauseCount).toBe(0);
    // The slow seconds are still slow, so they remain in pausedSeconds.
    expect(split!.pausedSeconds).toBeGreaterThan(0);
  });

  it("measures the activity to its furthest point, not its last record", () => {
    // A device that emits a corrupt or reset final record must not shrink the
    // activity: activity_bounds stores the maximum, so splits must agree.
    const points = steadyTrack(1_001, 2);
    points.push({ timestamp: "2026-01-01T01:00:00.000Z", distanceMeters: 5, altitudeMeters: null, heartRate: null, cadence: null, powerWatts: null });
    const { splits, totalDistanceMeters } = deriveSplits(points, "km", "supplied");

    expect(totalDistanceMeters).toBe(2_000);
    expect(splits).toHaveLength(2);
  });

  it("credits a resumed stream only with the ground it actually covers", () => {
    // The first record already carries distance, so the opening interval is
    // only partly recorded and must not be priced as a whole kilometre.
    const points: SplitPoint[] = Array.from({ length: 401 }, (_unused, index) => ({
      timestamp: new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString(),
      distanceMeters: 200 + index * 2,
      altitudeMeters: null, heartRate: null, cadence: null, powerWatts: null,
    }));
    const [split] = deriveSplits(points, "km", "supplied").splits;

    expect(split!.distanceMeters).toBe(800);
    expect(split!.complete).toBe(false);
    // 800 m at 2 m/s is 400 s, which is 500 s per kilometre — the true pace,
    // not the 400 s/km a full-interval assumption would report.
    expect(split!.paceSecondsPerKm).toBeCloseTo(500, 6);
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
