import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EXPERIMENT_DEFINITIONS,
  SESSION_COST_EXPERIMENT_ID,
} from "../experimentDefinitions";
import {
  EXPERIMENT_PREFERENCES_STORAGE_KEY,
  clearExperimentEnabledOverride,
  getExperiment,
  setExperimentAutoEnable,
  setExperimentEnabled,
} from "../experimentPreferences";

/**
 * The per-session cost display is opt-in. It must never show by default in a
 * production build, where the global experiment auto-enable preference is off.
 * Users turn it on explicitly from Settings -> Experiments.
 */
describe("session-cost-display experiment", () => {
  beforeEach(() => {
    window.localStorage.removeItem(EXPERIMENT_PREFERENCES_STORAGE_KEY);
  });

  afterEach(() => {
    window.localStorage.removeItem(EXPERIMENT_PREFERENCES_STORAGE_KEY);
    vi.unstubAllEnvs();
  });

  it("is registered with defaultEnabled: false (always off unless opted in)", () => {
    const def = EXPERIMENT_DEFINITIONS.find(
      (entry) => entry.id === SESSION_COST_EXPERIMENT_ID,
    );
    expect(def).toBeDefined();
    // Opt-in: pinned off so it does not follow the global auto-enable (which is
    // on in dev) and stays off after a reset-to-auto.
    expect((def as { defaultEnabled?: boolean }).defaultEnabled).toBe(false);
  });

  it("is OFF by default when global auto-enable is off (production)", () => {
    setExperimentAutoEnable(false);
    const experiment = getExperiment(SESSION_COST_EXPERIMENT_ID);
    expect(experiment?.enabled).toBe(false);
  });

  it("stays OFF by default even when global auto-enable is on (dev)", () => {
    setExperimentAutoEnable(true);
    const experiment = getExperiment(SESSION_COST_EXPERIMENT_ID);
    expect(experiment?.enabled).toBe(false);
  });

  it("honors an explicit user opt-in even when auto-enable is off", () => {
    setExperimentAutoEnable(false);
    setExperimentEnabled(SESSION_COST_EXPERIMENT_ID, true);
    expect(getExperiment(SESSION_COST_EXPERIMENT_ID)?.enabled).toBe(true);
  });

  it("honors an explicit user opt-out even when auto-enable is on", () => {
    setExperimentAutoEnable(true);
    setExperimentEnabled(SESSION_COST_EXPERIMENT_ID, false);
    expect(getExperiment(SESSION_COST_EXPERIMENT_ID)?.enabled).toBe(false);
  });

  it("reset-to-auto returns to OFF (not the global auto-enable), even in dev", () => {
    // Regression: reset-to-auto must NOT turn cost on. With defaultEnabled:false
    // the auto state is off regardless of the dev global auto-enable.
    setExperimentAutoEnable(true);
    setExperimentEnabled(SESSION_COST_EXPERIMENT_ID, true);
    expect(getExperiment(SESSION_COST_EXPERIMENT_ID)?.enabled).toBe(true);

    clearExperimentEnabledOverride(SESSION_COST_EXPERIMENT_ID);
    expect(getExperiment(SESSION_COST_EXPERIMENT_ID)?.enabled).toBe(false);
  });
});
