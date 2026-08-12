import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const mockGetGitState = vi.fn();
vi.mock("@/shared/api/git", () => ({
  getGitState: (...args: unknown[]) => mockGetGitState(...args),
}));

describe("useHomeDir", () => {
  beforeEach(() => {
    // The shared home-dir slot/cache lives in module state; reset so each
    // test observes a fresh, unresolved store.
    vi.resetModules();
    mockInvoke.mockReset();
    mockGetGitState.mockReset();
  });

  it("shares one lookup and updates every mounted consumer", async () => {
    mockInvoke.mockResolvedValue("/Users/test");
    const { useHomeDir } = await import("./useHomeDir");

    function Probe({ testId }: { testId: string }) {
      const homeDir = useHomeDir();
      return <div data-testid={testId}>{homeDir ?? "pending"}</div>;
    }

    render(
      <>
        <Probe testId="first" />
        <Probe testId="second" />
      </>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("first")).toHaveTextContent("/Users/test");
      expect(screen.getByTestId("second")).toHaveTextContent("/Users/test");
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("recovers a mounted ~-path git observer once a later lookup succeeds after a transient failure", async () => {
    mockInvoke
      .mockRejectedValueOnce(new Error("ipc bridge unavailable"))
      .mockResolvedValue("/Users/test");
    mockGetGitState.mockResolvedValue(null);

    const { useHomeDir } = await import("./useHomeDir");
    const { useGitState } = await import("./useGitState");

    function GitObserver() {
      useGitState("~/project");
      return null;
    }
    function LaterConsumer() {
      useHomeDir();
      return null;
    }

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <GitObserver />
      </QueryClientProvider>,
    );

    // The first lookup fails; the home-relative observer stays disabled
    // rather than fetching the raw `~` spelling.
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("get_home_dir"),
    );
    expect(mockGetGitState).not.toHaveBeenCalled();

    // A later consumer mounts, retrying the (cleared) shared lookup. Its
    // success must reach the still-mounted original observer, which then
    // queries under the expanded path.
    rerender(
      <QueryClientProvider client={queryClient}>
        <GitObserver />
        <LaterConsumer />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(mockGetGitState).toHaveBeenCalledWith("/Users/test/project"),
    );
    expect(mockGetGitState).not.toHaveBeenCalledWith("~/project");
  });
});
