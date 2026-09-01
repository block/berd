import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: true,
  reconcile: vi.fn().mockResolvedValue(undefined),
  startup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/app/lib/chatRuntimeStartup", () => ({
  runChatRuntimeStartup: mocks.startup,
}));
vi.mock("@/features/experiments/experimentPreferences", () => ({
  useExperiment: () => ({ enabled: mocks.enabled }),
  subscribeToExperimentChanges: () => () => {},
}));
vi.mock("@/features/chat/stores/remoteSessionPersistence", () => ({
  reconcileRemoteSessionsForExperiment: mocks.reconcile,
}));

import { useRemoteSessionExperimentReconciliation } from "./useRemoteSessionExperimentReconciliation";

describe("useRemoteSessionExperimentReconciliation", () => {
  beforeEach(() => {
    mocks.enabled = true;
    mocks.reconcile.mockClear();
    mocks.startup.mockClear();
  });

  it("reconciles both enabled and disabled runtime states after startup", async () => {
    const { rerender } = renderHook(() =>
      useRemoteSessionExperimentReconciliation(),
    );

    await waitFor(() => expect(mocks.reconcile).toHaveBeenCalledWith(true));
    expect(mocks.startup).toHaveBeenCalledTimes(1);

    mocks.enabled = false;
    rerender();

    await waitFor(() => expect(mocks.reconcile).toHaveBeenCalledWith(false));
    expect(mocks.startup).toHaveBeenCalledTimes(2);
  });
});
