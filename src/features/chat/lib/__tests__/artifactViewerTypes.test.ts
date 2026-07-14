import { describe, expect, it } from "vitest";
import {
  classifyArtifactView,
  fileExtension,
  isViewableArtifact,
} from "../artifactViewerTypes";

describe("fileExtension", () => {
  it("returns the lowercased extension", () => {
    expect(fileExtension("/a/b/README.MD")).toBe(".md");
    expect(fileExtension("notes.Markdown")).toBe(".markdown");
  });

  it("handles paths with no extension", () => {
    expect(fileExtension("/a/b/Dockerfile")).toBe("");
    expect(fileExtension("/a/b/.gitignore")).toBe("");
  });

  it("normalizes windows separators", () => {
    expect(fileExtension("C:\\src\\image.PNG")).toBe(".png");
  });
});

describe("classifyArtifactView", () => {
  it("classifies markdown", () => {
    expect(classifyArtifactView("doc.md")).toBe("markdown");
    expect(classifyArtifactView("doc.mdx")).toBe("markdown");
    expect(classifyArtifactView("doc.markdown")).toBe("markdown");
  });

  it("classifies images", () => {
    for (const path of [
      "a.png",
      "a.jpg",
      "a.jpeg",
      "a.gif",
      "a.webp",
      "a.svg",
    ]) {
      expect(classifyArtifactView(path)).toBe("image");
    }
  });

  it("returns null for non-viewable files", () => {
    expect(classifyArtifactView("main.ts")).toBeNull();
    expect(classifyArtifactView("data.csv")).toBeNull();
    expect(classifyArtifactView("report.pdf")).toBeNull();
    expect(classifyArtifactView("Dockerfile")).toBeNull();
  });
});

describe("isViewableArtifact", () => {
  it("is true only for viewable types", () => {
    expect(isViewableArtifact("a.md")).toBe(true);
    expect(isViewableArtifact("a.png")).toBe(true);
    expect(isViewableArtifact("a.ts")).toBe(false);
    expect(isViewableArtifact("a.pdf")).toBe(false);
  });
});
