import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import { renderWithProviders } from "@/test/render";
import { clearLocalMediaCaches } from "@/shared/api/localMediaCaches";
import {
  OPEN_SETTINGS_EVENT,
  type OpenSettingsEventDetail,
} from "@/features/settings/lib/settingsEvents";
import { TERMINAL_FALLBACK_CWD_STORAGE_KEY } from "@/features/terminal/lib/terminalCwdPreference";
import { STREAMING_SHORTCUT_MODE_STORAGE_KEY } from "@/features/chat/lib/streamingShortcutPreference";
import { AT_MENTION_DEFAULT_CATEGORY_STORAGE_KEY } from "@/features/chat/lib/mentionPreference";
import { SIDEBAR_GIT_BRANCH_SUBTITLE_STORAGE_KEY } from "@/features/sidebar/lib/sidebarBranchSubtitlePreference";
import {
  INITIAL_RUNTIME_CONFIG_RESULT,
  useRuntimeConfigStore,
} from "@/shared/runtime-config/runtimeConfigStore";
import { DEFAULT_RUNTIME_CONFIG } from "@/shared/runtime-config/schema";
import type {
  RuntimeConfig,
  RuntimeConfigLoadResult,
} from "@/shared/runtime-config/schema";
import {
  SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID,
  SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT_CONFIG_KEY,
} from "@/features/experiments/experimentDefinitions";
import {
  EXPERIMENT_PREFERENCES_STORAGE_KEY,
  setExperimentEnabled,
} from "@/features/experiments/experimentPreferences";
import { GeneralSettings } from "../GeneralSettings";
import { toast } from "sonner";

const { mockLogout, mockOpenDialog, mockRuntimeConfigApi } = vi.hoisted(() => ({
  mockLogout: vi.fn(),
  mockOpenDialog: vi.fn(),
  mockRuntimeConfigApi: {
    clearFakeRuntimeConfig: vi.fn(),
    getRuntimeConfig: vi.fn(),
    refreshRuntimeConfig: vi.fn(),
    setFakeRuntimeConfig: vi.fn(),
  },
}));

vi.mock("@/shared/api/localMediaCaches", () => ({
  clearLocalMediaCaches: vi.fn(),
}));

vi.mock("@/features/auth/api/auth", () => ({
  logout: mockLogout,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mockOpenDialog,
}));

vi.mock("@/shared/api/runtimeConfig", () => ({
  clearFakeRuntimeConfig: mockRuntimeConfigApi.clearFakeRuntimeConfig,
  getRuntimeConfig: mockRuntimeConfigApi.getRuntimeConfig,
  refreshRuntimeConfig: mockRuntimeConfigApi.refreshRuntimeConfig,
  setFakeRuntimeConfig: mockRuntimeConfigApi.setFakeRuntimeConfig,
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const clearLocalMediaCachesMock = vi.mocked(clearLocalMediaCaches);
const toastErrorMock = vi.mocked(toast.error);
const toastSuccessMock = vi.mocked(toast.success);

if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function renderGeneralSettings({
  authStatus,
  onLoggedOut,
  queryClient = createQueryClient(),
}: {
  authStatus?: ComponentProps<typeof GeneralSettings>["authStatus"];
  onLoggedOut?: ComponentProps<typeof GeneralSettings>["onLoggedOut"];
  queryClient?: QueryClient;
} = {}) {
  renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <GeneralSettings authStatus={authStatus} onLoggedOut={onLoggedOut} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

function readyRuntimeConfigResult(
  config: RuntimeConfig = DEFAULT_RUNTIME_CONFIG,
): RuntimeConfigLoadResult {
  return {
    status: "ready",
    source: "fakeEndpoint",
    config,
  };
}

function setReadyRuntimeConfig(config: RuntimeConfig = DEFAULT_RUNTIME_CONFIG) {
  useRuntimeConfigStore.setState({
    loaded: true,
    result: readyRuntimeConfigResult(config),
    config,
  });
}

function getClearCachedMediaButton() {
  const buttons = screen.getAllByRole("button", {
    name: "Clear cached media",
  });
  const button = buttons.at(-1);
  if (!button) {
    throw new Error("Clear cached media button not found");
  }
  return button;
}

describe("GeneralSettings appearance section", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("DEV", true);
    localStorage.clear();
    setReadyRuntimeConfig();
    mockRuntimeConfigApi.setFakeRuntimeConfig.mockImplementation(
      async (config: RuntimeConfig) => readyRuntimeConfigResult(config),
    );
    mockRuntimeConfigApi.refreshRuntimeConfig.mockResolvedValue(
      readyRuntimeConfigResult(),
    );
    mockRuntimeConfigApi.getRuntimeConfig.mockResolvedValue(
      readyRuntimeConfigResult(),
    );
    mockRuntimeConfigApi.clearFakeRuntimeConfig.mockResolvedValue(
      INITIAL_RUNTIME_CONFIG_RESULT,
    );
  });

  it("hides account details when no logged-in auth status is available", () => {
    renderGeneralSettings();

    expect(screen.queryByText("Account")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Log out" }),
    ).not.toBeInTheDocument();
  });

  it("shows account details and logs out", async () => {
    const user = userEvent.setup();
    const nextStatus = {
      loggedIn: false,
      requiresOrg: false,
      org: "test",
      profile: "default",
      kgooseBaseUrl: "https://test.blockstaging.build",
    };
    const onLoggedOut = vi.fn();
    mockLogout.mockResolvedValueOnce(nextStatus);

    renderGeneralSettings({
      authStatus: {
        loggedIn: true,
        requiresOrg: false,
        org: "test",
        profile: "default",
        kgooseBaseUrl: "https://test.blockstaging.build",
        email: "kalvin@example.com",
      },
      onLoggedOut,
    });

    expect(screen.getByText("Account")).toBeInTheDocument();
    expect(screen.getByText("kalvin@example.com")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
    expect(
      screen.queryByText("https://test.blockstaging.build"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => {
      expect(mockLogout).toHaveBeenCalledTimes(1);
      expect(toastSuccessMock).toHaveBeenCalledWith("Logged out.");
      expect(onLoggedOut).toHaveBeenCalledWith(nextStatus);
    });
  });

  it("selects default light and dark theme modes", async () => {
    const user = userEvent.setup();

    renderGeneralSettings();

    await user.click(screen.getByTestId("theme-option-dark"));

    await waitFor(() => {
      expect(localStorage.getItem("goose-theme-mode")).toBe("dark");
    });

    await user.click(screen.getByTestId("theme-option-light"));

    await waitFor(() => {
      expect(localStorage.getItem("goose-theme-mode")).toBe("light");
    });
  });

  it("sets and resets a custom primary color", async () => {
    const user = userEvent.setup();

    renderGeneralSettings();

    await user.click(screen.getByRole("button", { name: "Custom" }));

    const hexInput = screen.getByLabelText("Hex");
    await user.clear(hexInput);
    await user.type(hexInput, "#22c55e");

    await waitFor(() => {
      expect(localStorage.getItem("goose-primary-color")).toBe("#22c55e");
    });

    await user.click(screen.getByRole("button", { name: "Use theme" }));

    await waitFor(() => {
      expect(localStorage.getItem("goose-primary-color")).toBeNull();
    });
  });

  it("opens the keyboard shortcuts settings section from the shortcuts row", async () => {
    const user = userEvent.setup();
    const listener = vi.fn();
    window.addEventListener(OPEN_SETTINGS_EVENT, listener);

    try {
      renderGeneralSettings();

      await user.click(screen.getByRole("button", { name: "Customize" }));

      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0] as CustomEvent<
        OpenSettingsEventDetail | undefined
      >;
      expect(event.detail?.section).toBe("shortcuts");
    } finally {
      window.removeEventListener(OPEN_SETTINGS_EVENT, listener);
    }
  });

  it("restores Agent Tools composer tips", async () => {
    const user = userEvent.setup();
    localStorage.setItem("goose:agent-tools-tips-enabled", "false");

    renderGeneralSettings();

    const switchControl = screen.getByRole("switch", {
      name: "Chat tips",
    });

    expect(switchControl).not.toBeChecked();

    await user.click(switchControl);

    await waitFor(() => {
      expect(localStorage.getItem("goose:agent-tools-tips-enabled")).toBe(
        "true",
      );
    });
    expect(switchControl).toBeChecked();
  });

  it("updates sidebar chat grouping", async () => {
    const user = userEvent.setup();
    setExperimentEnabled(SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID, true);

    renderGeneralSettings();

    const switchControl = screen.getByRole("switch", {
      name: "Group Chats by Project",
    });

    expect(switchControl).toBeChecked();

    await user.click(switchControl);

    await waitFor(() => {
      const storedPreferences = JSON.parse(
        localStorage.getItem(EXPERIMENT_PREFERENCES_STORAGE_KEY) ?? "{}",
      );
      expect(
        storedPreferences.experiments[SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID]
          .config[SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT_CONFIG_KEY],
      ).toBe(false);
    });
    expect(switchControl).not.toBeChecked();
  });

  it("hides sidebar chat grouping when the flat chat list experiment is disabled", () => {
    setExperimentEnabled(SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID, false);

    renderGeneralSettings();

    expect(
      screen.queryByRole("switch", {
        name: "Group Chats by Project",
      }),
    ).toBeNull();
  });

  it("updates the follow-up behavior", async () => {
    const user = userEvent.setup();

    renderGeneralSettings();

    expect(screen.getByRole("button", { name: "Queue" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(
      screen.getByRole("button", { name: "Steer (Goose harness only)" }),
    );

    await waitFor(() => {
      expect(localStorage.getItem(STREAMING_SHORTCUT_MODE_STORAGE_KEY)).toBe(
        "enter-steers",
      );
    });
    expect(
      screen.getByRole("button", { name: "Steer (Goose harness only)" }),
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Queue" }));

    await waitFor(() => {
      expect(localStorage.getItem(STREAMING_SHORTCUT_MODE_STORAGE_KEY)).toBe(
        "cmd-enter-steers",
      );
    });
    expect(screen.getByRole("button", { name: "Queue" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("updates the default @ mention tab", async () => {
    const user = userEvent.setup();

    renderGeneralSettings();

    expect(screen.getByRole("button", { name: "Agents" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Files" }));

    await waitFor(() => {
      expect(
        localStorage.getItem(AT_MENTION_DEFAULT_CATEGORY_STORAGE_KEY),
      ).toBe("files");
    });
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Agents" }));

    await waitFor(() => {
      expect(
        localStorage.getItem(AT_MENTION_DEFAULT_CATEGORY_STORAGE_KEY),
      ).toBe("agents");
    });
    expect(screen.getByRole("button", { name: "Agents" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("toggles Git branch subtitles in the chat list", async () => {
    const user = userEvent.setup();

    renderGeneralSettings();

    const switchControl = screen.getByRole("switch", {
      name: "Show Git branches in chat list",
    });
    expect(switchControl).not.toBeChecked();

    await user.click(switchControl);

    await waitFor(() => {
      expect(
        localStorage.getItem(SIDEBAR_GIT_BRANCH_SUBTITLE_STORAGE_KEY),
      ).toBe("true");
    });
    expect(switchControl).toBeChecked();
  });

  it("updates the default artifact location", async () => {
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/test/Artifacts");

    renderGeneralSettings();

    await screen.findAllByText("~/goose artifacts");
    await user.click(screen.getAllByRole("button", { name: "Change" })[0]);

    expect(mockOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "~/goose artifacts",
        directory: true,
        multiple: false,
      }),
    );
    await waitFor(() => {
      expect(localStorage.getItem("goose:artifact-root-path")).toBe(
        "/Users/test/Artifacts",
      );
    });
    expect(toastSuccessMock).toHaveBeenCalledWith("Artifact location updated.");
  });

  it("updates the terminal fallback folder", async () => {
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/test");

    renderGeneralSettings();

    await screen.findAllByText("~/goose artifacts");
    const changeButtons = screen.getAllByRole("button", { name: "Change" });
    const terminalFallbackChangeButton = changeButtons.at(-1);
    if (!terminalFallbackChangeButton) {
      throw new Error("Terminal fallback change button not found");
    }

    await user.click(terminalFallbackChangeButton);

    expect(mockOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "~/goose artifacts",
        directory: true,
        multiple: false,
        title: "Choose terminal fallback folder",
      }),
    );

    await waitFor(() => {
      expect(localStorage.getItem(TERMINAL_FALLBACK_CWD_STORAGE_KEY)).toBe(
        "/Users/test",
      );
    });
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Terminal fallback folder updated.",
    );
  });

  it("restores animated avatar playback", async () => {
    const user = userEvent.setup();
    localStorage.setItem("goose:animated-avatars-enabled", "false");

    renderGeneralSettings();

    const switchControl = screen.getByRole("switch", {
      name: "Animated avatars",
    });

    expect(switchControl).not.toBeChecked();

    await user.click(switchControl);

    await waitFor(() => {
      expect(localStorage.getItem("goose:animated-avatars-enabled")).toBe(
        "true",
      );
    });
    expect(switchControl).toBeChecked();
  });

  it("opens cached media confirmation and confirms cache clearing", async () => {
    const user = userEvent.setup();
    clearLocalMediaCachesMock.mockResolvedValue(undefined);
    renderGeneralSettings();

    await user.click(getClearCachedMediaButton());

    expect(
      screen.getByRole("heading", { name: "Clear cached media?" }),
    ).toBeInTheDocument();

    await user.click(getClearCachedMediaButton());

    await waitFor(() => {
      expect(clearLocalMediaCachesMock).toHaveBeenCalledTimes(1);
    });
  });

  it("shows success and closes the cached media confirmation after clearing succeeds", async () => {
    const user = userEvent.setup();
    const queryClient = createQueryClient();
    clearLocalMediaCachesMock.mockResolvedValue(undefined);
    renderGeneralSettings({ queryClient });

    await user.click(getClearCachedMediaButton());
    await user.click(getClearCachedMediaButton());

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith("Cached media cleared.");
    });
    expect(
      screen.queryByRole("heading", { name: "Clear cached media?" }),
    ).not.toBeInTheDocument();
  });

  it("shows an error and leaves the cached media confirmation open when clearing fails", async () => {
    const user = userEvent.setup();
    clearLocalMediaCachesMock.mockRejectedValue(new Error("permission denied"));
    renderGeneralSettings();

    await user.click(getClearCachedMediaButton());
    await user.click(getClearCachedMediaButton());

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Couldn't clear cached media. Try again.",
      );
    });
    expect(
      screen.getByRole("heading", { name: "Clear cached media?" }),
    ).toBeInTheDocument();
    expect(getClearCachedMediaButton()).toBeEnabled();
  });

  it("shows the development fake endpoint runtime config editor", () => {
    setReadyRuntimeConfig({
      ...DEFAULT_RUNTIME_CONFIG,
      featureToggles: { doctor: true },
    });

    renderGeneralSettings();

    expect(screen.getByText("Runtime config")).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Fake endpoint JSON" }),
    ).toHaveValue(
      `${JSON.stringify(
        { ...DEFAULT_RUNTIME_CONFIG, featureToggles: { doctor: true } },
        null,
        2,
      )}\n`,
    );
  });

  it("hides the fake endpoint runtime config editor outside development", () => {
    vi.stubEnv("DEV", false);

    renderGeneralSettings();

    expect(screen.queryByText("Runtime config")).not.toBeInTheDocument();
  });

  it("saves fake endpoint runtime config through the runtime config store", async () => {
    const user = userEvent.setup();
    const nextConfig = {
      ...DEFAULT_RUNTIME_CONFIG,
      featureToggles: { doctor: true },
    } satisfies RuntimeConfig;
    renderGeneralSettings();

    fireEvent.change(
      screen.getByRole("textbox", { name: "Fake endpoint JSON" }),
      {
        target: { value: JSON.stringify(nextConfig, null, 2) },
      },
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockRuntimeConfigApi.setFakeRuntimeConfig).toHaveBeenCalledWith(
        nextConfig,
      );
    });
    expect(useRuntimeConfigStore.getState().config).toEqual(nextConfig);
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Fake endpoint response saved.",
    );
  });

  it("reports invalid fake endpoint runtime config without saving", async () => {
    const user = userEvent.setup();
    renderGeneralSettings();

    fireEvent.change(
      screen.getByRole("textbox", { name: "Fake endpoint JSON" }),
      {
        target: { value: "{not-json" },
      },
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mockRuntimeConfigApi.setFakeRuntimeConfig).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Couldn't save fake endpoint response.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/json/i);
  });

  it("clears the fake endpoint runtime config response", async () => {
    const user = userEvent.setup();
    setReadyRuntimeConfig({
      ...DEFAULT_RUNTIME_CONFIG,
      featureToggles: { doctor: true },
    });
    renderGeneralSettings();

    await user.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => {
      expect(mockRuntimeConfigApi.clearFakeRuntimeConfig).toHaveBeenCalled();
    });
    expect(useRuntimeConfigStore.getState().config).toEqual(
      DEFAULT_RUNTIME_CONFIG,
    );
    expect(
      screen.getByRole("textbox", { name: "Fake endpoint JSON" }),
    ).toHaveValue(`${JSON.stringify(DEFAULT_RUNTIME_CONFIG, null, 2)}\n`);
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Fake endpoint response cleared.",
    );
  });
});
