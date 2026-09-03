import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeMemoryAgentsProjection: vi.fn(),
  listTopics: vi.fn(),
  isMemoryEnabledByPolicy: vi.fn(),
  isMemoryContentApproved: vi.fn(),
}));

vi.mock("@/shared/api/system", () => ({
  writeMemoryAgentsProjection: (...args: unknown[]) =>
    mocks.writeMemoryAgentsProjection(...args),
  isMemoryContentApproved: (...args: unknown[]) =>
    mocks.isMemoryContentApproved(...args),
}));

vi.mock("../meTopics", () => ({
  listTopics: (...args: unknown[]) => mocks.listTopics(...args),
}));

vi.mock("../memoryPolicyFile", () => ({
  isMemoryEnabledByPolicy: (...args: unknown[]) =>
    mocks.isMemoryEnabledByPolicy(...args),
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
    mocks.listTopics.mockResolvedValue([]);
    mocks.isMemoryEnabledByPolicy.mockResolvedValue(true);
    mocks.isMemoryContentApproved.mockResolvedValue(true);
  });

  it("publishes the managed block through the scoped backend command", async () => {
    await publishMeFile(FILE_WITH_ENTRIES);
    expect(mocks.writeMemoryAgentsProjection).toHaveBeenCalledTimes(1);
    const block = mocks.writeMemoryAgentsProjection.mock.calls[0][0];
    expect(block).toContain(ME_PUBLISH_BEGIN);
    expect(block).toContain("- Keep answers brief.");
  });

  it("removes the projection when memory is off", async () => {
    mocks.isMemoryEnabledByPolicy.mockResolvedValue(false);
    await publishMeFile(FILE_WITH_ENTRIES);
    expect(mocks.writeMemoryAgentsProjection).toHaveBeenCalledWith(null);
  });

  it("publishes topic routing hints", async () => {
    mocks.listTopics.mockResolvedValue([
      {
        fileName: "travel.md",
        label: "Travel",
        description: "Travel preferences",
      },
    ]);
    await publishMeFile(FILE_WITH_ENTRIES);
    expect(mocks.writeMemoryAgentsProjection.mock.calls[0][0]).toContain(
      "Travel (travel.md)",
    );
  });

  it("never throws when projection fails", async () => {
    mocks.writeMemoryAgentsProjection.mockRejectedValue(new Error("read only"));
    await expect(publishMeFile(FILE_WITH_ENTRIES)).resolves.toBeUndefined();
  });
});
