import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock CDP. Identity is stamped per-event via the envelope `overrides`, so the
// client only needs `trackWithSchema`; there is no `user`/`_identify` to model.
const trackWithSchema = vi.fn();
const buildFeatures = vi.hoisted(() => ({
  agentToolsTip: true,
  automations: true,
  builderbot: true,
  telemetry: true,
}));
const desktopPageContext = {
  path: "",
  referrer: "",
  search: "",
  title: "Berd",
  url: "",
};

vi.mock("@squareup/cdp", () => ({
  CDP: vi.fn(function CDPMock() {
    return { trackWithSchema };
  }),
  EntityTypes: {
    anonVisitor: "ANON_VISITOR",
    squareEmployee: "SQUARE_EMPLOYEE",
  },
}));

// Mock the whoami Tauri command so we can drive identity resolution per-test.
const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("@/shared/profile/buildProfile", () => ({
  getBuildFeatureState: () => buildFeatures,
}));

// The schema factories just echo their params so we can assert what was passed.
vi.mock("@squareup/message-schemas-web", () => ({
  GooseInternalAppLifecycleLaunched: vi.fn((params: unknown) => ({
    name: "goose_internal_app_lifecycle_launched",
    params,
  })),
  GooseInternalAppLifecycleLaunchedProducer: {
    GOOSE_INTERNAL: "goose-internal",
  },
  GooseInternalAppFeedbackInitiated: vi.fn((params: unknown) => ({
    name: "goose_internal_app_feedback_initiated",
    params,
  })),
  GooseInternalAppFeedbackInitiatedProducer: {
    GOOSE_INTERNAL: "goose-internal",
  },
  GooseInternalAppFeedbackSubmitted: vi.fn((params: unknown) => ({
    name: "goose_internal_app_feedback_submitted",
    params,
  })),
  GooseInternalAppFeedbackSubmittedProducer: {
    GOOSE_INTERNAL: "goose-internal",
  },
}));

// Environment is mocked per-test so we can flip production/staging/development.
const getEnvironment = vi.fn();
const isProduction = vi.fn();
const isStaging = vi.fn();
const originalFetch = globalThis.fetch;
const TRANSPORT_BRIDGE_INSTALLED_KEY =
  "__berdTelemetryTransportBridgeInstalled";

type GlobalWithTelemetryTransport = typeof globalThis & {
  [TRANSPORT_BRIDGE_INSTALLED_KEY]?: boolean;
};

vi.mock("@/shared/utils/environment", () => ({
  getEnvironment: () => getEnvironment(),
  isProduction: () => isProduction(),
  isStaging: () => isStaging(),
}));

async function loadTelemetry() {
  // Re-import so the module-level client singleton and identity provider are fresh.
  vi.resetModules();
  return await import("./client");
}

function setEnv(env: "production" | "staging" | "development") {
  getEnvironment.mockReturnValue(env);
  isProduction.mockReturnValue(env === "production");
  isStaging.mockReturnValue(env === "staging");
}

beforeEach(() => {
  buildFeatures.agentToolsTip = true;
  buildFeatures.automations = true;
  buildFeatures.builderbot = true;
  buildFeatures.telemetry = true;
  trackWithSchema.mockClear();
  invoke.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as GlobalWithTelemetryTransport)[
    TRANSPORT_BRIDGE_INSTALLED_KEY
  ];
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("telemetry", () => {
  it("stamps the squareEmployee entity override once identity resolves", async () => {
    setEnv("production");
    invoke.mockResolvedValue({ email: "someone@squareup.com" });

    const t = await loadTelemetry();
    t.initTelemetry();
    // Let whoami settle before tracking so the event emits immediately.
    await new Promise((resolve) => setTimeout(resolve, 0));
    t.trackAppLaunched();

    expect(trackWithSchema).toHaveBeenCalledTimes(1);
    const [event, options] = trackWithSchema.mock.calls[0];
    expect(event).toEqual({
      name: "goose_internal_app_lifecycle_launched",
      params: {
        appVersion: expect.any(String),
        environment: "production",
        producer: "goose-internal",
      },
    });
    expect(options.page).toEqual(desktopPageContext);
    expect(options.overrides.entityId).toBe("someone@squareup.com");
    expect(options.overrides.entityType).toBe("SQUARE_EMPLOYEE");
  });

  it("buffers events until identity resolves, then flushes them backdated", async () => {
    setEnv("production");
    let resolveWhoami: (value: unknown) => void = () => {};
    invoke.mockReturnValue(
      new Promise((resolve) => {
        resolveWhoami = resolve;
      }),
    );

    const t = await loadTelemetry();
    t.initTelemetry();
    t.trackAppLaunched();

    // Identity not yet known: the event is buffered, not emitted.
    expect(trackWithSchema).not.toHaveBeenCalled();

    resolveWhoami({ email: "someone@squareup.com" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(trackWithSchema).toHaveBeenCalledTimes(1);
    const [event, options] = trackWithSchema.mock.calls[0];
    expect(event.name).toBe("goose_internal_app_lifecycle_launched");
    // Backdated to enqueue time and stamped with the resolved identity.
    expect(options.overrides.originalTimestamp).toEqual(expect.any(String));
    expect(options.overrides.timestamp).toBe(
      options.overrides.originalTimestamp,
    );
    expect(options.overrides.entityId).toBe("someone@squareup.com");
    expect(options.overrides.entityType).toBe("SQUARE_EMPLOYEE");
  });

  it("flushes buffered events as anonymous when identity resolution times out", async () => {
    setEnv("production");
    vi.useFakeTimers();
    invoke.mockReturnValue(new Promise(() => {})); // whoami never settles

    const t = await loadTelemetry();
    t.initTelemetry();
    t.trackAppLaunched();

    expect(trackWithSchema).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(trackWithSchema).toHaveBeenCalledTimes(1);
    const [, options] = trackWithSchema.mock.calls[0];
    // Backdated and stamped with the anonymous entity (no email resolved).
    expect(options.overrides.timestamp).toEqual(expect.any(String));
    expect(options.overrides.entityId).toBe("");
    expect(options.overrides.entityType).toBe("ANON_VISITOR");
  });

  it("retries whoami after a transient failure and identifies on success", async () => {
    setEnv("production");
    vi.useFakeTimers();
    invoke
      .mockRejectedValueOnce(new Error("off WARP"))
      .mockResolvedValueOnce({ email: "someone@squareup.com" });

    const t = await loadTelemetry();
    t.initTelemetry();
    t.trackAppLaunched();

    // First attempt fails; event stays buffered while a retry is scheduled.
    await vi.advanceTimersByTimeAsync(0);
    expect(trackWithSchema).not.toHaveBeenCalled();

    // Backoff is capped at 1s for the first retry; advance past it.
    await vi.advanceTimersByTimeAsync(1_000);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(trackWithSchema).toHaveBeenCalledTimes(1);
    const [, options] = trackWithSchema.mock.calls[0];
    expect(options.overrides.entityId).toBe("someone@squareup.com");
    expect(options.overrides.entityType).toBe("SQUARE_EMPLOYEE");
  });

  it("falls back to anonymous when whoami succeeds without an email", async () => {
    setEnv("staging");
    invoke.mockResolvedValue({ creator: "G2::someone@squareup.com" });

    const t = await loadTelemetry();
    t.initTelemetry();
    t.trackAppLaunched();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(trackWithSchema).toHaveBeenCalledTimes(1);
    const [event, options] = trackWithSchema.mock.calls[0];
    expect(event.params.environment).toBe("staging");
    expect(options.overrides.entityId).toBe("");
    expect(options.overrides.entityType).toBe("ANON_VISITOR");
  });

  it("routes feedback wrappers through the same identified track path", async () => {
    setEnv("production");
    invoke.mockResolvedValue({ email: "someone@squareup.com" });

    const t = await loadTelemetry();
    t.initTelemetry();
    await new Promise((resolve) => setTimeout(resolve, 0));
    t.trackFeedbackSubmitted();

    expect(trackWithSchema).toHaveBeenCalledTimes(1);
    const [event, options] = trackWithSchema.mock.calls[0];
    expect(event).toEqual({
      name: "goose_internal_app_feedback_submitted",
      params: {
        userId: "someone@squareup.com",
        producer: "goose-internal",
      },
    });
    expect(options.overrides.entityId).toBe("someone@squareup.com");
    expect(options.overrides.entityType).toBe("SQUARE_EMPLOYEE");
  });

  it("fills buffered feedback user id from identity when it resolves", async () => {
    setEnv("production");
    let resolveWhoami: (value: unknown) => void = () => {};
    invoke.mockReturnValue(
      new Promise((resolve) => {
        resolveWhoami = resolve;
      }),
    );

    const t = await loadTelemetry();
    t.initTelemetry();
    t.trackFeedbackSubmitted();

    expect(trackWithSchema).not.toHaveBeenCalled();

    resolveWhoami({ email: "someone@squareup.com" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(trackWithSchema).toHaveBeenCalledTimes(1);
    const [event, options] = trackWithSchema.mock.calls[0];
    expect(event).toEqual({
      name: "goose_internal_app_feedback_submitted",
      params: {
        userId: "someone@squareup.com",
        producer: "goose-internal",
      },
    });
    expect(options.overrides.entityId).toBe("someone@squareup.com");
    expect(options.overrides.entityType).toBe("SQUARE_EMPLOYEE");
  });

  it("is a no-op in development by default and never calls whoami", async () => {
    setEnv("development");
    const consoleInfo = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    const t = await loadTelemetry();
    t.initTelemetry();
    t.trackAppLaunched();

    expect(invoke).not.toHaveBeenCalled();
    expect(trackWithSchema).not.toHaveBeenCalled();
    expect(consoleInfo).not.toHaveBeenCalled();
  });

  it("is a no-op in production when the telemetry build feature is disabled", async () => {
    setEnv("production");
    buildFeatures.telemetry = false;

    const t = await loadTelemetry();
    t.initTelemetry();
    t.trackAppLaunched();

    expect(invoke).not.toHaveBeenCalled();
    expect(trackWithSchema).not.toHaveBeenCalled();
  });

  it("logs development events when the env debug toggle is enabled without sending", async () => {
    setEnv("development");
    vi.stubEnv("VITE_TELEMETRY_DEBUG", "1");
    const consoleInfo = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    const t = await loadTelemetry();
    t.initTelemetry();
    t.trackAppLaunched();

    expect(invoke).not.toHaveBeenCalled();
    expect(trackWithSchema).not.toHaveBeenCalled();
    expect(consoleInfo).toHaveBeenCalledWith(
      "[telemetry:debug] event suppressed",
      {
        event: {
          name: "goose_internal_app_lifecycle_launched",
          params: {
            appVersion: expect.any(String),
            environment: "development",
            producer: "goose-internal",
          },
        },
        options: {
          page: desktopPageContext,
          overrides: {
            entityId: "",
            entityType: "ANON_VISITOR",
          },
        },
      },
    );
  });

  it("logs development events when the localStorage debug toggle is enabled without sending", async () => {
    setEnv("development");
    localStorage.setItem("berd.telemetry.debug", "1");
    const consoleInfo = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    const t = await loadTelemetry();
    t.initTelemetry();
    t.trackFeedbackSubmitted();

    expect(invoke).not.toHaveBeenCalled();
    expect(trackWithSchema).not.toHaveBeenCalled();
    expect(consoleInfo).toHaveBeenCalledWith(
      "[telemetry:debug] event suppressed",
      {
        event: {
          name: "goose_internal_app_feedback_submitted",
          params: {
            producer: "goose-internal",
            userId: "",
          },
        },
        options: {
          page: desktopPageContext,
          overrides: {
            entityId: "",
            entityType: "ANON_VISITOR",
          },
        },
      },
    );
  });
});
