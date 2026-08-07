import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Update as TauriUpdate } from "@tauri-apps/plugin-updater";
import { relaunch as tauriRelaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { probeKgooseConnectivity } from "@/shared/api/connectivity";
import { I18nProvider } from "@/shared/i18n";
import { UpdaterProvider, useUpdaterContext } from "../useUpdater";

const mockUpdateInstances = vi.hoisted(() => [] as Array<TauriUpdate>);

vi.mock("@tauri-apps/plugin-updater", () => ({
  Update: class MockUpdate {
    rid: number;
    version: string;
    currentVersion: string;
    body?: string;
    rawJson: Record<string, unknown>;
    downloadAndInstall = vi.fn().mockResolvedValue(undefined);

    constructor(metadata: {
      rid: number;
      version: string;
      currentVersion: string;
      body?: string;
      rawJson: Record<string, unknown>;
    }) {
      this.rid = metadata.rid;
      this.version = metadata.version;
      this.currentVersion = metadata.currentVersion;
      this.body = metadata.body;
      this.rawJson = metadata.rawJson;
      mockUpdateInstances.push(this as unknown as TauriUpdate);
    }
  },
}));

vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/shared/api/connectivity", () => ({
  probeKgooseConnectivity: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const compatibility = {
  storeContractVersion: 1,
  writesDataEpoch: 1,
  minReadableDataEpoch: 1,
  maxReadableDataEpoch: 2,
};
const runtime = {
  enabled: true,
  channels: [
    { id: "main", label: "Main" },
    { id: "beta", label: "Beta" },
  ],
  defaultChannelId: "main",
  selectedFeed: "main",
  runningBuild: {
    channelId: "main",
    version: "1.2.3",
    compatibility,
  },
};

function metadata(channelId = "main", version = "9.9.9") {
  return {
    rid: 7,
    currentVersion: "1.2.3",
    version,
    rawJson: { compatibility },
    targetChannelId: channelId,
    targetChannelLabel: channelId === "beta" ? "Beta" : "Main",
  };
}

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

describe("UpdaterProvider", () => {
  beforeEach(() => {
    mockUpdateInstances.length = 0;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "get_release_runtime") return Promise.resolve(runtime);
      return Promise.reject(new Error(`unexpected invoke: ${command}`));
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not invoke the updater when release support is unavailable", async () => {
    vi.stubEnv("VITE_UPDATER_ENABLED", "false");
    vi.stubEnv("DEV", false);
    vi.stubGlobal("__TAURI_INTERNALS__", {});

    const { result } = renderHook(() => useUpdaterContext(), {
      wrapper: ({ children }) => wrapper({ children, runStartupCheck: true }),
    });
    await Promise.resolve();

    expect(result.current.enabled).toBe(false);
    expect(result.current.status).toBe("unavailable");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses the catalog-backed command for an ordinary check", async () => {
    enableUpdaterRuntime();
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "get_release_runtime") return Promise.resolve(runtime);
      if (command === "check_release_update") return Promise.resolve(null);
      return Promise.reject(new Error(`unexpected invoke: ${command}`));
    });

    const { result } = renderHook(() => useUpdaterContext(), { wrapper });
    await waitFor(() => expect(result.current.enabled).toBe(true));
    await act(async () => result.current.checkForUpdate());

    expect(invoke).toHaveBeenCalledWith("check_release_update");
    expect(result.current.status).toBe("up-to-date");
  });

  it("downloads an available same-channel update", async () => {
    enableUpdaterRuntime();
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "get_release_runtime") return Promise.resolve(runtime);
      if (command === "check_release_update")
        return Promise.resolve(metadata());
      if (command === "download_and_install_release")
        return Promise.resolve(runtime);
      return Promise.reject(new Error(`unexpected invoke: ${command}`));
    });

    const { result } = renderHook(() => useUpdaterContext(), { wrapper });
    await waitFor(() => expect(result.current.enabled).toBe(true));
    await act(async () => result.current.checkForUpdate());

    expect(mockUpdateInstances).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith("download_and_install_release", {
      rid: 7,
      transitionId: null,
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.availableVersion).toBe("9.9.9");
  });

  it("checks target metadata before exposing confirmation and does not mutate selection", async () => {
    enableUpdaterRuntime();
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "get_release_runtime") return Promise.resolve(runtime);
      if (command === "prepare_channel_switch")
        return Promise.resolve(metadata("beta", "2.0.0"));
      return Promise.reject(new Error(`unexpected invoke: ${command}`));
    });

    const { result } = renderHook(() => useUpdaterContext(), { wrapper });
    await waitFor(() => expect(result.current.enabled).toBe(true));
    await act(async () => result.current.prepareChannelSwitch("beta"));

    expect(invoke).toHaveBeenCalledWith("prepare_channel_switch", {
      request: { channelId: "beta" },
    });
    expect(result.current.preparedSwitch).toMatchObject({
      channelId: "beta",
      version: "2.0.0",
    });
    expect(result.current.runtime.selectedFeed).toBe("main");
    expect(mockUpdateInstances[0].downloadAndInstall).not.toHaveBeenCalled();
  });

  it("records the confirmed transition before downloading and marks it installed", async () => {
    enableUpdaterRuntime();
    const pendingRuntime = {
      ...runtime,
      selectedFeed: "beta",
      pendingInstall: {
        transitionId: "transition-1",
        sourceChannelId: "main",
        targetChannelId: "beta",
        targetVersion: "2.0.0",
        targetArtifactSha256: "a".repeat(64),
        targetCompatibility: compatibility,
        installed: false,
      },
    };
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "get_release_runtime") return Promise.resolve(runtime);
      if (command === "prepare_channel_switch")
        return Promise.resolve(metadata("beta", "2.0.0"));
      if (command === "confirm_channel_switch")
        return Promise.resolve({ runtime: pendingRuntime });
      if (command === "download_and_install_release")
        return Promise.resolve({
          ...pendingRuntime,
          pendingInstall: { ...pendingRuntime.pendingInstall, installed: true },
        });
      return Promise.reject(new Error(`unexpected invoke: ${command}`));
    });

    const { result } = renderHook(() => useUpdaterContext(), { wrapper });
    await waitFor(() => expect(result.current.enabled).toBe(true));
    await act(async () => result.current.prepareChannelSwitch("beta"));
    await act(async () => result.current.confirmPreparedSwitch());

    expect(invoke).toHaveBeenCalledWith("confirm_channel_switch", {
      request: { channelId: "beta", version: "2.0.0" },
    });
    const commandOrder = vi
      .mocked(invoke)
      .mock.calls.map(([command]) => command as string);
    expect(commandOrder.indexOf("confirm_channel_switch")).toBeLessThan(
      commandOrder.indexOf("download_and_install_release"),
    );
    expect(invoke).toHaveBeenCalledWith("download_and_install_release", {
      rid: 7,
      transitionId: "transition-1",
    });
    expect(result.current.runtime.runningBuild?.channelId).toBe("main");
    expect(result.current.runtime.pendingInstall?.installed).toBe(true);
    expect(result.current.status).toBe("ready");
  });

  it("clears a failed transition and leaves the running build unchanged", async () => {
    enableUpdaterRuntime();
    const pendingRuntime = {
      ...runtime,
      selectedFeed: "beta",
      pendingInstall: {
        transitionId: "transition-1",
        sourceChannelId: "main",
        targetChannelId: "beta",
        targetVersion: "2.0.0",
        targetArtifactSha256: "a".repeat(64),
        targetCompatibility: compatibility,
        installed: false,
      },
    };
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "get_release_runtime") return Promise.resolve(runtime);
      if (command === "prepare_channel_switch")
        return Promise.resolve(metadata("beta", "2.0.0"));
      if (command === "confirm_channel_switch")
        return Promise.resolve({ runtime: pendingRuntime });
      if (command === "download_and_install_release")
        return Promise.reject(new Error("download failed"));
      if (command === "cancel_channel_switch") return Promise.resolve(runtime);
      return Promise.reject(new Error(`unexpected invoke: ${command}`));
    });

    const { result } = renderHook(() => useUpdaterContext(), { wrapper });
    await waitFor(() => expect(result.current.enabled).toBe(true));
    await act(async () => result.current.prepareChannelSwitch("beta"));
    await act(async () => result.current.confirmPreparedSwitch());

    expect(invoke).toHaveBeenCalledWith("cancel_channel_switch", {
      request: { transitionId: "transition-1" },
    });
    expect(result.current.runtime.runningBuild?.channelId).toBe("main");
    expect(result.current.runtime.pendingInstall).toBeUndefined();
    expect(result.current.status).toBe("error");
  });

  it("shows WARP guidance only after the connectivity probe agrees", async () => {
    enableUpdaterRuntime();
    vi.mocked(probeKgooseConnectivity).mockResolvedValue({
      likelyWarpFailure: true,
      status: 403,
      kind: "status",
      message: "forbidden",
    });
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "get_release_runtime") return Promise.resolve(runtime);
      if (command === "check_release_update")
        return Promise.reject(new Error("manifest request failed"));
      return Promise.reject(new Error(`unexpected invoke: ${command}`));
    });

    const { result } = renderHook(() => useUpdaterContext(), { wrapper });
    await waitFor(() => expect(result.current.enabled).toBe(true));
    await act(async () => result.current.checkForUpdate());

    expect(result.current.errorMessage).toContain("Cloudflare WARP");
    expect(result.current.errorDetail).toBe("manifest request failed");
    expect(toast.error).toHaveBeenCalled();
  });

  it("relaunches through the standard process path when no rename applies", async () => {
    enableUpdaterRuntime();
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "get_release_runtime") return Promise.resolve(runtime);
      if (command === "finalize_update_relaunch") return Promise.resolve(false);
      return Promise.reject(new Error(`unexpected invoke: ${command}`));
    });
    vi.mocked(tauriRelaunch).mockResolvedValue(undefined);

    const { result } = renderHook(() => useUpdaterContext(), { wrapper });
    await waitFor(() => expect(result.current.enabled).toBe(true));
    await act(async () => result.current.relaunch());

    expect(tauriRelaunch).toHaveBeenCalledOnce();
  });

  it("keeps background checks out of a ready state", async () => {
    enableUpdaterRuntime();
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "get_release_runtime") return Promise.resolve(runtime);
      if (command === "check_release_update")
        return Promise.resolve(metadata());
      if (command === "download_and_install_release")
        return Promise.resolve(runtime);
      return Promise.reject(new Error(`unexpected invoke: ${command}`));
    });

    const { result } = renderHook(() => useUpdaterContext(), { wrapper });
    await waitFor(() => expect(result.current.enabled).toBe(true));
    await act(async () => result.current.checkForUpdate());
    vi.mocked(invoke).mockClear();
    await act(async () =>
      result.current.checkForUpdate({ background: true, quiet: true }),
    );

    expect(invoke).not.toHaveBeenCalledWith("check_release_update");
    expect(result.current.status).toBe("ready");
  });
});
