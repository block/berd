import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHomeDir: vi.fn(),
  pathExists: vi.fn(),
  readTextFile: vi.fn(),
}));

vi.mock("@/shared/api/system", () => ({
  getHomeDir: (...args: unknown[]) => mocks.getHomeDir(...args),
  pathExists: (...args: unknown[]) => mocks.pathExists(...args),
  readTextFile: (...args: unknown[]) => mocks.readTextFile(...args),
}));

import {
  buildAgentsFilePreamble,
  getAgentsFilePreamble,
} from "../agentsFilePreamble";
import { ME_PUBLISH_BEGIN, ME_PUBLISH_END } from "../mePublish";

const DISPLAY_PATH = "~/.agents/AGENTS.md";

describe("buildAgentsFilePreamble", () => {
  it("frames the user's own content with the file path", () => {
    const preamble = buildAgentsFilePreamble(
      "# My rules\n\n- Always use pnpm.",
      DISPLAY_PATH,
    );

    expect(preamble).toContain("[The user's agents file]");
    expect(preamble).toContain(DISPLAY_PATH);
    expect(preamble).toContain("- Always use pnpm.");
    expect(preamble).toContain("What the user says right now beats");
  });

  it("strips our published block so the me file never arrives twice", () => {
    const contents = [
      "# My rules",
      "",
      "- Always use pnpm.",
      "",
      ME_PUBLISH_BEGIN,
      "published me.md content",
      ME_PUBLISH_END,
    ].join("\n");

    const preamble = buildAgentsFilePreamble(contents, DISPLAY_PATH);

    expect(preamble).toContain("- Always use pnpm.");
    expect(preamble).not.toContain("published me.md content");
    expect(preamble).not.toContain(ME_PUBLISH_BEGIN);
  });

  it("returns null when the file is only our published block", () => {
    const contents = [
      ME_PUBLISH_BEGIN,
      "published me.md content",
      ME_PUBLISH_END,
    ].join("\n");

    expect(buildAgentsFilePreamble(contents, DISPLAY_PATH)).toBeNull();
  });

  it("returns null for empty contents", () => {
    expect(buildAgentsFilePreamble("", DISPLAY_PATH)).toBeNull();
    expect(buildAgentsFilePreamble("  \n\n ", DISPLAY_PATH)).toBeNull();
  });

  it("truncates oversized contents and says so", () => {
    const big = `- rule\n${"x".repeat(20_000)}`;

    const preamble = buildAgentsFilePreamble(big, DISPLAY_PATH);

    expect(preamble).toContain("agents file truncated for length");
  });
});

describe("getAgentsFilePreamble", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.__TAURI_INTERNALS__ = {};
    mocks.getHomeDir.mockResolvedValue("/home/u");
  });

  it("returns the framed file when present", async () => {
    mocks.pathExists.mockResolvedValue(true);
    mocks.readTextFile.mockResolvedValue({
      contents: "- Always use pnpm.",
    });

    const preamble = await getAgentsFilePreamble();

    expect(preamble).toContain("- Always use pnpm.");
    expect(mocks.pathExists).toHaveBeenCalledWith("/home/u/.agents/AGENTS.md");
  });

  it("returns null when the file is missing", async () => {
    mocks.pathExists.mockResolvedValue(false);

    await expect(getAgentsFilePreamble()).resolves.toBeNull();
    expect(mocks.readTextFile).not.toHaveBeenCalled();
  });

  it("returns null instead of throwing when the read fails", async () => {
    mocks.pathExists.mockResolvedValue(true);
    mocks.readTextFile.mockRejectedValue(new Error("binary file"));

    await expect(getAgentsFilePreamble()).resolves.toBeNull();
  });

  it("returns null outside a Tauri window", async () => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

    await expect(getAgentsFilePreamble()).resolves.toBeNull();
    expect(mocks.getHomeDir).not.toHaveBeenCalled();
  });
});
