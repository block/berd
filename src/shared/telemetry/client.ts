/**
 * Telemetry client for Berd.
 *
 * This is the product-analytics path: typed events — vendored as ordinary
 * source under `./events`, originally generated from
 * `squareup/message-schemas` — emitted as OpenTelemetry **log records** over
 * OTLP. Both private packages are gone: the vendored types replace
 * `@squareup/message-schemas-web`, and OTel logs + a native OTLP exporter
 * (`./exporter`) replace `@squareup/cdp`. A future Block-side collector maps the
 * OTel log records back onto Unified Eventing, keyed on the event name.
 *
 * Owns the telemetry client and a single `track` chokepoint that every event
 * flows through. No user identity rides the wire: events carry only their own
 * params (booleans, closed enums, provider/model/app-version strings, and the
 * chat events' opaque `session_id` — no names, paths, or other user-derived
 * ids), and the resource identifies the install — never the person — via the
 * anonymous `installation.id`. The OTel
 * `BatchLogRecordProcessor` owns batching and delivery. Delivery is
 * fire-and-forget *between* flushes: the processor holds records for its
 * scheduled delay and then drops a failed batch rather than retrying it — the
 * only retry anywhere in the pipeline is the native single re-auth retry on
 * 401 inside `export_otel_logs` — so this module owns gating plus a
 * best-effort drain when the window hides or closes (see
 * `installCloseFlushHooks`). Because a dropped batch is unrecoverable, batch
 * size and attribute-value length are capped below the gateway's request-body
 * limit (see `MAX_LOG_EXPORT_BATCH_SIZE`).
 *
 * Emission requires consent (see `./consent`): the build enforces telemetry
 * ON, or the user's persisted setting — Rust-owned, default OFF — has loaded
 * as enabled. Consent is fail-closed, so its startup read costs enabled
 * installs nothing (events buffer through the bounded consent gate and flush
 * once it answers) while a disabled install never sends a byte; the native
 * gate in `export_otel_logs` guarantees the latter regardless of renderer
 * timing.
 *
 * Startup is bounded on every side: the consent read and the logger's own
 * construction each answer within a deadline, and a construction failure is
 * terminal rather than an unbounded wait, so the startup buffer always drains.
 * The states that can still cost an event — overflow before the logger exists,
 * a consent read that answers late (both the buffer its timeout discards and
 * everything fired between that timeout and the late answer) or disabled, and
 * that terminal failure — are counted and logged rather than dropped silently
 * (see `noteDroppedEvents`).
 *
 * Event params (including the chat events' `session_id`, the one per-entity
 * id left on the wire) become OTLP log-record **attributes**;
 * `service.name`/`service.version`/`deployment.environment`, the persistent
 * anonymous `installation.id`, and the build's `distribution.channel` become
 * the OTel `Resource`.
 *
 * New events are thin wrappers that build their schema event and call `track`,
 * inheriting environment gating, consent gating, the startup buffer, and
 * crash-safety for free.
 *
 * A distribution with its own analytics pipeline replaces `./distributionSink`
 * (stock: an inert no-op) instead of forking this module: `emit` hands every
 * post-gate event to the sink, so an overlay inherits the build, consent, and
 * buffer gating unchanged.
 *
 * Dev-only logging can be enabled with `VITE_TELEMETRY_DEBUG=1` or
 * `localStorage.setItem("berd.telemetry.debug", "1")`. In development this
 * logs the event that would have been emitted, per window, to that window's
 * devtools console, while keeping real dispatch disabled. Complementing it,
 * `./devLog` taps the top of `trackEvent` unconditionally under `just dev` and
 * forwards every fired event to the terminal, where all windows converge.
 */

import type { LogAttributes, Logger } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
  type BerdAppEnvironment,
  type Event,
  berdAppLifecycleLaunched,
} from "@/shared/telemetry/events";

import { invokeWithStartupRetry } from "@/shared/api/invokeWithStartupRetry";
import { perfLog } from "@/shared/lib/perfLog";
import {
  getEnvironment,
  isProduction,
  isStaging,
} from "@/shared/utils/environment";
import { getProfileCapabilitySnapshot } from "@/shared/profile/capabilities";
import {
  ensureTelemetryConsentLoaded,
  telemetryConsentGranted,
  telemetryConsentSettled,
  useTelemetryConsentStore,
} from "./consent";
import { devLogEvent } from "./devLog";
import { distributionSink } from "./distributionSink";
import { createTelemetryLogExporter } from "./exporter";

// Injected by vite.config.ts from VITE_APP_VERSION, falling back to package.json.
const appVersion = import.meta.env.VITE_APP_VERSION ?? "0.0.0";
const TELEMETRY_DEBUG_STORAGE_KEY = "berd.telemetry.debug";

// OTel instrumentation scope for every emitted log record. The gateway's
// `berd-otlp-logs-v2` schema pins this exact literal, so it moves in lockstep
// with the gateway schema, not with local naming.
const TELEMETRY_SCOPE_NAME = "berd.telemetry";
// `deployment.environment` is an incubating semantic convention; inline the key
// to avoid importing the large `/incubating` module for a single constant.
const ATTR_DEPLOYMENT_ENVIRONMENT = "deployment.environment";
// Persistent anonymous per-install identity (not an OTel semantic convention;
// the ingestion gateway keys on this exact name). The primary analytics key —
// installs are anonymous, and no user identity rides the wire.
const ATTR_INSTALLATION_ID = "installation.id";
// Which build artifact this install came from (not an OTel semantic
// convention; the gateway allowlists this exact name with a closed value
// set). It labels the build channel, never the human — a Block employee
// running the public GitHub release is an internal person on a public channel
// — and it is dashboard segmentation, not a trust boundary: ingestion is
// anonymous, so the value is spoofable by design.
const ATTR_DISTRIBUTION_CHANNEL = "distribution.channel";

/**
 * The closed `distribution.channel` value set the gateway accepts. Sourced
 * natively from the staged distro config (`telemetry.channel` in distro.json);
 * `"public"` is the fallback for every other state — no distro bundle, no
 * `telemetry` section, an unrecognized value, or a native answer that never
 * arrives.
 */
type TelemetryChannel = "public" | "internal";

// OTel pipeline sizing. These are deliberately NOT the SDK defaults (512-record
// batches, unbounded attribute values), because a batch that exceeds the
// ingestion gateway's 256 KiB request-body limit is rejected with a 413 and
// then *permanently lost*: `BatchLogRecordProcessor` drops a failed export
// instead of re-queueing it, and the pipeline's only retry is the native 401
// re-auth (see `./exporter`). So the batch has to be small enough that a full
// one cannot reach the limit — the case that matters most, the recovery flush
// after an outage, is exactly the case that fills a batch.
//
// Measured through this repo's own serializer (`JsonLogsSerializer`, the exact
// path `TauriOtlpLogExporter` runs), a realistic worst-case record is ~819 B: a
// full 512-record batch is ~410 KiB, 1.6x over the limit, while a 128-record
// batch is ~103 KiB, 2.5x under it.
//
// A record-count cap bounds nothing on its own, though — one pasted 10k-char
// BYO-key model id (that field is user-typed free text) would push a 128-record
// batch past 1 MiB. `MAX_LOG_ATTRIBUTE_VALUE_LENGTH` closes that hole by
// truncating each attribute value at emit time, which makes the ceiling
// enforced rather than assumed: a 128-record batch with *every* string
// attribute maxed at the limit still serializes to ~224 KiB, under the body
// limit (pinned in `exporter.test.ts`). That enforced ceiling is the tight one
// — raising either constant needs the math redone, lowering them is free. 256
// characters leaves every real value untruncated — UUIDs (36), the
// `source_surface` enum (<=35), model ids (<80) — so only garbage is ever cut.
//
// Do not restore the SDK defaults without redoing this math against the
// gateway's current body limit. The three constants are exported so
// `exporter.test.ts` can pin the byte ceiling they encode.
export const MAX_LOG_EXPORT_BATCH_SIZE = 128;
export const MAX_LOG_ATTRIBUTE_VALUE_LENGTH = 256;
export const GATEWAY_BODY_LIMIT_BYTES = 256 * 1024;
// Memory bound rather than a wire bound: caps how many records a stalled
// exporter can hold (batch size <= queue size must hold). Left at the SDK
// default — a full queue now drains as ceil(2048 / 128) = 16 consecutive POSTs
// (exports are strictly sequential), well inside the gateway's per-installation
// upload rate limit.
const MAX_LOG_QUEUE_SIZE = 2048;

/**
 * The build/environment half of the telemetry gate: the `telemetry`
 * capability in production/staging. The capability AND-gates the build
 * feature (the immediate, no-flicker off switch) with
 * `featureToggles.telemetry` (the future endpoint toggle), so a restricted
 * build disables telemetry now via `VITE_TELEMETRY=0` and the bundled runtime
 * config / endpoint can disable it later with no code change.
 *
 * Caveat: `initTelemetry()` + `trackAppLaunched()` fire at startup before
 * runtime config loads, so a runtime/endpoint disable cannot suppress the launch
 * event — only the build feature can.
 */
function telemetryBuildEnabled(): boolean {
  return (
    getProfileCapabilitySnapshot("telemetry") && (isProduction() || isStaging())
  );
}

function telemetryDebugLoggingEnabled(): boolean {
  if (getEnvironment() !== "development") return false;
  if (import.meta.env.VITE_TELEMETRY_DEBUG === "1") return true;

  try {
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem(TELEMETRY_DEBUG_STORAGE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

// The OTel logger, created once telemetry is initialized in production/staging.
// Null in development / disabled builds so the path stays fully inert, and
// briefly null at startup while its `Resource` awaits the native telemetry
// resource (see `initTelemetry`).
let logger: Logger | null = null;

// Set when the logger can never appear: its construction threw. Nothing retries
// it, so the state is terminal for this renderer and every later event is a
// counted drop rather than a buffered wait for something that is not coming.
let loggerUnavailable = false;

// Cumulative count of events this window session could not emit. Telemetry
// cannot report its own loss over the wire (the wire is the thing that is
// broken in both loss states), so the count rides the module's existing
// diagnostic channel — `perfLog`, live under Vite dev or `goose.perf=1` in
// localStorage — which is what makes a drop observable rather than silent.
let droppedEventCount = 0;

/**
 * Records events the pipeline could not emit. Every loss path in this module
 * routes through here, so "dropped" is always a number someone can read rather
 * than an early `return`.
 */
function noteDroppedEvents(count: number, reason: string): void {
  if (count <= 0) return;
  droppedEventCount += count;
  perfLog(
    `[telemetry] dropped ${count} event(s): ${reason} (${droppedEventCount} dropped this session)`,
  );
}

// Startup buffer: holds events tracked before the pipeline can emit them —
// while consent is still loading, and while the logger's construction awaits
// the native telemetry-resource round-trip. Bounded in size and time so it can
// neither leak nor delay forever; events are flushed (backdated) once the
// logger exists, or discarded as counted drops when consent settles disabled
// or a gate times out.
//
// Both gates are bounded — consent by `CONSENT_LOAD_TIMEOUT_MS`, the logger by
// `TELEMETRY_RESOURCE_TIMEOUT_MS` plus the terminal `loggerUnavailable` state
// — so the buffer always drains. It can still cost events in one state: more
// than `MAX_BUFFERED_EVENTS` tracked before the logger exists overflows, and
// an overflowing event with no logger to emit through cannot be kept. That is
// a counted drop (`noteDroppedEvents`), not a silent one.
const MAX_BUFFERED_EVENTS = 50;
// Bounds the logger gate the way `CONSENT_LOAD_TIMEOUT_MS` bounds the consent
// gate. `get_telemetry_resource` is synchronous native work behind an IPC
// round-trip, so a hang needs main-thread contention or blocking filesystem IO
// in the app-data dir — unlikely, but nothing else bounds it, and the renderer
// cannot tell a hang from a slow answer. Without a deadline a hung invoke would
// wedge the pipeline permanently: the logger stays null, so every event buffers
// and then overflows one at a time. Timing out costs one resource attribute (a
// late answer is not adopted; the gateway still keys uploads on the id it
// authenticated natively) plus the channel falling back to "public", and keeps
// the pipeline live.
const TELEMETRY_RESOURCE_TIMEOUT_MS = 5_000;
// Bounds the consent gate the way the logger gate is bounded: the persisted
// telemetry setting is read asynchronously at startup, and until it answers,
// consent is unknown — events buffer rather than emit (fail closed). If the
// read has not settled within this deadline the buffer is released as counted
// drops; consent itself stays pending, so a late enabled answer still brings
// the pipeline up for everything tracked afterwards.
const CONSENT_LOAD_TIMEOUT_MS = 5_000;

interface BufferedEvent {
  createEvent: () => Event;
  timestamp: string;
}

let buffer: BufferedEvent[] = [];

/**
 * Emits an event as an OTel log record. The event's params are the record's
 * attributes, verbatim. `timestamp` backdates a buffered event to when it
 * actually occurred rather than when it was flushed.
 */
function emit(createEvent: () => Event, timestamp?: string): void {
  if (logger === null) {
    // Backstop: every caller already gates on the logger existing, so this is
    // unreachable. Counted rather than silently returned so a future caller
    // that forgets cannot reintroduce the silent drop this used to be.
    noteDroppedEvents(1, "no logger at emit");
    return;
  }
  const ev = createEvent();
  logger.emit({
    eventName: ev.name,
    attributes: ev.parameters as LogAttributes,
    timestamp: timestamp ? new Date(timestamp) : undefined,
  });
  // The distro fan-out seam (see `./distributionSink`): fires only for events
  // that reached the logger above, so a replacement sink inherits every
  // gating decision — build, consent, buffer — for free. Guarded here, on
  // this side of the seam, so a throwing replacement cannot disturb the
  // emission that already happened or the caller above it.
  try {
    distributionSink({
      name: ev.name,
      attributes: ev.parameters,
      firedAt: timestamp ?? new Date().toISOString(),
    });
  } catch (error) {
    perfLog(`[telemetry] distribution sink failed: ${String(error)}`);
  }
}

function logDebugEvent(createEvent: () => Event): void {
  if (!telemetryDebugLoggingEnabled()) return;

  try {
    const ev = createEvent();
    console.info("[telemetry:debug] event suppressed", {
      eventName: ev.name,
      attributes: ev.parameters as LogAttributes,
    });
  } catch {
    // Debug logging must never affect app behavior.
  }
}

/** Drains the startup buffer once the logger exists. Idempotent. */
function maybeFlushBuffer(): void {
  if (logger === null) return;

  const pending = buffer;
  buffer = [];
  for (const { createEvent, timestamp } of pending) {
    try {
      emit(createEvent, timestamp);
    } catch (error) {
      perfLog(`[telemetry] failed to flush event: ${String(error)}`);
    }
  }
}

/** Abandons the buffer when its events can never emit, counting the loss. */
function discardBuffer(reason: string): void {
  const pending = buffer;
  buffer = [];
  noteDroppedEvents(pending.length, reason);
}

/**
 * Rejects if `promise` has not settled within `ms`, so a caller that already
 * treats a rejection as a fallback answer treats a hang the same way. The timer
 * is cleared on settle, so a prompt answer leaves nothing pending.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not answer within ${ms}ms`));
    }, ms);
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
    });
  });
}

interface TelemetryResource {
  installationId: string;
  channel: TelemetryChannel;
}

/**
 * Resolves the native half of the OTel `Resource`: the persistent anonymous
 * installation id plus the distribution channel the staged distro config
 * declares. Both halves have safe fallbacks — an empty `installationId` omits
 * the attribute (the ingestion gateway still keys uploads on the id it
 * authenticated via the bootstrap token, which lives entirely in the Rust
 * layer), and anything but the exact `"internal"` literal reads as `"public"`,
 * so a stale or malformed native answer cannot put a value outside the
 * gateway's closed set on the wire.
 *
 * A hang is answered exactly like a rejection, because the logger — and with it
 * the whole pipeline — waits on this call (see `TELEMETRY_RESOURCE_TIMEOUT_MS`).
 *
 * The invoke goes through `invokeWithStartupRetry` for the same reason
 * `getTelemetrySettings` does, only more sharply: an enforced build reads its
 * consent from a build-time constant, so `initTelemetry()` reaches this call at
 * renderer boot with no prior native round-trip to absorb the window where the
 * hidden main window's webview runs ahead of Tauri's `setup()` and commands
 * reject with "state not managed". Without the retry that transient rejection
 * would take the fallback below, and because the provider's `Resource` is fixed
 * at construction and nothing rebuilds it, an internal build would spend the
 * whole session reporting `distribution.channel: "public"` — every event of it
 * silently counted in the public segment. A non-enforced install cannot hit the
 * window (it only starts the pipeline after the consent read has already proved
 * the state is managed), and genuine errors still fall through immediately:
 * the helper retries only the transient state messages.
 */
async function fetchTelemetryResource(): Promise<TelemetryResource> {
  try {
    // The retry's worst case (100+200+400+800+1600ms of backoff plus six IPC
    // round-trips) fits inside the deadline below, so the pipeline's startup
    // bound is unchanged; if the deadline still fires first, the fallback
    // applies exactly as it did before the retry existed.
    const resource = await withTimeout(
      invokeWithStartupRetry<TelemetryResource>("get_telemetry_resource"),
      TELEMETRY_RESOURCE_TIMEOUT_MS,
      "get_telemetry_resource",
    );
    return {
      installationId:
        typeof resource?.installationId === "string"
          ? resource.installationId
          : "",
      channel: resource?.channel === "internal" ? "internal" : "public",
    };
  } catch (error) {
    perfLog(
      `[telemetry] failed to resolve the telemetry resource: ${String(error)}`,
    );
    return { installationId: "", channel: "public" };
  }
}

/**
 * Initializes telemetry once at app start. No-op outside production/staging, so
 * the OTel `LoggerProvider`/exporter (and its native OTLP send path) are never
 * even constructed in dev or external clones. Must be called before any
 * `track`.
 *
 * With the build/environment gate open, what happens next depends on consent:
 * granted (enforced builds, or a mid-session re-init after the setting
 * loaded) starts the pipeline immediately; unknown starts the bounded consent
 * gate — events buffer while the persisted setting loads, then either the
 * pipeline comes up and flushes them (enabled) or the buffer is discarded
 * (disabled/timeout). The telemetry-resource round-trip is deferred until
 * consent is granted, so a disabled install does no telemetry work at all
 * beyond the one settings read.
 */
let initialized = false;
export function initTelemetry(): void {
  if (initialized) return;
  initialized = true;
  if (!telemetryBuildEnabled()) return;

  if (telemetryConsentSettled()) {
    if (telemetryConsentGranted()) startPipeline();
    return;
  }

  consentTimer = setTimeout(() => {
    consentTimer = null;
    consentTimedOut = true;
    discardBuffer("the telemetry setting did not load in time");
  }, CONSENT_LOAD_TIMEOUT_MS);
  // The subscription outlives the startup gate on purpose: it is also what
  // brings the pipeline up when the user enables telemetry mid-session from
  // the settings toggle (and after a late-arriving startup read).
  useTelemetryConsentStore.subscribe(onConsentChanged);
  ensureTelemetryConsentLoaded();
}

/** Applies a settled consent answer: pipeline up, or buffer released. */
function onConsentChanged(): void {
  if (!telemetryConsentSettled()) return;
  if (consentTimer !== null) {
    clearTimeout(consentTimer);
    consentTimer = null;
  }
  if (telemetryConsentGranted()) {
    consentTimedOut = false;
    startPipeline();
  } else {
    discardBuffer("telemetry is disabled for this installation");
  }
}

// Consent gate state. `consentTimedOut` closes the gate for buffering (events
// stop accumulating and are suppressed like a denial, but counted as drops
// while consent stays unsettled) without settling consent itself — a late
// enabled answer re-opens emission via the store subscription above.
let consentTimer: ReturnType<typeof setTimeout> | null = null;
let consentTimedOut = false;

/**
 * Whether consent has settled as (or timed out into) "not granted" — the
 * suppression state, as opposed to the still-loading state events buffer
 * through.
 *
 * The two sub-states it merges suppress identically but differ in drop
 * accounting: a settled denial is deliberate silence, while a timeout that
 * consent has not yet answered may still turn out to have been a loss. The
 * caller owns that distinction (see `trackEvent`).
 */
function telemetryConsentDenied(): boolean {
  return (
    (telemetryConsentSettled() || consentTimedOut) && !telemetryConsentGranted()
  );
}

/**
 * Drains the batch processor when the window hides or closes, so a session's
 * last events do not die with its webview.
 *
 * `BatchLogRecordProcessor` holds emitted records until its scheduled delay
 * elapses (1s by default in the pinned SDK; left implicit, and shortening it
 * is the wrong lever — it narrows the window without closing it and multiplies
 * POSTs against the gateway's per-install rate limit). Whatever is still
 * queued when the webview is torn down is lost *invisibly*: that queue is
 * opaque to `noteDroppedEvents`. The window is short but sits under exactly
 * the gestures the catalog cares about — closing a detached session window
 * right after a send, quitting shortly after launch, and the tail of every
 * session as a standing tax.
 *
 * A flush has real teeth here, unlike in a browser: `export()` serializes
 * synchronously and hands the body to `invoke("export_otel_logs")`, and once
 * that IPC message crosses into the Rust process the POST runs on the native
 * runtime, which outlives the webview. So the durable step is posting the
 * message, not awaiting the answer — hence fire-and-forget, which is also all
 * an unload handler could manage. `forceFlush()` reaches `export()` within a
 * few microtasks (no timers, and this `Resource` has no async attributes to
 * wait on), inside the same task as the event dispatch.
 *
 * Two listeners, because the teardown paths signal differently (see
 * `attach_main_window_lifecycle` in `src-tauri/src/lib.rs`): the main window's
 * close is intercepted and turned into `hide()` while any secondary window
 * exists, which is a `visibilitychange` to hidden with the page surviving,
 * while a last-window close, a detached `session:*` window close, and app quit
 * are real webview destructions, which is `pagehide`.
 *
 * `pagehide` is registered on `window`, where the event actually fires. The
 * SDK's browser-variant processor registers its own pair on `document`, so its
 * `visibilitychange` half works while its `pagehide` fallback — the one added
 * for WebKit, which is what this app runs on — never fires at all: a
 * window-targeted event's propagation path does not include `document`.
 * Overlapping with the half that does work costs nothing (`forceFlush` on an
 * empty queue snapshots an empty array and exports nothing, and a `_flushing`
 * guard makes a concurrent call return early), and owning both listeners here
 * means the defense no longer depends on which platform variant the bundler
 * resolves.
 *
 * Nothing in an unload path may throw, so the registration and each flush are
 * both contained — a failure is a diagnostic, never an exception into
 * teardown. The registration carries its own `try` rather than leaning on the
 * one it is called inside: a throw caught there would declare the terminal
 * `loggerUnavailable` state for a logger that exists and works.
 */
function installCloseFlushHooks(provider: LoggerProvider): void {
  const flush = () => {
    try {
      void provider.forceFlush().catch((error) => {
        perfLog(`[telemetry] close flush failed: ${String(error)}`);
      });
    } catch (error) {
      perfLog(`[telemetry] close flush failed: ${String(error)}`);
    }
  };

  try {
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  } catch (error) {
    perfLog(
      `[telemetry] failed to install the close flush hooks: ${String(error)}`,
    );
  }
}

/**
 * Brings up the OTel pipeline. The logger appears asynchronously — its
 * `Resource` awaits the native installation id and distribution channel — so
 * events buffered before it exists are flushed once it does. Idempotent —
 * consent can settle more than once (a mid-session toggle), but the pipeline
 * is built at most once per renderer, which is also what makes the close-flush
 * hooks below register exactly once.
 */
let pipelineStarted = false;
function startPipeline(): void {
  if (pipelineStarted) return;
  pipelineStarted = true;

  void (async () => {
    try {
      const { installationId, channel } = await fetchTelemetryResource();
      const provider = new LoggerProvider({
        resource: resourceFromAttributes({
          // Wire literal the gateway's schema pins exactly (renamed from
          // "goose-internal"), like TELEMETRY_SCOPE_NAME.
          [ATTR_SERVICE_NAME]: "berd",
          [ATTR_SERVICE_VERSION]: appVersion,
          [ATTR_DEPLOYMENT_ENVIRONMENT]: getEnvironment(),
          [ATTR_DISTRIBUTION_CHANNEL]: channel,
          ...(installationId ? { [ATTR_INSTALLATION_ID]: installationId } : {}),
        }),
        // Truncates each log-record attribute value at emit time (resource
        // attributes are fixed-length and unaffected), so batch size alone is
        // enough to bound the serialized body — see MAX_LOG_EXPORT_BATCH_SIZE.
        logRecordLimits: {
          attributeValueLengthLimit: MAX_LOG_ATTRIBUTE_VALUE_LENGTH,
        },
        processors: [
          new BatchLogRecordProcessor({
            exporter: createTelemetryLogExporter(),
            maxQueueSize: MAX_LOG_QUEUE_SIZE,
            maxExportBatchSize: MAX_LOG_EXPORT_BATCH_SIZE,
          }),
        ],
      });
      logger = provider.getLogger(TELEMETRY_SCOPE_NAME);
      maybeFlushBuffer();
      installCloseFlushHooks(provider);
    } catch (error) {
      // Construction is what throws here — `fetchTelemetryResource` answers
      // with its fallbacks for both a rejection and a hang. Nothing retries
      // the provider, so the failure is terminal for this renderer: without
      // the catch the rejection would be unhandled and the pipeline would
      // wedge exactly as a hung invoke used to, holding every event until it
      // overflowed one at a time. Give up loudly instead — release the buffer
      // and count what it cost.
      loggerUnavailable = true;
      perfLog(`[telemetry] failed to construct the logger: ${String(error)}`);
      discardBuffer("the telemetry logger could not be constructed");
    }
  })();
}

/**
 * The single entry point all events flow through. No-op outside
 * production/staging and when consent has settled disabled, and crash-safe.
 * Emits immediately once the logger exists; until then — while consent is
 * still loading and while the logger's construction is in flight — events
 * land in the startup buffer, which the consent gate then flushes or
 * discards.
 */
function trackEvent(createEvent: () => Event): void {
  // The dev-only viewer taps the chokepoint itself, ahead of every gate, so
  // the `just dev` terminal reports what fired rather than what survived. It
  // is dead code outside the Vite dev server and never reaches the exporter.
  devLogEvent(createEvent);

  // The gate checks sit inside the try too: track() runs at feature commit
  // points (some inside dispatch paths), so nothing in here may escape.
  try {
    // Split from the consent gate below so the build gate stays silent: a dev
    // build (or `VITE_TELEMETRY=0`) suppressing an event is not a loss, and
    // `telemetryBuildEnabled()` can flip off mid-session, which would
    // otherwise start counting drops for a build that never emits.
    if (!telemetryBuildEnabled()) {
      logDebugEvent(createEvent);
      return;
    }
    if (telemetryConsentDenied()) {
      // A settled denial is deliberate silence, not a loss. The timed-out but
      // still-unsettled state is: the setting may yet answer enabled, so this
      // event is a real loss for a consented install — counted, like the
      // buffer the same timeout already discarded under the same uncertainty,
      // and under the same accepted over-count if consent later settles
      // disabled. (`!telemetryConsentSettled()` alone already implies the
      // timeout here; the conjunction says so out loud.)
      if (consentTimedOut && !telemetryConsentSettled()) {
        noteDroppedEvents(1, "the telemetry setting did not load in time");
      }
      logDebugEvent(createEvent);
      return;
    }

    if (loggerUnavailable) {
      // Terminal: buffering for a logger that will never exist would only
      // defer the same loss, so take it now and keep it counted.
      noteDroppedEvents(1, "the telemetry logger could not be constructed");
      return;
    }
    if (logger !== null) {
      emit(createEvent);
      return;
    }
    if (buffer.length >= MAX_BUFFERED_EVENTS) {
      // Buffer full before the logger exists: the event can neither be kept
      // (the bound is what stops the buffer growing without end) nor emitted.
      // The window is short — both startup gates are bounded — so this needs
      // MAX_BUFFERED_EVENTS events inside it, but it is a real loss, so
      // count it instead of dropping it silently.
      noteDroppedEvents(1, "buffer full before the logger was ready");
      return;
    }
    buffer.push({ createEvent, timestamp: new Date().toISOString() });
  } catch (error) {
    perfLog(`[telemetry] failed to track event: ${String(error)}`);
  }
}

export function track(event: Event): void {
  trackEvent(() => event);
}

/**
 * Marks that this window session has already reported the app launch.
 *
 * A renderer reload is not an app start, but it re-runs the whole renderer
 * bundle, so module scope resets with it and a module-level flag cannot tell
 * the two apart. Production has two real reload paths — a WebKit reap of the
 * webview under memory pressure (see `src-tauri/src/services/renderer_monitor.rs`
 * and `RendererTelemetry`'s rapid-reload heuristic) and the crash screen's
 * Reload button (`RendererErrorBoundary`) — and both would otherwise re-fire
 * the launch event.
 *
 * `sessionStorage` is the guard because its scope is exactly the invariant: it
 * belongs to the window's browsing-context session, so it survives a reload of
 * that window, and a real app start builds a new webview whose store is empty
 * (nothing persists it to disk, and while the app runs the main window is
 * hidden on close rather than recreated). Detached session windows get their
 * own store, which is moot — they deliberately never fire this event.
 */
const LAUNCH_TRACKED_SESSION_KEY = "berd.telemetry.launchTracked";

/**
 * Claims the one launch report this window session gets. Returns false once it
 * has already been claimed.
 *
 * Fails open: if the store cannot be read or written the launch is reported
 * anyway, because over-counting on a hostile storage environment beats losing
 * the metric.
 */
function claimAppLaunch(): boolean {
  try {
    if (typeof sessionStorage === "undefined") return true;
    if (sessionStorage.getItem(LAUNCH_TRACKED_SESSION_KEY) !== null) {
      return false;
    }
    sessionStorage.setItem(LAUNCH_TRACKED_SESSION_KEY, "1");
    return true;
  } catch {
    return true;
  }
}

/**
 * The `environment` the launch event reports, narrowed to the two values that
 * can actually reach the wire — `development` has no representation in
 * `BerdAppEnvironment`, so the attribute is simply absent there.
 *
 * Not a second gate: `telemetryBuildEnabled()` stays the only thing deciding
 * whether an event emits, and it already closes in development. This decides
 * only what the attribute *says*, and answers "nothing" rather than inventing a
 * value, so a dev build can never be reported as production. The duplicate
 * `deployment.environment` resource attribute is deliberately left alone — it
 * still carries `getEnvironment()` verbatim.
 */
function launchEventEnvironment(): BerdAppEnvironment | undefined {
  const environment = getEnvironment();
  return environment === "development" ? undefined : environment;
}

/**
 * Tracks the `berd_app_lifecycle_launched` event once per app start — a
 * renderer reload re-runs the caller but reports nothing (see
 * `LAUNCH_TRACKED_SESSION_KEY`). The claim is taken ahead of the environment
 * gate so a reload is silent in every build, dev debug logging included: what
 * that logs should be what production would emit.
 */
export function trackAppLaunched(): void {
  if (!claimAppLaunch()) return;

  trackEvent(() =>
    berdAppLifecycleLaunched({
      app_version: appVersion,
      environment: launchEventEnvironment(),
    }),
  );
}
