import { describe, expect, it } from "vitest";
import { safeMediaPath, splitMediaReferences } from "../../src/media.js";

const EXPORT_DIR = "/tmp/export";

describe("media path safety", () => {
  it("accepts a path inside the approved media directory", () => {
    expect(safeMediaPath(EXPORT_DIR, "media/photo.jpg")).toBe("media/photo.jpg");
    expect(safeMediaPath(EXPORT_DIR, "  media/photo.jpg  ")).toBe("media/photo.jpg");
  });

  it("rejects traversal, absolute paths, and anything outside the media root", () => {
    // These are the shapes a hostile or corrupt export would use to reach a
    // file the server was never given access to.
    expect(safeMediaPath(EXPORT_DIR, "media/../../secrets.txt")).toBeNull();
    expect(safeMediaPath(EXPORT_DIR, "../secrets.txt")).toBeNull();
    expect(safeMediaPath(EXPORT_DIR, "/etc/passwd")).toBeNull();
    expect(safeMediaPath(EXPORT_DIR, "activities/run.gpx")).toBeNull();
    expect(safeMediaPath(EXPORT_DIR, "")).toBeNull();
    expect(safeMediaPath(EXPORT_DIR, "media/pho\0to.jpg")).toBeNull();
  });

  it("rejects a sibling directory that merely starts with the root name", () => {
    expect(safeMediaPath(EXPORT_DIR, "media-private/photo.jpg")).toBeNull();
  });

  it("splits the catalog's pipe-delimited column and drops empty entries", () => {
    expect(splitMediaReferences("media/a.jpg|media/b.jpg")).toEqual(["media/a.jpg", "media/b.jpg"]);
    expect(splitMediaReferences("media/a.jpg | | media/b.jpg")).toEqual(["media/a.jpg", "media/b.jpg"]);
    expect(splitMediaReferences("")).toEqual([]);
    expect(splitMediaReferences(null)).toEqual([]);
  });
});
