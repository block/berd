// Vendored typed telemetry event factories. Originally generated from
// squareup/message-schemas (cdp_events/goose_internal_app/goose_internal_app.yaml)
// and renamed here from GooseInternalApp to BerdApp — GooseInternal is the old
// product name. The generator is not part of this repo, so this is ordinary
// source now — edit by hand and keep event/param names aligned with the schema
// repo.

import type { Event } from "./event";

/**
 * The runtime environments this event can report.
 *
 * Deliberately narrower than `Environment` in `@/shared/utils/environment`:
 * `telemetryBuildEnabled()` gates emission on production/staging, so
 * `"development"` is already unreachable at runtime — this makes it
 * unrepresentable in the type as well, so the gate is not the only thing
 * standing between a dev build and a value the ingestion gateway rejects on
 * the `deployment.environment` resource attribute this one duplicates.
 */
export type BerdAppEnvironment = "production" | "staging";

export interface BerdAppLifecycleLaunchedParams {
  /** App version from package.json (injected via VITE_APP_VERSION) */
  app_version: string;
  /**
   * Runtime environment — production | staging. Optional only to express the
   * one state with no value in that closed set: a development build, where the
   * event still fires (the dev viewer reports it) but never reaches the wire.
   * Absent rather than defaulted, so nothing can report a dev build as
   * production.
   */
  environment?: BerdAppEnvironment;
}

/**
 * BerdApp · Lifecycle · Launched
 *
 * Tracks each time the Berd desktop app starts, emitted once from the frontend after React mounts.
 *
 * Feature: Feature for tracking events related to the Berd Tauri desktop app
 * Action: Events related to the Berd desktop app lifecycle
 */
export function berdAppLifecycleLaunched(
  params: BerdAppLifecycleLaunchedParams,
): Event {
  const parameters: Event["parameters"] = {
    app_version: params.app_version,
  };
  // Absent optional params are omitted entirely, never serialized as the OTLP
  // empty `value: {}` encoding, so the ingestion gateway's allowlist only ever
  // sees this key carrying a value.
  if (params.environment !== undefined) {
    parameters.environment = params.environment;
  }
  return {
    name: "berd_app_lifecycle_launched",
    parameters,
  };
}
