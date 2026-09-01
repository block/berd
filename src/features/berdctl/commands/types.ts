import type { ZodType } from "zod/v4";

import { berdctlErrorDetail } from "./helpers";

export interface CommandContext {
  /** Absolute time (ms epoch) the broker reports this call as timed out.
   *  Commands with slow pre-mutation work must not mutate state past it —
   *  the agent has already been told the call failed. */
  deadlineMs?: number;
}

export type CommandEffect = "read" | "create" | "update" | "archive";
export type CommandVisibility = "none" | "immediate" | "discoverable";

export interface AppCommand<In, Out> {
  /** Broad side-effect class for the no-auth safety gate. */
  effect: CommandEffect;
  /** Whether a successful command is visible to the user immediately, merely
   *  discoverable through app state, or invisible. */
  visibility: CommandVisibility;
  /** Destructive commands are outside v1's no-auth model. Keep false unless a
   *  future auth review deliberately adds an escape hatch. */
  destructive: boolean;
  /** One-line summary, rendered as the verb's line in
   *  `berdctl <noun> --help`'s command list. */
  summary: string;
  /** Static command description: the visible side effect, stated plainly.
   *  Renders as the body of `berdctl <noun> <verb> --help`. */
  description: string;
  /** Example invocation and result shape, rendered after the options in
   *  `berdctl <noun> <verb> --help`. */
  helpFooter: string;
  /** Bridge timeout override (ms) for slow actions; see
   *  commandBridgeTimeoutMs for the default it overrides. */
  bridgeTimeoutMs?: number;
  // Input type is `unknown` so schemas with defaulted fields (input/output
  // divergence) remain assignable; dispatch always parses raw args anyway.
  schema: ZodType<In, unknown>;
  /** Refusal check run after schema parsing and before execute (e.g. target
   *  session mid-run). Throw a CommandError to refuse. */
  precheck?(args: In): void | Promise<void>;
  execute(args: In, ctx: CommandContext): Promise<Out>;
}

/** One registry group: description + CLI metadata + its actions. */
export interface ToolGroup {
  description: string;
  cli: { noun: string; about: string; verbs?: Record<string, string> };
  // `any` is deliberate: the map is heterogeneous (each command has its own
  // In/Out); per-command type safety comes from defineCommand at the
  // definition site, not from this lookup type.
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous command map (see above)
  actions: Record<string, AppCommand<any, any>>;
}

/**
 * Identity helper that pins `AppCommand<In, Out>` inference from the zod
 * schema, so colocated command modules (one command = one file) stay fully
 * typed with no manual annotations: `args` in precheck/execute is the
 * schema's output type.
 */
export function defineCommand<In, Out>(
  command: AppCommand<In, Out>,
): AppCommand<In, Out> {
  return command;
}

export const COMMAND_ERROR_CODES = [
  "unknown_command",
  "unknown_action",
  "invalid_args",
  "workspace_name_required",
  "target_session_running",
  "queue_full",
  "session_not_found",
  "project_not_found",
  "agent_not_found",
  "skill_not_found",
  "harness_not_found",
  "harness_not_ready",
  "model_not_found",
  "blocked_unsaved_changes",
  "backend_read_failed",
  "backend_archive_failed",
  "voice_stop_failed",
  "cleanup_requires_discard",
  "git_inspection_failed",
  "workspace_cleanup_failed",
  "focus_failed",
  "feedback_disabled",
  "feedback_form_busy",
  "feedback_submission_failed",
  "timed_out",
  "internal_error",
] as const;
export type CommandErrorCode = (typeof COMMAND_ERROR_CODES)[number];

export class CommandError extends Error {
  readonly code: CommandErrorCode;

  constructor(code: CommandErrorCode, message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

export function toCommandError(e: unknown): { code: string; message: string } {
  if (e instanceof CommandError) {
    return { code: e.code, message: e.message };
  }
  return { code: "internal_error", message: berdctlErrorDetail(e) };
}
