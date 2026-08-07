import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_TILES_QUERY_KEY,
  AUTOMATION_TILES_STALE_TIME_MS,
  fetchAutomationTilesList,
  invalidateAutomationTileQueries,
} from "./automationTilesQuery";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

// The shape every list consumer (AutomationsView, pin widgets, Cmd-K search,
// widget picker) uses: shared key + shared fetcher.
function useAutomationTilesListForTest() {
  return useQuery({
    queryKey: AUTOMATION_TILES_QUERY_KEY,
    queryFn: fetchAutomationTilesList,
    staleTime: AUTOMATION_TILES_STALE_TIME_MS,
  });
}

describe("automationTilesQuery", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("deduplicates the fetch across consumers and invalidation reaches both", async () => {
    mockedInvoke.mockResolvedValue({
      tiles: [{ id: "tile-1", title: "Daily digest" }],
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = createWrapper(queryClient);

    // Two simultaneous consumers on the shared key — e.g. a home pin widget
    // and Cmd-K search — must coalesce into one get_automation_tiles call.
    const first = renderHook(() => useAutomationTilesListForTest(), {
      wrapper,
    });
    const second = renderHook(() => useAutomationTilesListForTest(), {
      wrapper,
    });

    await waitFor(() => {
      expect(first.result.current.data).toEqual([
        { id: "tile-1", title: "Daily digest" },
      ]);
      expect(second.result.current.data).toEqual([
        { id: "tile-1", title: "Daily digest" },
      ]);
    });
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke).toHaveBeenCalledWith("get_automation_tiles");

    // A tile mutation invalidating through the shared helper must refetch for
    // every observer — the regression this module exists to prevent is a
    // consumer minting its own key spelling and silently escaping this sweep.
    mockedInvoke.mockResolvedValue({
      tiles: [{ id: "tile-1", title: "Renamed digest" }],
    });
    await invalidateAutomationTileQueries(queryClient);

    await waitFor(() => {
      expect(first.result.current.data).toEqual([
        { id: "tile-1", title: "Renamed digest" },
      ]);
      expect(second.result.current.data).toEqual([
        { id: "tile-1", title: "Renamed digest" },
      ]);
    });
    expect(mockedInvoke).toHaveBeenCalledTimes(2);
  });
});
