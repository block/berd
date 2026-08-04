import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => {
  let loadStatus = "idle";
  const initialize = vi.fn(async () => {
    loadStatus = "ready";
  });
  const resetOnboardingTour = vi.fn(async () => true);
  const syncOnboardingExperiment = vi.fn();

  return {
    get loadStatus() {
      return loadStatus;
    },
    setLoadStatus(next: string) {
      loadStatus = next;
    },
    initialize,
    resetOnboardingTour,
    syncOnboardingExperiment,
  };
});

vi.mock("@/features/home/stores/homeWidgetStore", () => ({
  useHomeWidgetStore: {
    getState: () => ({
      loadStatus: storeMocks.loadStatus,
      initialize: storeMocks.initialize,
      resetOnboardingTour: storeMocks.resetOnboardingTour,
      syncOnboardingExperiment: storeMocks.syncOnboardingExperiment,
    }),
  },
}));

import {
  resetOnboardingTourExperience,
  syncOnboardingExperimentState,
} from "./resetOnboardingTour";

describe("onboarding tour experience controls", () => {
  beforeEach(() => {
    storeMocks.setLoadStatus("idle");
    storeMocks.initialize.mockClear();
    storeMocks.resetOnboardingTour.mockClear();
    storeMocks.syncOnboardingExperiment.mockClear();
  });

  it("initializes the Home widget store before resetting from another route", async () => {
    await expect(resetOnboardingTourExperience()).resolves.toBe(true);

    expect(storeMocks.initialize).toHaveBeenCalledOnce();
    expect(storeMocks.resetOnboardingTour).toHaveBeenCalledOnce();
  });

  it("initializes before synchronizing an experiment change", async () => {
    await syncOnboardingExperimentState(false);

    expect(storeMocks.initialize).toHaveBeenCalledOnce();
    expect(storeMocks.syncOnboardingExperiment).toHaveBeenCalledWith(false);
  });

  it("reuses an already initialized Home widget store", async () => {
    storeMocks.setLoadStatus("ready");

    await syncOnboardingExperimentState(true);

    expect(storeMocks.initialize).not.toHaveBeenCalled();
    expect(storeMocks.syncOnboardingExperiment).toHaveBeenCalledWith(true);
  });
});
