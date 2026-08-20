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
    'Only check on it later (action "get") if the user asks.',
  helpFooter: `Examples:
  berdctl session create --prompt "Triage the failing nightly build" \\
    --harness-id claude-acp --json
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
      { personaHarnessId, resolvePersonaExecutionTarget },
      { useAgentStore },
      { useProviderModelCacheStore },
      { getProviderCatalog },
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
      import("@/features/agents/lib/personaExecutionTarget"),
      import("@/features/agents/stores/agentStore"),
      import("@/features/providers/stores/providerModelCacheStore"),
      import("@/features/providers/providerCatalog"),
      import("../runtime/agents"),
      import("../runtime/projects"),
      import("../runtime/providers"),
    ]);
    // Resolve precedence before validating any target field: a complete
    // explicit target replaces saved execution metadata, while partial
    // overrides still consume and therefore validate the remaining saved fields.
    const [project, persona] = await Promise.all([
      args.project_id ? findProjectOrThrow(args.project_id) : null,
      args.agent_id ? findPersonaOrThrow(args.agent_id) : null,
    ]);
    const providers = useAgentStore.getState().providers;
    const catalogEntries = getProviderCatalog();
    const completeExplicitTarget = Boolean(args.harness_id && args.model_id);
    const hasSavedTarget = Boolean(
      persona?.provider || persona?.modelProviderId || persona?.model,
    );
    const savedHarnessId = persona
      ? personaHarnessId(persona.provider, providers, catalogEntries)
      : undefined;
    if (persona && !hasSavedTarget && !completeExplicitTarget) {
      throw new CommandError(
        "agent_configuration_invalid",
        `Agent "${persona.id}" has no saved provider and model. Configure it or pass both --harness-id and --model-id.`,
      );
    }
    if (persona?.provider && !savedHarnessId && !completeExplicitTarget) {
      throw new CommandError(
        "agent_configuration_invalid",
        `Agent "${persona.id}" has a saved provider or model that is no longer available. Update the agent configuration before invoking it.`,
      );
    }
    const harnessId = args.harness_id ?? savedHarnessId ?? GOOSE_PROVIDER_ID;
    await findReadyHarnessOrThrow(harnessId);

    const requiresModelValidation = Boolean(
      args.model_id || (persona && hasSavedTarget && !completeExplicitTarget),
    );
    if (requiresModelValidation) {
      if (harnessId === GOOSE_PROVIDER_ID) await gooseModelOptions();
      else await harnessModelOptions(harnessId);
    }
    const modelCache = useProviderModelCacheStore.getState();
    const cachedModels = [...modelCache.providers].flatMap(([providerId]) =>
      modelCache.isModelInventoryAuthoritative(providerId)
        ? modelCache.getProvenModelsForProvider(providerId).map((model) => ({
            ...model,
            providerId: model.providerId ?? providerId,
          }))
        : [],
    );
    const modelsForHarness = (candidateHarnessId: string) =>
      candidateHarnessId === GOOSE_PROVIDER_ID
        ? cachedModels
        : modelCache.getModelsForProvider(candidateHarnessId);
    const provenModelsForHarness = (candidateHarnessId: string) =>
      candidateHarnessId === GOOSE_PROVIDER_ID
        ? cachedModels
        : modelCache.getProvenModelsForProvider(candidateHarnessId);

    const effectivePersona = persona
      ? {
          provider: args.harness_id ?? persona.provider,
          modelProviderId: args.harness_id
            ? args.harness_id === GOOSE_PROVIDER_ID
              ? persona.modelProviderId
              : args.harness_id
            : persona.modelProviderId,
          model: args.model_id ?? persona.model,
        }
      : null;
    const personaResolution =
      effectivePersona && hasSavedTarget && !completeExplicitTarget
        ? resolvePersonaExecutionTarget(effectivePersona, {
            providers,
            models: cachedModels,
            getModelsForHarness: modelsForHarness,
            getProvenModelsForHarness: provenModelsForHarness,
            isModelInventoryAuthoritative:
              modelCache.isModelInventoryAuthoritative,
            catalogEntries,
          })
        : { status: "absent" as const };
    if (personaResolution.status === "invalid") {
      throw new CommandError(
        "agent_configuration_invalid",
        `Agent "${persona?.id}" has a saved provider or model that is no longer available. Update the agent configuration before invoking it.`,
      );
    }
    const personaTarget =
      personaResolution.status === "valid"
        ? personaResolution.target
        : undefined;
    const explicitModelId = args.model_id;
    const explicitModelProviderBoundary =
      harnessId === GOOSE_PROVIDER_ID &&
      persona &&
      !completeExplicitTarget &&
      !args.harness_id
        ? persona.modelProviderId
        : undefined;
    const inventoryModels = modelsForHarness(harnessId);
    const matchingExplicitModels = explicitModelId
      ? inventoryModels.filter(
          (model) =>
            model.id === explicitModelId &&
            (!explicitModelProviderBoundary ||
              model.providerId === explicitModelProviderBoundary),
        )
      : [];
    const matchingExplicitProviders = new Set(
      matchingExplicitModels.flatMap((model) =>
        model.providerId ? [model.providerId] : [],
      ),
    );
    if (
      explicitModelId &&
      harnessId === GOOSE_PROVIDER_ID &&
      matchingExplicitProviders.size > 1
    ) {
      throw new CommandError(
        "model_ambiguous",
        `Model "${explicitModelId}" is available from multiple Goose providers; select an agent with a provider-qualified model.`,
      );
    }
    const explicitModel = matchingExplicitModels[0];
    const inventoryIsAuthoritative =
      harnessId === GOOSE_PROVIDER_ID
        ? matchingExplicitProviders.size > 0
        : modelCache.isModelInventoryAuthoritative(harnessId);
    if (explicitModelId && !explicitModel && inventoryIsAuthoritative) {
      throw new CommandError(
        "model_not_found",
        `Model "${explicitModelId}" is not available on "${harnessId}"; list models with \`berdctl info models\`.`,
      );
    }
    const explicitModelProviderId =
      harnessId === GOOSE_PROVIDER_ID ? explicitModel?.providerId : harnessId;
    if (explicitModelId && !explicitModelProviderId) {
      throw new CommandError(
        "model_not_found",
        `Could not resolve a provider for model "${explicitModelId}"; list models with \`berdctl info models\` and retry.`,
      );
    }
    const executionTarget = explicitModelId
      ? targetFromAgentModelSelection(harnessId, {
          modelProviderId: explicitModelProviderId ?? harnessId,
          modelId: explicitModelId,
          modelName:
            explicitModel?.displayName ??
            explicitModel?.name ??
            explicitModelId,
        })
      : args.harness_id
        ? (personaTarget ?? normalizeSessionExecutionTarget({ harnessId }))
        : (personaTarget ?? normalizeSessionExecutionTarget({ harnessId }));
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
        sendOptions: berdctlCrossSessionSendOptions(),
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
