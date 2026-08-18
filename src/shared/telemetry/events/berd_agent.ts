// Vendored typed telemetry event factories. Originally generated from
// squareup/message-schemas (cdp_events/berd_agent/berd_agent.yaml); the
// generator is not part of this repo, so this is ordinary source now — edit by
// hand and keep event/param names aligned with the schema repo.

import type { Event } from "./event";

export interface BerdAgentCreateCompletedParams {
  /** Configured provider for the completed agent/persona, when present. */
  provider?: string;
  /** Configured model for the completed agent/persona, when present. */
  model?: string;
}

/**
 * BerdAgent · Create · Completed
 *
 * Tracks when the agent/persona creation flow completes.
 *
 * Feature: Events related to user agent/persona management in the Berd desktop app
 * Action: Events related to creating agents or personas
 */
export function berdAgentCreateCompleted(
  params: BerdAgentCreateCompletedParams,
): Event {
  const parameters: Event["parameters"] = {};
  // Absent optional params are omitted entirely, never serialized as the OTLP
  // empty `value: {}` encoding, so the ingestion gateway's allowlist only ever
  // sees these keys carrying a value.
  if (params.provider !== undefined) parameters.provider = params.provider;
  if (params.model !== undefined) parameters.model = params.model;
  return {
    name: "berd_agent_create_completed",
    parameters,
  };
}

export interface BerdAgentEditCompletedParams {
  /** Configured provider after the agent/persona edit completes, when present. */
  provider?: string;
  /** Configured model after the agent/persona edit completes, when present. */
  model?: string;
}

/**
 * BerdAgent · Edit · Completed
 *
 * Tracks when the agent/persona edit flow completes.
 *
 * Feature: Events related to user agent/persona management in the Berd desktop app
 * Action: Events related to editing agents or personas
 */
export function berdAgentEditCompleted(
  params: BerdAgentEditCompletedParams,
): Event {
  const parameters: Event["parameters"] = {};
  // Absent optional params are omitted entirely, never serialized as the OTLP
  // empty `value: {}` encoding, so the ingestion gateway's allowlist only ever
  // sees these keys carrying a value.
  if (params.provider !== undefined) parameters.provider = params.provider;
  if (params.model !== undefined) parameters.model = params.model;
  return {
    name: "berd_agent_edit_completed",
    parameters,
  };
}

/**
 * BerdAgent · Delete · Completed
 *
 * Tracks when the agent/persona deletion flow completes.
 *
 * A deliberately attribute-less bare counter: dropping `agent_id` (the
 * persona's on-disk path) left it carrying nothing else, and unlike the
 * retired feedback event its count *is* the signal — deletion rate against
 * creations is net agent adoption per install, derivable from nothing else
 * (see the policy comment in ./index.ts).
 *
 * Feature: Events related to user agent/persona management in the Berd desktop app
 * Action: Events related to deleting agents or personas
 */
export function berdAgentDeleteCompleted(): Event {
  return {
    name: "berd_agent_delete_completed",
    parameters: {},
  };
}
