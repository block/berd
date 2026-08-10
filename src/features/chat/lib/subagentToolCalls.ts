/**
 * Harness-agnostic classification of subagent tool calls.
 *
 * Each harness represents "spawn/await a subagent" as an ordinary tool call
 * whose real meaning rides in metadata or the tool name:
 *
 * - Goose: `delegate` (spawn, sync or async) and `load` with a task-id
 *   `source` (await/peek/cancel a background subagent). `load` with a named
 *   source (recipe/skill) is NOT a subagent run.
 * - Claude Code: `Task` / `Agent` tool (via `_meta.claudeCode.toolName`).
 * - Codex: `spawn_agent` collaboration tool (via `_meta.codex.collaboration`).
 *
 * Tool names arrive on `ToolRequestContent.toolName` (extracted from `_meta`
 * at the ACP edge by `getToolCallIdentity`). Titles are server-authored and
 * sometimes LLM-rewritten, so classification never keys off the title.
 */

import type { MessageContent } from "@/shared/types/messages";

export type SubagentActivity =
  | "delegating"
  | "waiting"
  | "checking"
  | "cancelling";

export interface SubagentToolCallInfo {
  activity: SubagentActivity;
  /** Short human label: the task description or prompt, when provided. */
  label?: string;
  /** Named delegate source (custom agent/recipe), when the spawn had one. */
  agentName?: string;
  /** Goose background-task id (e.g. `20260807_72`) for await/peek/cancel. */
  taskId?: string;
}

/** Goose background-task ids look like `20260807_72`. */
const GOOSE_TASK_ID_PATTERN = /^\d{8}_\w+$/;

/** `20260807_72` → `72`; anything unexpected passes through unchanged. */
export function shortTaskId(taskId: string): string {
  const separator = taskId.indexOf("_");
  return separator > 0 ? taskId.slice(separator + 1) : taskId;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match the task id as a whole token: ids share prefixes (`20260807_7` is a
 * prefix of `20260807_72`), so a raw substring check could attribute a task
 * to the wrong delegate. Reject matches followed by another word character.
 */
function mentionsTaskId(text: string, taskId: string): boolean {
  return new RegExp(`${escapeRegExp(taskId)}(?!\\w)`).test(text);
}

function toolResponseMentionsTask(
  block: Extract<MessageContent, { type: "toolResponse" }>,
  taskId: string,
): boolean {
  if (mentionsTaskId(block.result, taskId)) return true;
  if (block.structuredContent !== undefined) {
    try {
      return mentionsTaskId(JSON.stringify(block.structuredContent), taskId);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * For a `load <task-id>` tool call, resolve the named delegate source that
 * spawned the task (if any) from the session transcript. Returns undefined
 * for anything that isn't a task-id load or when the delegate was ad-hoc.
 */
export function resolveSubagentLabel(
  toolName: string | undefined,
  args: Record<string, unknown>,
  messages: ReadonlyArray<{ content: MessageContent[] }>,
): string | undefined {
  if (toolName !== "load") return undefined;
  const source = stringArg(args, "source")?.trim();
  if (!source || !GOOSE_TASK_ID_PATTERN.test(source)) return undefined;
  return resolveDelegateSourceForTask(messages, source);
}

/**
 * Resolve which named delegate source (custom agent, recipe) spawned a
 * background task, by scanning the session transcript for the `delegate`
 * call whose result announced the task id. Purely derived — no side state.
 *
 * Scans newest-to-oldest: the spawning delegate is almost always recent
 * (tasks are typically collected shortly after launch), and if the same
 * task id ever appears twice, the most recent delegate wins.
 */
export function resolveDelegateSourceForTask(
  messages: ReadonlyArray<{ content: MessageContent[] }>,
  taskId: string,
): string | undefined {
  // A delegate's response follows its request chronologically, so a reverse
  // scan sees the response first: remember matching response ids, then
  // resolve when the paired delegate request appears.
  const matchingResponseIds = new Set<string>();
  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const content = messages[m].content;
    for (let b = content.length - 1; b >= 0; b -= 1) {
      const block = content[b];
      if (
        block.type === "toolResponse" &&
        toolResponseMentionsTask(block, taskId)
      ) {
        matchingResponseIds.add(block.id);
      } else if (
        block.type === "toolRequest" &&
        block.toolName === "delegate" &&
        matchingResponseIds.has(block.id)
      ) {
        const source = block.arguments.source;
        return typeof source === "string" && source.trim().length > 0
          ? source.trim()
          : undefined;
      }
    }
  }
  return undefined;
}

const MAX_LABEL_LENGTH = 60;

function truncateLabel(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_LABEL_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…`;
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

export function getSubagentToolCallInfo(input: {
  toolName?: string;
  arguments: Record<string, unknown>;
}): SubagentToolCallInfo | undefined {
  const { toolName, arguments: args } = input;
  if (!toolName) return undefined;

  // Goose: delegate spawns a subagent. Keep the agent (source) and the task
  // (instructions) separate so titles can show both: "Delegating to Rivet ·
  // Count markdown files…".
  if (toolName === "delegate") {
    const agentName = stringArg(args, "source");
    const label = stringArg(args, "instructions");
    return {
      activity: "delegating",
      ...(agentName ? { agentName: agentName.trim() } : {}),
      ...(label ? { label: truncateLabel(label) } : {}),
    };
  }

  // Goose: load(task_id) waits on / peeks at / cancels a background subagent.
  if (toolName === "load") {
    const source = stringArg(args, "source");
    if (!source || !GOOSE_TASK_ID_PATTERN.test(source.trim())) {
      return undefined;
    }
    const activity: SubagentActivity =
      args.cancel === true
        ? "cancelling"
        : args.peek === true
          ? "checking"
          : "waiting";
    return { activity, taskId: source.trim() };
  }

  // Claude Code: Task/Agent tool spawns a subagent. subagent_type names the
  // configured agent; description is the task.
  if (toolName === "Task" || toolName === "Agent") {
    const agentName = stringArg(args, "subagent_type");
    const label = stringArg(args, "description");
    return {
      activity: "delegating",
      ...(agentName && agentName !== "general-purpose"
        ? { agentName: agentName.trim() }
        : {}),
      ...(label ? { label: truncateLabel(label) } : {}),
    };
  }

  // Codex: spawn_agent collaboration tool.
  if (toolName === "spawn_agent") {
    const label = stringArg(args, "prompt");
    return {
      activity: "delegating",
      ...(label ? { label: truncateLabel(label) } : {}),
    };
  }

  return undefined;
}
