export type LonLat = Readonly<{ longitude: number; latitude: number }>;

const METERS_PER_DEGREE_LATITUDE = 111_320;

/**
 * Flattens lon/lat to local planar meters around one reference latitude. GPS
 * traces span a small enough area per activity that this approximation is
 * accurate to well under a meter, which is smaller than any tolerance this
 * module is called with.
 */
function toPlanarMeters(point: LonLat, referenceLatitude: number): { x: number; y: number } {
  const metersPerDegreeLongitude = METERS_PER_DEGREE_LATITUDE * Math.cos((referenceLatitude * Math.PI) / 180);
  return { x: point.longitude * metersPerDegreeLongitude, y: point.latitude * METERS_PER_DEGREE_LATITUDE };
}

function perpendicularDistanceMeters(point: LonLat, segmentStart: LonLat, segmentEnd: LonLat, referenceLatitude: number): number {
  const p = toPlanarMeters(point, referenceLatitude);
  const a = toPlanarMeters(segmentStart, referenceLatitude);
  const b = toPlanarMeters(segmentEnd, referenceLatitude);
  const dx = b.x - a.x; const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  const clamped = Math.min(1, Math.max(0, t));
  return Math.hypot(p.x - (a.x + clamped * dx), p.y - (a.y + clamped * dy));
}

/**
 * Douglas–Peucker simplification. The first and last point are always kept,
 * and every retained segment's endpoints are exact source points, so no
 * middle section of the route is ever discarded outright the way fixed-stride
 * decimation would — a point is dropped only when it lies within tolerance of
 * the line connecting its still-retained neighbors.
 */
export function simplify(points: readonly LonLat[], toleranceMeters: number): LonLat[] {
  if (points.length < 3) return [...points];
  const referenceLatitude = points[Math.floor(points.length / 2)]!.latitude;
  let farthestDistance = 0; let farthestIndex = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = perpendicularDistanceMeters(points[index]!, points[0]!, points[points.length - 1]!, referenceLatitude);
    if (distance > farthestDistance) { farthestDistance = distance; farthestIndex = index; }
  }
  if (farthestDistance <= toleranceMeters) return [points[0]!, points[points.length - 1]!];
  const left = simplify(points.slice(0, farthestIndex + 1), toleranceMeters);
  const right = simplify(points.slice(farthestIndex), toleranceMeters);
  return [...left.slice(0, -1), ...right];
}

/**
 * Simplifies at increasing tolerance until the result fits `maxPoints`,
 * reporting the tolerance actually used so a client can judge how much detail
 * was traded away. Doubling bounds the number of attempts on a dense track
 * without needing to binary-search for an exact point count.
 */
export function simplifyToLimit(points: readonly LonLat[], maxPoints: number, startingToleranceMeters: number): { points: LonLat[]; toleranceMeters: number } {
  let toleranceMeters = startingToleranceMeters;
  let simplified = simplify(points, toleranceMeters);
  for (let attempt = 0; simplified.length > maxPoints && attempt < 20; attempt += 1) {
    toleranceMeters *= 2;
    simplified = simplify(points, toleranceMeters);
  }
  return { points: simplified, toleranceMeters };
}
