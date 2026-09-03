import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteHostSelector } from "../RemoteHostSelector";
import { useRemoteHostStore } from "@/features/remoteHosts/stores/remoteHostStore";

const mockListSshConfigHosts = vi.fn();
const mockConnectRemoteHost = vi.fn();

vi.mock("@/shared/api/remoteHosts", () => ({
  listSshConfigHosts: (...args: unknown[]) => mockListSshConfigHosts(...args),
  connectRemoteHost: (...args: unknown[]) => mockConnectRemoteHost(...args),
  disconnectRemoteHost: vi.fn(),
  shutdownRemoteHost: vi.fn(),
  listRemoteBackends: vi.fn().mockResolvedValue([]),
  checkRemoteHost: vi.fn(),
  listRemoteDirs: vi.fn(),
  listenRemoteBackendStatus: vi.fn().mockResolvedValue(() => {}),
  isRemoteBackendError: () => false,
}));

describe("RemoteHostSelector", () => {
  beforeEach(() => {
    // Opening the selector refreshes hosts from the SSH config, so the mock
    // must agree with the seeded store state.
    mockListSshConfigHosts.mockReset().mockResolvedValue(["devbox", "gpu-box"]);
    mockConnectRemoteHost.mockReset().mockResolvedValue({
      incarnation: "slot-1",
      generation: 1,
    });
    useRemoteHostStore.setState({
      configHosts: ["devbox", "gpu-box"],
      manualHosts: [],
      statusByHost: { devbox: { state: "ready" } },
      forgottenHosts: {},
      lifecycleByHost: {},
    });
  });

  it("renders the local option and the SSH hosts section", async () => {
    const user = userEvent.setup();
    render(<RemoteHostSelector selectedHost={null} onHostChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /select computer/i }));

    expect(
      screen.getByRole("menuitem", { name: /this computer/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("SSH hosts")).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /devbox/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /gpu-box/i }),
    ).toBeInTheDocument();
    // Known backend state shows as an item description.
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("fires onHostChange with the host, and null for the local option", async () => {
    const user = userEvent.setup();
    const onHostChange = vi.fn();
    const { unmount } = render(
      <RemoteHostSelector selectedHost={null} onHostChange={onHostChange} />,
    );

    await user.click(screen.getByRole("button", { name: /select computer/i }));
    await user.click(screen.getByRole("menuitem", { name: /devbox/i }));
    expect(onHostChange).toHaveBeenCalledWith("devbox");
    unmount();

    onHostChange.mockClear();
    render(
      <RemoteHostSelector selectedHost="devbox" onHostChange={onHostChange} />,
    );
    await user.click(screen.getByRole("button", { name: /select computer/i }));
    await user.click(screen.getByRole("menuitem", { name: /this computer/i }));
    expect(onHostChange).toHaveBeenCalledWith(null);
  });

  it("treats aliases matching the former action sentinels as SSH hosts", async () => {
    const aliases = ["__local__", "__add_ssh_environment__"];
    mockListSshConfigHosts.mockResolvedValue(aliases);
    useRemoteHostStore.setState({ configHosts: aliases });
    const user = userEvent.setup();
    const onHostChange = vi.fn();
    const { unmount } = render(
      <RemoteHostSelector selectedHost={null} onHostChange={onHostChange} />,
    );

    await user.click(screen.getByRole("button", { name: /select computer/i }));
    await user.click(screen.getByRole("menuitem", { name: "__local__" }));
    expect(onHostChange).toHaveBeenLastCalledWith("__local__");
    unmount();

    onHostChange.mockClear();
    render(
      <RemoteHostSelector selectedHost={null} onHostChange={onHostChange} />,
    );
    await user.click(screen.getByRole("button", { name: /select computer/i }));
    await user.click(
      screen.getByRole("menuitem", { name: "__add_ssh_environment__" }),
    );
    expect(onHostChange).toHaveBeenLastCalledWith("__add_ssh_environment__");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("still lists a selected host that is missing from the SSH config", async () => {
    mockListSshConfigHosts.mockResolvedValue(["gpu-box"]);
    useRemoteHostStore.setState({ configHosts: ["gpu-box"] });
    const user = userEvent.setup();
    render(<RemoteHostSelector selectedHost="devbox" onHostChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /select computer/i }));

    expect(
      screen.getByRole("menuitem", { name: /devbox/i }),
    ).toBeInTheDocument();
  });

  it("offers an add SSH host action even when no hosts are configured", async () => {
    mockListSshConfigHosts.mockResolvedValue([]);
    useRemoteHostStore.setState({ configHosts: [], statusByHost: {} });
    const user = userEvent.setup();
    render(<RemoteHostSelector selectedHost={null} onHostChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /select computer/i }));

    expect(
      screen.getByRole("menuitem", { name: /add ssh host/i }),
    ).toBeInTheDocument();
  });

  it("connects and selects a host added from the environment dialog", async () => {
    const user = userEvent.setup();
    const onHostChange = vi.fn();
    render(
      <RemoteHostSelector selectedHost={null} onHostChange={onHostChange} />,
    );

    await user.click(screen.getByRole("button", { name: /select computer/i }));
    await user.click(screen.getByRole("menuitem", { name: /add ssh host/i }));
    await user.type(screen.getByRole("textbox", { name: /ssh host/i }), "blox");
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => {
      expect(mockConnectRemoteHost).toHaveBeenCalledWith("blox");
      expect(onHostChange).toHaveBeenCalledWith("blox");
    });
    expect(
      screen.queryByRole("dialog", { name: /add ssh host/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the add dialog open with feedback when connecting fails", async () => {
    mockConnectRemoteHost.mockRejectedValue(new Error("SSH host unavailable"));
    const user = userEvent.setup();
    const onHostChange = vi.fn();
    render(
      <RemoteHostSelector selectedHost={null} onHostChange={onHostChange} />,
    );

    await user.click(screen.getByRole("button", { name: /select computer/i }));
    await user.click(screen.getByRole("menuitem", { name: /add ssh host/i }));
    await user.type(
      screen.getByRole("textbox", { name: /ssh host/i }),
      "offline-box",
    );
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "SSH host unavailable",
    );
    expect(onHostChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: /add ssh host/i }),
    ).toBeInTheDocument();
  });

  it("dismisses a pending connection and ignores its late success", async () => {
    let resolveConnection: (value: {
      incarnation: string;
      generation: number;
    }) => void = () => {};
    mockConnectRemoteHost.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConnection = resolve;
        }),
    );
    const user = userEvent.setup();
    const onHostChange = vi.fn();
    render(
      <RemoteHostSelector selectedHost={null} onHostChange={onHostChange} />,
    );

    await user.click(screen.getByRole("button", { name: /select computer/i }));
    await user.click(screen.getByRole("menuitem", { name: /add ssh host/i }));
    await user.type(
      screen.getByRole("textbox", { name: /ssh host/i }),
      "slow-box",
    );
    await user.click(screen.getByRole("button", { name: /^connect$/i }));
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(
      screen.queryByRole("dialog", { name: /add ssh host/i }),
    ).not.toBeInTheDocument();

    resolveConnection({ incarnation: "slot-slow", generation: 1 });
    await waitFor(() => {
      expect(
        useRemoteHostStore.getState().statusByHost["slow-box"]?.state,
      ).toBe("ready");
    });
    expect(onHostChange).not.toHaveBeenCalled();
  });

  it("does not select a connection lifecycle superseded while the dialog waits", async () => {
    const resolvers: Array<
      (value: { incarnation: string; generation: number }) => void
    > = [];
    mockConnectRemoteHost.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const user = userEvent.setup();
    const onHostChange = vi.fn();
    render(
      <RemoteHostSelector selectedHost={null} onHostChange={onHostChange} />,
    );

    await user.click(screen.getByRole("button", { name: /select computer/i }));
    await user.click(screen.getByRole("menuitem", { name: /add ssh host/i }));
    await user.type(
      screen.getByRole("textbox", { name: /ssh host/i }),
      "superseded-box",
    );
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    const replacement = useRemoteHostStore
      .getState()
      .ensureHostConnected("superseded-box");
    await waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]?.({ incarnation: "slot-new", generation: 2 });
    await expect(replacement).resolves.toBe("connected");
    resolvers[0]?.({ incarnation: "slot-old", generation: 1 });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /^connect$/i }),
      ).not.toBeDisabled();
    });
    expect(onHostChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: /add ssh host/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This SSH connection changed while connecting. Try again or cancel.",
    );
    expect(screen.getByRole("button", { name: /^connect$/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^cancel$/i })).toBeEnabled();
    expect(
      useRemoteHostStore.getState().statusByHost["superseded-box"],
    ).toEqual({
      state: "ready",
      incarnation: "slot-new",
      generation: 2,
    });
  });
});
