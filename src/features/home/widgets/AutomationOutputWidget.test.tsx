import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationTile } from "@/features/automations/api/kgooseAutomations";
import type { WidgetInstance } from "./types";
import { AutomationOutputWidget } from "./AutomationOutputWidget";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/shared/profile/capabilities", () => ({
  useProfileCapability: () => true,
}));

const mockedInvoke = vi.mocked(invoke);

function fullTile(overrides: Partial<AutomationTile> = {}): AutomationTile {
  return {
    id: "tile-1",
    title: "Daily digest",
    latestRunStatus: "TILE_RUN_STATUS_SUCCESS",
    lastSuccessAt: new Date(Date.now() - 60_000).toISOString(),
    latestRenderedData: { summary: "Fresh digest" },
    ...overrides,
  };
}

function instance(automationId: string): WidgetInstance {
  return {
    id: "automation-pin-1",
    type: "automationOutput",
    x: 20,
    y: 30,
    z: 1,
    state: { automationId },
  };
}

function renderPin(automationId: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }

  return render(
    <AutomationOutputWidget
      instance={instance(automationId)}
      onUpdateState={vi.fn()}
      onOpenAutomation={vi.fn()}
    />,
    { wrapper: Wrapper },
  );
}

describe("AutomationOutputWidget", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("renders run status and output from the list alone when it carries the rendered payload", async () => {
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "get_automation_tiles") {
        return Promise.resolve({ tiles: [fullTile()] });
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    renderPin("tile-1");

    expect(await screen.findByText("Fresh digest")).toBeVisible();
    expect(screen.getByText(/Completed/)).toBeVisible();
    // The whole home screen stays at one IPC call: a list entry with a
    // rendered payload must not trigger a per-pin detail fetch.
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith("get_automation_tiles");
  });

  it("confirms against the detail endpoint when the list entry lacks the rendered payload", async () => {
    // Simulates the list response being slimmed down to identity fields: the
    // run-outcome fields are all optional on AutomationTile, so without the
    // detail fallback this pin would silently render "Never run"/"No output".
    let resolveDetail: (value: unknown) => void = () => {};
    const detailGate = new Promise((resolve) => {
      resolveDetail = resolve;
    });
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "get_automation_tiles") {
        return Promise.resolve({
          tiles: [{ id: "tile-1", title: "Daily digest" }],
        });
      }
      if (cmd === "get_automation_tile") {
        return detailGate;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    renderPin("tile-1");

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("get_automation_tile", {
        id: "tile-1",
      });
    });
    // While the confirm fetch is in flight the slim entry is exactly the
    // state a slimmed payload fakes, so no run-outcome claim may render yet.
    expect(screen.queryByText(/Never run/)).not.toBeInTheDocument();
    expect(screen.queryByText("No output yet")).not.toBeInTheDocument();

    resolveDetail({ tileInfo: fullTile() });

    expect(await screen.findByText("Fresh digest")).toBeVisible();
    expect(screen.getByText(/Completed/)).toBeVisible();
  });

  it("renders never-run once the detail confirm returns the same bare fields", async () => {
    // A genuinely never-run tile is indistinguishable from a slimmed list
    // entry until the confirm fetch agrees; after it does, the bare state
    // must still render rather than staying stuck on the pending shell.
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "get_automation_tiles") {
        return Promise.resolve({
          tiles: [{ id: "tile-1", title: "Daily digest" }],
        });
      }
      if (cmd === "get_automation_tile") {
        return Promise.resolve({
          tileInfo: { id: "tile-1", title: "Daily digest" },
        });
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    renderPin("tile-1");

    expect(await screen.findByText(/Never run/)).toBeVisible();
    expect(screen.getByText("No output yet")).toBeVisible();
  });

  it("renders unavailable when the detail confirm fails with no cached snapshot", async () => {
    // An errored confirm fetch can't distinguish a slimmed payload from a
    // never-run tile, so the pin fails loudly instead of rendering the slim
    // entry's misleading state indefinitely.
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "get_automation_tiles") {
        return Promise.resolve({
          tiles: [{ id: "tile-1", title: "Daily digest" }],
        });
      }
      if (cmd === "get_automation_tile") {
        return Promise.reject(new Error("ipc down"));
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    renderPin("tile-1");

    expect(await screen.findByText("Unavailable")).toBeVisible();
    expect(screen.queryByText(/Never run/)).not.toBeInTheDocument();
    expect(screen.queryByText("No output yet")).not.toBeInTheDocument();
  });

  it("renders unavailable when the confirm returns an empty envelope for a slim list entry", async () => {
    // The confirm settling empty while the list still carries the slim entry
    // (tile deleted or no longer generic between the two calls) must fail
    // loudly, not fall back to the unverified slim fields.
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "get_automation_tiles") {
        return Promise.resolve({
          tiles: [{ id: "tile-1", title: "Daily digest" }],
        });
      }
      if (cmd === "get_automation_tile") {
        return Promise.resolve({});
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    renderPin("tile-1");

    expect(await screen.findByText("Unavailable")).toBeVisible();
    expect(screen.queryByText(/Never run/)).not.toBeInTheDocument();
    expect(screen.queryByText("No output yet")).not.toBeInTheDocument();
  });

  it("renders unavailable once the detail endpoint confirms a missing tile is gone", async () => {
    // A list that misses the pinned id is not proof the automation is gone,
    // so the pin only fails loudly after `get_automation_tile` agrees.
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "get_automation_tiles") {
        return Promise.resolve({ tiles: [] });
      }
      if (cmd === "get_automation_tile") {
        return Promise.resolve({});
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    renderPin("tile-gone");

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("get_automation_tile", {
        id: "tile-gone",
      });
    });
    expect(await screen.findByText("Unavailable")).toBeVisible();
  });

  it("recovers a pinned tile the list has not published yet from the detail endpoint", async () => {
    // Pinning straight off the detail page of a just-created automation beats
    // kgoose list propagation; the pin must render rather than claim the
    // automation is unavailable while the list catches up.
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "get_automation_tiles") {
        return Promise.resolve({ tiles: [] });
      }
      if (cmd === "get_automation_tile") {
        return Promise.resolve({ tileInfo: fullTile({ id: "tile-new" }) });
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    renderPin("tile-new");

    expect(await screen.findByText("Fresh digest")).toBeVisible();
    expect(screen.getByText(/Completed/)).toBeVisible();
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
  });

  it("shows no unavailable flash while the confirm for a missing tile is in flight", async () => {
    let resolveDetail: (value: unknown) => void = () => {};
    const detailGate = new Promise((resolve) => {
      resolveDetail = resolve;
    });
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "get_automation_tiles") {
        return Promise.resolve({ tiles: [] });
      }
      if (cmd === "get_automation_tile") {
        return detailGate;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    renderPin("tile-new");

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("get_automation_tile", {
        id: "tile-new",
      });
    });
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText(/Never run/)).not.toBeInTheDocument();

    resolveDetail({ tileInfo: fullTile({ id: "tile-new" }) });

    expect(await screen.findByText("Fresh digest")).toBeVisible();
  });
});
