import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHomeDir: vi.fn(),
  pathExists: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  listTopics: vi.fn(),
  isMemoryEnabled: vi.fn(),
}));

vi.mock("@/shared/api/system", () => ({
  getHomeDir: (...args: unknown[]) => mocks.getHomeDir(...args),
  pathExists: (...args: unknown[]) => mocks.pathExists(...args),
  readTextFile: (...args: unknown[]) => mocks.readTextFile(...args),
  writeTextFile: (...args: unknown[]) => mocks.writeTextFile(...args),
}));

vi.mock("../meTopics", () => ({
  listTopics: (...args: unknown[]) => mocks.listTopics(...args),
}));

vi.mock("../memoryPrefs", () => ({
  isMemoryEnabled: (...args: unknown[]) => mocks.isMemoryEnabled(...args),
}));

import {
  ME_PUBLISH_BEGIN,
  ME_PUBLISH_END,
  publishMeFile,
  renderMePublishBlock,
  spliceManagedBlock,
} from "../mePublish";

const FILE_WITH_ENTRIES = [
  "# Me",
  "",
  "*This file is yours. Agents never see this note.*",
  "",
  "## Preferences",
  "",
  "- Keep answers brief.",
].join("\n");

describe("renderMePublishBlock", () => {
  it("wraps the agent-facing rendering in managed-block markers", () => {
    const block = renderMePublishBlock(FILE_WITH_ENTRIES);

    expect(block).not.toBeNull();
    expect(block).toContain(ME_PUBLISH_BEGIN);
    expect(block).toContain(ME_PUBLISH_END);
    expect(block).toContain("- Keep answers brief.");
    // Notes to the user are stripped from what gets published.
    expect(block).not.toContain("Agents never see this note");
    // Reader rules travel with the block so foreign tools use it well.
    expect(block).toContain("What the user says in the moment always beats");
    expect(block).toContain("Do not edit this block");
  });

  it("returns null when there is nothing agent-facing", () => {
    expect(renderMePublishBlock("")).toBeNull();
    expect(renderMePublishBlock("*Only a note to the user.*")).toBeNull();
  });
});

describe("spliceManagedBlock", () => {
  const block = `${ME_PUBLISH_BEGIN}\ncontent v2\n${ME_PUBLISH_END}`;

  it("appends to existing content without touching it", () => {
    const existing = "# Other tool's stuff\n\ntheir content\n";
    const next = spliceManagedBlock(existing, block);

    expect(next).toContain("# Other tool's stuff");
    expect(next).toContain("their content");
    expect(next?.indexOf("their content")).toBeLessThan(
      next?.indexOf(ME_PUBLISH_BEGIN) ?? -1,
    );
  });

  it("replaces only our block, preserving surrounding content", () => {
    const existing = [
      "before ours",
      "",
      ME_PUBLISH_BEGIN,
      "content v1",
      ME_PUBLISH_END,
      "",
      "after ours",
      "<!-- BEGIN other-tool managed block -->keep me<!-- END other-tool managed block -->",
    ].join("\n");

    const next = spliceManagedBlock(existing, block);

    expect(next).toContain("before ours");
    expect(next).toContain("after ours");
    expect(next).toContain("content v2");
    expect(next).not.toContain("content v1");
    expect(next).toContain("keep me");
  });

  it("returns null when nothing would change", () => {
    const existing = `intro\n\n${block}\n`;
    expect(spliceManagedBlock(existing, block)).toBeNull();
  });

  it("starts a fresh file with just the block", () => {
    expect(spliceManagedBlock("", block)).toBe(`${block}\n`);
  });

  it("removes our block when there is nothing to publish", () => {
    const existing = `theirs\n\n${ME_PUBLISH_BEGIN}\nold\n${ME_PUBLISH_END}\n`;
    const next = spliceManagedBlock(existing, null);

    expect(next).not.toBeNull();
    expect(next).toContain("theirs");
    expect(next).not.toContain(ME_PUBLISH_BEGIN);
    expect(next).not.toContain("old");
  });

  it("repairs an orphaned begin marker instead of duplicating the block", () => {
    // A user hand-deleted the END marker; half a stale block remains.
    const damaged = [
      "# My agents file",
      "",
      ME_PUBLISH_BEGIN,
      "stale half-block content",
    ].join("\n");
    const freshBlock = [ME_PUBLISH_BEGIN, "fresh content", ME_PUBLISH_END].join(
      "\n",
    );

    const next = spliceManagedBlock(damaged, freshBlock);

    expect(next).toContain("# My agents file");
    expect(next).toContain("fresh content");
    // Exactly one begin marker afterward — never two.
    expect(next?.split(ME_PUBLISH_BEGIN)).toHaveLength(2);
    // The stale half-block body survives as plain text (we only own our
    // markers), but no marker duplication is possible.
    expect(next?.split(ME_PUBLISH_END)).toHaveLength(2);
  });

  it("removes orphaned markers on removal instead of leaving them behind", () => {
    const damaged = ["# Keep me", ME_PUBLISH_END, "", "and keep me too"].join(
      "\n",
    );

    const next = spliceManagedBlock(damaged, null);

    expect(next).toContain("# Keep me");
    expect(next).toContain("and keep me too");
    expect(next).not.toContain(ME_PUBLISH_END);
  });

  it("is a no-op removal when we were never there", () => {
    expect(spliceManagedBlock("just theirs\n", null)).toBeNull();
  });
});

describe("publishMeFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getHomeDir.mockResolvedValue("/home/u");
    mocks.listTopics.mockResolvedValue([]);
    mocks.isMemoryEnabled.mockReturnValue(true);
  });

  it("removes the managed block from existing targets when memory is off", async () => {
    mocks.isMemoryEnabled.mockReturnValue(false);
    mocks.pathExists.mockResolvedValue(true);
    mocks.readTextFile.mockResolvedValue({
      contents: [
        "# My agents file",
        "",
        ME_PUBLISH_BEGIN,
        "old published content",
        ME_PUBLISH_END,
      ].join("\n"),
    });

    await publishMeFile(FILE_WITH_ENTRIES);

    // Both targets get rewritten without our block; other content survives.
    expect(mocks.writeTextFile).toHaveBeenCalledTimes(2);
    for (const call of mocks.writeTextFile.mock.calls) {
      expect(call[1]).toContain("# My agents file");
      expect(call[1]).not.toContain(ME_PUBLISH_BEGIN);
      expect(call[1]).not.toContain("old published content");
    }
  });

  it("does not create target files when memory is off", async () => {
    mocks.isMemoryEnabled.mockReturnValue(false);
    mocks.pathExists.mockResolvedValue(false);

    await publishMeFile(FILE_WITH_ENTRIES);

    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it("publishes nothing when no agents files exist", async () => {
    mocks.pathExists.mockResolvedValue(false);

    await publishMeFile(FILE_WITH_ENTRIES);

    // Publication joins a convention the user already has; it never starts
    // one. No agents file anywhere means memory stays scoped to ~/.me/.
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it("publishes into an agents file the user already has", async () => {
    mocks.pathExists.mockImplementation((path: unknown) =>
      Promise.resolve(path === "/home/u/.agents/AGENTS.md"),
    );
    mocks.readTextFile.mockResolvedValue({ contents: "# My rules\n" });

    await publishMeFile(FILE_WITH_ENTRIES);

    expect(mocks.writeTextFile).toHaveBeenCalledTimes(1);
    const [path, contents] = mocks.writeTextFile.mock.calls[0];
    expect(path).toBe("/home/u/.agents/AGENTS.md");
    expect(contents).toContain("# My rules");
    expect(contents).toContain(ME_PUBLISH_BEGIN);
    expect(contents).toContain("- Keep answers brief.");
  });

  it("writes the goose target when it already exists", async () => {
    // An existing goose AGENTS.md is proof of a real goose CLI user.
    mocks.pathExists.mockResolvedValue(true);
    mocks.readTextFile.mockResolvedValue({ contents: "" });

    await publishMeFile(FILE_WITH_ENTRIES);

    const paths = mocks.writeTextFile.mock.calls.map((call) => call[0]);
    expect(paths).toContain("/home/u/.agents/AGENTS.md");
    expect(paths).toContain("/home/u/.config/goose/AGENTS.md");
  });

  it("preserves existing target contents", async () => {
    mocks.pathExists.mockResolvedValue(true);
    mocks.readTextFile.mockResolvedValue({
      contents: "existing tool config\n",
    });

    await publishMeFile(FILE_WITH_ENTRIES);

    for (const call of mocks.writeTextFile.mock.calls) {
      expect(call[1]).toContain("existing tool config");
    }
  });

  it("skips writes when the target is already current", async () => {
    const block = renderMePublishBlock(FILE_WITH_ENTRIES);
    mocks.pathExists.mockResolvedValue(true);
    mocks.readTextFile.mockResolvedValue({ contents: `${block}\n` });

    await publishMeFile(FILE_WITH_ENTRIES);

    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it("does not create targets just to publish nothing", async () => {
    mocks.pathExists.mockResolvedValue(false);

    await publishMeFile("*nothing but notes*");

    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it("one failing target does not block the others", async () => {
    mocks.pathExists.mockResolvedValue(true);
    mocks.readTextFile
      .mockRejectedValueOnce(new Error("binary file"))
      .mockResolvedValueOnce({ contents: "" });

    await publishMeFile(FILE_WITH_ENTRIES);

    expect(mocks.writeTextFile).toHaveBeenCalledTimes(1);
  });

  it("never throws, even when everything fails", async () => {
    mocks.getHomeDir.mockRejectedValue(new Error("no home"));

    await expect(publishMeFile(FILE_WITH_ENTRIES)).resolves.toBeUndefined();
  });
});
