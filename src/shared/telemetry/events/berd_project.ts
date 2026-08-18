// Vendored typed telemetry event factories. Originally generated from
// squareup/message-schemas (cdp_events/berd_project/berd_project.yaml); the
// generator is not part of this repo, so this is ordinary source now — edit by
// hand and keep event/param names aligned with the schema repo.

import type { Event } from "./event";

export interface BerdProjectCreateCompletedParams {
  /** Whether the completed project included a working directory. */
  has_working_dir: boolean;
  /** Whether the completed project included configured instructions or prompt text. */
  has_prompt: boolean;
}

/**
 * BerdProject · Create · Completed
 *
 * Tracks when the project creation flow completes.
 *
 * Feature: Events related to user project management in the Berd desktop app
 * Action: Events related to creating projects
 */
export function berdProjectCreateCompleted(
  params: BerdProjectCreateCompletedParams,
): Event {
  return {
    name: "berd_project_create_completed",
    parameters: {
      has_working_dir: params.has_working_dir,
      has_prompt: params.has_prompt,
    },
  };
}

export interface BerdProjectEditCompletedParams {
  /** Whether the completed project included a working directory. */
  has_working_dir: boolean;
  /** Whether the completed project included configured instructions or prompt text. */
  has_prompt: boolean;
}

/**
 * BerdProject · Edit · Completed
 *
 * Tracks when the project edit flow completes.
 *
 * Feature: Events related to user project management in the Berd desktop app
 * Action: Events related to editing projects
 */
export function berdProjectEditCompleted(
  params: BerdProjectEditCompletedParams,
): Event {
  return {
    name: "berd_project_edit_completed",
    parameters: {
      has_working_dir: params.has_working_dir,
      has_prompt: params.has_prompt,
    },
  };
}

export interface BerdProjectDeleteCompletedParams {
  /** Whether the deleted project had a working directory configured. */
  had_working_dir: boolean;
  /** Whether the deleted project had an associated generated artifact. */
  had_artifact: boolean;
}

/**
 * BerdProject · Delete · Completed
 *
 * Tracks when the project deletion flow completes.
 *
 * Feature: Events related to user project management in the Berd desktop app
 * Action: Events related to deleting projects
 */
export function berdProjectDeleteCompleted(
  params: BerdProjectDeleteCompletedParams,
): Event {
  return {
    name: "berd_project_delete_completed",
    parameters: {
      had_working_dir: params.had_working_dir,
      had_artifact: params.had_artifact,
    },
  };
}
