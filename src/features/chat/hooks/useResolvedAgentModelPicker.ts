import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AcpProvider } from "@/shared/api/acp";
import {
  resolveAgentProviderCatalogIdStrictFromEntries,
  resolveModelProviderCatalogIdStrictFromEntries,
} from "@/features/providers/providerCatalog";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useDefaultProviderReadinessStore } from "@/features/providers/stores/defaultProviderReadinessStore";
import {
  useChatSessionStore,
  type ChatSession,
} from "../stores/chatSessionStore";
import { recoverStrandedProviderSession } from "../model-selection/strandedProviderRecovery";
import { useAgentModelPickerState } from "./useAgentModelPickerState";
import {
  clearStoredModelPreference,
  getStoredModelPreference,
  setStoredModelPreference,
} from "../lib/modelPreferences";
import {
  clearCurrentModelSelectionIntent,
  createModelSelectionRequestId,
  rollbackToPreviousModel,
  type ApplySessionModelSelection,
  type ModelSelectionApplyOptions,
  type PreferredModelSelection,
} from "../model-selection/modelSelectionIntent";
import { resolveSelectedAgentId } from "../lib/agentProviderResolution";

const MODEL_ALIAS_IDS = new Set(["current", "default"]);

interface UseResolvedAgentModelPickerOptions {
  providers: AcpProvider[];
  selectedProvider: string;
  sessionId: string | null;
  session?: ChatSession;
  sessionHasStarted: boolean;
  pendingModelSelection: PreferredModelSelection | null | undefined;
  setPendingProviderId: (providerId: string | undefined) => void;
  setPendingModelSelection: (
    selection: PreferredModelSelection | null | undefined,
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

export function useResolvedAgentModelPicker({
  providers,
  selectedProvider,
  sessionId,
  session,
  sessionHasStarted,
  pendingModelSelection,
  setPendingProviderId,
  setPendingModelSelection,
  setGlobalSelectedProvider,
  prepareSelectedProvider,
  applySessionModelSelection,
  recreateSessionForProvider,
}: UseResolvedAgentModelPickerOptions) {
  const catalogEntries = useProviderCatalogStore((state) => state.entries);
  const catalogLoaded = useProviderCatalogStore((state) => state.loaded);
  // Monotonic version counter shared across onProviderSelected and
  // onModelSelected. Any user interaction (provider OR model change) bumps
  // this, which invalidates in-flight async work from either callback —
  // intentionally cross-callback so a rapid provider switch also cancels a
  // stale model mutation and vice versa.
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

  const getPreferredSelectionForAgent = useCallback(
    (agentId: string, fallbackProviderId?: string) => {
      const preferredModel = getStoredModelPreference(agentId);
      if (preferredModel) {
        return {
          id: preferredModel.modelId,
          name: preferredModel.modelName,
          providerId: preferredModel.providerId ?? fallbackProviderId,
          source: "explicit" as const,
        };
      }

      if (agentId === "goose") {
        if (!gooseDefaultSelection) {
          return null;
        }

        return {
          ...gooseDefaultSelection,
          providerId: gooseDefaultSelection.providerId ?? fallbackProviderId,
        };
      }

      return null;
    },
    [gooseDefaultSelection],
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
          (await useDefaultProviderReadinessStore.getState().refresh());

        if (cancelled) {
          return;
        }

        const providerId =
          readiness.status === "ready" ? readiness.providerId : undefined;
        const modelId =
          readiness.status === "ready" ? readiness.modelId : undefined;

        if (!modelId) {
          setGooseDefaultSelection(null);
          return;
        }

        setGooseDefaultSelection({
          id: modelId,
          name: modelId,
          providerId,
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
        providerId,
      );
      const nextProviderId = requestedAgentId
        ? (preferredModelSelection?.providerId ?? providerId)
        : providerId;
      const nextModelSelection =
        !requestedAgentId &&
        preferredModelSelection?.providerId &&
        preferredModelSelection.providerId !== providerId
          ? undefined
          : preferredModelSelection
            ? {
                ...preferredModelSelection,
                providerId:
                  requestedAgentId == null
                    ? providerId
                    : preferredModelSelection.providerId,
              }
            : undefined;

      if (!sessionId) {
        setGlobalSelectedProvider(nextProviderId);
        setPendingProviderId(nextProviderId);
        setPendingModelSelection(nextModelSelection);
        return;
      }

      const sessionStore = useChatSessionStore.getState();
      sessionStore.clearModelSelectionIntent(sessionId);
      sessionStore.switchSessionProvider(sessionId, nextProviderId);
      if (!sessionHasStarted) {
        setGlobalSelectedProvider(providerId);
      }

      // A pending draft only has a client-generated id. Keep the selection on
      // the draft so startup can apply it after ACP returns the backend id;
      // sending a config request now would target a session ACP cannot know.
      if (session?.creationState === "pending") {
        if (nextModelSelection?.id) {
          sessionStore.patchSession(sessionId, {
            modelId: nextModelSelection.id,
            modelName: nextModelSelection.name,
          });
        }
        return;
      }

      if (nextModelSelection?.id) {
        const previousProviderId = session?.providerId;
        const previousModelId = session?.modelId;
        const previousModelName = session?.modelName;
        const requestId = createModelSelectionRequestId();
        sessionStore.beginModelSelectionIntent(sessionId, {
          requestId,
          kind: "model",
          providerId: nextModelSelection.providerId ?? nextProviderId,
          modelId: nextModelSelection.id,
          modelName: nextModelSelection.name,
          previousProviderId,
          previousModelId,
          previousModelName,
        });
        void applySessionModelSelection(
          nextProviderId,
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
                nextProviderId,
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
              previous: {
                providerId: previousProviderId,
                modelId: previousModelId,
                modelName: previousModelName,
              },
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
      sessionStore.beginModelSelectionIntent(sessionId, {
        requestId,
        kind: "provider",
        providerId: nextProviderId,
        previousProviderId: session?.providerId,
        previousModelId: session?.modelId,
        previousModelName: session?.modelName,
      });
      void prepareSelectedProvider(nextProviderId, { requestId })
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
              nextProviderId,
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
      const nextProviderId = model.providerId ?? selectedProvider;
      const nextModelSelection: PreferredModelSelection = {
        id: modelId,
        name: modelName,
        providerId: nextProviderId,
        source: "explicit",
      };
      const nextStoredModelPreference = {
        modelId,
        modelName,
        providerId: nextProviderId,
      };

      if (!sessionId) {
        if (nextProviderId && nextProviderId !== selectedProvider) {
          setPendingProviderId(nextProviderId);
          setGlobalSelectedProvider(nextProviderId);
        }
        setPendingModelSelection(nextModelSelection);
        return;
      }

      // No-op guard: if the selected model/provider already matches the
      // session, bail out without bumping the version counter. Bumping
      // before this check would invalidate in-flight async work from the
      // original selection that is still correctly configuring the backend.
      if (
        !session ||
        (modelId === session.modelId &&
          (!nextProviderId || nextProviderId === session.providerId))
      ) {
        return;
      }

      selectionVersionRef.current += 1;
      const versionAtSelection = selectionVersionRef.current;
      const requestId = createModelSelectionRequestId();

      const previousStoredModelPreference =
        getStoredModelPreference(selectedAgentId);
      const previousProviderId = session.providerId;
      const previousModelId = session.modelId;
      const previousModelName = session.modelName;
      const providerChanged =
        Boolean(nextProviderId) && nextProviderId !== session.providerId;
      const sessionStore = useChatSessionStore.getState();

      // Pending drafts are not ACP sessions yet. Record the latest choice on
      // the draft and let draft promotion configure the real backend session.
      if (session.creationState === "pending") {
        if (providerChanged && nextProviderId) {
          sessionStore.switchSessionProvider(sessionId, nextProviderId);
          if (!sessionHasStarted) {
            setGlobalSelectedProvider(selectedAgentId);
          }
        }
        sessionStore.patchSession(sessionId, {
          modelId,
          modelName,
          reasoningEffort: undefined,
        });
        sessionStore.beginModelSelectionIntent(sessionId, {
          requestId,
          kind: "model",
          providerId: nextProviderId,
          modelId,
          modelName,
          previousProviderId,
          previousModelId,
          previousModelName,
          preferenceAgentId: selectedAgentId,
        });
        return;
      }

      sessionStore.beginModelSelectionIntent(sessionId, {
        requestId,
        kind: "model",
        providerId: nextProviderId,
        modelId,
        modelName,
        previousProviderId,
        previousModelId,
        previousModelName,
      });

      if (providerChanged && nextProviderId) {
        sessionStore.switchSessionProvider(sessionId, nextProviderId);
        if (!sessionHasStarted) {
          setGlobalSelectedProvider(selectedAgentId);
        }
      }

      sessionStore.patchSession(sessionId, {
        modelId,
        modelName,
        reasoningEffort: undefined,
      });

      void (async () => {
        try {
          const applied = await applySessionModelSelection(
            nextProviderId,
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
              nextProviderId,
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
            previous: {
              providerId: previousProviderId,
              modelId: previousModelId,
              modelName: previousModelName,
            },
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
      if (storedModelPreference) {
        const matchingStoredModel =
          availableModels.find(
            (model) =>
              model.id === storedModelPreference.modelId &&
              (!storedModelPreference.providerId ||
                !model.providerId ||
                model.providerId === storedModelPreference.providerId) &&
              (!concreteSelectedProviderId ||
                !model.providerId ||
                model.providerId === concreteSelectedProviderId),
          ) ?? null;
        const storedSelectionCompatible =
          !concreteSelectedProviderId ||
          storedModelPreference.providerId === concreteSelectedProviderId;

        if (
          matchingStoredModel ||
          ((availableModels.length === 0 || modelsLoading) &&
            storedSelectionCompatible)
        ) {
          return {
            id: storedModelPreference.modelId,
            name:
              matchingStoredModel?.displayName ??
              matchingStoredModel?.name ??
              storedModelPreference.modelName,
            providerId:
              matchingStoredModel?.providerId ??
              storedModelPreference.providerId,
            source: "explicit",
          };
        }
      }

      const defaultSelection = getPreferredSelectionForAgent(
        selectedAgentId,
        selectedProvider,
      );

      if (!defaultSelection) {
        return null;
      }

      const matchingDefaultModel =
        availableModels.find(
          (model) =>
            model.id === defaultSelection.id &&
            (!defaultSelection.providerId ||
              !model.providerId ||
              model.providerId === defaultSelection.providerId) &&
            (!concreteSelectedProviderId ||
              !model.providerId ||
              model.providerId === concreteSelectedProviderId),
        ) ?? null;
      const defaultSelectionCompatible =
        !concreteSelectedProviderId ||
        defaultSelection.providerId === concreteSelectedProviderId;

      if (!matchingDefaultModel && !defaultSelectionCompatible) {
        return null;
      }

      return {
        id: defaultSelection.id,
        name:
          matchingDefaultModel?.displayName ??
          matchingDefaultModel?.name ??
          defaultSelection.name,
        providerId:
          matchingDefaultModel?.providerId ?? defaultSelection.providerId,
        source: "default",
      };
    }, [
      availableModels,
      getPreferredSelectionForAgent,
      modelsLoading,
      concreteSelectedProviderId,
      selectedProvider,
      selectedAgentId,
      storedModelPreference,
    ]);

  const sessionModelSelection = useMemo<PreferredModelSelection | null>(() => {
    if (!session?.modelId) {
      return null;
    }

    const modelsMatchingSessionId = availableModels.filter(
      (model) => model.id === session.modelId,
    );
    const exactProviderMatch =
      modelsMatchingSessionId.find(
        (model) =>
          !session.providerId ||
          !model.providerId ||
          model.providerId === session.providerId,
      ) ?? null;
    const matchingSessionModel =
      exactProviderMatch ??
      (session.providerId === selectedAgentId &&
      modelsMatchingSessionId.length === 1
        ? modelsMatchingSessionId[0]
        : null);

    if (matchingSessionModel) {
      return {
        id: matchingSessionModel.id,
        name:
          matchingSessionModel.displayName ??
          matchingSessionModel.name ??
          session.modelName ??
          session.modelId,
        providerId: matchingSessionModel.providerId ?? session.providerId,
        source: "explicit",
      };
    }

    if (isModelAlias(session.modelId)) {
      return null;
    }

    return {
      id: session.modelId,
      name: session.modelName ?? session.modelId,
      providerId: session.providerId,
      source: "explicit",
    };
  }, [availableModels, selectedAgentId, session]);

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
        providerId: defaultModel.providerId ?? selectedProvider,
        source: defaultModel.recommended ? "default" : "explicit",
      };
    }, [availableModels, concreteSelectedProviderId, selectedProvider]);

  const effectiveModelSelection =
    pendingModelSelection !== undefined
      ? pendingModelSelection
      : (sessionModelSelection ??
        preferredModelSelection ??
        availableDefaultModelSelection);

  return {
    selectedAgentId,
    pickerAgents,
    availableModels,
    modelsLoading,
    modelStatusMessage,
    handleProviderChange,
    handleModelChange,
    handlePickerOpen,
    effectiveModelSelection,
  };
}
