import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PocketVoiceStatus } from "../api/pocketVoice";

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  installModel: vi.fn(),
  listen: vi.fn(),
  removeModel: vi.fn(),
  stopPocket: vi.fn(),
}));

vi.mock("../api/pocketVoice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/pocketVoice")>()),
  getPocketVoiceStatus: mocks.getStatus,
  installVoiceModel: mocks.installModel,
  listenToPocketVoiceStatus: mocks.listen,
  removeVoiceModel: mocks.removeModel,
  stopPocketVoice: mocks.stopPocket,
}));

import {
  mergePocketVoiceStatus,
  usePocketVoiceSetup,
} from "./usePocketVoiceSetup";

function status(downloadedBytes: number, attemptId = 1): PocketVoiceStatus {
  return {
    statusRevision: attemptId * 1_000 + downloadedBytes,
    installed: false,
    pocketInstalled: false,
    parakeetInstalled: false,
    pocketSizeBytes: null,
    parakeetSizeBytes: null,
    pocketDownloadBytes: 174,
    parakeetDownloadBytes: 104,
    downloading: true,
    activeModel: "pocket",
    pocketAttemptId: attemptId,
    parakeetAttemptId: null,
    pocketProgress: {
      attemptId,
      downloadedBytes,
      totalBytes: 174,
      phase: "downloading",
    },
    parakeetProgress: null,
    pocketError: null,
    parakeetError: null,
    removing: null,
    removalQueued: false,
    downloadedBytes,
    totalBytes: 100,
    error: null,
    selectedVoice: "mary",
    playbackSpeed: 1,
    voices: [],
  };
}

describe("mergePocketVoiceStatus", () => {
  beforeEach(() => {
    mocks.getStatus.mockReset();
    mocks.installModel.mockReset();
    mocks.listen.mockReset();
    mocks.removeModel.mockReset();
    mocks.stopPocket.mockReset().mockResolvedValue(false);
  });

  it("never moves per-model install progress backwards", () => {
    expect(
      mergePocketVoiceStatus(status(70), status(20)).pocketProgress
        ?.downloadedBytes,
    ).toBe(70);
  });

  it("rejects an out-of-order whole-status snapshot before it can flicker fields", () => {
    const current = {
      ...status(70),
      statusRevision: 12,
      activeModel: "pocket" as const,
    };
    const stale = {
      ...status(65),
      statusRevision: 11,
      activeModel: "parakeet" as const,
    };

    expect(mergePocketVoiceStatus(current, stale)).toBe(current);
  });

  it("keeps each attempt total immutable", () => {
    const current = status(70);
    const recalculated = {
      ...status(80),
      pocketProgress: {
        attemptId: 1,
        downloadedBytes: 80,
        totalBytes: 278,
        phase: "downloading" as const,
      },
    };

    expect(mergePocketVoiceStatus(current, recalculated)).toBe(current);
  });

  it("accepts verified terminal state after atomic publication", () => {
    const installed = {
      ...status(100),
      installed: true,
      pocketInstalled: true,
      pocketSizeBytes: 174,
      downloading: false,
    };
    expect(mergePocketVoiceStatus(status(70), installed)).toEqual(installed);
  });

  it("keeps model progress independent and permits only a new attempt to reset", () => {
    const failed = {
      ...status(70),
      downloading: false,
      pocketError: "network failed",
    };
    const retry = {
      ...status(0, 2),
      pocketError: null,
    };
    expect(
      mergePocketVoiceStatus(failed, retry).pocketProgress?.downloadedBytes,
    ).toBe(0);

    const parakeetUpdate = {
      ...status(20),
      statusRevision: status(70).statusRevision + 1,
      pocketProgress: null,
      parakeetProgress: {
        attemptId: 2,
        downloadedBytes: 40,
        totalBytes: 104,
        phase: "downloading" as const,
      },
      parakeetAttemptId: 2,
    };
    expect(
      mergePocketVoiceStatus(status(70), parakeetUpdate).parakeetProgress
        ?.downloadedBytes,
    ).toBe(40);
  });

  it("ignores late progress from an older removed attempt", () => {
    const redownload = status(30, 2);
    const staleCompletion = status(174, 1);

    expect(
      mergePocketVoiceStatus(redownload, staleCompletion).pocketProgress,
    ).toEqual(redownload.pocketProgress);
  });

  it("clears completed progress on removal and starts redownload at zero", () => {
    const completed = {
      ...status(174, 1),
      installed: true,
      pocketInstalled: true,
      pocketSizeBytes: 174,
      downloading: false,
      activeModel: null,
    };
    const removed = {
      ...completed,
      installed: false,
      pocketInstalled: false,
      pocketSizeBytes: null,
      pocketProgress: null,
    };
    const afterRemoval = mergePocketVoiceStatus(completed, removed);
    expect(afterRemoval.pocketProgress).toBeNull();
    expect(
      mergePocketVoiceStatus(afterRemoval, completed).pocketProgress,
    ).toBeNull();

    const redownload = status(0, 2);
    expect(
      mergePocketVoiceStatus(afterRemoval, redownload).pocketProgress,
    ).toEqual(redownload.pocketProgress);
  });

  it("does not query native Pocket state when the feature is disabled", async () => {
    const { result } = renderHook(() => usePocketVoiceSetup(false));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mocks.getStatus).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
  });

  it("installs only the selected missing model", async () => {
    const initial = { ...status(0), downloading: false, activeModel: null };
    const installed = {
      ...initial,
      parakeetInstalled: true,
      parakeetSizeBytes: 132,
    };
    mocks.getStatus.mockResolvedValue(initial);
    mocks.installModel.mockResolvedValue(installed);
    mocks.listen.mockResolvedValue(vi.fn());
    window.__TAURI_INTERNALS__ = {} as typeof window.__TAURI_INTERNALS__;

    const { result } = renderHook(() => usePocketVoiceSetup(true));
    await waitFor(() => expect(result.current.status).toEqual(initial));
    await act(() => result.current.installModel("parakeet"));

    expect(mocks.installModel).toHaveBeenCalledWith("parakeet");
    expect(result.current.status).toEqual(installed);
  });

  it("stops active use before removing a model and refreshes status", async () => {
    const installed = {
      ...status(100),
      installed: true,
      pocketInstalled: true,
      parakeetInstalled: true,
      pocketSizeBytes: 174,
      parakeetSizeBytes: 132,
      downloading: false,
    };
    const removed = {
      ...installed,
      installed: false,
      pocketInstalled: false,
    };
    mocks.getStatus.mockResolvedValue(installed);
    mocks.listen.mockResolvedValue(vi.fn());
    mocks.removeModel.mockResolvedValue(removed);
    window.__TAURI_INTERNALS__ = {} as typeof window.__TAURI_INTERNALS__;
    const stop = vi.fn().mockResolvedValue({
      available: true,
      unavailableReason: null,
      lifecycle: "stopped",
      sessionId: null,
      revision: 2,
    });
    const { useVoiceConversationStore } = await import(
      "../stores/voiceConversationStore"
    );
    useVoiceConversationStore.setState({
      status: {
        available: true,
        unavailableReason: null,
        lifecycle: "running",
        sessionId: "session-1",
        ownerWindowLabel: "main",
        microphoneMuted: false,
        revision: 1,
      },
      stop,
    });

    const { result } = renderHook(() => usePocketVoiceSetup(true));
    await waitFor(() => expect(result.current.status).toEqual(installed));
    await act(() => result.current.removeModel("pocket"));

    expect(stop).toHaveBeenCalledOnce();
    expect(mocks.stopPocket).toHaveBeenCalledOnce();
    expect(mocks.removeModel).toHaveBeenCalledWith("pocket");
    expect(result.current.status).toEqual(removed);
  });
});
