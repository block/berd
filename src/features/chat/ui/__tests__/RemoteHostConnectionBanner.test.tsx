import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRemoteHostStore } from "@/features/remoteHosts/stores/remoteHostStore";
import { RemoteHostConnectionBanner } from "../RemoteHostConnectionBanner";

const loadSessionMessages = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@/features/chat/lib/sessionActivation", () => ({
  loadSessionMessages,
}));

const HOST = "blox";

function setHostState(
  state: "connecting" | "ready" | "reconnecting" | "disconnected" | "failed",
  error?: { kind: string; message: string },
) {
  useRemoteHostStore.setState((current) => ({
    statusByHost: {
      ...current.statusByHost,
      [HOST]: { state, ...(error ? { error } : {}) },
    },
  }));
}

function clearHostState() {
  useRemoteHostStore.setState((current) => {
    const statusByHost = { ...current.statusByHost };
    delete statusByHost[HOST];
    return { statusByHost };
  });
}

describe("RemoteHostConnectionBanner", () => {
  afterEach(() => {
    clearHostState();
    loadSessionMessages.mockClear();
  });

  it("treats a host with no status entry as disconnected", () => {
    render(<RemoteHostConnectionBanner host={HOST} sessionId="s1" />);

    expect(screen.getByText("Disconnected from blox")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reconnect" }),
    ).toBeInTheDocument();
  });

  it("renders nothing while the host is ready", () => {
    setHostState("ready");
    const { container } = render(
      <RemoteHostConnectionBanner host={HOST} sessionId="s1" />,
    );

    expect(container.querySelector("[data-remote-host-banner]")).toBeNull();
  });

  it("shows automatic reconnect progress without a button", () => {
    setHostState("reconnecting");
    render(<RemoteHostConnectionBanner host={HOST} sessionId="s1" />);

    expect(screen.getByText("Reconnecting to blox...")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });

  it("shows the failure detail and offers a retry", () => {
    setHostState("failed", { kind: "hostUnreachable", message: "no route" });
    render(<RemoteHostConnectionBanner host={HOST} sessionId="s1" />);

    expect(screen.getByText("Couldn't connect to blox")).toBeInTheDocument();
    expect(screen.getByText("no route")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reconnect" }),
    ).toBeInTheDocument();
  });

  it("reconnects the host and reloads the session transcript", async () => {
    const ensureHostConnected = vi.fn(async () => {
      setHostState("ready");
      return "connected" as const;
    });
    const original = useRemoteHostStore.getState().ensureHostConnected;
    useRemoteHostStore.setState({ ensureHostConnected });
    try {
      render(<RemoteHostConnectionBanner host={HOST} sessionId="s1" />);

      await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));

      expect(ensureHostConnected).toHaveBeenCalledWith(HOST);
      await waitFor(() => {
        expect(loadSessionMessages).toHaveBeenCalledWith("s1");
      });
    } finally {
      useRemoteHostStore.setState({ ensureHostConnected: original });
    }
  });

  it("does not reload the transcript when reconnecting fails", async () => {
    const ensureHostConnected = vi.fn(async () => {
      setHostState("failed", { kind: "hostUnreachable", message: "no route" });
      throw new Error("no route");
    });
    const original = useRemoteHostStore.getState().ensureHostConnected;
    useRemoteHostStore.setState({ ensureHostConnected });
    try {
      render(<RemoteHostConnectionBanner host={HOST} sessionId="s1" />);

      await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));

      await waitFor(() => {
        expect(screen.getByText("Couldn't connect to blox")).toBeVisible();
      });
      expect(loadSessionMessages).not.toHaveBeenCalled();
    } finally {
      useRemoteHostStore.setState({ ensureHostConnected: original });
    }
  });
});
