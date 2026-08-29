import { z } from "zod/v4";

import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { createDeferredQueuedMessagePayload } from "@/features/chat/lib/admittedSend";

import { CommandError, defineCommand } from "../types";

const createSessionSchema = z
  .object({
    prompt: z
      .string()
      .min(1)
      .max(50_000)
      .describe("The message to send in the new session (1-50000 chars)."),
    harness_id: z
      .string()
      .optional()
      .describe(
        "Agent harness to run the session on (from `berdctl info harnesses`, " +
          'e.g. "goose", "claude-acp", "codex-acp"). Defaults to the app default.',
      ),
    model_id: z
      .string()
      .optional()
      .describe("Id of the model to use (from `berdctl info models`)."),
    agent_id: z
      .string()
      .optional()
      .describe(
        "Id of the agent (persona) to use (from `berdctl agent list`).",
      ),
    project_id: z
      .string()
      .optional()
      .describe("Id of the project to create the session in."),
    startup_name: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Branch/worktree name when the project's startup mode is branch or worktree; required for those modes.",
      ),
    from: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[^\r\n]*$/, "Sender label must be a single line.")
      .optional()
      .describe(
        "Optional visible sender label for the initial message (1-120 chars).",
      ),
  })
  .strict();

// The margin covers the store create + send dispatch after validation, so we
// never create a session the caller has already been told timed out.
const CREATE_DEADLINE_MARGIN_MS = 3_000;

interface CreateSessionResult {
  session_id: string;
  title: string;
  harness_id: string;
  send_status: "dispatched";
}

export const createSessionCommand = defineCommand({
  effect: "create",
  visibility: "discoverable",
  destructive: false,
  summary:
    "Create a new chat session and send a prompt in it (fire-and-forget)",
  description:
    "Create a new chat session on any installed agent harness and send the prompt in it. " +
    "Fire-and-forget: returns the session id immediately and the session runs in the " +
    "background without changing what the user sees; the user can open it themselves. " +
    "Use --from to give the delegating session or tool a concise visible label on " +
    "the initial message. " +
    'Only check on it later (action "get") if the user asks.',
  helpFooter: `Examples:
  berdctl session create --prompt "Triage the failing nightly build" \\
    --harness-id claude-acp --from "the release orchestrator" --json
  berdctl session create --prompt "Implement the fix" \\
    --project-id <project-id> --startup-name my-feature

Result:
  {"session_id": "...", "title": "...", "harness_id": "...",
   "send_status": "dispatched"}
  The session runs in the background; the user's view does not change. Check
  progress later with \`berdctl session get --session-id <session_id>\`.`,
  schema: createSessionSchema,
  // Backend session create is a real round-trip; everything after it is
  // fire-and-forget.
  bridgeTimeoutMs: 900_000,
  execute: async (args, ctx): Promise<CreateSessionResult> => {
    const [
      { acceptFirstSend },
      { useChatSessionStore },
      { resolveSessionCwd },
      {
        planProjectChatWorkspaces,
        planProjectChatWorkspacesAsIs,
        projectRequiresStartupWorkspaceName,
        rollbackProjectChatWorkspacePlan,
      },
      { berdctlCrossSessionSendOptions },
      { GOOSE_PROVIDER_ID },
      { normalizeSessionExecutionTarget, targetFromAgentModelSelection },
      { findPersonaOrThrow },
      { findProjectOrThrow },
      { findReadyHarnessOrThrow, gooseModelOptions, harnessModelOptions },
    ] = await Promise.all([
      import("@/features/chat/lib/firstWorkspaceSend"),
      import("@/features/chat/stores/chatSessionStore"),
      import("@/features/projects/lib/sessionCwdSelection"),
      import("@/features/projects/lib/projectChatWorkspaces"),
      import("../runtime/sessionSend"),
      import("@/shared/api/acpPersonaHandoff"),
      import("@/features/chat/lib/sessionExecutionTarget"),
      import("../runtime/agents"),
      import("../runtime/projects"),
      import("../runtime/providers"),
    ]);
    const harnessId = args.harness_id ?? GOOSE_PROVIDER_ID;
    // The validation legs are independent I/O; overlap them.
    const [project, , models, persona] = await Promise.all([
      args.project_id ? findProjectOrThrow(args.project_id) : null,
      args.harness_id ? findReadyHarnessOrThrow(args.harness_id) : null,
      args.model_id
        ? (harnessId === GOOSE_PROVIDER_ID
            ? gooseModelOptions()
            : harnessModelOptions(harnessId)
          ).catch(() => [])
        : null,
      args.agent_id ? findPersonaOrThrow(args.agent_id) : null,
    ]);
    // Soft model validation: only reject when the harness's model list is
    // known and the id is not in it. On goose a model belongs to a model
    // provider (anthropic, openai, ...), so a match also resolves the
    // provider the session should run against — mirroring the in-app picker.
    let modelProviderId =
      harnessId === GOOSE_PROVIDER_ID ? undefined : harnessId;
    if (args.model_id && models) {
      const match = models.find((model) => model.model_id === args.model_id);
      if (match) {
        modelProviderId = match.provider ?? modelProviderId;
      } else if (models.length > 0) {
        throw new CommandError(
          "model_not_found",
          `Model "${args.model_id}" is not available on "${harnessId}"; list models with \`berdctl info models\`.`,
        );
      }
    }
    if (args.model_id && !modelProviderId && harnessId === GOOSE_PROVIDER_ID) {
      throw new CommandError(
        "model_not_found",
        `Could not resolve a provider for model "${args.model_id}"; list models with \`berdctl info models\` and retry.`,
      );
    }
    const executionTarget = args.model_id
      ? targetFromAgentModelSelection(harnessId, {
          modelProviderId: modelProviderId ?? harnessId,
          modelId: args.model_id,
          modelName: args.model_id,
        })
      : normalizeSessionExecutionTarget({ harnessId });
    const requiresStartupName = Boolean(
      project && projectRequiresStartupWorkspaceName(project),
    );
    const startupName = args.startup_name?.trim();
    let workspacePlan = project ? planProjectChatWorkspacesAsIs(project) : null;
    if (requiresStartupName) {
      if (!project || !startupName) {
        throw new CommandError(
          "workspace_name_required",
          `Project "${project?.id}" creates a branch or worktree for each new chat; pass --startup-name <name>.`,
        );
      }
      workspacePlan = await planProjectChatWorkspaces(project, startupName);
    } else if (startupName) {
      throw new CommandError(
        "invalid_args",
        "--startup-name only applies when the selected project's startup mode is branch or worktree.",
      );
    }
    // Even an as-is plan may contain a home-relative or relative project
    // folder. Keep its full attachment set, but resolve the primary cwd
    // through the same path resolver used before workspace planning existed.
    const workingDir = requiresStartupName
      ? (workspacePlan?.workingDir ?? (await resolveSessionCwd(project)))
      : await resolveSessionCwd(project);
    let session: ChatSession;
    try {
      // Past the broker deadline the agent was already told this call failed;
      // do not create a session it cannot see. The workspace plan may already
      // have created a branch/worktree, so the catch below rolls it back.
      if (
        ctx.deadlineMs != null &&
        Date.now() > ctx.deadlineMs - CREATE_DEADLINE_MARGIN_MS
      ) {
        throw new CommandError(
          "timed_out",
          "Validation took too long; no session was created. Retry once.",
        );
      }
      session = await useChatSessionStore.getState().createSession({
        workingDir,
        projectId: args.project_id,
        executionTarget,
        personaId: persona?.id,
        workspaceAttachments: workspacePlan?.workspaceAttachments,
        deferProviderSetup: false,
      });
    } catch (error) {
      await rollbackProjectChatWorkspacePlan(workspacePlan);
      throw error;
    }
    const accepted = acceptFirstSend(
      session.id,
      createDeferredQueuedMessagePayload({
        text: args.prompt,
        persona: persona
          ? { kind: "persona", id: persona.id, name: persona.displayName }
          : { kind: "inherit" },
        sendOptions: berdctlCrossSessionSendOptions({
          senderLabel: args.from,
        }),
      }),
      { project, queueReady: true },
    );
    if (!accepted.accepted) {
      throw new CommandError(
        "queue_full",
        "The new session could not accept its first message.",
      );
    }
    return {
      session_id: session.id,
      title: session.title,
      harness_id: harnessId,
      send_status: "dispatched" as const,
    };
  },
});
