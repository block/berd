import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { berdHomePinPinned } from "./events";

// Observe emitted OTel log records by spying on the logger's `emit`. Events
// carry only their own params — no user identity is stamped anywhere, so there
// is no `identify`/CDP envelope to model. The native OTLP exporter is mocked
// out — its wire shape is covered by `exporter.test.ts`.
const emit = vi.fn();
// Captures each LoggerProvider construction so the resource attributes
// (service identity, installation.id, distribution.channel) and the record
// limits can be asserted per-test even after `vi.resetModules()` re-runs the
// mock factory.
const loggerProviderConfigs: Array<{
  resource: { attributes: Record<string, unknown> };
  logRecordLimits?: Record<string, unknown>;
}> = [];
// Same, for the batch processor's queue/batch sizing.
const batchProcessorConfigs: Array<Record<string, unknown>> = [];
// Same, for the instrumentation scope name each logger is requested under.
const loggerScopeNames: string[] = [];
// Lets a test make the `LoggerProvider` constructor throw, standing in for any
// failure inside telemetry's asynchronous init.
const loggerProviderFailure = vi.hoisted(() => ({
  error: null as Error | null,
}));
// Each construction's `forceFlush`, so the close-flush hooks can be asserted
// against the provider the test itself built (listeners from earlier tests in
// this file stay registered on the shared jsdom window and flush their own,
// long-dead providers).
const loggerProviderFlushes: Array<ReturnType<typeof vi.fn>> = [];
// Lets a test make that flush fail, both ways an unload-path call could: a
// rejected promise and a synchronous throw.
const forceFlushFailure = vi.hoisted(() => ({
  rejection: null as Error | null,
  thrown: null as Error | null,
}));
// Events the pipeline cannot emit are reported through the module's diagnostic
// channel, so the tests read that rather than a counter exported only for them.
const perfLog = vi.hoisted(() => vi.fn());
vi.mock("@/shared/lib/perfLog", () => ({ perfLog }));

/** The drop reports `perfLog` has seen, ignoring the module's other logging. */
function dropReports(): string[] {
  return perfLog.mock.calls
    .map(([message]) => String(message))
    .filter((message) => message.includes("dropped"));
}
// The distro fan-out seam (see `./distributionSink`), replaced with a spy so
// tests can pin exactly which events cross it — and, per test, with a throwing
// implementation standing in for a misbehaving overlay replacement.
const distributionSink = vi.hoisted(() => vi.fn());
vi.mock("./distributionSink", () => ({ distributionSink }));
// The telemetry gate now reads the resolved `telemetry` capability (build
// feature AND `featureToggles.telemetry`), so the test drives that snapshot
// directly rather than the raw build-feature state.
const telemetryCapability = vi.hoisted(() => ({ enabled: true }));

vi.mock("@opentelemetry/sdk-logs", () => ({
  LoggerProvider: vi.fn(function LoggerProviderMock(
    config: (typeof loggerProviderConfigs)[number],
  ) {
    if (loggerProviderFailure.error) throw loggerProviderFailure.error;
    loggerProviderConfigs.push(config);
    // Captured at construction rather than read at call time: every pipeline
    // this file starts leaves its close-flush listeners on the shared jsdom
    // window, so a later test's dispatch reaches earlier tests' providers too
    // — and those must keep behaving the way their own test configured them.
    const failure = { ...forceFlushFailure };
    const forceFlush = vi.fn(() => {
      if (failure.thrown) throw failure.thrown;
      return failure.rejection
        ? Promise.reject(failure.rejection)
        : Promise.resolve();
    });
    loggerProviderFlushes.push(forceFlush);
    return {
      getLogger: (name: string) => {
        loggerScopeNames.push(name);
        return { emit, enabled: () => true };
      },
      forceFlush,
      shutdown: vi.fn(),
    };
  }),
  BatchLogRecordProcessor: vi.fn(function BatchLogRecordProcessorMock(
    options: Record<string, unknown>,
  ) {
    batchProcessorConfigs.push(options);
    return {};
  }),
}));

vi.mock("./exporter", () => ({
  createTelemetryLogExporter: () => ({}),
}));

// Mock the Tauri command layer, dispatching per command: `get_telemetry_resource`
// supplies the native resource half the logger's `Resource` awaits (the
// persistent anonymous install id plus the distribution channel), and
// `get_telemetry_settings` / `set_telemetry_enabled` back the consent gate
// (the default answers "enabled", so tests not about consent behave as
// before).
const invoke = vi.fn();
const telemetryResourceCommand = vi.fn();
const telemetrySettingsCommand = vi.fn();
const setTelemetryEnabledCommand = vi.fn();
// The dev-time viewer's only side effect (see `./devLog`).
const rendererLogCommand = vi.fn();
const INSTALLATION_ID = "11111111-2222-4333-8444-555555555555";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("@/shared/profile/capabilities", () => ({
  getProfileCapabilitySnapshot: (id: string) =>
    id === "telemetry" ? telemetryCapability.enabled : true,
}));

// Environment is mocked per-test so we can flip production/staging/development.
const getEnvironment = vi.fn();
const isProduction = vi.fn();
const isStaging = vi.fn();

vi.mock("@/shared/utils/environment", () => ({
  getEnvironment: () => getEnvironment(),
  isProduction: () => isProduction(),
  isStaging: () => isStaging(),
}));

async function loadTelemetry() {
  // Re-import so the module-level logger singleton and buffer state are fresh.
  vi.resetModules();
  return await import("./client");
}

type Telemetry = Awaited<ReturnType<typeof loadTelemetry>>;

const PINNED_ATTRIBUTES = {
  item_type: "HOME_ITEM_TYPE_CHAT",
} as const;

/**
 * A second, non-launch event for the tests that need one — a real catalog
 * event through the public `track` seam, which is how all four feature helpers
 * emit. (`trackAppLaunched` is the module's only remaining event-specific
 * wrapper: the feedback one went with `berd_app_feedback_submitted`.)
 */
function trackPinned(t: Telemetry): void {
  t.track(berdHomePinPinned(PINNED_ATTRIBUTES));
}

function setEnv(env: "production" | "staging" | "development") {
  getEnvironment.mockReturnValue(env);
  isProduction.mockReturnValue(env === "production");
  isStaging.mockReturnValue(env === "staging");
}

beforeEach(() => {
  telemetryCapability.enabled = true;
  emit.mockClear();
  perfLog.mockReset();
  distributionSink.mockReset();
  loggerProviderFailure.error = null;
  forceFlushFailure.rejection = null;
  forceFlushFailure.thrown = null;
  loggerProviderFlushes.length = 0;
  loggerProviderConfigs.length = 0;
  batchProcessorConfigs.length = 0;
  loggerScopeNames.length = 0;
  invoke.mockReset();
  telemetryResourceCommand.mockReset().mockResolvedValue({
    installationId: INSTALLATION_ID,
    channel: "public",
  });
  telemetrySettingsCommand.mockReset().mockResolvedValue({ enabled: true });
  setTelemetryEnabledCommand
    .mockReset()
    .mockImplementation((args: { enabled: boolean }) =>
      Promise.resolve({ enabled: args.enabled }),
    );
  rendererLogCommand.mockReset().mockResolvedValue(undefined);
  invoke.mockImplementation((command: unknown, args?: unknown) => {
    switch (command) {
      case "get_telemetry_resource":
        return telemetryResourceCommand();
      case "get_telemetry_settings":
        return telemetrySettingsCommand();
      case "set_telemetry_enabled":
        return setTelemetryEnabledCommand(args as { enabled: boolean });
      case "log_renderer_event":
        return rendererLogCommand(args as { level: string; message: string });
      default:
        // The client invokes nothing else (the whoami identity round-trip is
        // gone from telemetry entirely), so an unexpected command is a bug.
        return Promise.reject(new Error(`unexpected command: ${command}`));
    }
  });
});

/**
 * The minimum Tauri internals the dev-time viewer's log bridge needs. Absent by
 * default, which is what keeps every other test's `invoke` assertions about
 * telemetry's own commands.
 */
function stubTauriWindow(label: string) {
  window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label } } };
}

/** Lines the dev-time viewer forwarded to the app log. */
function devLogLines(): string[] {
  return rendererLogCommand.mock.calls.map(([args]) => String(args.message));
}

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  localStorage.clear();
  // The launch guard is scoped to the window session, not to module state, so
  // clearing it is what makes each test a fresh app start rather than a reload
  // of the previous one.
  sessionStorage.clear();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("telemetry", () => {
  it("emits an event's params as its attributes, with no identity stamp", async () => {
    setEnv("production");

    const t = await loadTelemetry();
    t.initTelemetry();
    // Let the pipeline come up before tracking so the event emits immediately.
    await new Promise((resolve) => setTimeout(resolve, 0));
    t.trackAppLaunched();

    expect(emit).toHaveBeenCalledTimes(1);
    const [record] = emit.mock.calls[0];
    expect(record.eventName).toBe("berd_app_lifecycle_launched");
    expect(record.attributes).toEqual({
      app_version: expect.any(String),
      environment: "production",
    });
    // `user_id` is gone from the wire contract entirely — `berd-otlp-logs-v2`
    // rejects its presence — so nothing may reintroduce it.
    expect(record.attributes).not.toHaveProperty("user_id");
    // Emitted immediately (not backdated), so no explicit timestamp.
    expect(record.timestamp).toBeUndefined();
  });

  // `berd_app_lifecycle_launched.environment` is typed as the two values the
  // build gate lets emit, so `development` is unrepresentable rather than
  // merely unreachable. The gate itself is unchanged — `telemetryBuildEnabled`
  // is still the only thing deciding whether anything emits — so what these
  // pin is the attribute, not a second gate: development still *fires* the
  // event (the dev viewer reports it), just without a value it has no member
  // for, and never coerced into "production".
  describe("launch event environment", () => {
    it("reports staging as staging", async () => {
      setEnv("staging");

      const t = await loadTelemetry();
      t.initTelemetry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      t.trackAppLaunched();

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls[0][0].attributes).toEqual({
        app_version: expect.any(String),
        environment: "staging",
      });
    });

    it("omits the attribute in development rather than inventing one", async () => {
      setEnv("development");
      stubTauriWindow("main");

      const t = await loadTelemetry();
      t.initTelemetry();
      t.trackAppLaunched();

      // The build gate suppresses the emission, as before...
      expect(emit).not.toHaveBeenCalled();
      // ...and the event that fired carries no environment at all — in
      // particular not "production", which the gateway would happily accept.
      expect(devLogLines()).toEqual([
        expect.stringContaining("berd_app_lifecycle_launched"),
      ]);
      expect(devLogLines()[0]).not.toContain("environment");
    });
  });

  it("buffers events until the logger exists, then flushes them backdated", async () => {
    setEnv("production");
    let resolveResource: (value: unknown) => void = () => {};
    telemetryResourceCommand.mockReturnValue(
      new Promise((resolve) => {
        resolveResource = resolve;
      }),
    );

    const t = await loadTelemetry();
    t.initTelemetry();
    t.trackAppLaunched();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The logger's resource is still awaiting the native answer: the event is
    // buffered, not emitted.
    expect(emit).not.toHaveBeenCalled();

    resolveResource({ installationId: INSTALLATION_ID, channel: "public" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(emit).toHaveBeenCalledTimes(1);
    const [record] = emit.mock.calls[0];
    expect(record.eventName).toBe("berd_app_lifecycle_launched");
    // Backdated to when the launch actually happened, not when it flushed.
    expect(record.timestamp).toBeInstanceOf(Date);
  });

  it("stamps the installation id and distribution channel as resource attributes", async () => {
    setEnv("production");

    const t = await loadTelemetry();
    t.initTelemetry();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(telemetryResourceCommand).toHaveBeenCalledTimes(1);
    expect(loggerProviderConfigs).toHaveLength(1);
    expect(loggerProviderConfigs[0].resource.attributes).toMatchObject({
      "installation.id": INSTALLATION_ID,
      "distribution.channel": "public",
    });
  });

  it("stamps the internal channel when the staged distro config declares it", async () => {
    setEnv("staging");
    telemetryResourceCommand.mockResolvedValue({
      installationId: INSTALLATION_ID,
      channel: "internal",
    });

    const t = await loadTelemetry();
    t.initTelemetry();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loggerProviderConfigs[0].resource.attributes).toMatchObject({
      "deployment.environment": "staging",
      "distribution.channel": "internal",
    });
  });

  it("falls back to the public channel when the native answer is outside the closed set", async () => {
    setEnv("production");
    // The gateway allowlists exactly {public, internal}; anything else on the
    // wire is a terminal 400 for the whole batch, so an unrecognized native
    // answer must read as public rather than pass through.
    telemetryResourceCommand.mockResolvedValue({
      installationId: INSTALLATION_ID,
      channel: "beta",
    });

    const t = await loadTelemetry();
    t.initTelemetry();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loggerProviderConfigs[0].resource.attributes).toMatchObject({
      "distribution.channel": "public",
    });
  });

  it("names the service and instrumentation scope with the gateway's literals", async () => {
    setEnv("production");

    const t = await loadTelemetry();
    t.initTelemetry();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Pinned as literals, not as the module's own constants: the gateway's
    // `berd-otlp-logs-v2` schema accepts exactly these values — both renamed
    // from `goose-internal` before any client shipped — so a revert is a
    // terminal 400 on every upload, and the dropped batch is never retried.
    expect(loggerProviderConfigs[0].resource.attributes).toMatchObject({
      "service.name": "berd",
    });
    expect(loggerScopeNames).toEqual(["berd.telemetry"]);
  });

  it("sizes batches and attribute values for the gateway's body limit", async () => {
    setEnv("production");

    const t = await loadTelemetry();
    t.initTelemetry();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Pinned as literals, not as the module's own constants: these values are
    // deliberately not the SDK defaults (512-record batches, unbounded
    // attribute values), because an oversized batch is 413'd and then dropped
    // rather than retried. `exporter.test.ts` pins the byte math behind them.
    expect(batchProcessorConfigs).toEqual([
      {
        exporter: expect.anything(),
        maxQueueSize: 2048,
        maxExportBatchSize: 128,
      },
    ]);
    expect(loggerProviderConfigs[0].logRecordLimits).toEqual({
      attributeValueLengthLimit: 256,
    });
  });

  it("omits installation.id and defaults the channel when the native resource is unavailable", async () => {
    setEnv("production");
    // A genuine failure, deliberately not a "state not managed" one: the
    // startup retry treats that message as transient and would answer it with
    // backoff rather than this immediate fallback (pinned separately below).
    telemetryResourceCommand.mockRejectedValue(
      new Error("telemetry state unavailable"),
    );

    const t = await loadTelemetry();
    t.initTelemetry();
    await new Promise((resolve) => setTimeout(resolve, 0));
    t.trackAppLaunched();

    // Telemetry stays best-effort: the resource simply lacks the id attribute
    // (the native side still keys uploads on the id it bootstrapped with) and
    // the channel takes its universal fallback.
    expect(emit).toHaveBeenCalledTimes(1);
    expect(telemetryResourceCommand).toHaveBeenCalledTimes(1);
    expect(loggerProviderConfigs).toHaveLength(1);
    expect(loggerProviderConfigs[0].resource.attributes).not.toHaveProperty(
      "installation.id",
    );
    expect(loggerProviderConfigs[0].resource.attributes).toMatchObject({
      "distribution.channel": "public",
    });
  });

  // The renderer can run ahead of Tauri's `setup()`, and this invoke is the
  // one an enforced build reaches at renderer boot with no earlier native
  // round-trip to absorb that window. Losing it there is not a lost event but
  // a mislabelled session: the provider's `Resource` is fixed at construction,
  // so the fallback channel would ride every event the renderer ever sends.
  describe("startup state-not-managed window", () => {
    it("keeps the real installation id and channel across a transient rejection", async () => {
      setEnv("production");
      vi.useFakeTimers();
      telemetryResourceCommand
        .mockRejectedValueOnce(new Error("state not managed"))
        .mockResolvedValue({
          installationId: INSTALLATION_ID,
          channel: "internal",
        });

      const t = await loadTelemetry();
      t.initTelemetry();
      t.trackAppLaunched();

      // The first attempt rejected, so the provider does not exist yet and the
      // launch event is still buffered.
      await vi.advanceTimersByTimeAsync(0);
      expect(loggerProviderConfigs).toHaveLength(0);

      // Past the first backoff the retry answers, and the session is both
      // attributed and labelled with the channel it actually shipped on —
      // rather than silently counted in the public segment.
      await vi.advanceTimersByTimeAsync(100);

      expect(telemetryResourceCommand).toHaveBeenCalledTimes(2);
      expect(loggerProviderConfigs).toHaveLength(1);
      expect(loggerProviderConfigs[0].resource.attributes).toMatchObject({
        "installation.id": INSTALLATION_ID,
        "distribution.channel": "internal",
      });
      expect(emit).toHaveBeenCalledTimes(1);
      expect(dropReports()).toEqual([]);
    });

    it("falls back once the retries are exhausted, inside the logger gate", async () => {
      setEnv("production");
      vi.useFakeTimers();
      telemetryResourceCommand.mockRejectedValue(
        new Error("state not managed"),
      );

      const t = await loadTelemetry();
      t.initTelemetry();
      t.trackAppLaunched();

      // Six attempts across 100+200+400+800+1600ms of backoff, all inside
      // `TELEMETRY_RESOURCE_TIMEOUT_MS`: the retry path terminates on its own
      // rather than leaving the logger gate to time out.
      await vi.advanceTimersByTimeAsync(3_100);

      expect(telemetryResourceCommand).toHaveBeenCalledTimes(6);
      expect(loggerProviderConfigs).toHaveLength(1);
      expect(loggerProviderConfigs[0].resource.attributes).not.toHaveProperty(
        "installation.id",
      );
      expect(loggerProviderConfigs[0].resource.attributes).toMatchObject({
        "distribution.channel": "public",
      });
      // And the pipeline still came up: the buffered launch event flushed and
      // later events emit immediately.
      expect(emit).toHaveBeenCalledTimes(1);
      trackPinned(t);
      expect(emit).toHaveBeenCalledTimes(2);
      expect(dropReports()).toEqual([]);
    });
  });

  // `berd_app_lifecycle_launched` means "the app started". A renderer reload
  // (a WebKit reap under memory pressure, the crash screen's Reload button)
  // re-runs the whole bundle in the same window, so the guard has to outlive
  // module state — `loadTelemetry()` here is exactly that reload, since it
  // gives a fresh module instance against the same window session store.
  describe("launch event once per app start", () => {
    it("does not fire again when the renderer reloads", async () => {
      setEnv("production");

      const first = await loadTelemetry();
      first.initTelemetry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      first.trackAppLaunched();

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls[0][0].eventName).toBe(
        "berd_app_lifecycle_launched",
      );

      const reloaded = await loadTelemetry();
      reloaded.initTelemetry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      reloaded.trackAppLaunched();

      expect(emit).toHaveBeenCalledTimes(1);

      // Only the launch event is suppressed: the reloaded renderer still built
      // its own pipeline and every other event still emits through it.
      expect(loggerProviderConfigs).toHaveLength(2);
      trackPinned(reloaded);
      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit.mock.calls[1][0].eventName).toBe("berd_home_pin_pinned");
    });

    it("fires again in the fresh window a real app start creates", async () => {
      setEnv("production");

      const first = await loadTelemetry();
      first.initTelemetry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      first.trackAppLaunched();

      expect(emit).toHaveBeenCalledTimes(1);

      // A real app start builds a new webview, whose session store is empty —
      // nothing persists it across the process.
      sessionStorage.clear();

      const restarted = await loadTelemetry();
      restarted.initTelemetry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      restarted.trackAppLaunched();

      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit.mock.calls[1][0].eventName).toBe(
        "berd_app_lifecycle_launched",
      );
    });

    it("still fires when the window session store is unavailable", async () => {
      setEnv("production");
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("storage disabled");
      });

      const first = await loadTelemetry();
      first.initTelemetry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      first.trackAppLaunched();

      const reloaded = await loadTelemetry();
      reloaded.initTelemetry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      reloaded.trackAppLaunched();

      // Fails open: an unreadable store over-counts launches rather than
      // silently losing the event.
      expect(emit).toHaveBeenCalledTimes(2);
    });
  });

  // The chokepoint's own edges: the pipeline has to come up — or give up —
  // even when the native side never answers, and whatever it cannot emit has
  // to be countable. This matters more now that detached session windows
  // initialize telemetry too: they run the instrumented chat send paths, so a
  // wedged pipeline there loses real user events with nothing to show for it.
  describe("startup edges", () => {
    it("builds the pipeline anyway when the native resource never answers", async () => {
      setEnv("production");
      vi.useFakeTimers();
      // The invoke hangs rather than rejecting — the case the client cannot
      // tell apart from a slow answer.
      telemetryResourceCommand.mockReturnValue(new Promise(() => {}));

      const t = await loadTelemetry();
      t.initTelemetry();
      t.trackAppLaunched();

      // Nothing emits while the logger waits on the native answer.
      await vi.advanceTimersByTimeAsync(0);
      expect(emit).not.toHaveBeenCalled();

      // The logger gate is bounded like the consent gate: the hang answers as
      // "no installation id, public channel", so the provider is built and the
      // buffer drains.
      await vi.advanceTimersByTimeAsync(5_000);

      expect(loggerProviderConfigs).toHaveLength(1);
      expect(loggerProviderConfigs[0].resource.attributes).not.toHaveProperty(
        "installation.id",
      );
      expect(loggerProviderConfigs[0].resource.attributes).toMatchObject({
        "distribution.channel": "public",
      });
      expect(emit).toHaveBeenCalledTimes(1);
      const [record] = emit.mock.calls[0];
      expect(record.eventName).toBe("berd_app_lifecycle_launched");

      // And the pipeline is live afterwards, not merely drained once.
      trackPinned(t);
      expect(emit).toHaveBeenCalledTimes(2);
      expect(dropReports()).toEqual([]);
    });

    it("gives up loudly when the logger cannot be constructed", async () => {
      setEnv("production");
      loggerProviderFailure.error = new Error("provider unavailable");

      const t = await loadTelemetry();
      t.initTelemetry();
      t.trackAppLaunched();
      // A throw inside init must be caught here, not surface as an unhandled
      // rejection, and must not leave the pipeline waiting on a logger that is
      // never coming.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(emit).not.toHaveBeenCalled();
      expect(perfLog).toHaveBeenCalledWith(
        "[telemetry] failed to construct the logger: Error: provider unavailable",
      );
      expect(dropReports()).toEqual([
        "[telemetry] dropped 1 event(s): the telemetry logger could not be constructed (1 dropped this session)",
      ]);

      // Terminal: later events are counted drops, not a buffer that grows
      // until it overflows one event at a time.
      trackPinned(t);
      expect(emit).not.toHaveBeenCalled();
      expect(dropReports()).toHaveLength(2);
      expect(dropReports()[1]).toContain("(2 dropped this session)");
    });

    it("counts what an overflowing buffer cannot keep before the logger exists", async () => {
      setEnv("production");
      let resolveResource: (value: unknown) => void = () => {};
      telemetryResourceCommand.mockReturnValue(
        new Promise((resolve) => {
          resolveResource = resolve;
        }),
      );

      const t = await loadTelemetry();
      t.initTelemetry();

      // 50 fit; the next two have nowhere to go — no logger to emit through
      // and no room left to wait in.
      for (let i = 0; i < 52; i += 1) trackPinned(t);

      expect(emit).not.toHaveBeenCalled();
      expect(dropReports()).toEqual([
        "[telemetry] dropped 1 event(s): buffer full before the logger was ready (1 dropped this session)",
        "[telemetry] dropped 1 event(s): buffer full before the logger was ready (2 dropped this session)",
      ]);

      resolveResource({ installationId: INSTALLATION_ID, channel: "public" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The 50 that fit still flush once the pipeline comes up.
      expect(emit).toHaveBeenCalledTimes(50);
    });
  });

  // The consent gate: the persisted, Rust-owned telemetry setting is read
  // asynchronously at startup and fails closed. Enabled installs must not
  // lose the launch event to the read window; disabled installs must do no
  // telemetry work at all — no telemetry-resource round-trip, no pipeline.
  describe("consent gate", () => {
    it("buffers events while the setting loads, then flushes them backdated once it enables", async () => {
      setEnv("production");
      let resolveConsent: (value: unknown) => void = () => {};
      telemetrySettingsCommand.mockReturnValue(
        new Promise((resolve) => {
          resolveConsent = resolve;
        }),
      );

      const t = await loadTelemetry();
      t.initTelemetry();
      t.trackAppLaunched();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Consent unknown: nothing emits and the pipeline stays down — no
      // telemetry-resource round-trip.
      expect(emit).not.toHaveBeenCalled();
      expect(telemetryResourceCommand).not.toHaveBeenCalled();

      resolveConsent({ enabled: true });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(emit).toHaveBeenCalledTimes(1);
      const [record] = emit.mock.calls[0];
      expect(record.eventName).toBe("berd_app_lifecycle_launched");
      // Backdated to when the launch actually happened, not when consent
      // loaded.
      expect(record.timestamp).toBeInstanceOf(Date);
      expect(dropReports()).toEqual([]);
    });

    it("discards buffered events and stays fully inert when the setting loads disabled", async () => {
      setEnv("production");
      telemetrySettingsCommand.mockResolvedValue({ enabled: false });

      const t = await loadTelemetry();
      t.initTelemetry();
      t.trackAppLaunched();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(emit).not.toHaveBeenCalled();
      expect(loggerProviderConfigs).toHaveLength(0);
      expect(telemetryResourceCommand).not.toHaveBeenCalled();
      expect(dropReports()).toEqual([
        "[telemetry] dropped 1 event(s): telemetry is disabled for this installation (1 dropped this session)",
      ]);

      // Settled disabled: later events are suppressed outright, not buffered
      // (and not counted — production was told not to emit them).
      trackPinned(t);
      expect(emit).not.toHaveBeenCalled();
      expect(dropReports()).toHaveLength(1);
    });

    it("drops buffered events when the setting never answers, then recovers if it enables late", async () => {
      setEnv("production");
      vi.useFakeTimers();
      let resolveConsent: (value: unknown) => void = () => {};
      telemetrySettingsCommand.mockReturnValue(
        new Promise((resolve) => {
          resolveConsent = resolve;
        }),
      );

      const t = await loadTelemetry();
      t.initTelemetry();
      t.trackAppLaunched();

      // The consent gate is bounded like the logger gate: a read that never
      // answers costs the buffered events (counted), it does not wedge the
      // renderer.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(emit).not.toHaveBeenCalled();
      expect(dropReports()).toEqual([
        "[telemetry] dropped 1 event(s): the telemetry setting did not load in time (1 dropped this session)",
      ]);

      // Events after the timeout are suppressed as counted drops, not
      // buffered: consent is still unsettled, so a late enabled answer would
      // make each of them a real loss on a consented install — the same
      // uncertainty the buffer discard above was counted under.
      trackPinned(t);
      expect(dropReports()).toHaveLength(2);
      expect(dropReports()[1]).toBe(
        "[telemetry] dropped 1 event(s): the telemetry setting did not load in time (2 dropped this session)",
      );

      // A late enabled answer still brings the pipeline up for what follows.
      resolveConsent({ enabled: true });
      await vi.advanceTimersByTimeAsync(0);
      trackPinned(t);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls[0][0].eventName).toBe("berd_home_pin_pinned");
      // Emission resumed, so the counting stops with it.
      expect(dropReports()).toHaveLength(2);
    });

    it("stops counting once a late answer settles the setting disabled", async () => {
      setEnv("production");
      vi.useFakeTimers();
      let resolveConsent: (value: unknown) => void = () => {};
      telemetrySettingsCommand.mockReturnValue(
        new Promise((resolve) => {
          resolveConsent = resolve;
        }),
      );

      const t = await loadTelemetry();
      t.initTelemetry();
      t.trackAppLaunched();

      await vi.advanceTimersByTimeAsync(5_000);
      trackPinned(t);
      // The discarded buffer plus the post-timeout event, both counted while
      // the answer was still unknown.
      expect(dropReports()).toHaveLength(2);

      resolveConsent({ enabled: false });
      await vi.advanceTimersByTimeAsync(0);
      trackPinned(t);

      // Consent has an answer now, and it is no: suppression is the product
      // working rather than a loss, so it goes back to uncounted.
      expect(emit).not.toHaveBeenCalled();
      expect(dropReports()).toHaveLength(2);
    });

    it("treats an enforced build as consented without reading the setting", async () => {
      setEnv("production");
      vi.stubEnv("VITE_TELEMETRY_ENFORCED", "1");

      const t = await loadTelemetry();
      t.initTelemetry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      t.trackAppLaunched();

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls[0][0].eventName).toBe(
        "berd_app_lifecycle_launched",
      );
      // Enforced consent never consults the persisted setting.
      expect(telemetrySettingsCommand).not.toHaveBeenCalled();
    });

    it("starts the pipeline mid-session when the user turns telemetry on", async () => {
      setEnv("production");
      telemetrySettingsCommand.mockResolvedValue({ enabled: false });

      const t = await loadTelemetry();
      t.initTelemetry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(telemetryResourceCommand).not.toHaveBeenCalled();

      // Same module registry as the client, i.e. the store instance the
      // settings toggle writes through.
      const consent = await import("./consent");
      await consent.updateTelemetryEnabled(true);
      await new Promise((resolve) => setTimeout(resolve, 0));

      trackPinned(t);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls[0][0].eventName).toBe("berd_home_pin_pinned");
      expect(setTelemetryEnabledCommand).toHaveBeenCalledWith({
        enabled: true,
      });
    });
  });

  // The dev-time viewer (see `./devLog`) taps the chokepoint itself, ahead of
  // every gate, so `just dev` reports what *fired* rather than what survived.
  // These pin that it hangs off `trackEvent` — not off one entry point or one
  // gating outcome — and that it costs production builds nothing.
  describe("dev event viewer", () => {
    it("reports every entry point's event at track time", async () => {
      setEnv("production");
      stubTauriWindow("main");

      const t = await loadTelemetry();
      t.initTelemetry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      t.trackAppLaunched();
      trackPinned(t);

      expect(devLogLines()).toEqual([
        expect.stringContaining("main berd_app_lifecycle_launched"),
        expect.stringContaining("main berd_home_pin_pinned"),
      ]);
      // The same params the record carries as its attributes.
      expect(devLogLines()[0]).toContain('"environment":"production"');
    });

    it("reports events the build gate suppresses", async () => {
      setEnv("development");
      stubTauriWindow("main");

      const t = await loadTelemetry();
      t.initTelemetry();
      t.trackAppLaunched();

      // Nothing is emitted in development — which is exactly the case a
      // terminal viewer exists for.
      expect(emit).not.toHaveBeenCalled();
      expect(devLogLines()).toEqual([
        expect.stringContaining("berd_app_lifecycle_launched"),
      ]);
    });

    it("reports events consent then discards, labelled by window", async () => {
      setEnv("production");
      stubTauriWindow("session:abc123");
      telemetrySettingsCommand.mockResolvedValue({ enabled: false });

      const t = await loadTelemetry();
      t.initTelemetry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      trackPinned(t);

      expect(emit).not.toHaveBeenCalled();
      expect(devLogLines()).toEqual([
        expect.stringContaining("session:abc123 berd_home_pin_pinned"),
      ]);
    });

    it("reports a buffered event when it fires, not when it flushes", async () => {
      setEnv("production");
      stubTauriWindow("main");
      // The native resource never answers, so the logger never appears and
      // the event stays buffered.
      telemetryResourceCommand.mockReturnValue(new Promise(() => {}));

      const t = await loadTelemetry();
      t.initTelemetry();
      trackPinned(t);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(emit).not.toHaveBeenCalled();
      expect(devLogLines()).toHaveLength(1);
    });

    it("is absent outside the Vite dev server, leaving emission untouched", async () => {
      setEnv("production");
      vi.stubEnv("DEV", false);
      stubTauriWindow("main");

      const t = await loadTelemetry();
      t.initTelemetry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      t.trackAppLaunched();

      expect(emit).toHaveBeenCalledTimes(1);
      expect(rendererLogCommand).not.toHaveBeenCalled();
    });
  });

  // The distro fan-out seam (see `./distributionSink`): a distribution
  // overlay replaces the stock no-op module to receive every emitted event
  // without forking the client. These pin the seam's contract — it fires
  // exactly for events that reach the logger (post build gate, consent gate,
  // and startup buffer), carries the original fire time, and a misbehaving
  // replacement cannot disturb emission. The stock module's own inertness is
  // pinned in `distributionSink.test.ts`.
  describe("distribution sink seam", () => {
    it("hands each emitted event to the sink with its name, attributes, and fire time", async () => {
      setEnv("production");

      const t = await loadTelemetry();
      t.initTelemetry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      t.trackAppLaunched();
      trackPinned(t);

      expect(distributionSink).toHaveBeenCalledTimes(2);
      expect(distributionSink.mock.calls[0][0]).toEqual({
        name: "berd_app_lifecycle_launched",
        attributes: {
          app_version: expect.any(String),
          environment: "production",
        },
        firedAt: expect.any(String),
      });
      expect(distributionSink.mock.calls[1][0]).toEqual({
        name: "berd_home_pin_pinned",
        attributes: PINNED_ATTRIBUTES,
        firedAt: expect.any(String),
      });
      // An immediately-emitted event's fire time is "now", as a parseable
      // ISO timestamp.
      expect(
        new Date(distributionSink.mock.calls[0][0].firedAt).getTime(),
      ).not.toBeNaN();
    });

    it("hands a buffered event over backdated to when it fired, not when it flushed", async () => {
      setEnv("production");
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-14T00:00:00.000Z"));
      let resolveResource: (value: unknown) => void = () => {};
      telemetryResourceCommand.mockReturnValue(
        new Promise((resolve) => {
          resolveResource = resolve;
        }),
      );

      const t = await loadTelemetry();
      t.initTelemetry();
      trackPinned(t);
      await vi.advanceTimersByTimeAsync(0);

      // Buffered: nothing has reached the logger, so nothing crosses the
      // seam yet.
      expect(emit).not.toHaveBeenCalled();
      expect(distributionSink).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3_000);
      resolveResource({ installationId: INSTALLATION_ID, channel: "public" });
      await vi.advanceTimersByTimeAsync(0);

      expect(emit).toHaveBeenCalledTimes(1);
      expect(distributionSink).toHaveBeenCalledTimes(1);
      expect(distributionSink.mock.calls[0][0].firedAt).toBe(
        "2026-08-14T00:00:00.000Z",
      );
    });

    it("does not cross the seam for events the build gate suppresses", async () => {
      setEnv("development");

      const t = await loadTelemetry();
      t.initTelemetry();
      t.trackAppLaunched();

      expect(emit).not.toHaveBeenCalled();
      expect(distributionSink).not.toHaveBeenCalled();
    });

    it("does not cross the seam for events consent discards or suppresses", async () => {
      setEnv("production");
      telemetrySettingsCommand.mockResolvedValue({ enabled: false });

      const t = await loadTelemetry();
      t.initTelemetry();
      // Buffered while the setting loads, then discarded when it answers
      // disabled...
      t.trackAppLaunched();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // ...and suppressed outright once consent has settled.
      trackPinned(t);

      expect(emit).not.toHaveBeenCalled();
      expect(distributionSink).not.toHaveBeenCalled();
    });

    it("keeps emitting when a replacement sink throws", async () => {
      setEnv("production");
      distributionSink.mockImplementation(() => {
        throw new Error("overlay sink is broken");
      });

      const t = await loadTelemetry();
      t.initTelemetry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      t.trackAppLaunched();
      trackPinned(t);

      // Every record still reached the logger: the throw is contained on the
      // client's side of the seam and reported through the diagnostic
      // channel, not escalated into a tracking failure or a counted drop.
      expect(emit).toHaveBeenCalledTimes(2);
      expect(perfLog).toHaveBeenCalledWith(
        "[telemetry] distribution sink failed: Error: overlay sink is broken",
      );
      expect(perfLog.mock.calls.map(([m]) => String(m))).not.toContainEqual(
        expect.stringContaining("failed to track event"),
      );
      expect(dropReports()).toEqual([]);
    });
  });

  // The close-flush hooks: the batch processor holds emitted records until its
  // scheduled delay elapses, so whatever is still queued when a webview is
  // torn down is lost with no counter to show for it. These pin the drain at
  // both teardown signals — `pagehide` on `window` for a real unload (a
  // detached session window closing, the last window closing, quit) and
  // `visibilitychange` to hidden for the main window's close-as-hide — that
  // an inert pipeline registers nothing, and that a failing flush stays a
  // diagnostic rather than an exception into teardown.
  describe("close flush", () => {
    /** The teardown signal the main window's close-as-hide produces. */
    function dispatchVisibility(state: DocumentVisibilityState): void {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
      document.dispatchEvent(new Event("visibilitychange"));
    }

    /** The `perfLog` reports the flush path is allowed to produce. */
    function flushFailureReports(): string[] {
      return perfLog.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes("flush"));
    }

    /** The event names an `addEventListener` spy was asked to listen for. */
    function listenedEvents(spy: { mock: { calls: unknown[][] } }): string[] {
      return spy.mock.calls.map(([type]) => String(type));
    }

    async function startedPipeline(): Promise<Telemetry> {
      setEnv("production");
      const t = await loadTelemetry();
      t.initTelemetry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return t;
    }

    it("drains the queue on a real unload", async () => {
      const t = await startedPipeline();
      trackPinned(t);

      expect(loggerProviderFlushes).toHaveLength(1);
      expect(loggerProviderFlushes[0]).not.toHaveBeenCalled();

      // Registered on `window`, where `pagehide` actually fires — the SDK's
      // own fallback listens on `document`, which this event never reaches.
      window.dispatchEvent(new Event("pagehide"));

      expect(loggerProviderFlushes[0]).toHaveBeenCalledTimes(1);
      expect(flushFailureReports()).toEqual([]);
    });

    it("drains the queue when the window is hidden, and only then", async () => {
      await startedPipeline();

      // The main window's close is intercepted into `hide()` whenever a
      // secondary window exists, so hidden is a teardown signal here...
      dispatchVisibility("hidden");
      expect(loggerProviderFlushes[0]).toHaveBeenCalledTimes(1);

      // ...while coming back is not.
      dispatchVisibility("visible");
      expect(loggerProviderFlushes[0]).toHaveBeenCalledTimes(1);
    });

    it("registers once no matter how often consent settles", async () => {
      setEnv("production");
      const t = await loadTelemetry();
      t.initTelemetry();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // A mid-session toggle settles consent again; the pipeline guard means
      // one provider, and with it one pair of listeners.
      const consent = await import("./consent");
      await consent.updateTelemetryEnabled(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      trackPinned(t);

      expect(loggerProviderFlushes).toHaveLength(1);
      window.dispatchEvent(new Event("pagehide"));
      expect(loggerProviderFlushes[0]).toHaveBeenCalledTimes(1);
    });

    it("registers nothing when the build gate keeps the pipeline down", async () => {
      setEnv("development");
      const addWindowListener = vi.spyOn(window, "addEventListener");
      const addDocumentListener = vi.spyOn(document, "addEventListener");

      const t = await loadTelemetry();
      t.initTelemetry();
      t.trackAppLaunched();

      expect(loggerProviderFlushes).toHaveLength(0);
      expect(listenedEvents(addWindowListener)).not.toContain("pagehide");
      expect(listenedEvents(addDocumentListener)).not.toContain(
        "visibilitychange",
      );

      // And dispatching the teardown signals anyway is inert.
      window.dispatchEvent(new Event("pagehide"));
      dispatchVisibility("hidden");
      expect(flushFailureReports()).toEqual([]);
    });

    it("registers nothing when consent denies the pipeline", async () => {
      setEnv("production");
      telemetrySettingsCommand.mockResolvedValue({ enabled: false });

      const t = await loadTelemetry();
      t.initTelemetry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      trackPinned(t);

      expect(loggerProviderFlushes).toHaveLength(0);

      window.dispatchEvent(new Event("pagehide"));
      dispatchVisibility("hidden");
      expect(flushFailureReports()).toEqual([]);
    });

    it("contains a rejected flush", async () => {
      forceFlushFailure.rejection = new Error("exporter is gone");
      await startedPipeline();

      // Fire-and-forget by design: the durable step is the IPC message the
      // export already posted, and an unload handler cannot await anything.
      expect(() => window.dispatchEvent(new Event("pagehide"))).not.toThrow();
      await Promise.resolve();

      expect(flushFailureReports()).toEqual([
        "[telemetry] close flush failed: Error: exporter is gone",
      ]);
      expect(dropReports()).toEqual([]);
    });

    it("contains a flush that throws synchronously", async () => {
      forceFlushFailure.thrown = new Error("provider is broken");
      await startedPipeline();

      expect(() => dispatchVisibility("hidden")).not.toThrow();

      expect(flushFailureReports()).toEqual([
        "[telemetry] close flush failed: Error: provider is broken",
      ]);
      expect(dropReports()).toEqual([]);
    });
  });

  // `track` is the seam all four feature helpers emit through, so it goes
  // through the same gates and the same buffer as the launch wrapper above it.
  it("routes the generic track seam through the same path", async () => {
    setEnv("production");

    const t = await loadTelemetry();
    t.initTelemetry();
    await new Promise((resolve) => setTimeout(resolve, 0));
    trackPinned(t);

    expect(emit).toHaveBeenCalledTimes(1);
    const [record] = emit.mock.calls[0];
    expect(record.eventName).toBe("berd_home_pin_pinned");
    // The event's params, verbatim — nothing stamps anything else on.
    expect(record.attributes).toEqual(PINNED_ATTRIBUTES);
  });

  it("does not leak renderer page context or local URLs into the emitted record", async () => {
    setEnv("production");
    window.history.replaceState(null, "", "/renderer?debug=true");
    Object.defineProperty(document, "referrer", {
      configurable: true,
      value: "http://localhost:1520/previous",
    });

    const t = await loadTelemetry();
    t.initTelemetry();
    await new Promise((resolve) => setTimeout(resolve, 0));
    t.trackAppLaunched();

    expect(emit).toHaveBeenCalledTimes(1);
    const [record] = emit.mock.calls[0];
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("localhost");
    expect(serialized).not.toContain("/renderer");
    expect(serialized).not.toContain("referrer");

    window.history.replaceState(null, "", "/");
    delete (document as unknown as Record<string, unknown>).referrer;
  });

  it("is a no-op in development by default and performs no native work", async () => {
    setEnv("development");
    const consoleInfo = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    const t = await loadTelemetry();
    t.initTelemetry();
    t.trackAppLaunched();

    expect(invoke).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(consoleInfo).not.toHaveBeenCalled();
  });

  it("is a no-op in production when the telemetry capability is disabled", async () => {
    setEnv("production");
    // A disabled capability covers both the build-feature off switch and a
    // future `featureToggles.telemetry: false`; the client only sees the
    // resolved snapshot.
    telemetryCapability.enabled = false;

    const t = await loadTelemetry();
    t.initTelemetry();
    t.trackAppLaunched();

    expect(invoke).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
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
    expect(emit).not.toHaveBeenCalled();
    expect(consoleInfo).toHaveBeenCalledWith(
      "[telemetry:debug] event suppressed",
      {
        eventName: "berd_app_lifecycle_launched",
        // No `environment`: `BerdAppEnvironment` models only the two values
        // that can reach the wire, so a development build reports none rather
        // than one it would be misfiled under.
        attributes: { app_version: expect.any(String) },
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
    trackPinned(t);

    expect(invoke).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(consoleInfo).toHaveBeenCalledWith(
      "[telemetry:debug] event suppressed",
      {
        eventName: "berd_home_pin_pinned",
        attributes: PINNED_ATTRIBUTES,
      },
    );
  });
});
