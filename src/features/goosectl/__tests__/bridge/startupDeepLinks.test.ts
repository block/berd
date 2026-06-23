import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installStartupSessionDeepLinkHandler,
  openStartupSessionDeepLinkUrls,
  parseStartupSessionDeepLink,
} from "@/features/goosectl/bridge/startupDeepLinks";

const mocks = vi.hoisted(() => ({
  dispatchCommand: vi.fn(),
  getCurrent: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: mocks.getCurrent,
}));

vi.mock("@/features/goosectl/commands/registry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/goosectl/commands/registry")
    >();
  return {
    ...actual,
    dispatchCommand: mocks.dispatchCommand,
  };
});

function installTauriInternals(): void {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
}

function clearTauriInternals(): void {
  delete (window as typeof window & { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
}

describe("startup session deep links", () => {
  beforeEach(() => {
    clearTauriInternals();
    mocks.dispatchCommand.mockReset();
    mocks.dispatchCommand.mockResolvedValue({ ok: true });
    mocks.getCurrent.mockReset();
    mocks.getCurrent.mockResolvedValue(null);
  });

  afterEach(() => {
    clearTauriInternals();
    vi.restoreAllMocks();
  });

  it("parses session host links", () => {
    expect(
      parseStartupSessionDeepLink("goose-internal://session/abc-123"),
    ).toBe("abc-123");
  });

  it("parses session path links", () => {
    expect(
      parseStartupSessionDeepLink("goose-internal:///session/abc-123"),
    ).toBe("abc-123");
  });

  it("percent-decodes session IDs", () => {
    expect(
      parseStartupSessionDeepLink(
        "goose-internal://session/id%2Fwith%20spaces",
      ),
    ).toBe("id/with spaces");
  });

  it("ignores links outside the session route", () => {
    expect(
      parseStartupSessionDeepLink("goose-internal://connect-return"),
    ).toBeNull();
    expect(
      parseStartupSessionDeepLink("https://example.com/session/abc"),
    ).toBeNull();
    expect(parseStartupSessionDeepLink("goose-internal://session/")).toBeNull();
    expect(
      parseStartupSessionDeepLink("goose-internal:///session/"),
    ).toBeNull();
    expect(
      parseStartupSessionDeepLink("goose-internal://session/a/b"),
    ).toBeNull();
    expect(
      parseStartupSessionDeepLink("goose-internal://session/abc/"),
    ).toBeNull();
    expect(
      parseStartupSessionDeepLink("goose-internal://session/a//b"),
    ).toBeNull();
    expect(
      parseStartupSessionDeepLink("goose-internal://session/%FF"),
    ).toBeNull();
  });

  it("opens the first session link in a startup batch", async () => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      openStartupSessionDeepLinkUrls(
        [
          "goose-internal://connect-return",
          "goose-internal://session/session-1",
          "goose-internal://session/session-2",
        ],
        dispatch,
      ),
    ).resolves.toBe(true);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(
      "sessions",
      { action: "open", session_id: "session-1" },
      {},
    );
  });

  it("returns false when a startup batch has no session links", async () => {
    const dispatch = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      openStartupSessionDeepLinkUrls(
        ["goose-internal://connect-return"],
        dispatch,
      ),
    ).resolves.toBe(false);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not read startup links outside the Tauri webview", () => {
    const cleanup = installStartupSessionDeepLinkHandler();

    cleanup();

    expect(mocks.getCurrent).not.toHaveBeenCalled();
    expect(mocks.dispatchCommand).not.toHaveBeenCalled();
  });

  it("opens a startup session link after the bridge mounts", async () => {
    vi.resetModules();
    const { installStartupSessionDeepLinkHandler: installFreshHandler } =
      await import("@/features/goosectl/bridge/startupDeepLinks");
    installTauriInternals();
    mocks.getCurrent.mockResolvedValue([
      "goose-internal://session/startup-session",
    ]);

    const cleanup = installFreshHandler();

    await waitFor(() => {
      expect(mocks.dispatchCommand).toHaveBeenCalledWith(
        "sessions",
        { action: "open", session_id: "startup-session" },
        {},
      );
    });

    cleanup();
  });

  it("does not reopen the same startup batch across installs", async () => {
    vi.resetModules();
    const { installStartupSessionDeepLinkHandler: installFreshHandler } =
      await import("@/features/goosectl/bridge/startupDeepLinks");
    installTauriInternals();
    mocks.getCurrent.mockResolvedValue([
      "goose-internal://session/startup-session",
    ]);

    installFreshHandler();
    await waitFor(() => {
      expect(mocks.dispatchCommand).toHaveBeenCalledTimes(1);
    });

    installFreshHandler();
    await Promise.resolve();

    expect(mocks.getCurrent).toHaveBeenCalledTimes(2);
    expect(mocks.dispatchCommand).toHaveBeenCalledTimes(1);
  });

  it("does not open startup links after cleanup", async () => {
    vi.resetModules();
    const { installStartupSessionDeepLinkHandler: installFreshHandler } =
      await import("@/features/goosectl/bridge/startupDeepLinks");
    installTauriInternals();
    let resolveCurrent: (urls: string[]) => void = () => {};
    mocks.getCurrent.mockReturnValue(
      new Promise<string[]>((resolve) => {
        resolveCurrent = resolve;
      }),
    );

    const cleanup = installFreshHandler();
    cleanup();
    resolveCurrent(["goose-internal://session/startup-session"]);
    await Promise.resolve();

    expect(mocks.dispatchCommand).not.toHaveBeenCalled();
  });

  it("logs startup open failures without marking the batch handled", async () => {
    vi.resetModules();
    const { installStartupSessionDeepLinkHandler: installFreshHandler } =
      await import("@/features/goosectl/bridge/startupDeepLinks");
    installTauriInternals();
    mocks.getCurrent.mockResolvedValue([
      "goose-internal://session/missing-session",
    ]);
    mocks.dispatchCommand
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce({ ok: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    installFreshHandler();
    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        "Failed to open startup session deep link",
        expect.any(Error),
      );
    });

    installFreshHandler();
    await waitFor(() => {
      expect(mocks.dispatchCommand).toHaveBeenCalledTimes(2);
    });

    expect(mocks.dispatchCommand).toHaveBeenNthCalledWith(
      2,
      "sessions",
      { action: "open", session_id: "missing-session" },
      {},
    );
  });
});
