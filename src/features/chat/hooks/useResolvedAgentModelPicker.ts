import { useEffect, useMemo, useRef, useState } from "react";
import type { AcpProvider } from "@/shared/api/acp";
import {
  resolveAgentProviderCatalogIdStrictFromEntries,
  resolveModelProviderCatalogIdStrictFromEntries,
} from "@/features/providers/providerCatalog";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useDefaultProviderReadinessStore } from "@/features/providers/stores/defaultProviderReadinessStore";
import { resolveModelProviderId } from "@/features/providers/lib/modelProviderResolution";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import type { ChatSession } from "../stores/chatSessionStore";
import { recoverStrandedProviderSession } from "../model-selection/strandedProviderRecovery";
import { useAgentModelPickerState } from "./useAgentModelPickerState";
import {
  clearStoredModelPreference,
  getStoredModelPreference,
  setStoredModelPreference,
} from "../lib/modelPreferences";
import {
  beginModelSelectionIntent,
  clearCurrentModelSelectionIntent,
  createModelSelectionRequestId,
  rollbackToPreviousModel,
  type ApplySessionModelSelection,
  type ModelSelectionApplyOptions,
  type PreferredModelSelection,
} from "../model-selection/modelSelectionIntent";
import { resolveSelectedAgentId } from "../lib/agentProviderResolution";
import {
  isModelExecutionTarget,
  normalizeSessionExecutionTarget,
  sameSessionExecutionTarget,
  targetFromAgentModelSelection,
  type SessionExecutionTarget,
} from "../lib/sessionExecutionTarget";
import { gooseServeSelectionFromExecutionTarget } from "../lib/gooseServeExecutionTarget";
import { replaceSessionTargetAfterDispatch } from "../lib/sessionTargetCoordinator";
import type { ModelOption } from "../types";

const MODEL_ALIAS_IDS = new Set(["current", "default"]);

interface UseResolvedAgentModelPickerOptions {
  providers: AcpProvider[];
  selectedProvider: string;
  sessionId: string | null;
  session?: ChatSession;
  sessionHasStarted: boolean;
  pendingModelSelection: PreferredModelSelection | null | undefined;
  setPendingModelSelection: (
    selection: PreferredModelSelection | null | undefined,
  ) => void;
  setPendingExecutionTarget: (
    target: SessionExecutionTarget | undefined,
  ) => void;
  setGlobalSelectedProvider: (providerId: string) => void;
  prepareSelectedProvider: (
    providerId: string,
    options?: ModelSelectionApplyOptions,
  ) => Promise<boolean>;
  applySessionModelSelection: ApplySessionModelSelection;
  // Recreate the current (empty) session on a fresh provider when an in-place
  // switch is impossible because the live provider is unset. Optional so
  // non-session callers and tests can omit it. isSelectionCurrent is re-checked
  // inside the recreate right before it navigates, so a switch superseded while
  // createSession was in flight does not steal navigation from the newer pick.
  recreateSessionForProvider?: (
    providerId: string,
    modelSelection?: PreferredModelSelection | null,
    isSelectionCurrent?: () => boolean,
  ) => Promise<boolean>;
}

function isModelAlias(modelId?: string | null): boolean {
  return modelId != null && MODEL_ALIAS_IDS.has(modelId);
}

function resolvePreferredModelProviderId(
  agentId: string,
  modelId: string,
  storedProviderId: string | undefined,
  models: readonly ModelOption[],
  catalogEntries: ProviderCatalogEntry[],
): string | undefined {
  return resolveModelProviderId({
    harnessId: agentId,
    modelId,
    hintedModelProviderId: storedProviderId,
    models,
    catalogEntries,
  });
}

function getPreferredSelectionForAgent(
  agentId: string,
  gooseDefaultSelection: PreferredModelSelection | null,
  models: readonly ModelOption[],
  catalogEntries: ProviderCatalogEntry[],
): PreferredModelSelection | null {
  const preferredModel = getStoredModelPreference(agentId);
  if (preferredModel) {
    const providerId = resolvePreferredModelProviderId(
      agentId,
      preferredModel.modelId,
      preferredModel.providerId,
      models,
      catalogEntries,
    );
    return providerId
      ? {
          id: preferredModel.modelId,
          name: preferredModel.modelName,
          modelProviderId: providerId,
          source: "explicit",
        }
      : null;
  }

  if (agentId !== "goose" || !gooseDefaultSelection) {
    return null;
  }
  const providerId = resolvePreferredModelProviderId(
    agentId,
    gooseDefaultSelection.id,
    gooseDefaultSelection.modelProviderId,
    models,
    catalogEntries,
  );
  return providerId
    ? { ...gooseDefaultSelection, modelProviderId: providerId }
    : null;
}

function resolveAvailableSelection(
  selection: PreferredModelSelection,
  models: readonly ModelOption[],
  selectedModelProviderId: string | null,
  isInventoryAuthoritative: (providerId: string) => boolean,
): PreferredModelSelection | null {
  if (
    selectedModelProviderId &&
    selection.modelProviderId !== selectedModelProviderId
  ) {
    return null;
  }

  const matchingModel = models.find(
    (model) =>
      model.id === selection.id &&
      (!model.providerId || model.providerId === selection.modelProviderId),
  );
  if (!matchingModel && isInventoryAuthoritative(selection.modelProviderId)) {
    return null;
  }

  return {
    ...selection,
    name: matchingModel?.displayName ?? matchingModel?.name ?? selection.name,
    modelProviderId: matchingModel?.providerId ?? selection.modelProviderId,
  };
}

function resolveProviderSelectionTarget(
  providerId: string,
  requestedAgentId: string | null,
  resolvedAgentId: string,
  preferredSelection: PreferredModelSelection | null,
): {
  target: SessionExecutionTarget;
  modelSelection?: PreferredModelSelection;
} {
  let modelSelection = preferredSelection ?? undefined;
  if (!requestedAgentId && modelSelection?.modelProviderId !== providerId) {
    modelSelection = undefined;
  }

  if (modelSelection) {
    return {
      modelSelection,
      target: targetFromAgentModelSelection(resolvedAgentId, {
        modelProviderId: modelSelection.modelProviderId,
        modelId: modelSelection.id,
        modelName: modelSelection.name,
      }),
    };
  }
  if (requestedAgentId) {
    return {
      target: normalizeSessionExecutionTarget({ harnessId: resolvedAgentId }),
    };
  }
  return {
    target: normalizeSessionExecutionTarget({
      harnessId: resolvedAgentId,
      modelProviderId: providerId,
    }),
  };
}

export function useResolvedAgentModelPicker({
  providers,
  selectedProvider,
  sessionId,
  session,
  sessionHasStarted,
  pendingModelSelection,
  setPendingModelSelection,
  setPendingExecutionTarget,
  setGlobalSelectedProvider,
  prepareSelectedProvider,
  applySessionModelSelection,
  recreateSessionForProvider,
}: UseResolvedAgentModelPickerOptions) {
  const catalogEntries = useProviderCatalogStore((state) => state.entries);
  const catalogLoaded = useProviderCatalogStore((state) => state.loaded);
  // A provider or model choice supersedes work started by either callback.
  const selectionVersionRef = useRef(0);
  const [gooseDefaultSelection, setGooseDefaultSelection] =
    useState<PreferredModelSelection | null>(null);

  const selectedAgentId = useMemo(
    () =>
      resolveSelectedAgentId({
        catalogEntries,
        catalogLoaded,
        selectedProvider,
      }),
    [catalogEntries, catalogLoaded, selectedProvider],
  );
  const concreteSelectedProviderId = useMemo(() => {
    const resolvedAgentId = resolveAgentProviderCatalogIdStrictFromEntries(
      catalogEntries,
      selectedProvider,
    );
    if (resolvedAgentId) {
      return null;
    }

    return (
      resolveModelProviderCatalogIdStrictFromEntries(
        catalogEntries,
        selectedProvider,
      ) ?? selectedProvider
    );
  }, [catalogEntries, selectedProvider]);
  const storedModelPreference = useMemo(
    () => getStoredModelPreference(selectedAgentId),
    [selectedAgentId],
  );

  if (selectedAgentId !== "goose" && gooseDefaultSelection !== null) {
    setGooseDefaultSelection(null);
  }

  useEffect(() => {
    if (selectedAgentId !== "goose") {
      return;
    }
    let cancelled = false;

    const loadGooseDefaultSelection = async () => {
      try {
        const readiness =
          useDefaultProviderReadinessStore.getState().readiness ??
          (await useDefaultProviderReadinessStore
            .getState()
            .refresh({ coalesce: true }));

        if (cancelled) {
          return;
        }

        if (
          readiness.status !== "ready" ||
          !readiness.providerId ||
          !readiness.modelId
        ) {
          setGooseDefaultSelection(null);
          return;
        }

        setGooseDefaultSelection({
          id: readiness.modelId,
          name: readiness.modelId,
          modelProviderId: readiness.providerId,
          source: "default",
        });
      } catch {
        if (!cancelled) {
          setGooseDefaultSelection(null);
        }
      }
    };

    void loadGooseDefaultSelection();

    return () => {
      cancelled = true;
    };
  }, [selectedAgentId]);

  // When a switch fails because the current session's provider is unset
  // ("Provider not set"), the in-place switch can never succeed — the backend
  // reads the dead provider before applying the change. Claim the failure and
  // recreate the session on the target provider instead of rolling back onto
  // the corpse (shared logic in strandedProviderRecovery). Returns true when
  // it took over handling the error; false routes the caller through its
  // normal failure and rollback path.
  const recoverFromStrandedProvider = (
    error: unknown,
    providerId: string,
    modelSelection: PreferredModelSelection | null | undefined,
    versionAtSelection: number,
    // Runs only if the recreate actually navigated onto the fresh session (not
    // superseded, not failed). The explicit-model path uses it to persist the
    // recovered choice; without it the success-path setStoredModelPreference is
    // skipped by the recovery early-return, so the next new session for this
    // agent falls back to the old (likely dead) preference and re-enters the trap.
    onRecovered?: () => void,
  ): Promise<boolean> =>
    recoverStrandedProviderSession({
      error,
      sessionId,
      providerId,
      modelSelection,
      recreateSessionForProvider,
      // Re-check the version inside the recreate (right before it navigates)
      // rather than only here: the recreate awaits createSession, and a second
      // provider/model pick during that window bumps the counter. Without the
      // live check, two recreates would race to navigate and could strand the
      // user on the superseded provider while orphaning an extra empty session.
      isSelectionCurrent: () =>
        selectionVersionRef.current === versionAtSelection,
      onRecovered,
    });

  const {
    pickerAgents,
    availableModels,
    getModelsForAgent,
    isModelInventoryAuthoritative,
    modelsLoading,
    modelStatusMessage,
    handleProviderChange,
    handleModelChange,
    handlePickerOpen,
  } = useAgentModelPickerState({
    providers,
    selectedProvider,
    onProviderSelected: (providerId) => {
      selectionVersionRef.current += 1;
      const versionAtSelection = selectionVersionRef.current;
      const requestedAgentId = resolveAgentProviderCatalogIdStrictFromEntries(
        catalogEntries,
        providerId,
      );
      const resolvedRequestedAgentId =
        requestedAgentId ??
        resolveSelectedAgentId({
          catalogEntries,
          catalogLoaded,
          selectedProvider: providerId,
        });
      const preferredModelSelection = getPreferredSelectionForAgent(
        resolvedRequestedAgentId,
        gooseDefaultSelection,
        getModelsForAgent(resolvedRequestedAgentId),
        catalogEntries,
      );
      const { target: nextTarget, modelSelection: nextModelSelection } =
        resolveProviderSelectionTarget(
          providerId,
          requestedAgentId,
          resolvedRequestedAgentId,
          preferredModelSelection,
        );
      const nextWireProviderId =
        gooseServeSelectionFromExecutionTarget(nextTarget).providerId;
      if (!nextWireProviderId) {
        return;
      }

      if (!sessionId) {
        setPendingExecutionTarget(nextTarget);
        setGlobalSelectedProvider(resolvedRequestedAgentId);
        setPendingModelSelection(nextModelSelection);
        return;
      }

      clearCurrentModelSelectionIntent(sessionId);
      if (!sessionHasStarted) {
        setGlobalSelectedProvider(resolvedRequestedAgentId);
      }

      // A pending draft only has a client-generated id. Keep the selection on
      // the draft so startup can apply it after ACP returns the backend id;
      // sending a config request now would target a session ACP cannot know.
      if (session?.creationState === "pending") {
        if (nextTarget.modelId) {
          beginModelSelectionIntent(sessionId, {
            requestId: createModelSelectionRequestId(),
            target: nextTarget,
            previousTarget: session.executionTarget,
            preferenceAgentId: resolvedRequestedAgentId,
          });
        } else {
          replaceSessionTargetAfterDispatch(sessionId, nextTarget);
        }
        return;
      }

      if (nextModelSelection?.id && isModelExecutionTarget(nextTarget)) {
        const previousTarget = session?.executionTarget;
        const requestId = createModelSelectionRequestId();
        beginModelSelectionIntent(sessionId, {
          requestId,
          target: nextTarget,
          previousTarget,
        });
        void applySessionModelSelection(
          nextWireProviderId,
          nextModelSelection,
          requestId,
        )
          .then(() => {
            clearCurrentModelSelectionIntent(sessionId, requestId);
          })
          .catch(async (error) => {
            const intentStillMatches = clearCurrentModelSelectionIntent(
              sessionId,
              requestId,
            );
            if (selectionVersionRef.current !== versionAtSelection) {
              return;
            }
            if (!intentStillMatches) {
              return;
            }
            if (
              await recoverFromStrandedProvider(
                error,
                nextWireProviderId,
                nextModelSelection,
                versionAtSelection,
              )
            ) {
              return;
            }
            if (selectionVersionRef.current !== versionAtSelection) {
              return;
            }
            console.error("Failed to update ACP session provider:", error);
            rollbackToPreviousModel({
              sessionId,
              failedModelName: nextModelSelection.name,
              previousTarget,
              applySessionModelSelection,
              prepareSelectedProvider,
              setGlobalSelectedProvider: sessionHasStarted
                ? undefined
                : setGlobalSelectedProvider,
              restoreErrorMessage:
                "Failed to restore previous model after provider switch failure:",
            });
          });
        return;
      }

      const requestId = createModelSelectionRequestId();
      if (isModelExecutionTarget(nextTarget)) {
        return;
      }
      beginModelSelectionIntent(sessionId, {
        requestId,
        target: nextTarget,
        previousTarget: session?.executionTarget,
      });
      void prepareSelectedProvider(nextWireProviderId, { requestId })
        .then(() => {
          clearCurrentModelSelectionIntent(sessionId, requestId);
        })
        .catch(async (error) => {
          const intentStillMatches = clearCurrentModelSelectionIntent(
            sessionId,
            requestId,
          );
          if (
            !intentStillMatches ||
            selectionVersionRef.current !== versionAtSelection
          ) {
            return;
          }
          if (
            await recoverFromStrandedProvider(
              error,
              nextWireProviderId,
              undefined,
              versionAtSelection,
            )
          ) {
            return;
          }
          if (selectionVersionRef.current !== versionAtSelection) {
            return;
          }
          console.error("Failed to update ACP session provider:", error);
        });
    },
    onModelSelected: (model) => {
      const modelId = model.id;
      const modelName = model.displayName ?? model.name ?? model.id;
      const nextModelProviderId =
        model.providerId ??
        session?.executionTarget?.modelProviderId ??
        (selectedAgentId === "goose" ? undefined : selectedAgentId);
      if (!nextModelProviderId) {
        console.warn("Dropped model selection without a model provider", {
          harnessId: selectedAgentId,
          modelId,
        });
        return;
      }
      const nextTarget = targetFromAgentModelSelection(selectedAgentId, {
        modelProviderId: nextModelProviderId,
        modelId,
        modelName,
      });
      if (!isModelExecutionTarget(nextTarget)) {
        return;
      }
      const nextModelSelection: PreferredModelSelection = {
        id: modelId,
        name: modelName,
        modelProviderId: nextModelProviderId,
        source: "explicit",
      };
      const nextStoredModelPreference = {
        modelId,
        modelName,
        providerId: nextModelProviderId,
      };

      if (!sessionId) {
        setPendingExecutionTarget(nextTarget);
        setGlobalSelectedProvider(selectedAgentId);
        setPendingModelSelection(nextModelSelection);
        return;
      }

      // No-op guard: if the selected model/provider already matches the
      // session, bail out without bumping the version counter. Bumping
      // before this check would invalidate in-flight async work from the
      // original selection that is still correctly configuring the backend.
      if (
        !session ||
        sameSessionExecutionTarget(session.executionTarget, nextTarget)
      ) {
        return;
      }

      selectionVersionRef.current += 1;
      const versionAtSelection = selectionVersionRef.current;
      const requestId = createModelSelectionRequestId();

      const previousStoredModelPreference =
        getStoredModelPreference(selectedAgentId);
      const previousTarget = session.executionTarget;
      const providerChanged =
        nextTarget.modelProviderId !== previousTarget?.modelProviderId;

      // Pending drafts are not ACP sessions yet. Record the latest choice on
      // the draft and let draft promotion configure the real backend session.
      if (session.creationState === "pending") {
        if (providerChanged && !sessionHasStarted) {
          setGlobalSelectedProvider(selectedAgentId);
        }
        beginModelSelectionIntent(sessionId, {
          requestId,
          target: nextTarget,
          previousTarget,
          preferenceAgentId: selectedAgentId,
        });
        return;
      }

      beginModelSelectionIntent(sessionId, {
        requestId,
        target: nextTarget,
        previousTarget,
      });
      if (providerChanged && !sessionHasStarted) {
        setGlobalSelectedProvider(selectedAgentId);
      }

      void (async () => {
        try {
          const applied = await applySessionModelSelection(
            nextModelProviderId,
            nextModelSelection,
            requestId,
          );
          const intentStillMatches = clearCurrentModelSelectionIntent(
            sessionId,
            requestId,
          );
          if (!applied || !intentStillMatches) {
            return;
          }
          if (selectionVersionRef.current !== versionAtSelection) {
            return;
          }
          if (!sessionHasStarted) {
            setStoredModelPreference(
              selectedAgentId,
              nextStoredModelPreference,
            );
          }
        } catch (error) {
          const intentStillMatches = clearCurrentModelSelectionIntent(
            sessionId,
            requestId,
          );
          if (
            !intentStillMatches ||
            selectionVersionRef.current !== versionAtSelection
          ) {
            return;
          }
          if (
            await recoverFromStrandedProvider(
              error,
              nextModelProviderId,
              nextModelSelection,
              versionAtSelection,
              sessionHasStarted
                ? undefined
                : () =>
                    setStoredModelPreference(
                      selectedAgentId,
                      nextStoredModelPreference,
                    ),
            )
          ) {
            return;
          }
          if (selectionVersionRef.current !== versionAtSelection) {
            return;
          }
          console.error("Failed to set model:", error);
          if (!sessionHasStarted) {
            if (previousStoredModelPreference) {
              setStoredModelPreference(
                selectedAgentId,
                previousStoredModelPreference,
              );
            } else {
              clearStoredModelPreference(selectedAgentId);
            }
          }
          rollbackToPreviousModel({
            sessionId,
            failedModelName: modelName,
            previousTarget,
            applySessionModelSelection,
            prepareSelectedProvider,
            setGlobalSelectedProvider:
              providerChanged && !sessionHasStarted
                ? setGlobalSelectedProvider
                : undefined,
            restoreErrorMessage:
              "Failed to restore previous model after setModel failure:",
          });
        }
      })();
    },
  });

  const preferredModelSelection =
    useMemo<PreferredModelSelection | null>(() => {
      const storedModelProviderId = storedModelPreference
        ? resolvePreferredModelProviderId(
            selectedAgentId,
            storedModelPreference.modelId,
            storedModelPreference.providerId,
            availableModels,
            catalogEntries,
          )
        : undefined;
      if (storedModelPreference && storedModelProviderId) {
        const storedSelection: PreferredModelSelection = {
          id: storedModelPreference.modelId,
          name: storedModelPreference.modelName,
          modelProviderId: storedModelProviderId,
          source: "explicit",
        };
        const availableStoredSelection = resolveAvailableSelection(
          storedSelection,
          availableModels,
          concreteSelectedProviderId,
          isModelInventoryAuthoritative,
        );
        if (availableStoredSelection) return availableStoredSelection;
      }

      const defaultModelProviderId = gooseDefaultSelection
        ? resolvePreferredModelProviderId(
            selectedAgentId,
            gooseDefaultSelection.id,
            gooseDefaultSelection.modelProviderId,
            availableModels,
            catalogEntries,
          )
        : undefined;
      if (
        selectedAgentId !== "goose" ||
        !gooseDefaultSelection ||
        !defaultModelProviderId
      ) {
        return null;
      }
      return resolveAvailableSelection(
        {
          ...gooseDefaultSelection,
          modelProviderId: defaultModelProviderId,
        },
        availableModels,
        concreteSelectedProviderId,
        isModelInventoryAuthoritative,
      );
    }, [
      availableModels,
      catalogEntries,
      concreteSelectedProviderId,
      gooseDefaultSelection,
      isModelInventoryAuthoritative,
      selectedAgentId,
      storedModelPreference,
    ]);

  const sessionModelSelection = useMemo<PreferredModelSelection | null>(() => {
    const executionTarget = session?.executionTarget;
    if (!executionTarget?.modelId) {
      return null;
    }

    const modelsMatchingSessionId = availableModels.filter(
      (model) => model.id === executionTarget.modelId,
    );
    const exactProviderMatch =
      modelsMatchingSessionId.find(
        (model) =>
          !model.providerId ||
          model.providerId === executionTarget.modelProviderId,
      ) ?? null;
    const matchingSessionModel = exactProviderMatch;

    if (matchingSessionModel) {
      return {
        id: matchingSessionModel.id,
        name:
          matchingSessionModel.displayName ??
          matchingSessionModel.name ??
          executionTarget.modelName ??
          executionTarget.modelId,
        modelProviderId:
          matchingSessionModel.providerId ?? executionTarget.modelProviderId,
        source: "explicit",
      };
    }

    if (isModelAlias(executionTarget.modelId)) {
      return null;
    }

    return {
      id: executionTarget.modelId,
      name: executionTarget.modelName,
      modelProviderId: executionTarget.modelProviderId,
      source: "explicit",
    };
  }, [availableModels, session]);

  const availableDefaultModelSelection =
    useMemo<PreferredModelSelection | null>(() => {
      const compatibleModels = concreteSelectedProviderId
        ? availableModels.filter(
            (model) =>
              !model.providerId ||
              model.providerId === concreteSelectedProviderId,
          )
        : availableModels;
      const defaultModel =
        compatibleModels.find((model) => model.recommended) ??
        compatibleModels[0];

      if (!defaultModel) {
        return null;
      }

      return {
        id: defaultModel.id,
        name: defaultModel.displayName ?? defaultModel.name ?? defaultModel.id,
        modelProviderId: defaultModel.providerId ?? selectedProvider,
        source: defaultModel.recommended ? "default" : "explicit",
      };
    }, [availableModels, concreteSelectedProviderId, selectedProvider]);

  const fallbackModelSelection = session
    ? null
    : (preferredModelSelection ?? availableDefaultModelSelection);
  const effectiveModelSelection =
    pendingModelSelection !== undefined
      ? pendingModelSelection
      : (sessionModelSelection ?? fallbackModelSelection);

  return {
    selectedAgentId,
    pickerAgents,
    availableModels,
    getModelsForAgent,
    modelsLoading,
    modelStatusMessage,
    handleProviderChange,
    handleModelChange,
    handlePickerOpen,
    effectiveModelSelection,
  };
}
