import { useCallback, useEffect, useRef, useState } from "react";
import {
  listAgentBuilderSources,
  readFreshAgentSource,
  updateAgentBuilderSource,
  type AgentSourceEntry,
  type PersonaSourcePatch,
} from "@/features/agents/lib/agentBuilderSourceLifecycle";
import { isEmptyPlaceholderDraft } from "@/features/agents/lib/agentBuilderIdentity";
import { perfLog } from "@/shared/lib/perfLog";

export type { PersonaSourcePatch } from "@/features/agents/lib/agentBuilderSourceLifecycle";

const POLL_MS = 750;
const FLUSH_DEBOUNCE_MS = 400;
const MISSING_GRACE_POLLS = 4;
const LOCAL_BUILDER_PROPERTY_KEYS = [
  "avatar",
  "provider",
  "modelProviderId",
  "model",
] as const;

type PersonaSourceError = "missing" | "parse" | "load" | null;

interface UsePersonaSourceResult {
  data: AgentSourceEntry | null;
  isLoading: boolean;
  error: PersonaSourceError;
  update: (patch: PersonaSourcePatch) => void;
  saveStatus: "saved" | "unsaved" | "saving" | "error";
  saveNow: () => Promise<boolean>;
}

interface UsePersonaSourceOptions {
  builderSessionId?: string;
  onResolvedPathChange?: (source: AgentSourceEntry) => void;
  /**
   * Called with the persisted source after a flush write durably completes.
   * A saveNow with nothing pending never reaches it, and a failed write never
   * reaches it, so callers can treat every invocation as one real persisted
   * edit (drafts included — filtering draft writes is the caller's call).
   */
  onWritePersisted?: (source: AgentSourceEntry) => void;
}

export function usePersonaSource(
  path: string | null,
  options: UsePersonaSourceOptions = {},
): UsePersonaSourceResult {
  const { builderSessionId, onResolvedPathChange, onWritePersisted } = options;
  const [data, setData] = useState<AgentSourceEntry | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<PersonaSourceError>(null);
  const dataRef = useRef<AgentSourceEntry | null>(null);
  const onResolvedPathChangeRef = useRef(onResolvedPathChange);
  const onWritePersistedRef = useRef(onWritePersisted);
  const missingPollsRef = useRef(0);
  const pendingPatchRef = useRef<PersonaSourcePatch | null>(null);
  const inFlightPatchRef = useRef<PersonaSourcePatch | null>(null);
  const inFlightPromiseRef = useRef<Promise<boolean> | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef<(() => Promise<boolean>) | null>(null);
  const baseSourceRef = useRef<AgentSourceEntry | null>(null);
  const externalOverrideVersionRef = useRef(0);
  const saveIdentityRef = useRef("");
  const activeWritePathRef = useRef<string | null>(path);
  const mountedRef = useRef(true);
  const [saveStatus, setSaveStatus] =
    useState<UsePersonaSourceResult["saveStatus"]>("saved");
  const [isPollingActive, setIsPollingActive] = useState(() =>
    shouldPollPersonaSource(),
  );
  const wasPollingActiveRef = useRef(isPollingActive);
  const sourceIdentity = `${builderSessionId ?? ""}\u0000${path ?? ""}`;
  const [previousSourceIdentity, setPreviousSourceIdentity] =
    useState(sourceIdentity);
  if (previousSourceIdentity !== sourceIdentity) {
    setPreviousSourceIdentity(sourceIdentity);
    saveIdentityRef.current = sourceIdentity;
    activeWritePathRef.current = path;
    missingPollsRef.current = 0;
    pendingPatchRef.current = null;
    inFlightPatchRef.current = null;
    inFlightPromiseRef.current = null;
    externalOverrideVersionRef.current += 1;
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    dataRef.current = null;
    baseSourceRef.current = null;
    setData(null);
    setError(null);
    setSaveStatus("saved");
    setIsLoading(true);
  } else {
    saveIdentityRef.current = sourceIdentity;
    activeWritePathRef.current = path;
  }

  const shouldAutoSave = useCallback(
    (source: AgentSourceEntry | null = dataRef.current) =>
      !builderSessionId || source?.properties?.draft === true,
    [builderSessionId],
  );

  const scheduleAutoFlush = useCallback(
    (source: AgentSourceEntry | null = dataRef.current) => {
      if (!shouldAutoSave(source)) {
        return;
      }

      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        void flushRef.current?.();
      }, FLUSH_DEBOUNCE_MS);
    },
    [shouldAutoSave],
  );

  const reload = useCallback(async () => {
    if (!path) {
      setData(null);
      dataRef.current = null;
      setIsLoading(false);
      setError("missing");
      return;
    }

    let keepLoading = false;
    try {
      const identity = saveIdentityRef.current;
      const inFlight = inFlightPromiseRef.current;
      if (inFlight) {
        await inFlight.catch(() => false);
        if (!mountedRef.current || saveIdentityRef.current !== identity) {
          return;
        }
      }

      const sources = await listAgentBuilderSources();
      let found = resolvePersonaSource(sources, path, builderSessionId);
      let readFromExactPath = false;
      if (!found) {
        if (builderSessionId) {
          try {
            found = await readFreshAgentSource(
              path,
              dataRef.current ?? undefined,
            );
            readFromExactPath = true;
          } catch (error) {
            console.warn("Failed to read agent builder draft source:", error);
          }
        }
      }

      if (!found) {
        missingPollsRef.current += 1;
        if (missingPollsRef.current <= MISSING_GRACE_POLLS) {
          if (!dataRef.current) {
            keepLoading = true;
          }
          setError(null);
          return;
        }

        dataRef.current = null;
        setData(null);
        setError("missing");
        return;
      }

      const resolvedSource = found;
      if (builderSessionId && !readFromExactPath) {
        try {
          found = await readFreshAgentSource(
            resolvedSource.path,
            resolvedSource,
          );
        } catch (error) {
          console.warn("Failed to read agent builder draft source:", error);
          found = resolvedSource;
        }
      }

      missingPollsRef.current = 0;
      if (found.path !== path) {
        activeWritePathRef.current = found.path;
        onResolvedPathChangeRef.current?.(found);
      }

      const optimisticPatch = mergePatches(
        inFlightPatchRef.current,
        pendingPatchRef.current,
      );
      const previousBase = baseSourceRef.current;
      const foundMatchesInFlight =
        previousBase &&
        inFlightPatchRef.current &&
        sameSourceView(
          found,
          applyPatch(previousBase, inFlightPatchRef.current),
        );
      const externalDraftChanged =
        builderSessionId &&
        optimisticPatch &&
        previousBase &&
        hasExternalChange(
          previousBase,
          found,
          optimisticPatch,
          foundMatchesInFlight,
        );
      if (externalDraftChanged) {
        const remainingLocalPatch = mergePatches(
          stripExternallyChangedFields(
            inFlightPatchRef.current,
            previousBase,
            found,
          ),
          stripExternallyChangedFields(
            pendingPatchRef.current,
            previousBase,
            found,
          ),
        );
        inFlightPatchRef.current = null;
        pendingPatchRef.current = remainingLocalPatch;
        externalOverrideVersionRef.current += 1;

        if (flushTimerRef.current) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }

        if (remainingLocalPatch) {
          setSaveStatus("unsaved");
          scheduleAutoFlush(found);
        } else {
          setSaveStatus("saved");
        }
      }

      baseSourceRef.current = found;
      const localBuilderPatch = builderSessionId
        ? localBuilderPropertiesPatch(found, dataRef.current)
        : null;
      if (localBuilderPatch) {
        pendingPatchRef.current = mergePatches(
          pendingPatchRef.current,
          localBuilderPatch,
        );
        if (!flushTimerRef.current) {
          setSaveStatus("unsaved");
          scheduleAutoFlush(found);
        }
      }
      const displaySource = builderSessionId
        ? preserveLocalBuilderProperties(found, dataRef.current)
        : found;
      const nextData = mergeOptimistic(
        displaySource,
        foundMatchesInFlight
          ? pendingPatchRef.current
          : mergePatches(inFlightPatchRef.current, pendingPatchRef.current),
      );
      const prevData = dataRef.current;
      const nextDisplayData = prevData
        ? preserveLocalContentEdgeWhitespace(prevData, nextData)
        : nextData;
      dataRef.current = nextDisplayData;
      if (!mountedRef.current || saveIdentityRef.current !== identity) {
        return;
      }
      if (!prevData || !sameSourceView(prevData, nextDisplayData)) {
        setData(nextDisplayData);
      }
      setError(null);
    } catch {
      setError("load");
    } finally {
      if (!keepLoading) {
        setIsLoading(false);
      }
    }
  }, [builderSessionId, path, scheduleAutoFlush]);

  const flush = useCallback(async (): Promise<boolean> => {
    const identity = saveIdentityRef.current;
    const writePath = activeWritePathRef.current ?? path;
    if (!writePath) {
      return true;
    }
    if (inFlightPatchRef.current) {
      setSaveStatus("unsaved");
      const inFlightSaved = (await inFlightPromiseRef.current) ?? false;
      if (!inFlightSaved) {
        return false;
      }
      if (pendingPatchRef.current) {
        return (await flushRef.current?.()) ?? true;
      }
      return true;
    }
    if (!pendingPatchRef.current) {
      return true;
    }

    const patch = pendingPatchRef.current;
    pendingPatchRef.current = null;
    inFlightPatchRef.current = patch;
    const externalOverrideVersion = externalOverrideVersionRef.current;
    setSaveStatus("saving");
    let writePromise: Promise<boolean> | null = null;
    writePromise = (async (): Promise<boolean> => {
      try {
        const updated = await updateAgentBuilderSource(writePath, patch);
        // The write is durable no matter what the guards below decide about
        // component state, so persisted-write observers hear about it even
        // when the hook has since unmounted or switched sources. The call is
        // contained so a throwing observer cannot fall through to the write's
        // catch, which would re-queue — and later re-write — a patch that
        // already persisted.
        try {
          onWritePersistedRef.current?.(updated);
        } catch (observerError) {
          perfLog(
            `[telemetry] persisted-write observer failed: ${String(observerError)}`,
          );
        }
        if (
          externalOverrideVersion !== externalOverrideVersionRef.current ||
          saveIdentityRef.current !== identity ||
          !mountedRef.current
        ) {
          return true;
        }
        inFlightPatchRef.current = null;
        baseSourceRef.current = updated;
        const prevData = dataRef.current;
        const nextData = mergeOptimistic(updated, pendingPatchRef.current);
        const nextDisplayData = prevData
          ? preserveLocalContentEdgeWhitespace(prevData, nextData)
          : nextData;
        dataRef.current = nextDisplayData;
        if (!prevData || !sameSourceView(prevData, nextDisplayData)) {
          setData(nextDisplayData);
        }
        setError(null);
        if (pendingPatchRef.current) {
          setSaveStatus("unsaved");
          scheduleAutoFlush(dataRef.current);
        } else {
          setSaveStatus("saved");
        }
        return true;
      } catch {
        if (
          externalOverrideVersion !== externalOverrideVersionRef.current ||
          saveIdentityRef.current !== identity ||
          !mountedRef.current
        ) {
          return false;
        }
        inFlightPatchRef.current = null;
        pendingPatchRef.current = mergePatches(patch, pendingPatchRef.current);
        setError("load");
        setSaveStatus("error");
        return false;
      } finally {
        if (writePromise && inFlightPromiseRef.current === writePromise) {
          inFlightPromiseRef.current = null;
        }
      }
    })();

    inFlightPromiseRef.current = writePromise;
    return writePromise;
  }, [path, scheduleAutoFlush]);

  const update = useCallback(
    (patch: PersonaSourcePatch) => {
      pendingPatchRef.current = mergePatches(pendingPatchRef.current, patch);
      setData((prev) => {
        const nextData = prev ? applyPatch(prev, patch) : prev;
        dataRef.current = nextData;
        return nextData;
      });
      setSaveStatus("unsaved");

      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
      }
      flushTimerRef.current = null;
      scheduleAutoFlush(dataRef.current);
    },
    [scheduleAutoFlush],
  );

  const saveNow = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    return flush();
  }, [flush]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  useEffect(() => {
    onResolvedPathChangeRef.current = onResolvedPathChange;
  }, [onResolvedPathChange]);

  useEffect(() => {
    onWritePersistedRef.current = onWritePersisted;
  }, [onWritePersisted]);

  useEffect(() => {
    const updatePollingState = () => {
      setIsPollingActive(shouldPollPersonaSource());
    };

    window.addEventListener("focus", updatePollingState);
    window.addEventListener("blur", updatePollingState);
    document.addEventListener("visibilitychange", updatePollingState);

    return () => {
      window.removeEventListener("focus", updatePollingState);
      window.removeEventListener("blur", updatePollingState);
      document.removeEventListener("visibilitychange", updatePollingState);
    };
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const wasPollingActive = wasPollingActiveRef.current;
    wasPollingActiveRef.current = isPollingActive;

    if (isPollingActive && !wasPollingActive) {
      void reload();
    }
  }, [isPollingActive, reload]);

  useEffect(() => {
    if (!path || !isPollingActive) {
      return;
    }

    const intervalId = setInterval(() => {
      if (shouldPollPersonaSource()) {
        void reload();
      }
    }, POLL_MS);

    return () => {
      clearInterval(intervalId);
    };
  }, [isPollingActive, path, reload]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
      }
    };
  }, []);

  return { data, isLoading, error, update, saveStatus, saveNow };
}

function shouldPollPersonaSource() {
  return document.visibilityState !== "hidden" && document.hasFocus();
}

function resolvePersonaSource(
  sources: AgentSourceEntry[],
  path: string,
  builderSessionId: string | undefined,
): AgentSourceEntry | undefined {
  const foundByPath = sources.find((source) => source.path === path);
  if (!builderSessionId) {
    return foundByPath;
  }

  const sessionMatches = sources.filter(
    (source) => source.properties?.builderSessionId === builderSessionId,
  );
  const movedNonPlaceholder = sessionMatches.find(
    (source) => source.path !== path && !isEmptyPlaceholderDraft(source),
  );

  if (foundByPath && !isEmptyPlaceholderDraft(foundByPath)) {
    return foundByPath;
  }

  return movedNonPlaceholder ?? foundByPath ?? sessionMatches[0];
}

function mergePatches(
  left: PersonaSourcePatch | null,
  right: PersonaSourcePatch | null,
): PersonaSourcePatch | null {
  if (!left) return right;
  if (!right) return left;

  return {
    ...left,
    ...right,
    properties:
      left.properties || right.properties
        ? { ...left.properties, ...right.properties }
        : undefined,
  };
}

function applyPatch(
  source: AgentSourceEntry,
  patch: PersonaSourcePatch,
): AgentSourceEntry {
  return {
    ...source,
    ...("name" in patch ? { name: patch.name ?? source.name } : {}),
    ...("description" in patch
      ? { description: patch.description ?? source.description }
      : {}),
    ...("content" in patch ? { content: patch.content ?? source.content } : {}),
    properties: patch.properties
      ? { ...source.properties, ...patch.properties }
      : source.properties,
  };
}

function mergeOptimistic(
  source: AgentSourceEntry,
  pending: PersonaSourcePatch | null,
): AgentSourceEntry {
  return pending ? applyPatch(source, pending) : source;
}

function preserveLocalBuilderProperties(
  source: AgentSourceEntry,
  current: AgentSourceEntry | null,
): AgentSourceEntry {
  const localProperties = localBuilderProperties(source, current);
  if (!localProperties) {
    return source;
  }

  return {
    ...source,
    properties: {
      ...source.properties,
      ...localProperties,
    },
  };
}

function localBuilderPropertiesPatch(
  source: AgentSourceEntry,
  current: AgentSourceEntry | null,
): PersonaSourcePatch | null {
  const properties = localBuilderProperties(source, current);
  return properties ? { properties } : null;
}

function localBuilderProperties(
  source: AgentSourceEntry,
  current: AgentSourceEntry | null,
): NonNullable<AgentSourceEntry["properties"]> | null {
  if (!current?.properties) {
    return null;
  }

  const currentProperties = current.properties;
  const localProperties = LOCAL_BUILDER_PROPERTY_KEYS.reduce<
    NonNullable<AgentSourceEntry["properties"]>
  >((properties, key) => {
    if (
      Object.hasOwn(currentProperties, key) &&
      currentProperties[key] !== source.properties?.[key]
    ) {
      properties[key] = currentProperties[key];
    }
    return properties;
  }, {});

  if (Object.keys(localProperties).length === 0) {
    return null;
  }

  return localProperties;
}

function hasExternalChange(
  previousBase: AgentSourceEntry,
  source: AgentSourceEntry,
  optimisticPatch: PersonaSourcePatch,
  foundMatchesInFlight: boolean | null,
): boolean {
  if (foundMatchesInFlight) {
    return false;
  }

  const optimistic = applyPatch(previousBase, optimisticPatch);
  return (
    (source.name !== previousBase.name ||
      source.description !== previousBase.description ||
      source.content !== previousBase.content ||
      !sameProperties(source.properties, previousBase.properties)) &&
    !sameSourceView(source, optimistic)
  );
}

function stripExternallyChangedFields(
  patch: PersonaSourcePatch | null,
  previousBase: AgentSourceEntry,
  source: AgentSourceEntry,
): PersonaSourcePatch | null {
  if (!patch) {
    return null;
  }

  const nextPatch = { ...patch };
  if (source.name !== previousBase.name) {
    delete nextPatch.name;
  }
  if (source.description !== previousBase.description) {
    delete nextPatch.description;
  }
  if (source.content !== previousBase.content) {
    delete nextPatch.content;
  }
  if (nextPatch.properties) {
    const nextProperties = { ...nextPatch.properties };
    const previousProperties = previousBase.properties ?? {};
    const sourceProperties = source.properties ?? {};

    for (const key of Object.keys(nextProperties)) {
      if (isLocalBuilderPropertyKey(key)) {
        continue;
      }
      if (
        sourceProperties[key as keyof typeof sourceProperties] !==
        previousProperties[key as keyof typeof previousProperties]
      ) {
        delete nextProperties[key as keyof typeof nextProperties];
      }
    }

    nextPatch.properties =
      Object.keys(nextProperties).length > 0 ? nextProperties : undefined;
  }

  return hasPatchEntries(nextPatch) ? nextPatch : null;
}

function isLocalBuilderPropertyKey(
  key: string,
): key is (typeof LOCAL_BUILDER_PROPERTY_KEYS)[number] {
  return LOCAL_BUILDER_PROPERTY_KEYS.includes(
    key as (typeof LOCAL_BUILDER_PROPERTY_KEYS)[number],
  );
}

function hasPatchEntries(patch: PersonaSourcePatch): boolean {
  return (
    "name" in patch ||
    "description" in patch ||
    "content" in patch ||
    Boolean(patch.properties && Object.keys(patch.properties).length > 0)
  );
}

function sameSourceView(
  left: AgentSourceEntry,
  right: AgentSourceEntry,
): boolean {
  return (
    left.name === right.name &&
    left.description === right.description &&
    left.content === right.content &&
    sameProperties(left.properties, right.properties)
  );
}

function preserveLocalContentEdgeWhitespace(
  previous: AgentSourceEntry,
  next: AgentSourceEntry,
): AgentSourceEntry {
  if (
    previous.name !== next.name ||
    previous.description !== next.description ||
    !sameProperties(previous.properties, next.properties) ||
    previous.content === next.content ||
    previous.content.trim() !== next.content.trim()
  ) {
    return next;
  }

  return { ...next, content: previous.content };
}

function sameProperties(
  left: AgentSourceEntry["properties"],
  right: AgentSourceEntry["properties"],
): boolean {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}
