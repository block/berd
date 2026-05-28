import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_ICON,
  fileProjectIconValue,
  isFileProjectIcon,
  isImageProjectIcon,
  normalizeProjectIcon,
} from "./projectIcons";

describe("projectIcons", () => {
  it("normalizes empty and legacy folder icons to the default preset", () => {
    expect(normalizeProjectIcon(null)).toBe(DEFAULT_PROJECT_ICON);
    expect(normalizeProjectIcon(undefined)).toBe(DEFAULT_PROJECT_ICON);
    expect(normalizeProjectIcon("\u{1F4C1}")).toBe(DEFAULT_PROJECT_ICON);
  });

  it("normalizes legacy preset icons to the default color-block sentinel", () => {
    expect(normalizeProjectIcon("tabler:code")).toBe(DEFAULT_PROJECT_ICON);
    expect(normalizeProjectIcon("tabler:brand-github")).toBe(
      DEFAULT_PROJECT_ICON,
    );
  });

  it("preserves image-backed icon values", () => {
    expect(normalizeProjectIcon("data:image/png;base64,aWNvbg==")).toBe(
      "data:image/png;base64,aWNvbg==",
    );
    expect(normalizeProjectIcon(fileProjectIconValue("/tmp/logo.svg"))).toBe(
      "file:/tmp/logo.svg",
    );
  });

  it("identifies file and image-backed icon values", () => {
    const fileIcon = fileProjectIconValue("/tmp/logo.svg");

    expect(fileIcon).toBe("file:/tmp/logo.svg");
    expect(isFileProjectIcon(fileIcon)).toBe(true);
    expect(isImageProjectIcon(fileIcon)).toBe(true);
    expect(isImageProjectIcon("data:image/svg+xml;base64,aWNvbg==")).toBe(true);
    expect(isImageProjectIcon(DEFAULT_PROJECT_ICON)).toBe(false);
  });
});
