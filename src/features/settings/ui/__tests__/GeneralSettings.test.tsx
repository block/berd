import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import { renderWithProviders } from "@/test/render";
import { clearLocalMediaCaches } from "@/shared/api/localMediaCaches";
import { GeneralSettings } from "../GeneralSettings";
import { toast } from "sonner";

const { mockOpenDialog } = vi.hoisted(() => ({
  mockOpenDialog: vi.fn(),
}));

vi.mock("@/shared/api/localMediaCaches", () => ({
  clearLocalMediaCaches: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mockOpenDialog,
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

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function renderGeneralSettings(queryClient = createQueryClient()) {
  renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <GeneralSettings />
      </ThemeProvider>
    </QueryClientProvider>,
  );
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
    localStorage.clear();
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

  it("updates the default artifact location", async () => {
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/test/Artifacts");

    renderGeneralSettings();

    await screen.findByText("~/goose artifacts");
    await user.click(screen.getByRole("button", { name: "Change" }));

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
    renderGeneralSettings(queryClient);

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
});
