import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "@/features/updates/hooks/useUpdater";
import { renderWithProviders } from "@/test/render";
import { UpdatesSettings } from "../UpdatesSettings";

type MockUpdaterState = {
  status: UpdateStatus;
  enabled: boolean;
  availableVersion: string | null;
  downloadProgress: number | null;
  errorMessage: string | null;
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
  });

  it("renders the idle state and starts a manual check", async () => {
    const user = userEvent.setup();
    const state = setUpdaterState();

    renderWithProviders(<UpdatesSettings />);

    expect(screen.getByText("Software Updates")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Keep Goose up to date with the latest features and fixes.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Check if a new version is available."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check for Updates" }));

    expect(state.checkForUpdate).toHaveBeenCalledTimes(1);
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

    expect(screen.getByText("Goose is up to date.")).toBeInTheDocument();
  });

  it("restarts when an update is ready", async () => {
    const user = userEvent.setup();
    const state = setUpdaterState({
      status: "ready",
      availableVersion: "9.9.9",
    });

    renderWithProviders(<UpdatesSettings />);

    await user.click(screen.getByRole("button", { name: "Restart" }));

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
});
