// Vendored typed telemetry event factories. Originally generated from
// squareup/message-schemas (cdp_events/berd_chat/berd_chat.yaml); the
// generator is not part of this repo, so this is ordinary source now — edit by
// hand and keep event/param names aligned with the schema repo.

import type { Event } from "./event";

// SESSION_WINDOW and SEARCH were dropped from this set: no flow ever produced
// them (detached session windows report MAIN_CHAT), so keeping them implied a
// distinction the data does not carry.
export type BerdChatChatSourceSurface =
  | "CHAT_SOURCE_SURFACE_MAIN_CHAT"
  | "CHAT_SOURCE_SURFACE_GLOBAL_COMPOSER"
  | "CHAT_SOURCE_SURFACE_AGENT_BUILDER";

export interface BerdChatSessionStartedParams {
  /** ID of the chat session. */
  session_id: string;
  /** Entry point for how the user started the chat session. */
  source_surface: BerdChatChatSourceSurface;
  /** Whether the session start was associated with a project. */
  has_project: boolean;
  /** Whether the session start used a persona/agent */
  has_persona: boolean;
  /** AI provider for the first message. */
  provider?: string;
  /** AI model for the first message. */
  model?: string;
}

/**
 * BerdChat · Session · Started
 *
 * Tracks when the user starts a chat session just before submitting the first user message, after a session id exists.
 *
 * Feature: Events related to chat sessions and direct chat interactions in the Berd desktop app
 * Action: Events related to starting and opening chat sessions
 */
export function berdChatSessionStarted(
  params: BerdChatSessionStartedParams,
): Event {
  const parameters: Event["parameters"] = {
    session_id: params.session_id,
    source_surface: params.source_surface,
    has_project: params.has_project,
    has_persona: params.has_persona,
  };
  // Absent optional params are omitted entirely, never serialized as the OTLP
  // empty `value: {}` encoding, so the ingestion gateway's allowlist only ever
  // sees these keys carrying a value.
  if (params.provider !== undefined) parameters.provider = params.provider;
  if (params.model !== undefined) parameters.model = params.model;
  return {
    name: "berd_chat_session_started",
    parameters,
  };
}

export interface BerdChatMessageSentParams {
  /** ID of the chat session. */
  session_id: string;
  /** Whether this submitted message is the first user message in the session. */
  is_first_message: boolean;
  /** Whether the submitted message included attachments. */
  has_attachments: boolean;
  /** Whether the message used a persona/agent. */
  has_persona: boolean;
  /** AI provider for the message. */
  provider?: string;
  /** AI model for the message. */
  model?: string;
}

/**
 * BerdChat · Message · Sent
 *
 * Tracks when the user sends a chat message.
 *
 * Feature: Events related to chat sessions and direct chat interactions in the Berd desktop app
 * Action: Events related to sending chat messages
 */
export function berdChatMessageSent(params: BerdChatMessageSentParams): Event {
  const parameters: Event["parameters"] = {
    session_id: params.session_id,
    is_first_message: params.is_first_message,
    has_attachments: params.has_attachments,
    has_persona: params.has_persona,
  };
  // Absent optional params are omitted entirely, never serialized as the OTLP
  // empty `value: {}` encoding, so the ingestion gateway's allowlist only ever
  // sees these keys carrying a value.
  if (params.provider !== undefined) parameters.provider = params.provider;
  if (params.model !== undefined) parameters.model = params.model;
  return {
    name: "berd_chat_message_sent",
    parameters,
  };
}
