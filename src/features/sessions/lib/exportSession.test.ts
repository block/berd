import { describe, expect, it } from "vitest";
import { defaultExportFilename, exportFilenameFromPath } from "./exportSession";

describe("defaultExportFilename", () => {
  it("builds a safe default export filename from the session title", () => {
    expect(defaultExportFilename("  Foo:/Bar*Baz  ")).toBe("Foo--Bar-Baz.json");
    expect(defaultExportFilename("")).toBe("session.json");
  });
});

describe("exportFilenameFromPath", () => {
  it("returns the filename from a saved path", () => {
    expect(
      exportFilenameFromPath("/Users/kalvin/Desktop/test.json", "session.json"),
    ).toBe("test.json");
    expect(
      exportFilenameFromPath("C:\\Users\\kalvin\\test.json", "session.json"),
    ).toBe("test.json");
  });

  it("falls back when a saved path has no filename", () => {
    expect(exportFilenameFromPath("/", "session.json")).toBe("session.json");
  });
});
