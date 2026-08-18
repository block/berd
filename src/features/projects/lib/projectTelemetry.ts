/**
 * Thin, feature-scoped wrappers over the vendored `berd_project` event
 * factories, mirroring `src/features/agents/lib/agentTelemetry.ts`,
 * `src/features/chat/lib/chatTelemetry.ts`, and
 * `src/features/home/lib/homeTelemetry.ts`.
 *
 * These build the vendored schema events and hand them to the shared telemetry
 * `track` chokepoint, inheriting its prod/staging gate, consent gating, and
 * startup buffering for free. Keeping the wrappers here (rather than in
 * `client.ts`) keeps `berd_project` wiring additive and local to the projects
 * feature.
 */
import { track } from "@/shared/telemetry/client";
import {
  berdProjectCreateCompleted,
  berdProjectDeleteCompleted,
  berdProjectEditCompleted,
} from "@/shared/telemetry/events";
import type { ProjectInfo } from "../api/projects";

/**
 * `has_working_dir` / `had_working_dir`: the project has at least one working
 * directory configured. `ProjectInfo.workingDirs` is the persisted list (see
 * `toProjectInfo` in `../api/projects`).
 */
function hasWorkingDir(project: ProjectInfo): boolean {
  return project.workingDirs.length > 0;
}

/**
 * `has_prompt`: the project has non-blank configured instructions / prompt
 * text. `ProjectInfo.prompt` is the persisted source content — the "describe"
 * field of the create/edit dialog.
 */
function hasPrompt(project: ProjectInfo): boolean {
  return project.prompt.trim().length > 0;
}

/**
 * `had_artifact`: the project had an associated generated artifact — the 3D hero
 * artifact whose metadata rides on `ProjectInfo.artifact` (populated via
 * `parseProjectArtifactMetadata`, `null` when absent/malformed). NOTE: the
 * create path always generates this metadata (`createArtifactMetadata` in
 * `../api/projects`), so for anything created through the app this is
 * effectively always true; it only reads false for legacy projects saved before
 * artifact metadata existed.
 */
function hasArtifact(project: ProjectInfo): boolean {
  return project.artifact != null;
}

/** A project creation flow completed successfully. */
export function trackProjectCreateCompleted(project: ProjectInfo): void {
  track(
    berdProjectCreateCompleted({
      has_working_dir: hasWorkingDir(project),
      has_prompt: hasPrompt(project),
    }),
  );
}

/** A project edit flow completed successfully. */
export function trackProjectEditCompleted(project: ProjectInfo): void {
  track(
    berdProjectEditCompleted({
      has_working_dir: hasWorkingDir(project),
      has_prompt: hasPrompt(project),
    }),
  );
}

/**
 * A project deletion completed successfully. `project` is the pre-deletion
 * snapshot, so `had_working_dir`/`had_artifact` reflect the deleted project's
 * state.
 */
export function trackProjectDeleteCompleted(project: ProjectInfo): void {
  track(
    berdProjectDeleteCompleted({
      had_working_dir: hasWorkingDir(project),
      had_artifact: hasArtifact(project),
    }),
  );
}
