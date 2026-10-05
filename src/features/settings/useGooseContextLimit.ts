import { useCallback, useEffect, useRef, useState } from "react";
import { getClient } from "@/shared/api/acpConnection";
import {
  CONTEXT_LIMIT_CONFIG_KEY,
  DEFAULT_CONTEXT_LIMIT,
  parseContextLimit,
} from "@/features/chat/lib/contextLimit";

const CONTEXT_LIMIT_EVENT = "goose:context-limit-preferences";
type ContextLimitUpdate = { value: number; needsReadback: boolean };

export function useGooseContextLimit() {
  const [contextLimit, setContextLimit] = useState(DEFAULT_CONTEXT_LIMIT);
  const [isHydrated, setIsHydrated] = useState(false);
  const [isReadbackPending, setIsReadbackPending] = useState(false);
  const revision = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;
    let retryDelay = 1000;

    const sync = async () => {
      window.clearTimeout(retryTimer);
      const readRevision = ++revision.current;
      try {
        const client = await getClient();
        const { value } = await client.goose.GooseUnstableConfigRead({
          key: CONTEXT_LIMIT_CONFIG_KEY,
          isSecret: false,
        });
        if (cancelled || readRevision !== revision.current) return;
        // Missing config is a fallback, not a reason to overwrite user config.
        setContextLimit(parseContextLimit(value) ?? DEFAULT_CONTEXT_LIMIT);
        setIsHydrated(true);
        setIsReadbackPending(false);
        retryDelay = 1000;
      } catch {
        if (cancelled || readRevision !== revision.current) return;
        retryTimer = window.setTimeout(() => void sync(), retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
    };

    const handler = (event: Event) => {
      const update = (event as CustomEvent<ContextLimitUpdate>).detail;
      if (!update || parseContextLimit(update.value) === null) {
        void sync();
        return;
      }
      // A successful write must stay represented even if ACP readback fails.
      // Broadcast it to every control, invalidating any older in-flight reads.
      window.clearTimeout(retryTimer);
      revision.current += 1;
      setContextLimit(update.value);
      setIsHydrated(true);
      setIsReadbackPending(update.needsReadback);
      retryDelay = 1000;
      if (update.needsReadback) {
        retryTimer = window.setTimeout(() => void sync(), retryDelay);
      }
    };
    window.addEventListener(CONTEXT_LIMIT_EVENT, handler);
    void sync();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      window.removeEventListener(CONTEXT_LIMIT_EVENT, handler);
    };
  }, []);

  const saveContextLimit = useCallback(async (value: number) => {
    const parsed = parseContextLimit(value);
    if (parsed === null) throw new Error("Invalid context limit");
    const client = await getClient();
    await client.goose.GooseUnstableConfigUpsert({
      key: CONTEXT_LIMIT_CONFIG_KEY,
      value: parsed,
      isSecret: false,
    });
    revision.current += 1;
    let effectiveLimit = parsed;
    let needsReadback = false;
    try {
      // An environment override may still win. Readback is reconciliation,
      // not persistence: its failure must not turn a saved change into a rollback.
      const { value: effectiveValue } =
        await client.goose.GooseUnstableConfigRead({
          key: CONTEXT_LIMIT_CONFIG_KEY,
          isSecret: false,
        });
      effectiveLimit = parseContextLimit(effectiveValue) ?? parsed;
    } catch {
      needsReadback = true;
    }
    window.dispatchEvent(
      new CustomEvent<ContextLimitUpdate>(CONTEXT_LIMIT_EVENT, {
        detail: { value: effectiveLimit, needsReadback },
      }),
    );
    return effectiveLimit;
  }, []);

  return { contextLimit, isHydrated, isReadbackPending, saveContextLimit };
}
