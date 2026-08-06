import { create } from "zustand";
import type { WorkStatusSnapshot } from "./types";

interface WorkStatusState {
  snapshot: WorkStatusSnapshot;
  pullRequestsRefreshedAt: string | null;
  isManualRefreshPending: boolean;
  lastManualRefreshSucceeded: boolean | null;
  publishSnapshot: (snapshot: WorkStatusSnapshot) => void;
  resetSnapshot: () => void;
  setManualRefreshOutcome: (succeeded: boolean | null) => void;
  setManualRefreshPending: (pending: boolean) => void;
}

export const EMPTY_WORK_STATUS_SNAPSHOT: WorkStatusSnapshot = {
  chats: [],
  pullRequests: [],
  errors: [],
  isFresh: false,
  isTruncated: false,
};

export const useWorkStatusStore = create<WorkStatusState>((set) => ({
  snapshot: EMPTY_WORK_STATUS_SNAPSHOT,
  pullRequestsRefreshedAt: null,
  isManualRefreshPending: false,
  lastManualRefreshSucceeded: null,
  publishSnapshot: (snapshot) =>
    set((state) => ({
      snapshot,
      pullRequestsRefreshedAt: snapshot.isFresh
        ? new Date().toISOString()
        : state.pullRequestsRefreshedAt,
    })),
  resetSnapshot: () =>
    set({
      snapshot: EMPTY_WORK_STATUS_SNAPSHOT,
      pullRequestsRefreshedAt: null,
      isManualRefreshPending: false,
      lastManualRefreshSucceeded: null,
    }),
  setManualRefreshOutcome: (lastManualRefreshSucceeded) =>
    set({ lastManualRefreshSucceeded }),
  setManualRefreshPending: (isManualRefreshPending) =>
    set({ isManualRefreshPending }),
}));
