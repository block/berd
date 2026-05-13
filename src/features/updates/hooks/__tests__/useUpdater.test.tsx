import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DownloadEvent,
  Update as TauriUpdate,
} from "@tauri-apps/plugin-updater";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch as tauriRelaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";
import { I18nProvider } from "@/shared/i18n";
import { UpdaterProvider, useUpdaterContext } from "../useUpdater";

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(),
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

    expect(check).toHaveBeenCalledWith({ timeout: 15_000 });
    expect(result.current.status).toBe("up-to-date");
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
    expect(toast.success).toHaveBeenCalled();
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
    expect(result.current.errorMessage).toBe("download failed");
    expect(toast.error).toHaveBeenCalled();
  });

  it("records relaunch failures as errors", async () => {
    enableUpdaterRuntime();
    vi.mocked(check).mockResolvedValue(createUpdate());
    vi.mocked(tauriRelaunch).mockRejectedValue(new Error("restart failed"));

    const { result } = renderHook(() => useUpdaterContext(), { wrapper });

    await act(async () => {
      await result.current.checkForUpdate();
    });
    await act(async () => {
      await result.current.relaunch();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe("restart failed");
    expect(toast.error).toHaveBeenCalled();
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
