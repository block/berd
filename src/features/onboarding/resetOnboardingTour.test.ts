import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => {
  let loadStatus = "idle";
  let instances: Array<{ type: string }> = [];
  const initialize = vi.fn(async () => {
    loadStatus = "ready";
  });
  const resetOnboardingTour = vi.fn(async () => true);
  const resetHomeForOnboarding = vi.fn(async () => true);
  const resetStarterTasks = vi.fn(async () => true);
  const syncOnboardingExperiment = vi.fn();

  return {
    get loadStatus() {
      return loadStatus;
    },
    setLoadStatus(next: string) {
      loadStatus = next;
    },
    get instances() {
      return instances;
    },
    setInstances(next: Array<{ type: string }>) {
      instances = next;
    },
    initialize,
    resetOnboardingTour,
    resetHomeForOnboarding,
    resetStarterTasks,
    syncOnboardingExperiment,
  };
});

vi.mock("@/features/home/stores/homeWidgetStore", () => ({
  useHomeWidgetStore: {
    getState: () => ({
      loadStatus: storeMocks.loadStatus,
      instances: storeMocks.instances,
      initialize: storeMocks.initialize,
      resetOnboardingTour: storeMocks.resetOnboardingTour,
      resetHomeForOnboarding: storeMocks.resetHomeForOnboarding,
      resetStarterTasks: storeMocks.resetStarterTasks,
      syncOnboardingExperiment: storeMocks.syncOnboardingExperiment,
    }),
  },
}));

import {
  resetHomeForOnboardingExperience,
  resetOnboardingTourExperience,
  resetStarterTasksExperience,
  syncOnboardingExperimentState,
} from "./resetOnboardingTour";
import {
  areStarterAgentPinsEligible,
  haveStarterAgentPinsBeenSeeded,
} from "@/features/home/onboarding/starterAgents";

describe("onboarding tour experience controls", () => {
  beforeEach(() => {
    storeMocks.setLoadStatus("idle");
    storeMocks.setInstances([{ type: "agentPin" }, { type: "agentPin" }]);
    storeMocks.initialize.mockClear();
    storeMocks.resetOnboardingTour.mockClear();
    storeMocks.resetHomeForOnboarding.mockClear();
    storeMocks.resetStarterTasks.mockClear();
    storeMocks.syncOnboardingExperiment.mockClear();
  });

  it("initializes before resetting the whole Home onboarding canvas", async () => {
    await expect(resetHomeForOnboardingExperience()).resolves.toBe(true);

    expect(storeMocks.initialize).toHaveBeenCalledOnce();
    expect(storeMocks.resetHomeForOnboarding).toHaveBeenCalledOnce();
  });

  it("preserves starter-agent markers when the Home reset fails", async () => {
    localStorage.setItem("goose:home:starter-agent-pins-seeded-v5", "1");
    storeMocks.resetHomeForOnboarding.mockResolvedValueOnce(false);

    await expect(resetHomeForOnboardingExperience()).resolves.toBe(false);

    expect(haveStarterAgentPinsBeenSeeded()).toBe(true);
    expect(areStarterAgentPinsEligible()).toBe(false);
  });

  it("keeps a partial reset eligible for starter-agent recovery", async () => {
    storeMocks.setInstances([]);

    await expect(resetHomeForOnboardingExperience()).resolves.toBe(true);

    expect(haveStarterAgentPinsBeenSeeded()).toBe(false);
    expect(areStarterAgentPinsEligible()).toBe(true);
  });

  it("initializes before resetting starter tasks from another route", async () => {
    await expect(resetStarterTasksExperience()).resolves.toBe(true);

    expect(storeMocks.initialize).toHaveBeenCalledOnce();
    expect(storeMocks.resetStarterTasks).toHaveBeenCalledOnce();
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
