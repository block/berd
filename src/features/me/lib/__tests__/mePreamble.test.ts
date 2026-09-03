import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadMeFile: vi.fn(),
  listTopics: vi.fn(),
  isMemoryEnabledByPolicy: vi.fn(),
  isMemoryContentApproved: vi.fn(),
}));

vi.mock("../meFile", () => ({
  loadMeFile: (...args: unknown[]) => mocks.loadMeFile(...args),
}));

vi.mock("../meTopics", () => ({
  listTopics: (...args: unknown[]) => mocks.listTopics(...args),
}));

vi.mock("@/shared/api/system", () => ({
  isMemoryContentApproved: (...args: unknown[]) =>
    mocks.isMemoryContentApproved(...args),
}));

vi.mock("../memoryPolicyFile", () => ({
  isMemoryEnabledByPolicy: (...args: unknown[]) =>
    mocks.isMemoryEnabledByPolicy(...args),
}));

import {
  buildTopicIndexBlock,
  ME_PREAMBLE_MAX_CONTENT_CHARS,
  buildMePreamble,
  getMePreamble,
} from "../mePreamble";

const DISPLAY_PATH = "~/.me/me.md";

describe("buildMePreamble", () => {
  it("frames the file contents with reader rules and path", () => {
    const preamble = buildMePreamble(
      "# Me\n\n## Preferences\n\n- Keep answers brief.",
      DISPLAY_PATH,
    );

    expect(preamble).toContain("[The user's file]");
    expect(preamble).toContain(DISPLAY_PATH);
    expect(preamble).toContain("- Keep answers brief.");
    expect(preamble).toContain("--- end of file ---");
    // The reader rules that must reach every agent.
    expect(preamble).toContain("What the user says right now always beats");
    expect(preamble).toContain("Never add to, change, or delete anything");
    expect(preamble).toContain("topic files under `topics/`");
  });

  it("returns null for empty or whitespace-only contents", () => {
    expect(buildMePreamble("", DISPLAY_PATH)).toBeNull();
    expect(buildMePreamble("   \n\n  ", DISPLAY_PATH)).toBeNull();
  });

  it("strips italic notes-to-user but keeps entries", () => {
    const preamble = buildMePreamble(
      [
        "# Me",
        "",
        "*This file is yours. Agents never see this note.*",
        "",
        "## Preferences",
        "",
        "*Tools and defaults you want agents to respect.*",
        "",
        "- Keep answers brief.",
        "- **Always** ask before deleting.",
      ].join("\n"),
      DISPLAY_PATH,
    );

    expect(preamble).not.toContain("Agents never see this note");
    expect(preamble).not.toContain("defaults you want agents to respect");
    expect(preamble).toContain("## Preferences");
    expect(preamble).toContain("- Keep answers brief.");
    expect(preamble).toContain("**Always** ask before deleting.");
  });

  it("returns null when the file is nothing but notes-to-user", () => {
    expect(
      buildMePreamble(
        "*This file is yours.*\n\n*Replace these hints with entries.*",
        DISPLAY_PATH,
      ),
    ).toBeNull();
  });

  it("truncates oversized contents and says so", () => {
    const contents = "x".repeat(ME_PREAMBLE_MAX_CONTENT_CHARS + 500);

    const preamble = buildMePreamble(contents, DISPLAY_PATH);

    expect(preamble).not.toBeNull();
    expect(preamble).toContain("file truncated for length");
    // The injected content itself is capped (allow for the frame text).
    expect((preamble as string).length).toBeLessThan(
      ME_PREAMBLE_MAX_CONTENT_CHARS + 2_000,
    );
  });

  it("does not truncate contents at or under the cap", () => {
    const contents = "x".repeat(ME_PREAMBLE_MAX_CONTENT_CHARS);

    expect(buildMePreamble(contents, DISPLAY_PATH)).not.toContain(
      "file truncated for length",
    );
  });
});

describe("buildTopicIndexBlock", () => {
  it("renders one routing line per topic", () => {
    const block = buildTopicIndexBlock([
      {
        fileName: "style.md",
        label: "Style",
        description: "Brands and fits.",
      },
      { fileName: "work.md", label: "Work", description: null },
    ]);

    expect(block).toContain("read one only when that part of their life");
    expect(block).toContain("- Style (style.md): Brands and fits.");
    expect(block).toContain("- Work (work.md)");
    expect(block).not.toContain("work.md):");
  });

  it("returns the empty-state nudge when there are no topics", () => {
    const block = buildTopicIndexBlock([]);
    // Instruction first, dead-end fact second — models latch onto a
    // leading "no topics" and skip the rest.
    expect(block?.startsWith("[Offer to remember")).toBe(true);
    expect(block).toContain("no memory topics yet");
    expect(block).toContain("propose_memory");
  });
});

describe("getMePreamble", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listTopics.mockResolvedValue([]);
    mocks.isMemoryEnabledByPolicy.mockResolvedValue(true);
    mocks.isMemoryContentApproved.mockResolvedValue(true);
    window.__TAURI_INTERNALS__ = {};
  });

  it("returns the memory-off notice instead of the file when memory is off", async () => {
    mocks.isMemoryEnabledByPolicy.mockResolvedValue(false);

    const preamble = await getMePreamble();

    expect(preamble).toContain("[Memory is off]");
    expect(preamble).toContain("Don't offer to remember things");
    // The file is never read — off means off.
    expect(mocks.loadMeFile).not.toHaveBeenCalled();
    expect(mocks.listTopics).not.toHaveBeenCalled();
  });

  it("returns the framed file when present", async () => {
    mocks.loadMeFile.mockResolvedValue({
      status: "present",
      path: "/Users/someone/.me/me.md",
      displayPath: DISPLAY_PATH,
      contents: "## Standing rules\n\n- Draft before sending.",
    });

    const preamble = await getMePreamble();

    expect(preamble).toContain("- Draft before sending.");
    expect(preamble).toContain(DISPLAY_PATH);
  });

  it("appends the derived topic index after the file", async () => {
    mocks.loadMeFile.mockResolvedValue({
      status: "present",
      path: "/Users/someone/.me/me.md",
      displayPath: DISPLAY_PATH,
      contents: "## Preferences\n\n- Keep answers brief.",
    });
    mocks.listTopics.mockResolvedValue([
      {
        path: "/Users/someone/.me/style.md",
        fileName: "style.md",
        label: "Style",
        description: "Brands and fits.",
        contents: "# Style",
      },
    ]);

    const preamble = await getMePreamble();

    expect(preamble).toContain("- Style (style.md): Brands and fits.");
    // Index only — topic contents are never injected.
    const endOfFile = preamble?.indexOf("--- end of file ---") ?? -1;
    const indexAt = preamble?.indexOf("Topic files under ~/.me/topics/") ?? -1;
    expect(indexAt).toBeGreaterThan(endOfFile);
  });

  it("ships the preamble without the index when topic listing fails", async () => {
    mocks.loadMeFile.mockResolvedValue({
      status: "present",
      path: "/Users/someone/.me/me.md",
      displayPath: DISPLAY_PATH,
      contents: "## Preferences\n\n- Keep answers brief.",
    });
    mocks.listTopics.mockRejectedValue(new Error("folder unreadable"));

    const preamble = await getMePreamble();

    expect(preamble).toContain("- Keep answers brief.");
    expect(preamble).not.toContain("Topic files under ~/.me/topics/ —");
  });

  it("returns null when the file is missing", async () => {
    mocks.loadMeFile.mockResolvedValue({
      status: "missing",
      path: "/Users/someone/.me/me.md",
      displayPath: DISPLAY_PATH,
    });

    await expect(getMePreamble()).resolves.toBeNull();
  });

  it("returns null instead of throwing when the read fails", async () => {
    mocks.loadMeFile.mockRejectedValue(new Error("disk unhappy"));

    await expect(getMePreamble()).resolves.toBeNull();
  });

  it("returns null outside a Tauri window", async () => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

    await expect(getMePreamble()).resolves.toBeNull();
    expect(mocks.loadMeFile).not.toHaveBeenCalled();
  });
});
