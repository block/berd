import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteHostSelector } from "../RemoteHostSelector";
import { useRemoteHostStore } from "@/features/remoteHosts/stores/remoteHostStore";

const mockListSshConfigHosts = vi.fn();

vi.mock("@/shared/api/remoteHosts", () => ({
  listSshConfigHosts: (...args: unknown[]) => mockListSshConfigHosts(...args),
  connectRemoteHost: vi.fn(),
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
    useRemoteHostStore.setState({
      configHosts: ["devbox", "gpu-box"],
      statusByHost: { devbox: { state: "ready" } },
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
});
