import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/shared/i18n/I18nProvider";
import { TOOLTIP_DELAY } from "@/shared/ui/tooltip-delay";
import { MonitorStatus } from "./MonitorStatus";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <I18nProvider>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </I18nProvider>,
  );
}

describe("MonitorStatus", () => {
  beforeEach(() => invoke.mockReset());

  it("renders nothing when there are no monitors for the session", async () => {
    invoke.mockResolvedValue([
      { sessionId: "other", stateKey: "a", label: "Other" },
    ]);
    renderWithClient(
      <MonitorStatus sessionId="session-1" variant="composer" />,
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("get_running_monitors"),
    );
    expect(screen.queryByRole("button", { name: /Inspect/ })).toBeNull();
  });

  it("deduplicates multiple session consumers onto one fetch and filters per session", async () => {
    invoke.mockResolvedValue([
      { sessionId: "session-1", stateKey: "a", label: "Monitor A" },
      { sessionId: "session-1", stateKey: "b", label: "Monitor B" },
      { sessionId: "session-2", stateKey: "c", label: "Monitor C" },
    ]);
    renderWithClient(
      <>
        <MonitorStatus sessionId="session-1" variant="composer" />
        <MonitorStatus sessionId="session-2" variant="composer" />
      </>,
    );
    expect(
      await screen.findByRole("button", { name: "Inspect 2 running monitors" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Inspect 1 running monitor" }),
    ).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("shows the sidebar count and monitor labels in a tooltip", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue([
      { sessionId: "session-1", stateKey: "a", label: "Monitor A" },
      { sessionId: "session-1", stateKey: "b", label: "Monitor B" },
    ]);
    renderWithClient(<MonitorStatus sessionId="session-1" variant="sidebar" />);
    const status = await screen.findByRole("img", {
      name: "2 monitors running",
    });
    await user.hover(status);
    const tooltip = await screen.findByRole("tooltip", undefined, {
      timeout: TOOLTIP_DELAY.restedHover + 1_000,
    });
    expect(within(tooltip).getByText(/Monitor A/)).toBeInTheDocument();
    expect(within(tooltip).getByText(/Monitor B/)).toBeInTheDocument();
  });

  it("preserves confirmed monitors and stop controls on refresh failure, then clears on confirmed exit", async () => {
    let result: "running" | "error" | "empty" = "running";
    invoke.mockImplementation((command: string) => {
      if (command !== "get_running_monitors") return Promise.resolve();
      if (result === "error") return Promise.reject(new Error("scan failed"));
      return Promise.resolve(result === "empty" ? [] : [buildMonitor]);
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <QueryClientProvider client={client}>
          <MonitorStatus sessionId="session-1" variant="sidebar" />
          <MonitorStatus sessionId="session-1" variant="composer" />
        </QueryClientProvider>
      </I18nProvider>,
    );
    const trigger = await screen.findByRole("button", {
      name: "Inspect 1 running monitor",
    });
    const eye = screen.getByRole("img", { name: "1 monitor running" });
    result = "error";
    await client.invalidateQueries({ queryKey: ["running-monitors"] });
    expect(client.getQueryState(["running-monitors"])?.status).toBe("error");
    expect(trigger).toBeInTheDocument();
    expect(eye).toBeInTheDocument();
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await user.click(screen.getByRole("button", { name: "Stop monitor" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("stop_running_monitor", {
        sessionId: buildMonitor.sessionId,
        stateKey: buildMonitor.stateKey,
        instanceId: buildMonitor.instanceId,
      }),
    );
    result = "empty";
    await client.invalidateQueries({ queryKey: ["running-monitors"] });
    await waitFor(() => expect(trigger).not.toBeInTheDocument());
    expect(eye).not.toBeInTheDocument();
  });

  it("shows no monitors on failed cold load", async () => {
    invoke.mockImplementation((command: string) =>
      command === "get_running_monitors"
        ? Promise.reject(new Error("scan failed"))
        : Promise.resolve(),
    );
    renderWithClient(
      <MonitorStatus sessionId="session-1" variant="composer" />,
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("get_running_monitors"),
    );
    expect(screen.queryByRole("button", { name: /Inspect/ })).toBeNull();
  });

  it("polls and clears when monitors stop", async () => {
    invoke
      .mockResolvedValueOnce([
        { sessionId: "session-1", stateKey: "a", label: "Monitor A" },
      ])
      .mockResolvedValueOnce([]);
    renderWithClient(
      <MonitorStatus sessionId="session-1" variant="composer" />,
    );
    expect(
      await screen.findByRole("button", { name: "Inspect 1 running monitor" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2), {
      timeout: 2_500,
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Inspect 1 running monitor" }),
      ).not.toBeInTheDocument(),
    );
  }, 4_000);
});

const buildMonitor = {
  sessionId: "session-1",
  stateKey: "build",
  instanceId: "build-instance",
  label: "Build watcher",
  command: ["cargo", "test", "--workspace"],
  startedAt: 1793286000000,
  stopping: false,
};

async function inspectBuild() {
  const user = userEvent.setup();
  renderWithClient(<MonitorStatus sessionId="session-1" variant="composer" />);
  await user.click(
    await screen.findByRole("button", { name: "Inspect 1 running monitor" }),
  );
  return user;
}

describe("monitor inspector", () => {
  beforeEach(() => invoke.mockReset());

  it("shows command, start time and running status; cancel leaves it running", async () => {
    invoke.mockResolvedValue([buildMonitor]);
    const user = await inspectBuild();
    const panel = screen.getByRole("dialog", { name: "Running monitors" });
    expect(
      within(panel).getByText('"cargo" "test" "--workspace"'),
    ).toBeInTheDocument();
    expect(within(panel).getByText("Started")).toBeInTheDocument();
    expect(within(panel).getByText("Running")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Stop" }));
    expect(
      within(panel).getByText(/agent session will keep running/),
    ).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(
      invoke.mock.calls.every(
        ([command]) => command !== "stop_running_monitor",
      ),
    ).toBe(true);
  });

  it("stops the displayed instance only after confirmation and keeps stopping until observed gone", async () => {
    let monitors = [buildMonitor];
    invoke.mockImplementation((command: string) =>
      command === "get_running_monitors"
        ? Promise.resolve(monitors)
        : Promise.resolve(),
    );
    const user = await inspectBuild();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(
      invoke.mock.calls.some(([command]) => command === "stop_running_monitor"),
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "Stop monitor" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("stop_running_monitor", {
        sessionId: "session-1",
        stateKey: "build",
        instanceId: "build-instance",
      }),
    );
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Inspect 1 running monitor" }),
    ).toBeInTheDocument();
    monitors = [];
    await waitFor(
      () =>
        expect(
          screen.queryByRole("button", { name: "Inspect 1 running monitor" }),
        ).not.toBeInTheDocument(),
      { timeout: 2500 },
    );
  });

  it("shows a stop failure without hiding the monitor and permits retry", async () => {
    invoke.mockImplementation((command: string) =>
      command === "get_running_monitors"
        ? Promise.resolve([buildMonitor])
        : command === "stop_running_monitor"
          ? Promise.reject(new Error("replaced"))
          : Promise.resolve(),
    );
    const user = await inspectBuild();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await user.click(screen.getByRole("button", { name: "Stop monitor" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not stop",
    );
    expect(screen.getByRole("button", { name: "Stop monitor" })).toBeEnabled();
  });

  it("supports older descriptors without command or time and disables duplicate stop requests", async () => {
    invoke.mockResolvedValue([
      {
        sessionId: "session-1",
        stateKey: "build",
        instanceId: "old-instance",
        label: "Old watcher",
        stopping: true,
      },
    ]);
    const user = await inspectBuild();
    expect(screen.getAllByText("Unavailable for this monitor")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Stopping…" }));
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    expect(
      invoke.mock.calls.every(
        ([command]) => command !== "stop_running_monitor",
      ),
    ).toBe(true);
  });
});
