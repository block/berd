import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUILDERBOT_SURFACE_EXPERIMENT_ID,
  SKILL_DISCOVERY_EXPERIMENT_ID,
  type ExperimentDefinition,
} from "../experimentDefinitions";
import {
  EXPERIMENT_PREFERENCES_CHANGE_EVENT,
  EXPERIMENT_PREFERENCES_STORAGE_KEY,
  EXPERIMENT_PREFERENCES_STORAGE_VERSION,
  clearExperimentEnabledOverride,
  getExperiment,
  getExperimentAutoEnable,
  getVisibleExperimentRegistry,
  listExperiments,
  resolveAutoEnabled,
  setExperimentAutoEnable,
  setExperimentConfigValue,
  setExperimentEnabled,
  useExperiment,
  useExperimentAutoEnable,
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

const defaultEnabledRegistry = [
  {
    id: "default-enabled-experiment",
    titleKey: "experiments.title",
    descriptionKey: "experiments.description",
    defaultEnabled: true,
  },
] as const satisfies readonly ExperimentDefinition[];

const defaultDisabledRegistry = [
  {
    id: "default-disabled-experiment",
    titleKey: "experiments.title",
    descriptionKey: "experiments.description",
    defaultEnabled: false,
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

describe("resolveAutoEnabled", () => {
  it("returns true when autoEnable is true regardless of defaultEnabled", () => {
    expect(resolveAutoEnabled(true, undefined)).toBe(true);
    expect(resolveAutoEnabled(true, true)).toBe(true);
    expect(resolveAutoEnabled(true, false)).toBe(true);
  });

  it("returns defaultEnabled when autoEnable is false", () => {
    expect(resolveAutoEnabled(false, true)).toBe(true);
    expect(resolveAutoEnabled(false, false)).toBe(false);
  });

  it("returns false when autoEnable is false and defaultEnabled is omitted", () => {
    expect(resolveAutoEnabled(false, undefined)).toBe(false);
  });
});

describe("experimentPreferences", () => {
  beforeEach(() => {
    localStorage.removeItem(EXPERIMENT_PREFERENCES_STORAGE_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    });
  });

  it.each([
    { id: BUILDERBOT_SURFACE_EXPERIMENT_ID, env: "VITE_BUILDERBOT" },
    { id: SKILL_DISCOVERY_EXPERIMENT_ID, env: "VITE_SKILL_DISCOVERY" },
  ])("gates the $id experiment on its build family", ({ id, env }) => {
    const registry = [
      testRegistry[0],
      {
        ...testRegistry[0],
        id,
      },
    ];

    expect(getVisibleExperimentRegistry(registry).map(({ id }) => id)).toEqual([
      "test-experiment",
    ]);

    vi.stubEnv(env, "1");
    expect(getVisibleExperimentRegistry(registry).map(({ id }) => id)).toEqual([
      "test-experiment",
      id,
    ]);
  });

  it("does not let a stale enabled override resurrect the Skill Discovery experiment when its build family is unavailable", () => {
    const registry = [
      testRegistry[0],
      {
        ...testRegistry[0],
        id: SKILL_DISCOVERY_EXPERIMENT_ID,
      },
    ];

    localStorage.setItem(
      EXPERIMENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        experiments: {
          [SKILL_DISCOVERY_EXPERIMENT_ID]: {
            enabled: true,
          },
        },
      }),
    );

    expect(getExperiment(SKILL_DISCOVERY_EXPERIMENT_ID, registry)).toBeNull();
    expect(listExperiments(registry).map(({ id }) => id)).toEqual([
      "test-experiment",
    ]);
  });

  it("defaults auto-enable on in dev builds", () => {
    vi.stubEnv("DEV", true);

    expect(getExperimentAutoEnable()).toEqual({
      enabled: true,
      source: "default",
      defaultEnabled: true,
    });
    expect(getExperiment("test-experiment", testRegistry)).toEqual({
      id: "test-experiment",
      enabled: true,
      enabledSource: "auto",
      config: {
        enabledConfig: false,
        mode: "stable",
        count: 2,
        label: "default",
      },
    });
  });

  it("keeps manual-only experiments off under development auto-enable", () => {
    vi.stubEnv("DEV", true);
    const manualRegistry = [
      {
        id: "manual",
        titleKey: "experiments.title",
        descriptionKey: "experiments.description",
        defaultEnabled: false,
        manualEnableOnly: true,
      },
    ] satisfies readonly ExperimentDefinition[];

    expect(getExperiment("manual", manualRegistry)).toMatchObject({
      enabled: false,
      enabledSource: "auto",
    });
  });

  it("defaults auto-enable off in production builds", () => {
    vi.stubEnv("DEV", false);

    expect(getExperimentAutoEnable()).toEqual({
      enabled: false,
      source: "default",
      defaultEnabled: false,
    });
    expect(getExperiment("test-experiment", testRegistry)).toMatchObject({
      enabled: false,
      enabledSource: "auto",
    });
  });

  it("uses per-experiment default-enabled overrides in production builds", () => {
    vi.stubEnv("DEV", false);

    expect(
      getExperiment("default-enabled-experiment", defaultEnabledRegistry),
    ).toEqual({
      id: "default-enabled-experiment",
      enabled: true,
      enabledSource: "auto",
      config: {},
    });
  });

  it("auto-enables experiments with defaultEnabled: false in dev builds", () => {
    vi.stubEnv("DEV", true);

    expect(
      getExperiment("default-disabled-experiment", defaultDisabledRegistry),
    ).toMatchObject({
      enabled: true,
      enabledSource: "auto",
    });
  });

  it("keeps experiments with defaultEnabled: false off in production builds", () => {
    vi.stubEnv("DEV", false);

    expect(
      getExperiment("default-disabled-experiment", defaultDisabledRegistry),
    ).toMatchObject({
      enabled: false,
      enabledSource: "auto",
    });
  });

  it("uses stored auto-enable instead of the build default", () => {
    vi.stubEnv("DEV", false);
    localStorage.setItem(
      EXPERIMENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        autoEnable: true,
        experiments: {},
      }),
    );

    expect(getExperimentAutoEnable()).toEqual({
      enabled: true,
      source: "stored",
      defaultEnabled: false,
    });
    expect(getExperiment("test-experiment", testRegistry)).toMatchObject({
      enabled: true,
      enabledSource: "auto",
    });
  });

  it("lets explicit enabled true win over auto-enable false", () => {
    vi.stubEnv("DEV", false);
    setExperimentEnabled("test-experiment", true, testRegistry);

    expect(getExperiment("test-experiment", testRegistry)).toMatchObject({
      enabled: true,
      enabledSource: "explicit",
    });
  });

  it("lets explicit enabled false win over auto-enable true", () => {
    vi.stubEnv("DEV", true);
    setExperimentEnabled("test-experiment", false, testRegistry);

    expect(getExperiment("test-experiment", testRegistry)).toMatchObject({
      enabled: false,
      enabledSource: "explicit",
    });
  });

  it("lets explicit enabled false win over a per-experiment default-enabled override", () => {
    vi.stubEnv("DEV", false);
    setExperimentEnabled(
      "default-enabled-experiment",
      false,
      defaultEnabledRegistry,
    );

    expect(
      getExperiment("default-enabled-experiment", defaultEnabledRegistry),
    ).toMatchObject({
      enabled: false,
      enabledSource: "explicit",
    });
  });

  it("clears explicit enabled overrides back to auto behavior", () => {
    vi.stubEnv("DEV", false);
    setExperimentAutoEnable(false);
    setExperimentEnabled("test-experiment", true, testRegistry);

    expect(
      clearExperimentEnabledOverride("test-experiment", testRegistry),
    ).toBe(true);

    expect(getExperiment("test-experiment", testRegistry)).toMatchObject({
      enabled: false,
      enabledSource: "auto",
    });
    expect(
      storedPreferences().experiments["test-experiment"].enabled,
    ).toBeUndefined();
  });

  it("clears explicit enabled overrides without removing config", () => {
    vi.stubEnv("DEV", false);
    setExperimentConfigValue(
      "test-experiment",
      "mode",
      "preview",
      testRegistry,
    );
    setExperimentEnabled("test-experiment", true, testRegistry);

    clearExperimentEnabledOverride("test-experiment", testRegistry);

    expect(storedPreferences().experiments["test-experiment"]).toEqual({
      config: { mode: "preview" },
    });
    expect(getExperiment("test-experiment", testRegistry)).toMatchObject({
      enabled: false,
      config: { mode: "preview" },
    });
  });

  it("falls back to defaults for invalid localStorage", () => {
    vi.stubEnv("DEV", false);
    localStorage.setItem(EXPERIMENT_PREFERENCES_STORAGE_KEY, "not json");

    expect(getExperiment("test-experiment", testRegistry)?.enabled).toBe(false);
    expect(getExperiment("test-experiment", testRegistry)?.config.mode).toBe(
      "stable",
    );
  });

  it("falls back to defaults for unsupported storage versions", () => {
    vi.stubEnv("DEV", false);
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
    vi.stubEnv("DEV", false);
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
    vi.stubEnv("DEV", false);
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
    vi.stubEnv("DEV", false);
    function Probe() {
      const experiment = useExperiment("test-experiment", testRegistry);
      return <div>{experiment?.enabled ? "enabled" : "disabled"}</div>;
    }

    render(<Probe />);
    expect(screen.getByText("disabled")).toBeInTheDocument();

    const nextValue = JSON.stringify({
      version: 2,
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
    vi.stubEnv("DEV", false);
    localStorage.setItem(
      EXPERIMENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 2,
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
    vi.stubEnv("DEV", false);
    localStorage.setItem(
      EXPERIMENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 2,
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
      enabledSource: "explicit",
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
        version: 2,
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

    expect(storedPreferences()).toMatchObject({
      version: 2,
    });
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
        version: 2,
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
      enabledSource: "explicit",
      config: { label: "custom" },
    });
  });

  it("reads v1 storage and preserves enabled and config values", () => {
    vi.stubEnv("DEV", false);
    localStorage.setItem(
      EXPERIMENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        experiments: {
          "test-experiment": {
            enabled: true,
            config: { mode: "preview" },
          },
        },
      }),
    );

    expect(getExperimentAutoEnable()).toMatchObject({
      enabled: false,
      source: "default",
    });
    expect(getExperiment("test-experiment", testRegistry)).toMatchObject({
      enabled: true,
      enabledSource: "explicit",
      config: { mode: "preview" },
    });
  });

  it("updates auto-enable same-window and cross-window subscribers", () => {
    vi.stubEnv("DEV", false);

    function Probe() {
      const autoEnable = useExperimentAutoEnable();
      return <div>{autoEnable.enabled ? "auto on" : "auto off"}</div>;
    }

    render(<Probe />);
    expect(screen.getByText("auto off")).toBeInTheDocument();

    act(() => setExperimentAutoEnable(true));
    expect(screen.getByText("auto on")).toBeInTheDocument();

    const nextValue = JSON.stringify({
      version: 2,
      autoEnable: false,
      experiments: {},
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

    expect(screen.getByText("auto off")).toBeInTheDocument();
  });
});
