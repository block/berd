import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteDirectoryPicker } from "../RemoteDirectoryPicker";
import {
  REMOTE_HOST_RECENT_DIRS_STORAGE_KEY,
  useRemoteHostStore,
} from "@/features/remoteHosts/stores/remoteHostStore";

const mockListRemoteDirs = vi.fn();

vi.mock("@/shared/api/remoteHosts", () => ({
  listSshConfigHosts: vi.fn().mockResolvedValue([]),
  connectRemoteHost: vi.fn(),
  disconnectRemoteHost: vi.fn(),
  shutdownRemoteHost: vi.fn(),
  listRemoteBackends: vi.fn().mockResolvedValue([]),
  checkRemoteHost: vi.fn(),
  listRemoteDirs: (...args: unknown[]) => mockListRemoteDirs(...args),
  listenRemoteBackendStatus: vi.fn().mockResolvedValue(() => {}),
  isRemoteBackendError: (candidate: unknown) =>
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { kind?: unknown }).kind === "string" &&
    typeof (candidate as { message?: unknown }).message === "string",
}));

describe("RemoteDirectoryPicker", () => {
  beforeEach(() => {
    window.localStorage.removeItem(REMOTE_HOST_RECENT_DIRS_STORAGE_KEY);
    useRemoteHostStore.setState({ recentDirsByHost: {} });
    mockListRemoteDirs.mockReset();
  });

  it("browses from home, descends into subfolders, and confirms a folder", async () => {
    mockListRemoteDirs
      .mockResolvedValueOnce({
        resolvedPath: "/home/dev",
        entries: [
          { name: "projects", isDir: true },
          { name: "notes.txt", isDir: false },
        ],
      })
      .mockResolvedValueOnce({
        resolvedPath: "/home/dev/projects",
        entries: [],
      });
    const user = userEvent.setup();
    const onDirChange = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <RemoteDirectoryPicker
        host="devbox"
        selectedDir={null}
        onDirChange={onDirChange}
        open
        onOpenChange={onOpenChange}
      />,
    );

    await waitFor(() =>
      expect(mockListRemoteDirs).toHaveBeenCalledWith("devbox", "~"),
    );
    // Files are not offered; only directories are.
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /projects/i }));
    await waitFor(() =>
      expect(mockListRemoteDirs).toHaveBeenCalledWith(
        "devbox",
        "/home/dev/projects",
      ),
    );

    await user.click(screen.getByRole("button", { name: /use this folder/i }));
    expect(onDirChange).toHaveBeenCalledWith("/home/dev/projects");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(useRemoteHostStore.getState().recentDirsByHost.devbox).toContain(
      "/home/dev/projects",
    );
  });

  it("shows recent folders and browses into one on click", async () => {
    useRemoteHostStore.setState({
      recentDirsByHost: { devbox: ["/srv/app"] },
    });
    mockListRemoteDirs
      .mockResolvedValueOnce({ resolvedPath: "/home/dev", entries: [] })
      .mockResolvedValueOnce({ resolvedPath: "/srv/app", entries: [] });
    const user = userEvent.setup();

    render(
      <RemoteDirectoryPicker
        host="devbox"
        selectedDir={null}
        onDirChange={vi.fn()}
        open
        onOpenChange={vi.fn()}
      />,
    );

    expect(await screen.findByText("Recent folders")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "/srv/app" }));
    await waitFor(() =>
      expect(mockListRemoteDirs).toHaveBeenCalledWith("devbox", "/srv/app"),
    );
  });

  it("surfaces listRemoteDirs errors inline", async () => {
    mockListRemoteDirs.mockRejectedValueOnce({
      kind: "host-unreachable",
      message: "ssh: connect to host devbox port 22: Connection refused",
    });

    render(
      <RemoteDirectoryPicker
        host="devbox"
        selectedDir={null}
        onDirChange={vi.fn()}
        open
        onOpenChange={vi.fn()}
      />,
    );

    expect(await screen.findByText(/connection refused/i)).toBeInTheDocument();
    // Without a successful listing there is nothing to confirm.
    expect(
      screen.getByRole("button", { name: /use this folder/i }),
    ).toBeDisabled();
  });
});
