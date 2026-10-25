import { z } from "zod/v4";

import { defineCommand } from "../types";

const listModelsSchema = z
  .object({
    harness_id: z
      .string()
      .optional()
      .describe(
        "Agent harness to list models for (from list_harnesses). " +
          "Omit to list models for every ready harness in one call.",
      ),
  })
  .strict();

interface ModelEntry {
  model_id: string;
  name: string;
  /** Model provider the model belongs to (goose harness only, where a model
   *  choice implies a model provider). */
  provider?: string;
}

interface ListModelsResult {
  harnesses: Array<{
    harness_id: string;
    models: ModelEntry[];
    auto_modes?: Array<{ id: string; name: string; is_default: boolean }>;
    /** Present when a stale cached list was served (the last refresh failed)
     *  or when the harness manages its model outside the app. */
    warning?: string;
  }>;
}

export const listModelsCommand = defineCommand({
  effect: "read",
  visibility: "none",
  destructive: false,
  summary: "List the models available per agent harness",
  description:
    "List the models available per agent harness (same source as the app's " +
    "model picker); omit harness_id to cover every ready harness in one " +
    "call. Goose also lists configured Auto modes separately in auto_modes. Use " +
    "--auto-mode-id for those ids, or --model-id for a concrete model when creating a session.",
  helpFooter: `Example:
  berdctl info models --harness-id goose --json

Result:
  {"harnesses": [{"harness_id": "...",
                  "models": [{"model_id": "...", "name": "...",
                              "provider": "..."?}],
                  "auto_modes": [{"id": "...", "name": "...", "is_default": true}]?,
                  "warning": "..."?}]}
  Use a model_id (with its harness) as --model-id when creating a session.
  Goose auto_modes ids are not model ids; pass one as --auto-mode-id to route
  each fresh prompt. auto_modes is omitted for non-Goose harnesses.
  "warning" appears when a stale cached list was served or when the harness
  manages its model outside the app.`,
  schema: listModelsSchema,
  execute: async (args): Promise<ListModelsResult> => {
    const [
      { getProviderModelSelectionHint },
      { useProviderModelCacheStore },
      { GOOSE_PROVIDER_ID },
      { refreshRuntimeConfigForNewChat },
      { useRuntimeConfigStore },
      {
        findReadyHarnessOrThrow,
        listHarnessStatuses,
        gooseModelOptions,
        harnessModelOptions,
      },
    ] = await Promise.all([
      import("@/features/providers/modelSelectionHints"),
      import("@/features/providers/stores/providerModelCacheStore"),
      import("@/shared/api/acpPersonaHandoff"),
      import("@/shared/runtime-config/newChatRuntimeConfig"),
      import("@/shared/runtime-config/runtimeConfigStore"),
      import("../runtime/providers"),
    ]);
    const targets = args.harness_id
      ? [await findReadyHarnessOrThrow(args.harness_id)]
      : (await listHarnessStatuses()).filter(
          (harness) => harness.readiness === "ready",
        );
    if (targets.some((harness) => harness.id === GOOSE_PROVIDER_ID)) {
      await refreshRuntimeConfigForNewChat();
    }
    const autoRouting =
      useRuntimeConfigStore.getState().config.goose.autoRouting;
    const harnesses = await Promise.all(
      targets.map(async (harness) => {
        const models =
          harness.id === GOOSE_PROVIDER_ID
            ? await gooseModelOptions()
            : await harnessModelOptions(harness.id);
        const hint =
          harness.id === GOOSE_PROVIDER_ID
            ? null
            : getProviderModelSelectionHint(harness.id);
        // A failed refresh keeps serving the previous cache; tell the
        // caller the list may be stale instead of silently masking it.
        const staleError =
          harness.id === GOOSE_PROVIDER_ID
            ? null
            : useProviderModelCacheStore.getState().getError(harness.id);
        const warning =
          hint ?? (staleError ? `list may be stale: ${staleError}` : null);
        return {
          harness_id: harness.id,
          models,
          ...(harness.id === GOOSE_PROVIDER_ID
            ? {
                auto_modes: (autoRouting?.modes ?? []).map((mode) => ({
                  id: mode.id,
                  name: mode.displayName,
                  is_default: mode.id === autoRouting?.defaultModeId,
                })),
              }
            : {}),
          ...(warning ? { warning } : {}),
        };
      }),
    );
    return { harnesses };
  },
});
