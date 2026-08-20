import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_ONBOARDING_STATE } from "./onboardingState";
import {
  dispatchOnboarding,
  getOnboardingSnapshot,
  initializeOnboardingGraduation,
  ONBOARDING_STORAGE_KEY,
  ONBOARDING_STORAGE_VERSION,
  replayOnboarding,
  resetOnboarding,
  resetOnboardingStoreForTests,
  setOnboardingStorageForTests,
  subscribeToOnboarding,
} from "./onboardingStore";

describe("onboarding persistence", () => {
  beforeEach(() => {
    setOnboardingStorageForTests(undefined);
    window.localStorage.clear();
    resetOnboardingStoreForTests();
  });

  it("keeps onboarding pending for a fresh installation", () => {
    initializeOnboardingGraduation("fresh-with-landing-v1");
    resetOnboardingStoreForTests();

    expect(getOnboardingSnapshot()).toEqual(INITIAL_ONBOARDING_STATE);
  });

  it("marks an established installation complete during graduation", () => {
    initializeOnboardingGraduation("established-before-landing-v1");
    resetOnboardingStoreForTests();

    expect(getOnboardingSnapshot()).toMatchObject({
      lifecycle: "completed",
      step: "complete",
    });
  });

  it("graduates established installations when storage is unavailable or fails", () => {
    setOnboardingStorageForTests(null);
    initializeOnboardingGraduation("established-before-landing-v1");
    expect(getOnboardingSnapshot().lifecycle).toBe("completed");

    setOnboardingStorageForTests({
      getItem: () => {
        throw new Error("unavailable");
      },
    } as unknown as Storage);
    initializeOnboardingGraduation("established-before-landing-v1");
    expect(getOnboardingSnapshot().lifecycle).toBe("completed");

    setOnboardingStorageForTests({
      getItem: () => null,
      setItem: () => {
        throw new Error("full");
      },
    } as unknown as Storage);
    initializeOnboardingGraduation("established-before-landing-v1");
    expect(getOnboardingSnapshot().lifecycle).toBe("completed");
  });

  it("graduates malformed current state but preserves a newer record", () => {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "not json");
    initializeOnboardingGraduation("established-before-landing-v1");
    resetOnboardingStoreForTests();
    expect(getOnboardingSnapshot().lifecycle).toBe("completed");

    const newerRecord = JSON.stringify({
      version: ONBOARDING_STORAGE_VERSION + 1,
      state: { future: true },
    });
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, newerRecord);
    initializeOnboardingGraduation("established-before-landing-v1");
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe(
      newerRecord,
    );
  });

  it.each([
    ["in-progress", "recommendations"],
    ["completed", "complete"],
  ] as const)("preserves established %s records with retired recommendation selections", (lifecycle, step) => {
    for (const selectedAgentId of ["builder", "debugger", "generalist"]) {
      const state = {
        ...INITIAL_ONBOARDING_STATE,
        lifecycle,
        step,
        selectedWorkTypeIds: ["engineering"],
        selectedAgentId,
        selectedHarnessId: "goose",
        completedHarnessSetupIds: ["goose"],
        shareUsageData: false,
      };
      window.localStorage.setItem(
        ONBOARDING_STORAGE_KEY,
        JSON.stringify({ version: ONBOARDING_STORAGE_VERSION, state }),
      );

      initializeOnboardingGraduation("established-before-landing-v1");
      resetOnboardingStoreForTests();

      expect(getOnboardingSnapshot()).toEqual({
        ...state,
        selectedAgentId: null,
      });
    }
  });

  it("does not graduate when the cohort is unknown", () => {
    initializeOnboardingGraduation("unknown");
    resetOnboardingStoreForTests();
    expect(getOnboardingSnapshot()).toEqual(INITIAL_ONBOARDING_STATE);
  });

  it("preserves existing onboarding progress during graduation", () => {
    dispatchOnboarding({ type: "start" });

    initializeOnboardingGraduation("fresh-with-landing-v1");
    resetOnboardingStoreForTests();

    expect(getOnboardingSnapshot()).toMatchObject({
      lifecycle: "in-progress",
      step: "welcome",
    });
  });

  it("persists versioned state and hydrates it on a new lifecycle", () => {
    dispatchOnboarding({ type: "start" });
    const persisted = JSON.parse(
      window.localStorage.getItem(ONBOARDING_STORAGE_KEY) ?? "null",
    );
    expect(persisted).toMatchObject({
      version: ONBOARDING_STORAGE_VERSION,
      state: { lifecycle: "in-progress", selectedAgentId: null },
    });

    resetOnboardingStoreForTests();
    expect(getOnboardingSnapshot()).toMatchObject({
      lifecycle: "in-progress",
      selectedAgentId: null,
    });
  });

  it("falls back safely for malformed or unsupported records", () => {
    for (const value of [
      "not json",
      JSON.stringify({ version: ONBOARDING_STORAGE_VERSION + 1, state: {} }),
      JSON.stringify({
        version: ONBOARDING_STORAGE_VERSION,
        state: { step: "bogus" },
      }),
    ]) {
      window.localStorage.setItem(ONBOARDING_STORAGE_KEY, value);
      resetOnboardingStoreForTests();
      expect(getOnboardingSnapshot()).toEqual(INITIAL_ONBOARDING_STATE);
    }
  });

  it.each([
    ["work type", { selectedWorkTypeIds: ["unknown-work"] }],
    ["agent", { selectedAgentId: "unknown-agent" }],
    ["harness", { selectedHarnessId: "unknown-harness" }],
    ["completed harness", { completedHarnessSetupIds: ["unknown-harness"] }],
  ])("rejects a persisted unknown %s ID", (_label, statePatch) => {
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        version: ONBOARDING_STORAGE_VERSION,
        state: { ...INITIAL_ONBOARDING_STATE, ...statePatch },
      }),
    );

    expect(getOnboardingSnapshot()).toEqual(INITIAL_ONBOARDING_STATE);
  });

  it.each([
    ["a recorded opt-out", false, false],
    ["a recorded opt-in", true, true],
    ["an unanswered ceremony", null, null],
    ["a record predating the field", undefined, null],
  ])("hydrates %s as the usage-data answer", (_label, persisted, expected) => {
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        version: ONBOARDING_STORAGE_VERSION,
        state: { ...INITIAL_ONBOARDING_STATE, shareUsageData: persisted },
      }),
    );

    expect(getOnboardingSnapshot().shareUsageData).toBe(expected);
  });

  it("rejects a persisted non-boolean usage-data answer", () => {
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        version: ONBOARDING_STORAGE_VERSION,
        state: { ...INITIAL_ONBOARDING_STATE, shareUsageData: "yes" },
      }),
    );

    expect(getOnboardingSnapshot()).toEqual(INITIAL_ONBOARDING_STATE);
  });

  it("hydrates catalog-backed IDs and deduplicates persisted arrays", () => {
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        version: ONBOARDING_STORAGE_VERSION,
        state: {
          ...INITIAL_ONBOARDING_STATE,
          selectedWorkTypeIds: ["engineering", "engineering"],
          selectedAgentId: null,
          selectedHarnessId: "goose",
          completedHarnessSetupIds: ["goose", "goose", "claude-acp"],
        },
      }),
    );

    expect(getOnboardingSnapshot()).toMatchObject({
      selectedWorkTypeIds: ["engineering"],
      selectedAgentId: null,
      selectedHarnessId: "goose",
      completedHarnessSetupIds: ["goose", "claude-acp"],
    });
  });

  it.each([
    "builder",
    "debugger",
    "generalist",
  ])("hydrates a completed record with retired %s selection", (selectedAgentId) => {
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        version: ONBOARDING_STORAGE_VERSION,
        state: {
          ...INITIAL_ONBOARDING_STATE,
          lifecycle: "completed",
          step: "complete",
          selectedWorkTypeIds: ["engineering"],
          selectedAgentId,
          selectedHarnessId: "goose",
          completedHarnessSetupIds: ["goose"],
          shareUsageData: false,
        },
      }),
    );

    expect(getOnboardingSnapshot()).toEqual({
      ...INITIAL_ONBOARDING_STATE,
      lifecycle: "completed",
      step: "complete",
      selectedWorkTypeIds: ["engineering"],
      selectedAgentId: null,
      selectedHarnessId: "goose",
      completedHarnessSetupIds: ["goose"],
      shareUsageData: false,
    });
  });

  it.each([
    [
      "completed lifecycle before the complete step",
      { lifecycle: "completed", step: "welcome" },
    ],
    [
      "complete step before the completed lifecycle",
      { lifecycle: "in-progress", step: "complete" },
    ],
    [
      "setup without a selected harness",
      {
        lifecycle: "in-progress",
        step: "harness-setup",
        selectedHarnessId: null,
      },
    ],
  ])("rejects %s", (_label, statePatch) => {
    window.localStorage.setItem(
      ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        version: ONBOARDING_STORAGE_VERSION,
        state: { ...INITIAL_ONBOARDING_STATE, ...statePatch },
      }),
    );

    expect(getOnboardingSnapshot()).toEqual(INITIAL_ONBOARDING_STATE);
  });

  it("does not overwrite a newer record written after hydration", () => {
    expect(getOnboardingSnapshot()).toEqual(INITIAL_ONBOARDING_STATE);
    const newerRecord = JSON.stringify({
      version: ONBOARDING_STORAGE_VERSION + 1,
      state: { future: true },
    });
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, newerRecord);

    dispatchOnboarding({ type: "start" });
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe(
      newerRecord,
    );
    resetOnboarding();
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe(
      newerRecord,
    );
  });

  it("does not overwrite or remove a record from a newer storage version", () => {
    const newerRecord = JSON.stringify({
      version: ONBOARDING_STORAGE_VERSION + 1,
      state: { future: true },
    });
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, newerRecord);

    expect(getOnboardingSnapshot()).toEqual(INITIAL_ONBOARDING_STATE);
    dispatchOnboarding({ type: "start" });
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe(
      newerRecord,
    );

    resetOnboarding();
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe(
      newerRecord,
    );
  });

  it("notifies subscribers for dispatch, replay, and reset", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToOnboarding(listener);

    dispatchOnboarding({ type: "complete" });
    replayOnboarding();
    expect(getOnboardingSnapshot()).toMatchObject({
      lifecycle: "in-progress",
      step: "welcome",
    });
    resetOnboarding();

    expect(listener).toHaveBeenCalledTimes(3);
    expect(getOnboardingSnapshot()).toEqual(INITIAL_ONBOARDING_STATE);
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();

    unsubscribe();
    dispatchOnboarding({ type: "start" });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("synchronizes updates delivered by the browser storage event", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToOnboarding(listener);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: ONBOARDING_STORAGE_KEY,
        newValue: JSON.stringify({
          version: ONBOARDING_STORAGE_VERSION,
          state: {
            ...INITIAL_ONBOARDING_STATE,
            lifecycle: "completed",
            step: "complete",
          },
        }),
      }),
    );

    expect(listener).toHaveBeenCalledOnce();
    expect(getOnboardingSnapshot().lifecycle).toBe("completed");
    unsubscribe();
  });
});
