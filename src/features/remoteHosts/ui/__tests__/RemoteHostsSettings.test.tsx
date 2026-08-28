import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import enSettings from "@/shared/i18n/locales/en/settings.json";
import { REMOTE_SSH_SESSIONS_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import {
  EXPERIMENT_PREFERENCES_STORAGE_KEY,
  setExperimentEnabled,
} from "@/features/experiments/experimentPreferences";
import { useRemoteHostStore } from "@/features/remoteHosts/stores/remoteHostStore";
import { RemoteHostsSettings } from "../RemoteHostsSettings";

const ensureHostConnected = vi.fn(async () => {});
const disconnect = vi.fn(async () => {});
const shutdownHost = vi.fn(async () => {});
const runDoctor = vi.fn(async () => {});
const refreshConfigHosts = vi.fn(async () => {});
const syncBackendSnapshot = vi.fn(async () => {});

function seedStore(overrides?: Partial<ReturnType<typeof baseState>>) {
  useRemoteHostStore.setState({ ...baseState(), ...overrides });
}

function baseState() {
  return {
    configHosts: [] as string[],
    statusByHost: {},
    doctorByHost: {},
    doctorPendingByHost: {},
    doctorErrorByHost: {},
    recentDirsByHost: {},
    ensureHostConnected,
    disconnect,
    shutdownHost,
    runDoctor,
    refreshConfigHosts,
    syncBackendSnapshot,
  };
}

describe("RemoteHostsSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.removeItem(EXPERIMENT_PREFERENCES_STORAGE_KEY);
    // The experiment is manualEnableOnly, so it stays off (even under the
    // dev auto-enable default) until each test opts in explicitly.
    setExperimentEnabled(REMOTE_SSH_SESSIONS_EXPERIMENT_ID, true);
    seedStore();
  });

  it("renders nothing when the experiment is disabled", () => {
    setExperimentEnabled(REMOTE_SSH_SESSIONS_EXPERIMENT_ID, false);
    seedStore({ configHosts: ["alpha"] });
    renderWithProviders(<RemoteHostsSettings />);
    expect(
      screen.queryByText(enSettings.remoteHosts.title),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
  });

  it("renders ssh-config hosts with their statuses", () => {
    seedStore({
      configHosts: ["alpha", "beta", "gamma"],
      statusByHost: {
        alpha: { state: "ready" },
        beta: {
          state: "failed",
          error: { kind: "auth-failed", message: "Permission denied" },
        },
        gamma: { state: "reconnecting", attempt: 3 },
      },
    });
    renderWithProviders(<RemoteHostsSettings />);

    expect(screen.getByText(enSettings.remoteHosts.title)).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(
      screen.getByText(enSettings.remoteHosts.status.ready),
    ).toBeInTheDocument();
    expect(
      screen.getByText(enSettings.remoteHosts.status.failed),
    ).toBeInTheDocument();
    expect(screen.getByText("Permission denied")).toBeInTheDocument();
    expect(screen.getByText("Reconnecting (attempt 3)...")).toBeInTheDocument();
  });

  it("shows hosts with backend status that are not in the ssh config", () => {
    seedStore({
      configHosts: ["alpha"],
      statusByHost: { "user@adhoc": { state: "ready" } },
    });
    renderWithProviders(<RemoteHostsSettings />);
    expect(screen.getByText("user@adhoc")).toBeInTheDocument();
  });

  it("connects a disconnected host via the row's Connect button", async () => {
    const user = userEvent.setup();
    seedStore({ configHosts: ["alpha"] });
    renderWithProviders(<RemoteHostsSettings />);

    const [connectButton] = screen.getAllByRole("button", {
      name: enSettings.remoteHosts.actions.connect,
    });
    await user.click(connectButton);
    expect(ensureHostConnected).toHaveBeenCalledWith("alpha");
  });

  it("offers Disconnect and a confirmed Stop remote backend when connected", async () => {
    const user = userEvent.setup();
    seedStore({
      configHosts: ["alpha"],
      statusByHost: { alpha: { state: "ready" } },
    });
    renderWithProviders(<RemoteHostsSettings />);

    await user.click(
      screen.getByRole("button", {
        name: enSettings.remoteHosts.actions.shutdown,
      }),
    );
    // Confirm dialog interposes before anything stops.
    expect(shutdownHost).not.toHaveBeenCalled();
    await user.click(
      await screen.findByRole("button", {
        name: enSettings.remoteHosts.shutdownConfirm.confirm,
      }),
    );
    expect(shutdownHost).toHaveBeenCalledWith("alpha");

    await user.click(
      screen.getByRole("button", {
        name: enSettings.remoteHosts.actions.disconnect,
      }),
    );
    expect(disconnect).toHaveBeenCalledWith("alpha");
  });

  it("runs the doctor and renders the report inline", async () => {
    const user = userEvent.setup();
    seedStore({
      configHosts: ["alpha"],
      doctorByHost: {
        alpha: [
          { binary: "goose", found: false },
          { binary: "claude-agent-acp", found: true, version: "1.2.3" },
        ],
      },
    });
    renderWithProviders(<RemoteHostsSettings />);

    await user.click(
      screen.getByRole("button", {
        name: enSettings.remoteHosts.actions.check,
      }),
    );
    expect(runDoctor).toHaveBeenCalledWith("alpha");

    expect(screen.getByText("goose")).toBeInTheDocument();
    expect(
      screen.getByText(enSettings.remoteHosts.doctor.notFound),
    ).toBeInTheDocument();
    expect(screen.getByText("claude-agent-acp")).toBeInTheDocument();
    expect(screen.getByText("1.2.3")).toBeInTheDocument();
    expect(
      screen.getByText(enSettings.remoteHosts.doctor.gooseMissing),
    ).toBeInTheDocument();
  });

  it("connects a free-form user@host and validates empty input", async () => {
    const user = userEvent.setup();
    seedStore();
    renderWithProviders(<RemoteHostsSettings />);

    const connectButton = screen.getByRole("button", {
      name: enSettings.remoteHosts.actions.connect,
    });
    await user.click(connectButton);
    expect(ensureHostConnected).not.toHaveBeenCalled();
    expect(
      screen.getByText(enSettings.remoteHosts.custom.emptyError),
    ).toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText(enSettings.remoteHosts.custom.placeholder),
      "me@example.com",
    );
    await user.click(connectButton);
    expect(ensureHostConnected).toHaveBeenCalledWith("me@example.com");
  });

  it("renders the backend error under the free-form row when connect fails", async () => {
    const user = userEvent.setup();
    ensureHostConnected.mockRejectedValueOnce({
      kind: "host-unreachable",
      message: "Could not reach host",
    });
    seedStore();
    renderWithProviders(<RemoteHostsSettings />);

    await user.type(
      screen.getByPlaceholderText(enSettings.remoteHosts.custom.placeholder),
      "me@example.com",
    );
    await user.click(
      screen.getByRole("button", {
        name: enSettings.remoteHosts.actions.connect,
      }),
    );
    expect(await screen.findByText("Could not reach host")).toBeInTheDocument();
  });
});
