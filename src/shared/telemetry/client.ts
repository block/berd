/**
 * Telemetry client for goose-internal.
 *
 * This is the PAE (Product Analytics Eventing) path: declared
 * `@squareup/message-schemas-web` events emitted via `trackWithSchema`.
 * `@squareup/cdp` is just the sanctioned PAE web client SDK (historical package
 * name), so this module owns the telemetry client/facade, not "CDP" per se.
 *
 * Owns the telemetry client and a single `track` chokepoint that every event
 * flows through. Identity is resolved once per session (see `./identity`) and
 * stamped onto every event via the event envelope `overrides` (`entityId` /
 * `entityType`), mirroring g2 exactly. The client is constructed without an API
 * key, so neither the public `identify()` (a network call that throws without a
 * key) nor the private `user._identify(...)` is used; per-event overrides
 * sidestep both. Resolution survives transient `whoami` blips (see
 * `./identity`), and the @squareup/cdp client's own dispatch queue handles
 * delivery retries/batching, so this module only owns identity resilience and
 * gating.
 *
 * New events are thin wrappers that build their schema event and call `track`,
 * inheriting environment gating, identity stamping, the pre-identity buffer, and
 * crash-safety for free.
 *
 * Dev-only logging can be enabled with `VITE_TELEMETRY_DEBUG=1` or
 * `localStorage.setItem("goose.telemetry.debug", "1")`. In development this
 * logs the event that would have been tracked while keeping real dispatch
 * disabled.
 */

import { CDP, EntityTypes } from "@squareup/cdp";
import type { Options, TrackSchemaMessageProps } from "@squareup/cdp";
import {
  type Event,
  GooseInternalAppFeedbackInitiated,
  GooseInternalAppFeedbackInitiatedProducer,
  GooseInternalAppFeedbackSubmitted,
  GooseInternalAppFeedbackSubmittedProducer,
  GooseInternalAppLifecycleLaunched,
  GooseInternalAppLifecycleLaunchedProducer,
} from "@squareup/message-schemas-web";

import { perfLog } from "@/shared/lib/perfLog";
import {
  getEnvironment,
  isProduction,
  isStaging,
} from "@/shared/utils/environment";
import { getBuildFeatureState } from "@/shared/profile/buildProfile";
import { IdentityProvider, type ResolvedIdentity } from "./identity";
import { installTelemetryTransportBridge } from "./transport";

// Injected by vite.config.ts from VITE_APP_VERSION, falling back to package.json.
const appVersion = import.meta.env.VITE_APP_VERSION ?? "0.0.0";
const TELEMETRY_DEBUG_STORAGE_KEY = "goose.telemetry.debug";
type TrackSchemaOptions = Options<TrackSchemaMessageProps>;

export const TELEMETRY_DESKTOP_PAGE_CONTEXT: Record<string, string> = {
  path: "",
  referrer: "",
  search: "",
  title: "Goose Internal",
  url: "",
};

const client = new CDP({
  application: {
    name: "goose-internal",
    version: appVersion,
  },
  environment: getEnvironment(),
});

/** Telemetry only emits when the build feature is enabled in production/staging. */
function telemetryEnabled(): boolean {
  return getBuildFeatureState().telemetry && (isProduction() || isStaging());
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

// The session's resolved identity, or null until/unless whoami yields an email.
// Stamped onto every event's envelope via `entityOverrides()`; never applied to
// the telemetry client's user (no `_identify` / `identify`), matching g2.
let resolvedIdentity: ResolvedIdentity | null = null;

const identityProvider = new IdentityProvider((identity: ResolvedIdentity) => {
  resolvedIdentity = identity;
});

/**
 * Builds the entity envelope from the resolved identity, mirroring g2's
 * branch exactly: a real email stamps the `squareEmployee` entity, otherwise an
 * empty `anonVisitor`. These fields ride along in the event envelope per call.
 */
function entityOverrides() {
  return resolvedIdentity?.email
    ? {
        entityId: resolvedIdentity.email,
        entityType: EntityTypes.squareEmployee,
      }
    : { entityId: "", entityType: EntityTypes.anonVisitor };
}

function telemetryUserId(): string {
  return resolvedIdentity?.email ?? "";
}

function trackOptions(
  overrides: TrackSchemaOptions["overrides"],
): TrackSchemaOptions {
  return {
    page: TELEMETRY_DESKTOP_PAGE_CONTEXT,
    overrides,
  };
}

// Pre-identity buffer: holds events emitted before whoami settles. Bounded in
// size and time so it can neither leak nor delay forever; events are flushed
// (backdated) once identity settles, or as anonymous on timeout, but never
// dropped.
const MAX_BUFFERED_EVENTS = 50;
const BUFFER_TIMEOUT_MS = 5_000;

interface BufferedEvent {
  createEvent: () => Event;
  timestamp: string;
}

let buffer: BufferedEvent[] = [];
let bufferingClosed = false;
let bufferTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Hands an event to the telemetry client, always stamping the entity envelope
 * (`entityId` / `entityType`) from the resolved identity. `timestamp` backdates a buffered
 * event to when it actually occurred rather than when it was flushed.
 */
function emit(createEvent: () => Event, timestamp?: string): void {
  const event = createEvent();
  const overrides = timestamp
    ? { ...entityOverrides(), originalTimestamp: timestamp, timestamp }
    : entityOverrides();
  client.trackWithSchema(event, trackOptions(overrides));
}

function logDebugEvent(createEvent: () => Event): void {
  if (!telemetryDebugLoggingEnabled()) return;

  try {
    const event = createEvent();
    console.info("[telemetry:debug] event suppressed", {
      event,
      options: trackOptions(entityOverrides()),
    });
  } catch {
    // Debug logging must never affect app behavior.
  }
}

/** Drains the pre-identity buffer and stops further buffering. Idempotent. */
function flushBuffer(): void {
  if (bufferTimer !== null) {
    clearTimeout(bufferTimer);
    bufferTimer = null;
  }
  bufferingClosed = true;

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

/**
 * Initializes telemetry once at app start. Identity is resolved fresh each
 * session via whoami (it is no longer persisted on the telemetry client's user), so events are
 * briefly buffered until resolution settles, then flushed. Must be called before
 * any `track`.
 */
let initialized = false;
export function initTelemetry(): void {
  if (initialized) return;
  initialized = true;
  if (!telemetryEnabled()) return;

  installTelemetryTransportBridge();
  bufferTimer = setTimeout(flushBuffer, BUFFER_TIMEOUT_MS);
  identityProvider.whenResolved(flushBuffer);
  void identityProvider.ensureResolved();
}

/**
 * The single entry point all events flow through. No-op outside
 * production/staging, crash-safe, and identity-aware: emits immediately once
 * identity is known (or the buffer has closed), otherwise buffers until it is.
 */
function trackEvent(createEvent: () => Event): void {
  if (!telemetryEnabled()) {
    logDebugEvent(createEvent);
    return;
  }

  try {
    if (identityProvider.isSettled() || bufferingClosed) {
      emit(createEvent);
      return;
    }
    if (buffer.length >= MAX_BUFFERED_EVENTS) {
      // Buffer full: emit now (anonymous) rather than drop the event.
      emit(createEvent);
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

/** Tracks the `goose_internal_app_lifecycle_launched` event once at app start. */
export function trackAppLaunched(): void {
  trackEvent(() =>
    GooseInternalAppLifecycleLaunched({
      appVersion,
      environment: getEnvironment(),
      producer: GooseInternalAppLifecycleLaunchedProducer.GOOSE_INTERNAL,
    }),
  );
}

/** Tracks the user opening / being shown the feedback form. */
export function trackFeedbackInitiated(): void {
  trackEvent(() =>
    GooseInternalAppFeedbackInitiated({
      userId: telemetryUserId(),
      producer: GooseInternalAppFeedbackInitiatedProducer.GOOSE_INTERNAL,
    }),
  );
}

/** Tracks the user successfully submitting feedback. */
export function trackFeedbackSubmitted(): void {
  trackEvent(() =>
    GooseInternalAppFeedbackSubmitted({
      userId: telemetryUserId(),
      producer: GooseInternalAppFeedbackSubmittedProducer.GOOSE_INTERNAL,
    }),
  );
}
