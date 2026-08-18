import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => {
  let loadStatus = "idle";
  let instances: Array<{ type: string }> = [];
  let personas: Array<Record<string, unknown>> = [];
  const listPersonas = vi.fn(async () => personas);
  const setPersonas = vi.fn((next: Array<Record<string, unknown>>) => {
    personas = next;
  });
  const initialize = vi.fn(async () => {
    loadStatus = "ready";
  });
  const resetOnboardingTour = vi.fn(async () => true);
  const resetHomeForOnboarding = vi.fn(async () => ({
    itemsConfirmed: true,
    cameraConfirmed: true,
  }));
  const addMissingStarterAgentPins = vi.fn(async () => true);
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
    get personas() {
      return personas;
    },
    setPersonaRecords(next: Array<Record<string, unknown>>) {
      personas = next;
    },
    listPersonas,
    setPersonas,
    initialize,
    resetOnboardingTour,
    resetHomeForOnboarding,
    addMissingStarterAgentPins,
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
      addMissingStarterAgentPins: storeMocks.addMissingStarterAgentPins,
      resetStarterTasks: storeMocks.resetStarterTasks,
      syncOnboardingExperiment: storeMocks.syncOnboardingExperiment,
    }),
  },
}));

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: {
    getState: () => ({
      personas: storeMocks.personas,
      setPersonas: storeMocks.setPersonas,
    }),
  },
}));

vi.mock("@/shared/api/agents", () => ({
  listPersonas: storeMocks.listPersonas,
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
  resetStarterAgentPinsSeeded,
} from "@/features/home/onboarding/starterAgents";

function starterPersona(sourceId: "tinker" | "wildcard") {
  return {
    id: `/Users/test/.agents/agents/${sourceId}.md`,
    displayName: sourceId,
    systemPrompt: "Help.",
    isBuiltin: false,
    writable: true,
    sourceProperties: {
      metadata: { berdBundled: true, berdBundledSource: sourceId },
    },
  };
}

describe("onboarding tour experience controls", () => {
  beforeEach(() => {
    resetStarterAgentPinsSeeded();
    storeMocks.setLoadStatus("idle");
    storeMocks.setInstances([{ type: "agentPin" }, { type: "agentPin" }]);
    storeMocks.setPersonaRecords([]);
    storeMocks.listPersonas.mockClear();
    storeMocks.setPersonas.mockClear();
    storeMocks.addMissingStarterAgentPins.mockResolvedValue(true);
    storeMocks.initialize.mockClear();
    storeMocks.resetOnboardingTour.mockClear();
    storeMocks.resetHomeForOnboarding.mockClear();
    storeMocks.addMissingStarterAgentPins.mockClear();
    storeMocks.resetStarterTasks.mockClear();
    storeMocks.syncOnboardingExperiment.mockClear();
  });

  it("initializes before resetting the whole Home onboarding canvas", async () => {
    storeMocks.setPersonaRecords([
      starterPersona("tinker"),
      starterPersona("wildcard"),
    ]);

    await expect(resetHomeForOnboardingExperience()).resolves.toEqual({
      itemsConfirmed: true,
      cameraConfirmed: true,
      starterAgentsConfirmed: true,
    });

    expect(storeMocks.initialize).toHaveBeenCalledOnce();
    expect(storeMocks.resetHomeForOnboarding).toHaveBeenCalledOnce();
  });

  it("refreshes stale starter agents before persisting the reset", async () => {
    storeMocks.setPersonaRecords([
      { ...starterPersona("tinker"), id: "/stale/tinker.md" },
      { ...starterPersona("wildcard"), id: "/stale/wildcard.md" },
    ]);
    storeMocks.listPersonas.mockResolvedValueOnce([
      starterPersona("tinker"),
      starterPersona("wildcard"),
    ]);

    await resetHomeForOnboardingExperience();

    expect(storeMocks.listPersonas).toHaveBeenCalledOnce();
    expect(storeMocks.addMissingStarterAgentPins).toHaveBeenCalledWith([
      "/Users/test/.agents/agents/tinker.md",
      "/Users/test/.agents/agents/wildcard.md",
    ]);
    expect(storeMocks.personas.map((persona) => persona.id)).toEqual([
      "/Users/test/.agents/agents/tinker.md",
      "/Users/test/.agents/agents/wildcard.md",
    ]);
    expect(haveStarterAgentPinsBeenSeeded()).toBe(true);
  });

  it("preserves concurrent persona edits and deletions during refresh", async () => {
    const originalTinker = starterPersona("tinker");
    const originalWildcard = starterPersona("wildcard");
    storeMocks.setPersonaRecords([originalTinker, originalWildcard]);
    storeMocks.listPersonas.mockImplementationOnce(async () => {
      storeMocks.setPersonaRecords([
        { ...originalTinker, displayName: "Edited Tinker" },
      ]);
      return [originalTinker, originalWildcard];
    });

    await expect(resetHomeForOnboardingExperience()).resolves.toEqual({
      itemsConfirmed: true,
      cameraConfirmed: true,
      starterAgentsConfirmed: false,
    });

    expect(storeMocks.personas).toEqual([
      { ...originalTinker, displayName: "Edited Tinker" },
    ]);
    expect(storeMocks.addMissingStarterAgentPins).not.toHaveBeenCalled();
    expect(areStarterAgentPinsEligible()).toBe(true);
  });

  it("refreshes and persists starter agents when the store is empty", async () => {
    storeMocks.listPersonas.mockResolvedValueOnce([
      starterPersona("tinker"),
      starterPersona("wildcard"),
    ]);

    await resetHomeForOnboardingExperience();

    expect(storeMocks.addMissingStarterAgentPins).toHaveBeenCalledOnce();
    expect(haveStarterAgentPinsBeenSeeded()).toBe(true);
  });

  it("keeps recovery eligible when starter-agent persistence fails", async () => {
    storeMocks.setPersonaRecords([
      starterPersona("tinker"),
      starterPersona("wildcard"),
    ]);
    storeMocks.addMissingStarterAgentPins.mockResolvedValueOnce(false);

    await expect(resetHomeForOnboardingExperience()).resolves.toEqual({
      itemsConfirmed: true,
      cameraConfirmed: true,
      starterAgentsConfirmed: false,
    });

    expect(haveStarterAgentPinsBeenSeeded()).toBe(false);
    expect(areStarterAgentPinsEligible()).toBe(true);
  });

  it("keeps recovery eligible when starter-agent persistence rejects", async () => {
    storeMocks.setPersonaRecords([
      starterPersona("tinker"),
      starterPersona("wildcard"),
    ]);
    storeMocks.addMissingStarterAgentPins.mockRejectedValueOnce(
      new Error("save failed"),
    );

    await expect(resetHomeForOnboardingExperience()).resolves.toEqual({
      itemsConfirmed: true,
      cameraConfirmed: true,
      starterAgentsConfirmed: false,
    });

    expect(haveStarterAgentPinsBeenSeeded()).toBe(false);
    expect(areStarterAgentPinsEligible()).toBe(true);
  });

  it("preserves starter-agent markers when the Home reset fails", async () => {
    localStorage.setItem("goose:home:starter-agent-pins-seeded-v5", "1");
    storeMocks.resetHomeForOnboarding.mockResolvedValueOnce({
      itemsConfirmed: false,
      cameraConfirmed: false,
    });

    await expect(resetHomeForOnboardingExperience()).resolves.toEqual({
      itemsConfirmed: false,
      cameraConfirmed: false,
    });

    expect(haveStarterAgentPinsBeenSeeded()).toBe(true);
    expect(areStarterAgentPinsEligible()).toBe(false);
  });

  it("keeps recovery eligible when only one starter persona is available", async () => {
    storeMocks.listPersonas.mockResolvedValueOnce([starterPersona("tinker")]);

    await expect(resetHomeForOnboardingExperience()).resolves.toEqual({
      itemsConfirmed: true,
      cameraConfirmed: true,
      starterAgentsConfirmed: false,
    });

    expect(storeMocks.addMissingStarterAgentPins).not.toHaveBeenCalled();
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
