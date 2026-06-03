import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExperimentDefinition } from "../experimentDefinitions";
import {
  EXPERIMENT_PREFERENCES_CHANGE_EVENT,
  EXPERIMENT_PREFERENCES_STORAGE_KEY,
  EXPERIMENT_PREFERENCES_STORAGE_VERSION,
  getExperiment,
  setExperimentConfigValue,
  setExperimentEnabled,
  useExperiment,
} from "../experimentPreferences";

const testRegistry = [
  {
    id: "test-experiment",
    titleKey: "experiments.title",
    descriptionKey: "experiments.description",
    config: {
      enabledConfig: {
        type: "boolean",
        labelKey: "nav.general",
        defaultValue: false,
      },
      mode: {
        type: "select",
        labelKey: "nav.providers",
        defaultValue: "stable",
        options: [
          { labelKey: "nav.general", value: "stable" },
          { labelKey: "nav.providers", value: "preview" },
        ],
      },
      count: {
        type: "number",
        labelKey: "nav.archive",
        defaultValue: 2,
        min: 1,
        max: 5,
      },
      label: {
        type: "text",
        labelKey: "nav.updates",
        defaultValue: "default",
      },
    },
  },
] as const satisfies readonly ExperimentDefinition[];

function storedPreferences() {
  return JSON.parse(
    localStorage.getItem(EXPERIMENT_PREFERENCES_STORAGE_KEY) ?? "",
  );
}

const originalLocalStorage = window.localStorage;

function mockLocalStorage(overrides: Partial<Storage>) {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => store.delete(key),
    setItem: (key, value) => store.set(key, value),
    ...overrides,
  };

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}

describe("experimentPreferences", () => {
  beforeEach(() => {
    localStorage.removeItem(EXPERIMENT_PREFERENCES_STORAGE_KEY);
  });

  afterEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    });
  });

  it("defaults known experiments off with default config", () => {
    expect(getExperiment("test-experiment", testRegistry)).toEqual({
      id: "test-experiment",
      enabled: false,
      config: {
        enabledConfig: false,
        mode: "stable",
        count: 2,
        label: "default",
      },
    });
  });

  it("falls back to defaults for invalid localStorage", () => {
    localStorage.setItem(EXPERIMENT_PREFERENCES_STORAGE_KEY, "not json");

    expect(getExperiment("test-experiment", testRegistry)?.enabled).toBe(false);
    expect(getExperiment("test-experiment", testRegistry)?.config.mode).toBe(
      "stable",
    );
  });

  it("falls back to defaults for unsupported storage versions", () => {
    localStorage.setItem(
      EXPERIMENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: EXPERIMENT_PREFERENCES_STORAGE_VERSION + 1,
        experiments: {
          "test-experiment": {
            enabled: true,
            config: { mode: "preview" },
          },
        },
      }),
    );

    expect(getExperiment("test-experiment", testRegistry)).toMatchObject({
      enabled: false,
      config: { mode: "stable" },
    });
  });

  it("falls back to defaults when storage reads throw", () => {
    mockLocalStorage({
      getItem: () => {
        throw new Error("blocked");
      },
    });

    expect(getExperiment("test-experiment", testRegistry)).toMatchObject({
      enabled: false,
      config: { mode: "stable" },
    });
  });

  it("ignores unknown experiment ids on read", () => {
    expect(getExperiment("missing-experiment", testRegistry)).toBeNull();
  });

  it("updates same-window subscribers when preferences change", () => {
    function Probe() {
      const experiment = useExperiment("test-experiment", testRegistry);
      return <div>{experiment?.enabled ? "enabled" : "disabled"}</div>;
    }

    render(<Probe />);
    expect(screen.getByText("disabled")).toBeInTheDocument();

    act(() => setExperimentEnabled("test-experiment", true, testRegistry));

    expect(screen.getByText("enabled")).toBeInTheDocument();
  });

  it("updates subscribers from cross-window storage events", () => {
    function Probe() {
      const experiment = useExperiment("test-experiment", testRegistry);
      return <div>{experiment?.enabled ? "enabled" : "disabled"}</div>;
    }

    render(<Probe />);
    expect(screen.getByText("disabled")).toBeInTheDocument();

    const nextValue = JSON.stringify({
      version: 1,
      experiments: {
        "test-experiment": {
          enabled: true,
        },
      },
    });

    act(() => {
      localStorage.setItem(EXPERIMENT_PREFERENCES_STORAGE_KEY, nextValue);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: EXPERIMENT_PREFERENCES_STORAGE_KEY,
          newValue: nextValue,
        }),
      );
    });

    expect(screen.getByText("enabled")).toBeInTheDocument();
  });

  it("updates subscribers when another window clears storage", () => {
    localStorage.setItem(
      EXPERIMENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        experiments: {
          "test-experiment": {
            enabled: true,
          },
        },
      }),
    );

    function Probe() {
      const experiment = useExperiment("test-experiment", testRegistry);
      return <div>{experiment?.enabled ? "enabled" : "disabled"}</div>;
    }

    render(<Probe />);
    expect(screen.getByText("enabled")).toBeInTheDocument();

    act(() => {
      localStorage.removeItem(EXPERIMENT_PREFERENCES_STORAGE_KEY);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: null,
        }),
      );
    });

    expect(screen.getByText("disabled")).toBeInTheDocument();
  });

  it("validates stored config against typed controls", () => {
    localStorage.setItem(
      EXPERIMENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        experiments: {
          "test-experiment": {
            enabled: true,
            config: {
              enabledConfig: "yes",
              mode: "missing",
              count: 99,
              label: 123,
            },
          },
        },
      }),
    );

    expect(getExperiment("test-experiment", testRegistry)).toEqual({
      id: "test-experiment",
      enabled: true,
      config: {
        enabledConfig: false,
        mode: "stable",
        count: 5,
        label: "default",
      },
    });
  });

  it("preserves unknown experiment ids when writing known preferences", () => {
    localStorage.setItem(
      EXPERIMENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        experiments: {
          "branch-only": {
            enabled: true,
            config: { value: "kept" },
          },
        },
      }),
    );

    setExperimentEnabled("test-experiment", true, testRegistry);
    setExperimentConfigValue(
      "test-experiment",
      "mode",
      "preview",
      testRegistry,
    );

    expect(storedPreferences().experiments["branch-only"]).toEqual({
      enabled: true,
      config: { value: "kept" },
    });
    expect(storedPreferences().experiments["test-experiment"]).toEqual({
      enabled: true,
      config: { mode: "preview" },
    });
  });

  it("merges config writes with latest stored config", () => {
    localStorage.setItem(
      EXPERIMENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        experiments: {
          "test-experiment": {
            config: { label: "other-window" },
          },
        },
      }),
    );

    expect(
      setExperimentConfigValue(
        "test-experiment",
        "mode",
        "preview",
        testRegistry,
      ),
    ).toBe(true);

    expect(storedPreferences().experiments["test-experiment"].config).toEqual({
      label: "other-window",
      mode: "preview",
    });
  });

  it("returns false instead of overwriting newer storage versions", () => {
    const newerValue = JSON.stringify({
      version: EXPERIMENT_PREFERENCES_STORAGE_VERSION + 1,
      experiments: {
        "future-experiment": {
          enabled: true,
          config: { value: "keep" },
        },
      },
    });
    localStorage.setItem(EXPERIMENT_PREFERENCES_STORAGE_KEY, newerValue);

    expect(setExperimentEnabled("test-experiment", true, testRegistry)).toBe(
      false,
    );
    expect(localStorage.getItem(EXPERIMENT_PREFERENCES_STORAGE_KEY)).toBe(
      newerValue,
    );
  });

  it("returns false and does not notify subscribers when storage writes fail", () => {
    const handleChange = vi.fn();
    window.addEventListener(EXPERIMENT_PREFERENCES_CHANGE_EVENT, handleChange);

    mockLocalStorage({
      setItem: () => {
        throw new Error("quota");
      },
    });

    expect(setExperimentEnabled("test-experiment", true, testRegistry)).toBe(
      false,
    );
    expect(handleChange).not.toHaveBeenCalled();

    window.removeEventListener(
      EXPERIMENT_PREFERENCES_CHANGE_EVENT,
      handleChange,
    );
  });

  it("keeps config while callers see disabled experiments as disabled", () => {
    setExperimentConfigValue(
      "test-experiment",
      "label",
      "custom",
      testRegistry,
    );
    setExperimentEnabled("test-experiment", false, testRegistry);

    expect(getExperiment("test-experiment", testRegistry)).toMatchObject({
      enabled: false,
      config: { label: "custom" },
    });
  });
});
