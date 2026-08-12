import { useCallback, useEffect, useState } from "react";

import { getAuthStatus, type AuthStatus } from "../api/auth";

export type AuthGateStatus = "loading" | "loggedOut" | "loggedIn";

export interface AuthGate {
  status: AuthGateStatus;
  authStatus?: AuthStatus;
  error?: Error;
  retry: () => void;
  completeLogin: (status: AuthStatus) => void;
}

export function useAuthGate(enabled = true): AuthGate {
  const [status, setStatus] = useState<AuthGateStatus>(
    enabled ? "loading" : "loggedIn",
  );
  const [authStatus, setAuthStatus] = useState<AuthStatus | undefined>();
  const [error, setError] = useState<Error | undefined>();
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is bumped by `retry()` to force a re-read
  useEffect(() => {
    if (!enabled) {
      setStatus("loggedIn");
      setError(undefined);
      setAuthStatus(undefined);
      return;
    }

    let cancelled = false;

    async function execute() {
      try {
        setStatus("loading");
        setError(undefined);

        const nextStatus = await getAuthStatus();
        if (cancelled) return;

        setAuthStatus(nextStatus);
        setStatus(nextStatus.loggedIn ? "loggedIn" : "loggedOut");
      } catch (err) {
        if (cancelled) return;

        console.error("Failed to read auth status:", err);
        setError(err instanceof Error ? err : new Error(String(err)));
        setAuthStatus(undefined);
        setStatus("loggedOut");
      }
    }

    void execute();

    return () => {
      cancelled = true;
    };
  }, [attempt, enabled]);

  const retry = useCallback(() => {
    if (!enabled) return;
    setAttempt((value) => value + 1);
  }, [enabled]);

  const completeLogin = useCallback(
    (nextStatus: AuthStatus) => {
      setError(undefined);
      if (!enabled) {
        setAuthStatus(undefined);
        setStatus("loggedIn");
        return;
      }

      setAuthStatus(nextStatus);
      setStatus(nextStatus.loggedIn ? "loggedIn" : "loggedOut");
    },
    [enabled],
  );

  return { status, authStatus, error, retry, completeLogin };
}
