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
    expect(screen.queryByText(/monitor running/)).toBeNull();
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
    expect(await screen.findByText("2 monitors running")).toBeInTheDocument();
    expect(screen.getByText("1 monitor running")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("shows the count and monitor labels in a tooltip", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue([
      { sessionId: "session-1", stateKey: "a", label: "Monitor A" },
      { sessionId: "session-1", stateKey: "b", label: "Monitor B" },
    ]);
    renderWithClient(
      <MonitorStatus sessionId="session-1" variant="composer" />,
    );
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

  it("hides stale status on fetch error", async () => {
    invoke
      .mockResolvedValueOnce([
        { sessionId: "session-1", stateKey: "a", label: "Monitor A" },
      ])
      .mockRejectedValueOnce(new Error("boom"));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <I18nProvider>
        <QueryClientProvider client={client}>
          <MonitorStatus sessionId="session-1" variant="composer" />
        </QueryClientProvider>
      </I18nProvider>,
    );
    expect(await screen.findByText("1 monitor running")).toBeInTheDocument();
    await client.invalidateQueries({ queryKey: ["running-monitors"] });
    await waitFor(() =>
      expect(screen.queryByText("1 monitor running")).not.toBeInTheDocument(),
    );
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
    expect(await screen.findByText("1 monitor running")).toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2), {
      timeout: 2_500,
    });
    await waitFor(() =>
      expect(screen.queryByText("1 monitor running")).not.toBeInTheDocument(),
    );
  }, 4_000);
});
