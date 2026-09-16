import { elevationChangeMeters } from "./elevation.js";
import type { DistanceSource } from "./distance.js";

/** Bump when the split formula changes, so stored splits recompute. */
export const SPLIT_DERIVATION_VERSION = 1;

export type IntervalKind = "km" | "mile";
export const INTERVAL_METERS: Record<IntervalKind, number> = { km: 1_000, mile: 1_609.344 };

// A pause is defined by speed, not by sampling rate. Treating any gap over
// thirty seconds as a pause outright would mark a sparsely sampled track as
// entirely stopped — a GPX logging every two hundred seconds at running speed
// would report no moving time at all. Standing still is caught by the speed
// test whether or not the device kept sampling. A long gap that does cover
// ground is a hole in the recording rather than a rest, so it is counted and
// reported separately instead of being silently folded into either total.
const PAUSE_SPEED_METERS_PER_SECOND = 0.5;
const RECORDING_GAP_SECONDS = 30;
const ELEVATION_NOISE_THRESHOLD_METERS = 1;

export type SplitPoint = {
  timestamp: string | null;
  distanceMeters: number | null;
  altitudeMeters: number | null;
  heartRate: number | null;
  cadence: number | null;
  powerWatts: number | null;
};

export type Split = {
  sequence: number;
  startDistanceMeters: number;
  endDistanceMeters: number;
  distanceMeters: number;
  complete: boolean;
  startedAt: string | null;
  endedAt: string | null;
  elapsedSeconds: number | null;
  movingSeconds: number | null;
  pausedSeconds: number;
  pauseCount: number;
  recordingGapCount: number;
  paceSecondsPerKm: number | null;
  averageHeartRate: number | null;
  maxHeartRate: number | null;
  averageCadence: number | null;
  averagePowerWatts: number | null;
  elevationGainMeters: number | null;
  elevationLossMeters: number | null;
  pointCount: number;
  /** Named so a caller can tell an absent metric from a zero reading. */
  metricsAvailable: string[];
};

export type SplitDerivation = {
  splits: Split[];
  intervalKind: IntervalKind;
  intervalMeters: number;
  distanceSource: DistanceSource;
  totalDistanceMeters: number | null;
  withheldReason: string | null;
};

function millis(timestamp: string | null): number | null {
  if (timestamp === null) return null;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : null;
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
}

type Accumulator = {
  elapsedSeconds: number; pausedSeconds: number; pauseCount: number; recordingGapCount: number;
  firstTime: number | null; lastTime: number | null;
  altitudes: (number | null)[]; heartRates: number[]; cadences: number[]; powers: number[];
  pointCount: number; maxDistance: number;
};

function emptyAccumulator(): Accumulator {
  return { elapsedSeconds: 0, pausedSeconds: 0, pauseCount: 0, recordingGapCount: 0, firstTime: null, lastTime: null, altitudes: [], heartRates: [], cadences: [], powers: [], pointCount: 0, maxDistance: 0 };
}

/**
 * Splits are derived from cumulative distance, never from raw coordinates, so
 * FIT uses what its device recorded and GPX/TCX uses catalog-normalized route
 * progression or nothing at all. Time is allocated to a split in proportion to
 * the distance covered inside it, so a segment spanning a boundary donates
 * time to both sides and the split elapsed times still sum to the activity's.
 */
export function deriveSplits(points: readonly SplitPoint[], intervalKind: IntervalKind, distanceSource: DistanceSource): SplitDerivation {
  const intervalMeters = INTERVAL_METERS[intervalKind];
  const base = { intervalKind, intervalMeters, distanceSource } as const;
  if (distanceSource === "none") {
    return { ...base, splits: [], totalDistanceMeters: null, withheldReason: "No usable distance source, so distance-based splits cannot be derived." };
  }
  const usable = points.filter((point) => point.distanceMeters !== null && Number.isFinite(point.distanceMeters));
  if (usable.length < 2) {
    return { ...base, splits: [], totalDistanceMeters: null, withheldReason: "Too few points carry a distance for distance-based splits." };
  }
  const total = usable[usable.length - 1]!.distanceMeters!;
  if (!(total > 0)) {
    return { ...base, splits: [], totalDistanceMeters: total, withheldReason: "Total distance is zero, so there are no splits to derive." };
  }

  const bucketCount = Math.max(1, Math.ceil(total / intervalMeters));
  const buckets: Accumulator[] = Array.from({ length: bucketCount }, emptyAccumulator);
  const bucketFor = (distance: number) => Math.min(bucketCount - 1, Math.max(0, Math.floor(distance / intervalMeters)));

  for (const point of usable) {
    const bucket = buckets[bucketFor(point.distanceMeters!)]!;
    bucket.pointCount += 1;
    bucket.altitudes.push(point.altitudeMeters);
    if (point.heartRate !== null) bucket.heartRates.push(point.heartRate);
    if (point.cadence !== null) bucket.cadences.push(point.cadence);
    if (point.powerWatts !== null) bucket.powers.push(point.powerWatts);
    bucket.maxDistance = Math.max(bucket.maxDistance, point.distanceMeters!);
    const time = millis(point.timestamp);
    if (time !== null) {
      bucket.firstTime = bucket.firstTime === null ? time : Math.min(bucket.firstTime, time);
      bucket.lastTime = bucket.lastTime === null ? time : Math.max(bucket.lastTime, time);
    }
  }

  for (let index = 1; index < usable.length; index += 1) {
    const previous = usable[index - 1]!; const current = usable[index]!;
    const startDistance = previous.distanceMeters!; const endDistance = current.distanceMeters!;
    const previousTime = millis(previous.timestamp); const currentTime = millis(current.timestamp);
    if (previousTime === null || currentTime === null) continue;
    const seconds = (currentTime - previousTime) / 1000;
    if (seconds <= 0) continue;
    const distanceDelta = endDistance - startDistance;
    const speed = distanceDelta / seconds;
    const paused = speed < PAUSE_SPEED_METERS_PER_SECOND;
    const recordingGap = !paused && seconds > RECORDING_GAP_SECONDS;

    if (distanceDelta <= 0) {
      // Standing still covers no ground, so the whole interval belongs to the
      // split the athlete was standing in.
      const bucket = buckets[bucketFor(startDistance)]!;
      bucket.elapsedSeconds += seconds;
      if (paused) { bucket.pausedSeconds += seconds; bucket.pauseCount += 1; }
      continue;
    }

    const firstBucket = bucketFor(startDistance); const lastBucket = bucketFor(endDistance);
    // Counted once, against the split the segment starts in, so a segment
    // spanning a boundary is not reported as two separate interruptions.
    if (paused) buckets[firstBucket]!.pauseCount += 1;
    if (recordingGap) buckets[firstBucket]!.recordingGapCount += 1;
    for (let bucketIndex = firstBucket; bucketIndex <= lastBucket; bucketIndex += 1) {
      const bucketStart = bucketIndex * intervalMeters;
      const bucketEnd = bucketStart + intervalMeters;
      const overlap = Math.min(endDistance, bucketEnd) - Math.max(startDistance, bucketStart);
      if (overlap <= 0) continue;
      const share = (overlap / distanceDelta) * seconds;
      const bucket = buckets[bucketIndex]!;
      bucket.elapsedSeconds += share;
      if (paused) bucket.pausedSeconds += share;
    }
  }

  const splits = buckets.map((bucket, sequence) => {
    const startDistanceMeters = sequence * intervalMeters;
    const endDistanceMeters = Math.min(total, startDistanceMeters + intervalMeters);
    const distanceMeters = Math.max(0, endDistanceMeters - startDistanceMeters);
    const elapsedSeconds = bucket.elapsedSeconds > 0 ? bucket.elapsedSeconds : null;
    const movingSeconds = elapsedSeconds === null ? null : Math.max(0, elapsedSeconds - bucket.pausedSeconds);
    const elevation = elevationChangeMeters(bucket.altitudes, ELEVATION_NOISE_THRESHOLD_METERS);
    const averageHeartRate = average(bucket.heartRates);
    const averageCadence = average(bucket.cadences);
    const averagePowerWatts = average(bucket.powers);
    const metricsAvailable = [
      ...(bucket.heartRates.length > 0 ? ["heartRate"] : []),
      ...(bucket.cadences.length > 0 ? ["cadence"] : []),
      ...(bucket.powers.length > 0 ? ["powerWatts"] : []),
      ...(elevation !== null ? ["elevation"] : []),
    ];
    return {
      sequence, startDistanceMeters, endDistanceMeters, distanceMeters,
      complete: endDistanceMeters - startDistanceMeters >= intervalMeters - 1e-6,
      startedAt: bucket.firstTime === null ? null : new Date(bucket.firstTime).toISOString(),
      endedAt: bucket.lastTime === null ? null : new Date(bucket.lastTime).toISOString(),
      elapsedSeconds, movingSeconds,
      pausedSeconds: bucket.pausedSeconds, pauseCount: bucket.pauseCount,
      recordingGapCount: bucket.recordingGapCount,
      // Pace uses moving time, so a long stop does not read as a slow split.
      paceSecondsPerKm: movingSeconds !== null && movingSeconds > 0 && distanceMeters > 0 ? (movingSeconds * 1000) / distanceMeters : null,
      averageHeartRate, maxHeartRate: bucket.heartRates.length > 0 ? Math.max(...bucket.heartRates) : null,
      averageCadence, averagePowerWatts,
      elevationGainMeters: elevation?.gainMeters ?? null,
      elevationLossMeters: elevation?.lossMeters ?? null,
      pointCount: bucket.pointCount, metricsAvailable,
    };
  });

  return { ...base, splits, totalDistanceMeters: total, withheldReason: null };
}
