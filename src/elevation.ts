/**
 * Gating each consecutive sample-to-sample delta independently against a
 * threshold — "count this step only if it alone exceeds N meters" — zeroes
 * out a real, gradual climb whenever no single sample crosses the threshold,
 * which is the common case for barometric altitude sampled every second or
 * two. A marathon course with genuine net elevation change measured this way
 * can come out as 0m gained.
 *
 * Hysteresis avoids that: track a floating baseline and only credit gain (or
 * move the baseline down) once the altitude has moved more than the
 * threshold away from it in one direction. Small back-and-forth noise around
 * the baseline is absorbed; a gradual climb still accumulates once its total
 * excursion clears the threshold, even though no single step did.
 */
export function elevationGainMeters(altitudes: readonly (number | null)[], thresholdMeters: number): number | null {
  const samples = altitudes.filter((value): value is number => value !== null);
  if (samples.length === 0) return null;
  let gain = 0;
  let baseline = samples[0]!;
  for (let index = 1; index < samples.length; index += 1) {
    const delta = samples[index]! - baseline;
    if (delta > thresholdMeters) { gain += delta; baseline = samples[index]!; }
    else if (delta < -thresholdMeters) { baseline = samples[index]!; }
  }
  return gain;
}
