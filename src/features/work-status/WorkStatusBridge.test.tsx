import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkStatusSnapshot } from "./types";
import { WorkStatusBridge } from "./WorkStatusBridge";
import { WORK_STATUS_REFRESH_EVENT } from "./workStatusNative";
import {
  EMPTY_WORK_STATUS_SNAPSHOT,
  useWorkStatusStore,
} from "./workStatusStore";

const buildWorkStatusSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("./workStatusData", () => ({
  buildWorkStatusSnapshot: buildWorkStatusSnapshotMock,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function snapshot(title: string): WorkStatusSnapshot {
  return {
    chats: [],
    errors: [],
    isFresh: true,
    isTruncated: false,
    pullRequests: [
      {
        id: title,
        title,
        groupName: "squareup/berd",
        source: "github",
        status: "draft",
        updatedAt: "2026-08-07T00:00:00.000Z",
        destination: {
          type: "url",
          url: "https://github.com/squareup/berd/pull/1",
        },
      },
    ],
  };
}

describe("WorkStatusBridge", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    useWorkStatusStore.setState({
      snapshot: EMPTY_WORK_STATUS_SNAPSHOT,
      pullRequestsRefreshedAt: null,
      isManualRefreshPending: false,
      lastManualRefreshSucceeded: null,
    });
  });

  it("does not request data while the PR Inbox is closed", async () => {
    const { rerender } = render(<WorkStatusBridge active={false} />);

    expect(buildWorkStatusSnapshotMock).not.toHaveBeenCalled();

    rerender(<WorkStatusBridge active />);
    await waitFor(() =>
      expect(buildWorkStatusSnapshotMock).toHaveBeenCalledTimes(1),
    );

    rerender(<WorkStatusBridge active={false} />);
    act(() => {
      window.dispatchEvent(new CustomEvent(WORK_STATUS_REFRESH_EVENT));
    });
    expect(buildWorkStatusSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("polls only while the PR Inbox is open", async () => {
    vi.useFakeTimers();
    buildWorkStatusSnapshotMock.mockResolvedValue(snapshot("current"));
    const { rerender } = render(<WorkStatusBridge active />);

    await act(async () => Promise.resolve());
    expect(buildWorkStatusSnapshotMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(buildWorkStatusSnapshotMock).toHaveBeenCalledTimes(2);

    rerender(<WorkStatusBridge active={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(buildWorkStatusSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it("pauses while hidden and refreshes immediately when visible again", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibilityState,
    );
    buildWorkStatusSnapshotMock.mockResolvedValue(snapshot("current"));
    render(<WorkStatusBridge active />);
    await waitFor(() =>
      expect(buildWorkStatusSnapshotMock).toHaveBeenCalledTimes(1),
    );

    visibilityState = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => {
      window.dispatchEvent(new CustomEvent(WORK_STATUS_REFRESH_EVENT));
    });
    expect(buildWorkStatusSnapshotMock).toHaveBeenCalledTimes(1);

    visibilityState = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() =>
      expect(buildWorkStatusSnapshotMock).toHaveBeenCalledTimes(2),
    );
  });

  it("refreshes immediately each time the PR Inbox opens", async () => {
    buildWorkStatusSnapshotMock.mockResolvedValue(snapshot("current"));
    const { rerender } = render(<WorkStatusBridge active={false} />);

    rerender(<WorkStatusBridge active />);
    await waitFor(() =>
      expect(buildWorkStatusSnapshotMock).toHaveBeenCalledTimes(1),
    );

    rerender(<WorkStatusBridge active={false} />);
    rerender(<WorkStatusBridge active />);
    await waitFor(() =>
      expect(buildWorkStatusSnapshotMock).toHaveBeenCalledTimes(2),
    );
  });

  it("reports a rejected manual refresh as failed without advancing freshness", async () => {
    const initial = deferred<WorkStatusSnapshot>();
    const manualRefresh = deferred<WorkStatusSnapshot>();
    buildWorkStatusSnapshotMock
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(manualRefresh.promise);

    render(<WorkStatusBridge active />);
    await waitFor(() =>
      expect(buildWorkStatusSnapshotMock).toHaveBeenCalledTimes(1),
    );

    await act(async () => initial.resolve(snapshot("initial")));
    const refreshedAt = useWorkStatusStore.getState().pullRequestsRefreshedAt;
    expect(refreshedAt).not.toBeNull();

    act(() => {
      useWorkStatusStore.getState().setManualRefreshPending(true);
      window.dispatchEvent(new CustomEvent(WORK_STATUS_REFRESH_EVENT));
    });
    await waitFor(() =>
      expect(buildWorkStatusSnapshotMock).toHaveBeenCalledTimes(2),
    );

    await act(async () =>
      manualRefresh.reject(new Error("malformed response")),
    );

    expect(useWorkStatusStore.getState()).toMatchObject({
      isManualRefreshPending: false,
      lastManualRefreshSucceeded: false,
      pullRequestsRefreshedAt: refreshedAt,
    });
    expect(useWorkStatusStore.getState().snapshot.pullRequests[0]?.title).toBe(
      "initial",
    );
  });

  it("runs a queued manual refresh after an automatic request rejects", async () => {
    const initial = deferred<WorkStatusSnapshot>();
    const manualRefresh = deferred<WorkStatusSnapshot>();
    buildWorkStatusSnapshotMock
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(manualRefresh.promise);

    render(<WorkStatusBridge active />);
    await waitFor(() =>
      expect(buildWorkStatusSnapshotMock).toHaveBeenCalledTimes(1),
    );

    act(() => {
      useWorkStatusStore.getState().setManualRefreshPending(true);
      window.dispatchEvent(new CustomEvent(WORK_STATUS_REFRESH_EVENT));
    });

    await act(async () => initial.reject(new Error("automatic failure")));
    await waitFor(() =>
      expect(buildWorkStatusSnapshotMock).toHaveBeenCalledTimes(2),
    );
    expect(useWorkStatusStore.getState().isManualRefreshPending).toBe(true);

    await act(async () => manualRefresh.resolve(snapshot("manual")));
    expect(useWorkStatusStore.getState()).toMatchObject({
      isManualRefreshPending: false,
      lastManualRefreshSucceeded: true,
    });
    expect(useWorkStatusStore.getState().snapshot.pullRequests[0]?.title).toBe(
      "manual",
    );
  });

  it("coalesces clicks during an active refresh into one follow-up request", async () => {
    const initial = deferred<WorkStatusSnapshot>();
    const followUp = deferred<WorkStatusSnapshot>();
    buildWorkStatusSnapshotMock
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(followUp.promise);

    render(<WorkStatusBridge active />);
    await waitFor(() =>
      expect(buildWorkStatusSnapshotMock).toHaveBeenCalledTimes(1),
    );

    act(() => {
      useWorkStatusStore.getState().setManualRefreshPending(true);
      window.dispatchEvent(new CustomEvent(WORK_STATUS_REFRESH_EVENT));
      window.dispatchEvent(new CustomEvent(WORK_STATUS_REFRESH_EVENT));
    });
    expect(useWorkStatusStore.getState().isManualRefreshPending).toBe(true);

    await act(async () => initial.resolve(snapshot("initial")));
    await waitFor(() =>
      expect(buildWorkStatusSnapshotMock).toHaveBeenCalledTimes(2),
    );
    expect(useWorkStatusStore.getState().isManualRefreshPending).toBe(true);

    await act(async () => followUp.resolve(snapshot("follow-up")));
    expect(useWorkStatusStore.getState().snapshot.pullRequests[0]?.title).toBe(
      "follow-up",
    );
    expect(useWorkStatusStore.getState().isManualRefreshPending).toBe(false);
    expect(useWorkStatusStore.getState().lastManualRefreshSucceeded).toBe(true);
  });
});
