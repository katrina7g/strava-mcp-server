export type DistanceSource = "supplied" | "catalog-normalized-path" | "none";

export type DistancePoint = {
  timestamp: string | null;
  latitude: number | null;
  longitude: number | null;
  distanceMeters: number | null;
};

export type RouteDiagnostic = {
  rawGpsDistanceMeters: number | null;
  catalogDistanceMeters: number | null;
  errorRatio: number | null;
  totalPointCount: number;
  validCoordinatePointCount: number;
  timestampedPointCount: number;
  majorGapCount: number;
  qualityStatus: "eligible" | "ineligible" | "not-applicable";
  withheldReason: string | null;
};

export type NormalizedRoute<T extends DistancePoint> = {
  points: (T & { distanceMeters: number | null; distanceSource: DistanceSource })[];
  diagnostic: RouteDiagnostic;
};

export const ROUTE_DISTANCE_DERIVATION_VERSION = 1;
const EARTH_RADIUS_METERS = 6_371_008.8;
const MIN_ROUTE_POINTS = 3;
const MIN_COORDINATE_COVERAGE = 0.98;
const MIN_TIMESTAMP_COVERAGE = 0.98;
const MAX_RAW_CATALOG_ERROR_RATIO = 0.5;
// A long timestamp gap alone can be a café stop. It becomes a route gap only
// when it also jumps a substantial distance; an instantaneous large jump is
// likewise a discontinuity rather than a credible route segment.
const MAJOR_GAP_SECONDS = 300;
const MAJOR_GAP_DISTANCE_METERS = 1_000;
const MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND = 50;

function radians(degrees: number): number { return (degrees * Math.PI) / 180; }

export function validCoordinate(latitude: number | null, longitude: number | null): boolean {
  return latitude !== null && longitude !== null && Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

/** Great-circle length is diagnostic only for GPX/TCX; it is never exposed as
 * a standard-distance split input. */
export function haversineMeters(a: Pick<DistancePoint, "latitude" | "longitude">, b: Pick<DistancePoint, "latitude" | "longitude">): number | null {
  if (!validCoordinate(a.latitude, a.longitude) || !validCoordinate(b.latitude, b.longitude)) return null;
  const aLatitude = a.latitude; const aLongitude = a.longitude; const bLatitude = b.latitude; const bLongitude = b.longitude;
  if (aLatitude === null || aLongitude === null || bLatitude === null || bLongitude === null) return null;
  const latitudeDelta = radians(bLatitude - aLatitude);
  const longitudeDelta = radians(bLongitude - aLongitude);
  const sinLatitude = Math.sin(latitudeDelta / 2);
  const sinLongitude = Math.sin(longitudeDelta / 2);
  const h = sinLatitude ** 2 + Math.cos(radians(aLatitude)) * Math.cos(radians(bLatitude)) * sinLongitude ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

function timestampMillis(timestamp: string | null): number | null {
  if (timestamp === null) return null;
  const value = Date.parse(timestamp); return Number.isFinite(value) ? value : null;
}

/**
 * FIT records retain their decoder-supplied distances. GPX/TCX tracks are
 * normalized to their catalog total only after route continuity checks pass.
 * Invalid tracks intentionally yield no usable per-point distance.
 */
export function normalizeRouteProgression<T extends DistancePoint>(points: readonly T[], catalogDistanceMeters: number | null): NormalizedRoute<T> {
  const totalPointCount = points.length;
  const validCoordinatePointCount = points.filter((point) => validCoordinate(point.latitude, point.longitude)).length;
  const timestampedPointCount = points.filter((point) => timestampMillis(point.timestamp) !== null).length;
  const hasSuppliedDistance = points.some((point) => point.distanceMeters !== null && Number.isFinite(point.distanceMeters));
  if (hasSuppliedDistance) {
    return {
      points: points.map((point) => ({ ...point, distanceSource: point.distanceMeters !== null && Number.isFinite(point.distanceMeters) ? "supplied" : "none" })),
      diagnostic: { rawGpsDistanceMeters: null, catalogDistanceMeters, errorRatio: null, totalPointCount, validCoordinatePointCount, timestampedPointCount, majorGapCount: 0, qualityStatus: "not-applicable", withheldReason: null },
    };
  }

  let rawGpsDistanceMeters = 0; let majorGapCount = 0;
  const rawProgress = points.map((point, index) => {
    if (index === 0) return validCoordinate(point.latitude, point.longitude) ? 0 : null;
    const prior = points[index - 1]!;
    const segment = haversineMeters(prior, point);
    if (segment === null) return null;
    const priorTime = timestampMillis(prior.timestamp); const currentTime = timestampMillis(point.timestamp);
    if (priorTime !== null && currentTime !== null) {
      const elapsedSeconds = (currentTime - priorTime) / 1000;
      const speed = elapsedSeconds > 0 ? segment / elapsedSeconds : Infinity;
      if ((elapsedSeconds > MAJOR_GAP_SECONDS && segment > MAJOR_GAP_DISTANCE_METERS) || speed > MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND) majorGapCount += 1;
    }
    rawGpsDistanceMeters += segment;
    return rawGpsDistanceMeters;
  });
  const raw = rawGpsDistanceMeters > 0 ? rawGpsDistanceMeters : null;
  const errorRatio = raw !== null && catalogDistanceMeters !== null && catalogDistanceMeters > 0
    ? (raw - catalogDistanceMeters) / catalogDistanceMeters : null;
  const coordinateCoverage = totalPointCount === 0 ? 0 : validCoordinatePointCount / totalPointCount;
  const timestampCoverage = totalPointCount === 0 ? 0 : timestampedPointCount / totalPointCount;
  const withheldReason = catalogDistanceMeters === null || catalogDistanceMeters <= 0
    ? "Catalog total distance is unavailable."
    : totalPointCount < MIN_ROUTE_POINTS || raw === null
      ? "Route has too few usable location points for distance-based analysis."
      : coordinateCoverage < MIN_COORDINATE_COVERAGE
        ? "Route location coverage is insufficient for distance-based analysis."
        : timestampCoverage < MIN_TIMESTAMP_COVERAGE
          ? "Route timestamp coverage is insufficient for distance-based analysis."
          : majorGapCount > 0
            ? "Route contains a major discontinuity, so split position is ambiguous."
            : errorRatio === null || Math.abs(errorRatio) > MAX_RAW_CATALOG_ERROR_RATIO
              ? "Raw GPS route length differs too much from the catalog total for distance-based analysis."
              : null;
  const eligible = withheldReason === null;
  const scale = eligible && raw !== null && catalogDistanceMeters !== null ? catalogDistanceMeters / raw : null;
  return {
    points: points.map((point, index) => {
      const progress = rawProgress[index] ?? null;
      return { ...point, distanceMeters: scale !== null && progress !== null ? progress * scale : null, distanceSource: scale !== null && progress !== null ? "catalog-normalized-path" : "none" };
    }),
    diagnostic: { rawGpsDistanceMeters: raw, catalogDistanceMeters, errorRatio, totalPointCount, validCoordinatePointCount, timestampedPointCount, majorGapCount, qualityStatus: eligible ? "eligible" : "ineligible", withheldReason },
  };
}
