import { screen, within } from "@testing-library/react";
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

const ensureHostConnected = vi.fn(async () => "connected" as const);
const disconnect = vi.fn(async () => {});
const shutdownHost = vi.fn(async () => {});
const runDoctor = vi.fn(async () => {});
const refreshConfigHosts = vi.fn(async () => {});
const syncBackendSnapshot = vi.fn(async () => {});
const forgetHost = vi.fn(async () => {});
const setGoosePath = vi.fn((_host: string, _path: string | null) => true);

function seedStore(overrides?: Partial<ReturnType<typeof baseState>>) {
  useRemoteHostStore.setState({ ...baseState(), ...overrides });
}

function baseState() {
  return {
    configHosts: [] as string[],
    manualHosts: [] as string[],
    statusByHost: {},
    doctorByHost: {},
    doctorPendingByHost: {},
    doctorErrorByHost: {},
    forgottenHosts: {},
    lifecycleByHost: {},
    forgetPendingByHost: {},
    forgetErrorByHost: {},
    recentDirsByHost: {},
    goosePathByHost: {} as Record<string, string>,
    ensureHostConnected,
    disconnect,
    shutdownHost,
    runDoctor,
    refreshConfigHosts,
    syncBackendSnapshot,
    forgetHost,
    setGoosePath,
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

  it("can forget a failed free-form host", async () => {
    const user = userEvent.setup();
    const host = "ssh broken.blox";
    seedStore({
      statusByHost: {
        [host]: {
          state: "failed",
          error: {
            kind: "invalid-host",
            message: "host must not contain whitespace or control characters",
          },
        },
      },
    });
    renderWithProviders(<RemoteHostsSettings />);

    await user.click(
      screen.getByRole("button", {
        name: enSettings.remoteHosts.actions.forget,
      }),
    );

    expect(forgetHost).toHaveBeenCalledWith(host);
  });

  it("disables Forget while pending", () => {
    const host = "broken.blox";
    seedStore({
      statusByHost: { [host]: { state: "failed" } },
      forgetPendingByHost: { [host]: true },
    });
    renderWithProviders(<RemoteHostsSettings />);

    const button = screen.getByRole("button", {
      name: enSettings.remoteHosts.actions.forgetting,
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("data-feedback-state", "loading");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(
      within(button)
        .getAllByText(enSettings.remoteHosts.actions.forget)
        .every((label) => label.getAttribute("aria-hidden") === "true"),
    ).toBe(true);
  });

  it("keeps the row and explains a rejected Forget", async () => {
    const user = userEvent.setup();
    const host = "broken.blox";
    forgetHost.mockImplementationOnce(async () => {
      useRemoteHostStore.setState((state) => ({
        forgetPendingByHost: {
          ...state.forgetPendingByHost,
          [host]: false,
        },
        forgetErrorByHost: {
          ...state.forgetErrorByHost,
          [host]: { kind: "internal", message: "still connecting" },
        },
      }));
      throw new Error("still connecting");
    });
    seedStore({
      statusByHost: { [host]: { state: "failed" } },
    });
    renderWithProviders(<RemoteHostsSettings />);

    await user.click(
      screen.getByRole("button", {
        name: enSettings.remoteHosts.actions.forget,
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      enSettings.remoteHosts.forget.error,
    );
    expect(screen.getByText(host)).toBeInTheDocument();
  });

  it("does not offer Forget for an ssh-config host", () => {
    seedStore({
      configHosts: ["configured"],
      statusByHost: { configured: { state: "failed" } },
    });
    renderWithProviders(<RemoteHostsSettings />);

    expect(
      screen.queryByRole("button", {
        name: enSettings.remoteHosts.actions.forget,
      }),
    ).not.toBeInTheDocument();
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

  it("offers a confirmed stop for a persisted disconnected daemon", async () => {
    const user = userEvent.setup();
    seedStore({ configHosts: ["alpha"] });
    renderWithProviders(<RemoteHostsSettings />);

    await user.click(
      screen.getByRole("button", {
        name: enSettings.remoteHosts.actions.shutdown,
      }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: enSettings.remoteHosts.shutdownConfirm.confirm,
      }),
    );

    expect(shutdownHost).toHaveBeenCalledWith("alpha");
  });

  it("stops the exact conflicting daemon generation before reconnecting", async () => {
    const user = userEvent.setup();
    seedStore({
      configHosts: ["alpha"],
      statusByHost: {
        alpha: {
          state: "failed",
          error: {
            kind: "daemon-conflict",
            message: "incompatible daemon",
            daemonInstance: {
              pid: 4242,
              startedAt: "1756700000",
              gooseVersion: "goose 2.0",
              binary: "/opt/goose",
              instanceToken: "opaque-generation",
            },
          },
        },
      },
    });
    renderWithProviders(<RemoteHostsSettings />);

    expect(
      screen.getByText(/PID 4242, goose 2\.0, \/opt\/goose/),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: enSettings.remoteHosts.actions.takeover,
      }),
    );
    expect(shutdownHost).not.toHaveBeenCalled();
    await user.click(
      await screen.findByRole("button", {
        name: enSettings.remoteHosts.shutdownConfirm.confirm,
      }),
    );

    expect(shutdownHost).toHaveBeenCalledWith("alpha", "opaque-generation");
    expect(ensureHostConnected).toHaveBeenCalledWith("alpha");
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

  describe("goose binary override", () => {
    it("renders the persisted path for the host", () => {
      seedStore({
        configHosts: ["alpha"],
        goosePathByHost: { alpha: "~/src/goose/target/release/goose" },
      });
      renderWithProviders(<RemoteHostsSettings />);

      expect(
        screen.getByLabelText(enSettings.remoteHosts.gooseBinary.label),
      ).toHaveValue("~/src/goose/target/release/goose");
      expect(
        screen.getByText(enSettings.remoteHosts.gooseBinary.hint),
      ).toBeInTheDocument();
    });

    it("saves a typed path through the store", async () => {
      const user = userEvent.setup();
      seedStore({ configHosts: ["alpha"] });
      renderWithProviders(<RemoteHostsSettings />);

      await user.type(
        screen.getByLabelText(enSettings.remoteHosts.gooseBinary.label),
        "/opt/goose/bin/goose",
      );
      await user.click(
        screen.getByRole("button", {
          name: enSettings.remoteHosts.gooseBinary.save,
        }),
      );

      expect(setGoosePath).toHaveBeenCalledWith(
        "alpha",
        "/opt/goose/bin/goose",
      );
    });

    it("shows an error for a path the remote script cannot resolve", async () => {
      const user = userEvent.setup();
      setGoosePath.mockReturnValueOnce(false);
      seedStore({ configHosts: ["alpha"] });
      renderWithProviders(<RemoteHostsSettings />);

      await user.type(
        screen.getByLabelText(enSettings.remoteHosts.gooseBinary.label),
        "goose",
      );
      await user.click(
        screen.getByRole("button", {
          name: enSettings.remoteHosts.gooseBinary.save,
        }),
      );

      expect(
        screen.getByText(enSettings.remoteHosts.gooseBinary.invalidError),
      ).toBeInTheDocument();
    });

    it("clears a saved path", async () => {
      const user = userEvent.setup();
      seedStore({
        configHosts: ["alpha"],
        goosePathByHost: { alpha: "/opt/goose/bin/goose" },
      });
      renderWithProviders(<RemoteHostsSettings />);

      await user.click(
        screen.getByRole("button", {
          name: enSettings.remoteHosts.gooseBinary.clear,
        }),
      );

      expect(setGoosePath).toHaveBeenCalledWith("alpha", null);
    });

    it("reports which binary answered the doctor check", async () => {
      seedStore({
        configHosts: ["alpha"],
        doctorByHost: {
          alpha: [
            {
              binary: "goose",
              found: true,
              version: "goose 2.0.0-patched",
              path: "/opt/goose/bin/goose",
            },
          ],
        },
      });
      renderWithProviders(<RemoteHostsSettings />);

      expect(screen.getByText("goose 2.0.0-patched")).toBeInTheDocument();
      expect(screen.getByText("/opt/goose/bin/goose")).toBeInTheDocument();
    });
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
