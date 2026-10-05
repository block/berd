import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const search = vi.hoisted(() => vi.fn());
vi.mock("@/shared/api/messageSearch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/messageSearch")>()),
  searchMessagesPage: search,
}));
import { useMessageSearch } from "../useMessageSearch";
import {
  MessageSearchTimeoutError,
  type MessageSearchMatch,
} from "@/shared/api/messageSearch";
const match: MessageSearchMatch = {
  sessionId: "unloaded",
  title: "Synthetic",
  archivedAt: null,
  workingDir: "/synthetic/project",
  updatedAt: "2026-01-02T00:00:00Z",
  messageCreatedAt: "2026-01-01T00:00:00Z",
  messageId: "m1",
  messageIndex: 0,
  role: "assistant",
  snippet: "needle",
  matchCount: 1,
};
beforeEach(() => vi.resetAllMocks());
describe("useMessageSearch", () => {
  it("runs only when Messages is enabled and the query is nonempty", async () => {
    search.mockResolvedValue({ matches: [], complete: true, nextCursor: null });
    const { result, rerender } = renderHook(
      ({ enabled, query }) => useMessageSearch({ query, enabled }),
      { initialProps: { query: "needle", enabled: false } },
    );
    expect(result.current.status).toBe("idle");
    expect(search).not.toHaveBeenCalled();
    rerender({ query: "needle", enabled: true });
    await waitFor(() => expect(result.current.status).toBe("complete"));
    expect(search).toHaveBeenCalledTimes(1);
    rerender({ query: "", enabled: true });
    expect(result.current.results).toEqual([]);
    expect(result.current.status).toBe("idle");
  });
  it("does not commit a late reply from a changed query, even before debounce", async () => {
    let finish: (page: unknown) => void = () => {};
    search
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValueOnce({
        matches: [{ ...match, messageId: "new" }],
        complete: true,
        nextCursor: null,
      });
    const { result, rerender } = renderHook(
      ({ query }) => useMessageSearch({ query }),
      { initialProps: { query: "old" } },
    );
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    rerender({ query: "new" });
    await act(async () =>
      finish({ matches: [match], complete: true, nextCursor: null }),
    );
    expect(result.current.results).toEqual([]);
    await waitFor(() =>
      expect(result.current.results[0]?.messageId).toBe("new"),
    );
    expect(search.mock.calls[0][0].signal.aborted).toBe(true);
  });
  it("preserves multiple message hits per session, deduplicates overlap, and settles last-page completeness", async () => {
    search
      .mockResolvedValueOnce({
        matches: [match],
        complete: true,
        nextCursor: "next",
      })
      .mockResolvedValueOnce({
        matches: [match, { ...match, messageId: "m2" }],
        complete: true,
        nextCursor: null,
      });
    const { result } = renderHook(() => useMessageSearch({ query: "needle" }));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    expect(result.current.status).toBe("complete");
    act(() => result.current.loadMore());
    await waitFor(() =>
      expect(result.current.results.map((m) => m.messageId)).toEqual([
        "m1",
        "m2",
      ]),
    );
    expect(result.current.status).toBe("complete");
  });
  it("preserves omitted-content partial coverage across later successful pages", async () => {
    search
      .mockResolvedValueOnce({
        matches: [match],
        complete: false,
        nextCursor: "next",
      })
      .mockResolvedValueOnce({ matches: [], complete: true, nextCursor: null });
    const { result } = renderHook(() => useMessageSearch({ query: "needle" }));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.hasMore).toBe(false));
    expect(result.current.status).toBe("partial");
  });

  it("reports timeout/error/partial separately from an authoritative zero and retries", async () => {
    search
      .mockRejectedValueOnce(new MessageSearchTimeoutError())
      .mockResolvedValueOnce({
        matches: [],
        complete: false,
        nextCursor: null,
      });
    const { result } = renderHook(() => useMessageSearch({ query: "needle" }));
    await waitFor(() => expect(result.current.status).toBe("timeout"));
    expect(result.current.error).toContain("timed out");
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("partial"));
    expect(result.current.error).toBeNull();
  });
  it("cancels a pending debounce before launching a read", async () => {
    const { result } = renderHook(() => useMessageSearch({ query: "needle" }));
    act(() => result.current.cancel());
    await act(() => new Promise((resolve) => setTimeout(resolve, 210)));
    expect(search).not.toHaveBeenCalled();
  });

  it("cancels an in-flight query without accepting its late matches", async () => {
    let finish: (page: unknown) => void = () => {};
    search.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result } = renderHook(() => useMessageSearch({ query: "needle" }));
    await waitFor(() => expect(result.current.isLoading).toBe(true));
    act(() => result.current.cancel());
    await act(async () =>
      finish({ matches: [match], complete: true, nextCursor: null }),
    );
    expect(result.current.isLoading).toBe(false);
    expect(result.current.results).toEqual([]);
    expect(result.current.status).toBe("partial");
  });
  it("keeps successful pages on a failed next page, and rejects repeated cursors", async () => {
    search
      .mockResolvedValueOnce({
        matches: [match],
        complete: true,
        nextCursor: "next",
      })
      .mockResolvedValueOnce({
        matches: [],
        complete: true,
        nextCursor: "next",
      });
    const { result } = renderHook(() => useMessageSearch({ query: "needle" }));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toContain("Repeated");
    expect(result.current.results).toEqual([match]);
  });
});
