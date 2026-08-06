import { beforeEach, describe, expect, it } from "vitest";
import {
  clearStarterTaskProgress,
  EMPTY_STARTER_TASK_COMPLETION,
  loadStarterTaskProgress,
  saveStarterTaskProgress,
  STARTER_TASK_PROGRESS_STORAGE_KEY,
} from "./starterTaskProgress";

describe("starterTaskProgress", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists completion overrides and awaiting tasks", () => {
    saveStarterTaskProgress({
      completion: { ...EMPTY_STARTER_TASK_COMPLETION, "start-chat": true },
      awaiting: new Set(["create-project"]),
    });

    expect(loadStarterTaskProgress()).toEqual({
      completion: { ...EMPTY_STARTER_TASK_COMPLETION, "start-chat": true },
      awaiting: new Set(["create-project"]),
    });
  });

  it("clears progress for onboarding reset", () => {
    saveStarterTaskProgress({
      completion: { ...EMPTY_STARTER_TASK_COMPLETION, "build-agent": true },
      awaiting: new Set(),
    });
    clearStarterTaskProgress();

    expect(loadStarterTaskProgress()).toEqual({
      completion: EMPTY_STARTER_TASK_COMPLETION,
      awaiting: new Set(),
    });
  });

  it("falls back safely for unsupported stored data", () => {
    localStorage.setItem(
      STARTER_TASK_PROGRESS_STORAGE_KEY,
      JSON.stringify({ version: 99, completion: { "start-chat": true } }),
    );

    expect(loadStarterTaskProgress()).toEqual({
      completion: EMPTY_STARTER_TASK_COMPLETION,
      awaiting: new Set(),
    });
  });
});
