import type { ZodError } from "zod/v4";

import { archiveProjectCommand } from "./impl/archiveProject";
import { archiveSessionCommand } from "./impl/archiveSession";
import { attachProjectFolderCommand } from "./impl/attachProjectFolder";
import { attachSessionFolderCommand } from "./impl/attachSessionFolder";
import { detachProjectFolderCommand } from "./impl/detachProjectFolder";
import { detachSessionFolderCommand } from "./impl/detachSessionFolder";
import { listSessionFoldersCommand } from "./impl/listSessionFolders";
import { replaceSessionFolderCommand } from "./impl/replaceSessionFolder";
import { setSessionFolderCwdCommand } from "./impl/setSessionFolderCwd";
import { clearSessionProjectCommand } from "./impl/clearSessionProject";
import { createAgentCommand } from "./impl/createAgent";
import { createProjectCommand } from "./impl/createProject";
import { createSessionCommand } from "./impl/createSession";
import { createSkillCommand } from "./impl/createSkill";
import { forkSessionCommand } from "./impl/forkSession";
import { getContextCommand } from "./impl/getContext";
import { getProjectCommand } from "./impl/getProject";
import { getSessionCommand } from "./impl/getSession";
import { getSkillCommand } from "./impl/getSkill";
import { listAgentsCommand } from "./impl/listAgents";
import { listHarnessesCommand } from "./impl/listHarnesses";
import { listModelsCommand } from "./impl/listModels";
import { listProjectsCommand } from "./impl/listProjects";
import { listSessionsCommand } from "./impl/listSessions";
import { listSkillsCommand } from "./impl/listSkills";
import { moveSessionCommand } from "./impl/moveSession";
import { moveSessionToGroupCommand } from "./impl/moveSessionToGroup";
import { openFeedbackCommand } from "./impl/openFeedback";
import { openSessionCommand } from "./impl/openSession";
import { renameSessionCommand } from "./impl/renameSession";
import { sendSessionCommand } from "./impl/sendSession";
import { setProjectStartupModeCommand } from "./impl/setProjectStartupMode";
import { submitFeedbackCommand } from "./impl/submitFeedback";
import { commandBridgeTimeoutMs } from "./timeouts";
import { CommandError, type CommandContext, type ToolGroup } from "./types";

/**
 * The berdctl command surface: one group per domain, dispatching on an
 * `action` discriminator. Each action keeps its own schema. Bridge timeouts
 * are pushed to the broker as each group's per-action maximum (lifecycle.ts
 * groupTimeoutsMs), so at runtime the timeout granularity is per group; the
 * per-action bridgeTimeoutMs is the input to that max (plus dispatch's
 * test-only deadline fallback below). The berdctl CLI's noun/verb surface
 * mirrors these groups/actions via src-tauri/crates/berdctl/cli-surface.json,
 * which is generated from this registry's `cli` metadata
 * (`pnpm generate:berdctl-contract`) and asserted fresh on both sides.
 *
 * `cli.noun` is the CLI's (singular) noun for the group; `cli.about` is the
 * noun's one-line entry in `berdctl --help`'s command list; verbs default to
 * the action names, with `cli.verbs` (verb → action) for the cases where the
 * CLI spelling diverges.
 */
export const ALL_TOOL_GROUPS = {
  sessions: {
    description:
      "Manage the user's chat sessions: create (fire-and-forget, on any " +
      "installed agent harness), send, open, list, get, rename, move, " +
      "move to group, clear project, fork, archive.",
    cli: {
      noun: "session",
      about:
        "Manage chat sessions: create, send, open, list, get, rename, move, move to group, clear project, fork, archive",
      verbs: {
        create: "create",
        send: "send",
        open: "open",
        list: "list",
        get: "get",
        rename: "rename",
        move: "move",
        "move-to-group": "move_to_group",
        "clear-project": "clear_project",
        fork: "fork",
        archive: "archive",
      },
    },
    actions: {
      create: createSessionCommand,
      send: sendSessionCommand,
      open: openSessionCommand,
      list: listSessionsCommand,
      get: getSessionCommand,
      rename: renameSessionCommand,
      move: moveSessionCommand,
      move_to_group: moveSessionToGroupCommand,
      clear_project: clearSessionProjectCommand,
      fork: forkSessionCommand,
      archive: archiveSessionCommand,
    },
  },
  folders: {
    description:
      "Manage folders attached to chat sessions: attach, detach, replace, set cwd, list.",
    cli: {
      noun: "folder",
      about:
        "Manage attached chat folders: attach, detach, replace, set cwd, list",
      verbs: {
        attach: "attach",
        detach: "detach",
        replace: "replace",
        "set-cwd": "set_cwd",
        list: "list",
      },
    },
    actions: {
      attach: attachSessionFolderCommand,
      detach: detachSessionFolderCommand,
      replace: replaceSessionFolderCommand,
      set_cwd: setSessionFolderCwdCommand,
      list: listSessionFoldersCommand,
    },
  },
  projects: {
    description:
      "Manage the user's projects: create, list, get, attach folder, detach folder, set startup mode, archive.",
    cli: {
      noun: "project",
      about:
        "Manage projects: create, list, get, attach folder, detach folder, set startup mode, archive",
      verbs: {
        create: "create",
        list: "list",
        get: "get",
        "attach-folder": "attach_folder",
        "detach-folder": "detach_folder",
        "set-startup-mode": "set_startup_mode",
        archive: "archive",
      },
    },
    actions: {
      create: createProjectCommand,
      list: listProjectsCommand,
      get: getProjectCommand,
      attach_folder: attachProjectFolderCommand,
      detach_folder: detachProjectFolderCommand,
      set_startup_mode: setProjectStartupModeCommand,
      archive: archiveProjectCommand,
    },
  },
  agents: {
    description: "Manage the user's agents (personas): create, list.",
    cli: { noun: "agent", about: "Manage agents (personas): create, list" },
    actions: {
      create: createAgentCommand,
      list: listAgentsCommand,
    },
  },
  skills: {
    description: "Manage the user's skills: create, list, get.",
    cli: { noun: "skill", about: "Manage skills: create, list, get" },
    actions: {
      create: createSkillCommand,
      list: listSkillsCommand,
      get: getSkillCommand,
    },
  },
  feedback: {
    description:
      "Open an approved report in Berd's feedback form or submit it directly after explicit user approval.",
    cli: {
      noun: "feedback",
      about: "Open or submit an approved Berd feedback report",
    },
    actions: {
      open: openFeedbackCommand,
      submit: submitFeedbackCommand,
    },
  },
  info: {
    description:
      "Read-only app information: installed agent harnesses, available " +
      "models, and the current app context.",
    cli: {
      noun: "info",
      about:
        "Look up installed harnesses, available models, and the app context",
      verbs: {
        harnesses: "list_harnesses",
        models: "list_models",
        context: "get_context",
      },
    },
    actions: {
      list_harnesses: listHarnessesCommand,
      list_models: listModelsCommand,
      get_context: getContextCommand,
    },
  },
} as const satisfies Record<string, ToolGroup>;

/**
 * Build-owned command registry. Public builds omit Feedback entirely; an
 * enabled distribution opts it back in with the same VITE_FEEDBACK boolean
 * that owns the renderer and backend surfaces.
 */
export const TOOL_GROUPS: Record<string, ToolGroup> = Object.fromEntries(
  Object.entries(ALL_TOOL_GROUPS).filter(
    ([name]) => name !== "feedback" || import.meta.env.VITE_FEEDBACK === "1",
  ),
);

function formatZodError(error: ZodError): string {
  const parts = error.issues.map((issue) =>
    issue.path.length > 0
      ? `${issue.path.map(String).join(".")}: ${issue.message}`
      : issue.message,
  );
  return parts.join("; ") || error.message;
}

export async function dispatchCommand(
  name: string,
  rawArgs: unknown,
  ctx: CommandContext,
): Promise<unknown> {
  // Guard with Object.hasOwn before indexing: TOOL_GROUPS and each actions map
  // are plain objects, so prototype keys ("__proto__", "constructor", ...)
  // would otherwise resolve to inherited members and bypass the unknown check.
  if (!Object.hasOwn(TOOL_GROUPS, name)) {
    throw new CommandError("unknown_command", `No tool "${name}"`);
  }
  const group: ToolGroup = TOOL_GROUPS[name as keyof typeof TOOL_GROUPS];
  // The Rust broker rejects non-object args (400) and defaults a missing
  // `args` key to {}, so null only reaches dispatch from direct callers;
  // coalesce so action-only calls still parse.
  if (
    rawArgs != null &&
    (typeof rawArgs !== "object" || Array.isArray(rawArgs))
  ) {
    throw new CommandError("invalid_args", "Arguments must be an object");
  }
  const { action, ...actionArgs } = (rawArgs ?? {}) as Record<string, unknown>;
  if (typeof action !== "string" || !Object.hasOwn(group.actions, action)) {
    throw new CommandError(
      "unknown_action",
      `Tool "${name}" requires "action" to be one of: ${Object.keys(
        group.actions,
      ).join(", ")}`,
    );
  }
  const command = group.actions[action];

  const parsed = command.schema.safeParse(actionArgs);
  if (!parsed.success) {
    throw new CommandError("invalid_args", formatZodError(parsed.error));
  }
  // Bridge calls carry the broker-resolved deadline in ctx; only direct
  // callers (tests) fall back to the static per-command timeout.
  const deadline =
    ctx.deadlineMs ?? Date.now() + commandBridgeTimeoutMs(command);
  const enrichedCtx: CommandContext = { ...ctx, deadlineMs: deadline };
  await command.precheck?.(parsed.data);
  return command.execute(parsed.data, enrichedCtx);
}
