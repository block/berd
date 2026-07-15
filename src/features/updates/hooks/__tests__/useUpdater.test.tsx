import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DownloadEvent,
  Update as TauriUpdate,
} from "@tauri-apps/plugin-updater";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch as tauriRelaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { probeKgooseConnectivity } from "@/shared/api/connectivity";
import { I18nProvider } from "@/shared/i18n";
import { UpdaterProvider, useUpdaterContext } from "../useUpdater";

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/shared/api/connectivity", () => ({
  probeKgooseConnectivity: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

function enableUpdaterRuntime() {
  vi.stubEnv("VITE_UPDATER_ENABLED", "true");
  vi.stubEnv("DEV", false);
  vi.stubGlobal("__TAURI_INTERNALS__", {});
}

function wrapper({
  children,
  runStartupCheck = false,
}: {
  children: ReactNode;
  runStartupCheck?: boolean;
}) {
  return (
    <I18nProvider>
      <UpdaterProvider runStartupCheck={runStartupCheck}>
        {children}
      </UpdaterProvider>
    </I18nProvider>
  );
}

function createUpdate(
  downloadAndInstall = vi.fn().mockResolvedValue(undefined),
) {
  return {
    version: "9.9.9",
    downloadAndInstall,
  } as unknown as TauriUpdate;
}

describe("UpdaterProvider", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not call check when updater runtime is unavailable", async () => {
    vi.stubEnv("VITE_UPDATER_ENABLED", "false");
    vi.stubEnv("DEV", false);
    vi.stubGlobal("__TAURI_INTERNALS__", {});

    const { result } = renderHook(() => useUpdaterContext(), {
      wrapper: ({ children }) => wrapper({ children, runStartupCheck: true }),
    });

    await Promise.resolve();

    // A custom build bakes in VITE_UPDATER_ENABLED=false, so the updater is
    // inert: enabled is false, status stays "unavailable", and no startup /
    // interval check is scheduled.
    expect(result.current.enabled).toBe(false);
    expect(result.current.status).toBe("unavailable");
    expect(check).not.toHaveBeenCalled();
  });

  it("sets manual checks with no update to up-to-date", async () => {
    enableUpdaterRuntime();
    vi.mocked(check).mockResolvedValue(null);

    const { result } = renderHook(() => useUpdaterContext(), { wrapper });

    await act(async () => {
      await result.current.checkForUpdate();
    });

    expect(check).toHaveBeenCalledWith({ timeout: 10_000 });
    expect(result.current.status).toBe("up-to-date");
  });

  it("shows WARP guidance when a check failure looks like a WARP problem", async () => {
    enableUpdaterRuntime();
    vi.mocked(probeKgooseConnectivity).mockResolvedValue({
      likelyWarpFailure: true,
      status: 403,
      kind: "status",
      message: "forbidden",
    });
    vi.mocked(check)
      .mockRejectedValueOnce(
        new Error(
          "error sending request for url (https://global.block-artifacts.com/artifactory/mdx/goose-internal/latest.json)",
        ),
      )
      .mockRejectedValueOnce(new Error("operation timed out"));

    const { result } = renderHook(() => useUpdaterContext(), {
      wrapper,
    });

    await act(async () => {
      await result.current.checkForUpdate();
    });

    const networkMessage =
      "Unable to check for updates. Connect to Cloudflare WARP and try again.";
    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe(networkMessage);
    // WARP guidance is shown, but the raw detail is still captured so a
    // non-network root cause isn't masked behind the heuristic.
    expect(result.current.errorDetail).toContain("global.block-artifacts.com");
    expect(toast.error).toHaveBeenCalledWith(
      "Update failed",
      expect.objectContaining({
        description: networkMessage,
      }),
    );
    expect(toast.error).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        description: expect.stringContaining("global.block-artifacts.com"),
      }),
    );

    vi.mocked(toast.error).mockClear();

    await act(async () => {
      await result.current.checkForUpdate();
    });

    expect(result.current.errorMessage).toBe(networkMessage);
    expect(toast.error).toHaveBeenCalledWith(
      "Update failed",
      expect.objectContaining({
        description: networkMessage,
      }),
    );
  });

  it("shows generic guidance when a check failure is not a WARP problem", async () => {
    enableUpdaterRuntime();
    vi.mocked(probeKgooseConnectivity).mockResolvedValue({
      likelyWarpFailure: false,
      status: 500,
      kind: "status",
      message: "internal server error",
    });
    vi.mocked(check).mockRejectedValue(
      new Error("invalid manifest: unexpected end of JSON input"),
    );

    const { result } = renderHook(() => useUpdaterContext(), { wrapper });

    await act(async () => {
      await result.current.checkForUpdate();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe("Update failed. Try again.");
    expect(result.current.errorDetail).toBe(
      "invalid manifest: unexpected end of JSON input",
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Update failed",
      expect.objectContaining({
        description: "Update failed. Try again.",
      }),
    );
    expect(toast.error).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        description: expect.stringContaining("WARP"),
      }),
    );
    // Toast stays short — the raw detail belongs in the pane, not the toast.
    expect(toast.error).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        description: expect.stringContaining("invalid manifest"),
      }),
    );
  });

  it("downloads and installs an available update before marking it ready", async () => {
    enableUpdaterRuntime();
    let finishDownload: (() => void) | undefined;
    const downloadAndInstall = vi.fn(
      (onEvent?: (event: DownloadEvent) => void) => {
        onEvent?.({ event: "Started", data: { contentLength: 100 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 40 } });
        return new Promise<void>((resolve) => {
          finishDownload = () => {
            onEvent?.({ event: "Finished" });
            resolve();
          };
        });
      },
    );
    vi.mocked(check).mockResolvedValue(createUpdate(downloadAndInstall));

    const { result } = renderHook(() => useUpdaterContext(), { wrapper });
    let checkPromise = Promise.resolve();

    act(() => {
      checkPromise = result.current.checkForUpdate();
    });

    await waitFor(() => {
      expect(result.current.status).toBe("downloading");
      expect(result.current.downloadProgress).toBe(40);
    });

    await act(async () => {
      finishDownload?.();
      await checkPromise;
    });

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("ready");
    expect(result.current.availableVersion).toBe("9.9.9");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("records download failures as errors", async () => {
    enableUpdaterRuntime();
    vi.mocked(check).mockResolvedValue(
      createUpdate(vi.fn().mockRejectedValue(new Error("download failed"))),
    );

    const { result } = renderHook(() => useUpdaterContext(), { wrapper });

    await act(async () => {
      await result.current.checkForUpdate();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe("Update failed. Try again.");
    expect(result.current.errorDetail).toBe("download failed");
    expect(toast.error).toHaveBeenCalled();
  });

  it("records relaunch failures as errors", async () => {
    enableUpdaterRuntime();
    vi.mocked(check).mockResolvedValue(createUpdate());
    vi.mocked(invoke).mockResolvedValue(false);
    vi.mocked(tauriRelaunch).mockRejectedValue(new Error("restart failed"));

    const { result } = renderHook(() => useUpdaterContext(), { wrapper });

    await act(async () => {
      await result.current.checkForUpdate();
    });
    await act(async () => {
      await result.current.relaunch();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe("Update failed. Try again.");
    expect(toast.error).toHaveBeenCalled();
  });

  it("skips the standard restart when the backend relaunches a renamed bundle", async () => {
    enableUpdaterRuntime();
    // The backend renamed a legacy-named bundle (e.g. "Goose 2.app" →
    // "Berd.app"), scheduled its own relaunch, and is exiting.
    vi.mocked(invoke).mockResolvedValue(true);

    const { result } = renderHook(() => useUpdaterContext(), { wrapper });

    await act(async () => {
      await result.current.relaunch();
    });

    expect(invoke).toHaveBeenCalledWith("finalize_update_relaunch");
    expect(tauriRelaunch).not.toHaveBeenCalled();
    expect(result.current.status).not.toBe("error");
  });

  it("falls back to the standard restart when the rename command fails", async () => {
    enableUpdaterRuntime();
    vi.mocked(invoke).mockRejectedValue(new Error("command failed"));
    vi.mocked(tauriRelaunch).mockResolvedValue(undefined);

    const { result } = renderHook(() => useUpdaterContext(), { wrapper });

    await act(async () => {
      await result.current.relaunch();
    });

    expect(tauriRelaunch).toHaveBeenCalledTimes(1);
    expect(result.current.status).not.toBe("error");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does not let background checks interrupt an active update state", async () => {
    enableUpdaterRuntime();
    vi.mocked(check).mockResolvedValue(createUpdate());

    const { result } = renderHook(() => useUpdaterContext(), { wrapper });

    await act(async () => {
      await result.current.checkForUpdate();
    });

    expect(result.current.status).toBe("ready");
    vi.mocked(check).mockClear();

    await act(async () => {
      await result.current.checkForUpdate({ background: true, quiet: true });
    });

    expect(check).not.toHaveBeenCalled();
    expect(result.current.status).toBe("ready");
  });
});
