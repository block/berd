import { useCallback, useEffect, useRef, useState } from "react";
import { getClient } from "@/shared/api/acpConnection";
import {
  CONTEXT_LIMIT_CONFIG_KEY,
  DEFAULT_CONTEXT_LIMIT,
  parseContextLimit,
} from "@/features/chat/lib/contextLimit";

const CONTEXT_LIMIT_EVENT = "goose:context-limit-preferences";

export function useGooseContextLimit() {
  const [contextLimit, setContextLimit] = useState(DEFAULT_CONTEXT_LIMIT);
  const [isHydrated, setIsHydrated] = useState(false);
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
        retryDelay = 1000;
      } catch {
        if (cancelled || readRevision !== revision.current) return;
        retryTimer = window.setTimeout(() => void sync(), retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
    };

    const handler = () => void sync();
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
    // Read back the effective value: an environment override may still win.
    const { value: effectiveValue } =
      await client.goose.GooseUnstableConfigRead({
        key: CONTEXT_LIMIT_CONFIG_KEY,
        isSecret: false,
      });
    const effectiveLimit = parseContextLimit(effectiveValue) ?? parsed;
    setContextLimit(effectiveLimit);
    setIsHydrated(true);
    window.dispatchEvent(new Event(CONTEXT_LIMIT_EVENT));
    return effectiveLimit;
  }, []);

  return { contextLimit, isHydrated, saveContextLimit };
}
