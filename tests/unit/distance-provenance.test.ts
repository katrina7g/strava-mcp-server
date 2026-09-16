import { describe, expect, it } from "vitest";
import { haversineMeters, normalizeRouteProgression } from "../../src/distance.js";

const timestamp = (second: number): string => `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;

describe("route-distance provenance", () => {
  it("calculates a great-circle diagnostic segment across the antimeridian", () => {
    const meters = haversineMeters({ latitude: 0, longitude: 179.9 }, { latitude: 0, longitude: -179.9 });
    expect(meters).toBeCloseTo(22_239, -1);
  });

  it("preserves FIT-supplied record distance without normalization", () => {
    const route = normalizeRouteProgression([
      { timestamp: timestamp(0), latitude: 47, longitude: -122, distanceMeters: 0 },
      { timestamp: timestamp(10), latitude: 47.001, longitude: -122, distanceMeters: 101 },
    ], 100);
    expect(route.points).toMatchObject([
      { distanceMeters: 0, distanceSource: "supplied" },
      { distanceMeters: 101, distanceSource: "supplied" },
    ]);
    expect(route.diagnostic).toMatchObject({ qualityStatus: "not-applicable", rawGpsDistanceMeters: null });
  });

  it("normalizes an eligible GPX/TCX route to the catalog distance", () => {
    const points = [
      { timestamp: timestamp(0), latitude: 47, longitude: -122, distanceMeters: null },
      { timestamp: timestamp(10), latitude: 47.001, longitude: -122, distanceMeters: null },
      { timestamp: timestamp(20), latitude: 47.002, longitude: -122, distanceMeters: null },
    ];
    const raw = haversineMeters(points[0]!, points[1]!)! + haversineMeters(points[1]!, points[2]!)!;
    const route = normalizeRouteProgression(points, raw * 2);
    expect(route.diagnostic).toMatchObject({ qualityStatus: "eligible", rawGpsDistanceMeters: raw, catalogDistanceMeters: raw * 2 });
    expect(route.points).toMatchObject([
      { distanceMeters: 0, distanceSource: "catalog-normalized-path" },
      { distanceSource: "catalog-normalized-path" },
      { distanceSource: "catalog-normalized-path" },
    ]);
    expect(route.points[1]?.distanceMeters).toBeCloseTo(raw, 6);
    expect(route.points[2]?.distanceMeters).toBeCloseTo(raw * 2, 6);
  });

  it("withholds a route with an ambiguous major discontinuity", () => {
    const route = normalizeRouteProgression([
      { timestamp: "2026-01-01T00:00:00Z", latitude: 47, longitude: -122, distanceMeters: null },
      { timestamp: "2026-01-01T00:10:00Z", latitude: 47.02, longitude: -122, distanceMeters: null },
      { timestamp: "2026-01-01T00:10:10Z", latitude: 47.021, longitude: -122, distanceMeters: null },
    ], 2_400);
    expect(route.diagnostic).toMatchObject({ qualityStatus: "ineligible", majorGapCount: 1 });
    expect(route.diagnostic.withheldReason).toContain("major discontinuity");
    expect(route.points.every((point) => point.distanceSource === "none" && point.distanceMeters === null)).toBe(true);
  });

  it("withholds a route whose raw length differs too much from catalog distance", () => {
    const route = normalizeRouteProgression([
      { timestamp: timestamp(0), latitude: 47, longitude: -122, distanceMeters: null },
      { timestamp: timestamp(10), latitude: 47.001, longitude: -122, distanceMeters: null },
      { timestamp: timestamp(20), latitude: 47.002, longitude: -122, distanceMeters: null },
    ], 1_000);
    expect(route.diagnostic).toMatchObject({ qualityStatus: "ineligible" });
    expect(route.diagnostic.withheldReason).toContain("differs too much");
  });

  it("withholds routes with missing coordinate or timestamp coverage", () => {
    const route = normalizeRouteProgression([
      { timestamp: timestamp(0), latitude: 47, longitude: -122, distanceMeters: null },
      { timestamp: null, latitude: null, longitude: null, distanceMeters: null },
      { timestamp: timestamp(20), latitude: 47.002, longitude: -122, distanceMeters: null },
      { timestamp: timestamp(30), latitude: 47.003, longitude: -122, distanceMeters: null },
    ], 220);
    expect(route.diagnostic).toMatchObject({ qualityStatus: "ineligible" });
    expect(route.diagnostic.withheldReason).toContain("location coverage");
  });
});
