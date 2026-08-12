import { beforeEach, describe, expect, it, vi } from "vitest";

import cliSurface from "../../../../src-tauri/crates/berdctl/cli-surface.json";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

import {
  BERDCTL_PREAMBLE,
  getBerdctlPreamble,
  __resetBerdctlPreambleForTests,
} from "@/features/berdctl/appPreamble";

describe("getBerdctlPreamble", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetBerdctlPreambleForTests();
    window.__TAURI_INTERNALS__ = {};
  });

  it("returns the preamble when the plugin reports the broker running", async () => {
    mocks.invoke.mockResolvedValue({ running: true });

    await expect(getBerdctlPreamble()).resolves.toBe(BERDCTL_PREAMBLE);
    expect(mocks.invoke).toHaveBeenCalledWith("plugin:berdctl|status");
  });

  it("returns null when the plugin reports the broker stopped", async () => {
    mocks.invoke.mockResolvedValue({ running: false });

    await expect(getBerdctlPreamble()).resolves.toBeNull();
  });

  it("asks the plugin per call so availability changes are picked up", async () => {
    // The discriminating case for the popped-out-window bug: availability is
    // an app-global fact owned by the plugin, so it must be queried, not
    // cached renderer-locally where only one window would ever update it.
    mocks.invoke.mockResolvedValueOnce({ running: false });
    await expect(getBerdctlPreamble()).resolves.toBeNull();

    mocks.invoke.mockResolvedValueOnce({ running: true });
    await expect(getBerdctlPreamble()).resolves.toBe(BERDCTL_PREAMBLE);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("returns null outside the Tauri webview without invoking", async () => {
    window.__TAURI_INTERNALS__ = undefined;

    await expect(getBerdctlPreamble()).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("goes inert after a plugin-unavailable rejection (no repeat IPC)", async () => {
    mocks.invoke.mockRejectedValue(
      new Error(
        "berdctl.status not allowed. Permissions associated with this command: berdctl:default",
      ),
    );

    await expect(getBerdctlPreamble()).resolves.toBeNull();
    await expect(getBerdctlPreamble()).resolves.toBeNull();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("returns null on a transient status failure but retries next call", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.invoke.mockRejectedValueOnce(new Error("ipc glitch"));
    await expect(getBerdctlPreamble()).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalled();

    mocks.invoke.mockResolvedValueOnce({ running: true });
    await expect(getBerdctlPreamble()).resolves.toBe(BERDCTL_PREAMBLE);
  });
});

describe("BERDCTL_PREAMBLE content", () => {
  it("teaches the CLI name and --help discovery", () => {
    expect(BERDCTL_PREAMBLE).toContain("`berdctl`");
    expect(BERDCTL_PREAMBLE).toContain("--help");
  });

  it("routes switching to replace, selection/retention to set-cwd, and additions to attach", () => {
    expect(BERDCTL_PREAMBLE).toContain(
      "switch or move this chat to a new worktree/folder",
    );
    expect(BERDCTL_PREAMBLE).toContain("use `folder replace`");
    expect(BERDCTL_PREAMBLE).toContain(
      "Use `folder set-cwd` to select an already attached folder",
    );
    expect(BERDCTL_PREAMBLE).toContain(
      "Use `folder attach` only to add context without changing cwd",
    );
    expect(BERDCTL_PREAMBLE).not.toContain("set-worktree");
  });

  /**
   * Drift protection: every noun and verb the preamble names must exist in
   * the generated CLI surface. The listing is intentionally non-exhaustive
   * (niche verbs are omitted to save tokens), so new verbs never fail this
   * test — only renames and removals do.
   */
  it("only names nouns and verbs that exist in cli-surface.json", () => {
    const nouns = cliSurface.nouns as Record<
      string,
      { verbs: Record<string, unknown> }
    >;
    const listedLines = BERDCTL_PREAMBLE.split("\n").filter((line) =>
      line.startsWith("- "),
    );
    expect(listedLines.length).toBeGreaterThan(0);

    for (const line of listedLines) {
      const match = line.match(/^- (\S+): (.+)$/);
      expect(match, `unparseable preamble line: ${line}`).not.toBeNull();
      const [, noun, verbList] = match as RegExpMatchArray;
      expect(
        nouns[noun],
        `preamble names unknown noun "${noun}"`,
      ).toBeDefined();
      for (const verb of verbList.split(", ")) {
        expect(
          nouns[noun].verbs[verb],
          `preamble names unknown verb "${noun} ${verb}"`,
        ).toBeDefined();
      }
    }
  });
});
