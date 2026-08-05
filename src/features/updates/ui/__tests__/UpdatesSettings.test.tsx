import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "@/features/updates/hooks/useUpdater";
import { renderWithProviders } from "@/test/render";
import { UpdatesSettings } from "../UpdatesSettings";

const mockGetVersion = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: mockGetVersion,
}));

type MockUpdaterState = {
  status: UpdateStatus;
  enabled: boolean;
  availableVersion: string | null;
  downloadProgress: number | null;
  errorMessage: string | null;
  errorDetail: string | null;
  checkForUpdate: ReturnType<typeof vi.fn>;
  downloadAndInstall: ReturnType<typeof vi.fn>;
  relaunch: ReturnType<typeof vi.fn>;
};

const updaterMock = vi.hoisted(() => ({
  state: {} as MockUpdaterState,
}));

vi.mock("@/features/updates/hooks/useUpdater", () => ({
  useUpdaterContext: () => updaterMock.state,
}));

function setUpdaterState(overrides: Partial<MockUpdaterState> = {}) {
  updaterMock.state = {
    status: "idle",
    enabled: true,
    availableVersion: null,
    downloadProgress: null,
    errorMessage: null,
    errorDetail: null,
    checkForUpdate: vi.fn(),
    downloadAndInstall: vi.fn(),
    relaunch: vi.fn(),
    ...overrides,
  };
  return updaterMock.state;
}

describe("UpdatesSettings", () => {
  beforeEach(() => {
    setUpdaterState();
    mockGetVersion.mockResolvedValue("1.2.3");
    // Simulate Tauri environment
    (
      window as unknown as { __TAURI_INTERNALS__: boolean }
    ).__TAURI_INTERNALS__ = true;
  });

  it("renders the idle state and starts a manual check", async () => {
    const user = userEvent.setup();
    const state = setUpdaterState();

    renderWithProviders(<UpdatesSettings />);

    expect(screen.getByText("App Version")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Keep Berd up to date with the latest features and fixes.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Check if a new version is available."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check for Updates" }));

    expect(state.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("displays the current version number", async () => {
    renderWithProviders(<UpdatesSettings />);

    await waitFor(() => {
      expect(screen.getByText("Version 1.2.3")).toBeInTheDocument();
    });
  });

  it("hides version when not in Tauri environment", () => {
    (
      window as unknown as { __TAURI_INTERNALS__: undefined }
    ).__TAURI_INTERNALS__ = undefined;

    renderWithProviders(<UpdatesSettings />);

    expect(screen.queryByText(/Version \d/)).not.toBeInTheDocument();
  });

  it("disables the action while checking", () => {
    setUpdaterState({ status: "checking" });

    renderWithProviders(<UpdatesSettings />);

    expect(screen.getByRole("button", { name: "Checking..." })).toBeDisabled();
    expect(
      screen.getByText("Checking the update channel..."),
    ).toBeInTheDocument();
  });

  it("renders the up-to-date state", () => {
    setUpdaterState({ status: "up-to-date" });

    renderWithProviders(<UpdatesSettings />);

    expect(screen.getByText("Berd is up to date.")).toBeInTheDocument();
  });

  it("restarts when an update is ready", async () => {
    const user = userEvent.setup();
    const state = setUpdaterState({
      status: "ready",
      availableVersion: "9.9.9",
    });

    renderWithProviders(<UpdatesSettings />);

    await user.click(screen.getByRole("button", { name: "Restart to Update" }));

    expect(state.relaunch).toHaveBeenCalledTimes(1);
  });

  it("renders errors and retries checks", async () => {
    const user = userEvent.setup();
    const state = setUpdaterState({
      status: "error",
      errorMessage: "download failed",
    });

    renderWithProviders(<UpdatesSettings />);

    expect(screen.getByText("download failed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try Again" }));

    expect(state.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("never renders the retry label in the spinner layer while retrying", () => {
    setUpdaterState({ status: "error", errorMessage: "download failed" });

    const { rerender } = renderWithProviders(<UpdatesSettings />);

    // Retrying after a failure is the exact transition that garbled: the label
    // flips to "Try Again" while the button cross-fades back out of loading.
    setUpdaterState({ status: "checking" });
    rerender(<UpdatesSettings />);

    const button = screen.getByRole("button", { name: "Checking..." });

    // preserveWidth stacks every feedback layer in one centered grid cell, but
    // only the busy layer carries a spinner, so only it is a different width.
    // If it repeated a resting label, centering would offset the two identical
    // strings and the fade would paint both ("Try Againin", BOT-1466). Layers
    // without a spinner share geometry and superimpose exactly, so repeats
    // among those are harmless — the busy label just has to differ from them.
    const layers = Array.from(button.querySelectorAll('[class*="grid-area"]'));
    const busyLayer = layers.find((layer) => layer.querySelector("svg"));

    if (!busyLayer) {
      throw new Error("expected the busy layer to render a spinner");
    }

    const restingLabels = layers
      .filter((layer) => layer !== busyLayer)
      .map((layer) => layer.textContent);

    expect(busyLayer.textContent).toBe("Checking...");
    expect(restingLabels).not.toContain(busyLayer.textContent);
  });

  it.each([
    ["downloading", "Downloading..."],
    ["installing", "Installing..."],
  ] as const)("names the busy button for the %s phase", (status, expectedLabel) => {
    setUpdaterState({ status, downloadProgress: 42 });

    renderWithProviders(<UpdatesSettings />);

    // The button stays in its loading state for the whole busy run, so a
    // fixed "Checking..." label would contradict the progress row below it.
    expect(screen.getByRole("button", { name: expectedLabel })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Checking..." }),
    ).not.toBeInTheDocument();
  });

  it("shows the raw error detail alongside the friendly summary", () => {
    setUpdaterState({
      status: "error",
      errorMessage: "Update failed. Try again.",
      errorDetail: "signature verification failed",
    });

    renderWithProviders(<UpdatesSettings />);

    expect(screen.getByText("Update failed. Try again.")).toBeInTheDocument();
    expect(
      screen.getByText("Details: signature verification failed"),
    ).toBeInTheDocument();
  });
});
