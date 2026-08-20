import { describe, expect, it } from "vitest";
import {
  INITIAL_ONBOARDING_STATE,
  onboardingReducer,
  ONBOARDING_STEPS,
} from "./onboardingState";

describe("onboardingReducer", () => {
  it("defines a stable ordered flow and advances within its bounds", () => {
    expect(ONBOARDING_STEPS).toEqual([
      "welcome",
      "work-types",
      "recommendations",
      "harness",
      "harness-setup",
      "complete",
    ]);

    let state = onboardingReducer(
      { ...INITIAL_ONBOARDING_STATE },
      { type: "start" },
    );
    expect(state.lifecycle).toBe("in-progress");
    for (const step of ONBOARDING_STEPS.slice(1)) {
      state = onboardingReducer(state, { type: "next" });
      expect(state.step).toBe(step);
    }
    expect(state.lifecycle).toBe("completed");
    expect(onboardingReducer(state, { type: "next" })).toEqual(state);
  });

  it("records selections without duplicates and supports going back", () => {
    let state = onboardingReducer(
      { ...INITIAL_ONBOARDING_STATE },
      { type: "set-work-types", workTypeIds: ["write-code", "write-code"] },
    );
    state = onboardingReducer(state, {
      type: "select-agent",
      agentId: "test-agent",
    });
    state = onboardingReducer(state, {
      type: "select-harness",
      harnessId: "goose",
    });
    state = onboardingReducer(state, { type: "go-to", step: "harness" });
    state = onboardingReducer(state, { type: "back" });

    expect(state).toMatchObject({
      lifecycle: "in-progress",
      step: "recommendations",
      selectedWorkTypeIds: ["write-code"],
      selectedAgentId: "test-agent",
      selectedHarnessId: "goose",
      completedHarnessSetupIds: [],
    });
  });

  it("preserves completed provider setup while navigating within a run", () => {
    const complete = onboardingReducer(
      { ...INITIAL_ONBOARDING_STATE },
      { type: "complete-harness-setup", harnessId: "claude-acp" },
    );
    const back = onboardingReducer(
      { ...complete, step: "harness-setup" },
      { type: "back" },
    );
    expect(back.completedHarnessSetupIds).toEqual(["claude-acp"]);
  });

  it("records the usage-data answer given on the welcome page", () => {
    const declined = onboardingReducer(
      { ...INITIAL_ONBOARDING_STATE },
      { type: "set-share-usage-data", shareUsageData: false },
    );
    expect(declined.shareUsageData).toBe(false);
    expect(
      onboardingReducer(declined, {
        type: "set-share-usage-data",
        shareUsageData: true,
      }).shareUsageData,
    ).toBe(true);
  });

  it("replay clears choices but preserves durable setup outcomes", () => {
    const completed = onboardingReducer(
      {
        ...INITIAL_ONBOARDING_STATE,
        selectedWorkTypeIds: ["engineering"],
        selectedAgentId: "test-agent",
        selectedHarnessId: "goose",
        completedHarnessSetupIds: ["goose"],
        shareUsageData: false,
      },
      { type: "complete" },
    );
    // The consent answer is a durable outcome like configured providers: a
    // replayed tour shows what was chosen, and reset returns to "never asked".
    expect(onboardingReducer(completed, { type: "replay" })).toEqual({
      ...INITIAL_ONBOARDING_STATE,
      lifecycle: "in-progress",
      completedHarnessSetupIds: ["goose"],
      shareUsageData: false,
    });
    expect(onboardingReducer(completed, { type: "reset" })).toEqual(
      INITIAL_ONBOARDING_STATE,
    );
  });
});
