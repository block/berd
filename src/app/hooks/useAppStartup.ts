import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { perfLog } from "@/shared/lib/perfLog";
import { runChatRuntimeStartup } from "../lib/chatRuntimeStartup";
import type { KgooseProbeReport } from "../lib/startupDiagnostics";

export { filterStartupProvidersForDistro } from "../lib/chatRuntimeStartup";

const STARTUP_PROBE_TIMEOUT_MS = 5_000;

async function runStartupConnectivityProbe(): Promise<KgooseProbeReport | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const probePromise = invoke<KgooseProbeReport>("probe_kgoose_connectivity");
    const timeout = new Promise<KgooseProbeReport>((resolve) => {
      timeoutId = setTimeout(() => {
        // A hung probe is itself evidence the network path is broken;
        // surface that as a likely WARP failure so the UI can suggest the
        // right next step instead of waiting forever.
        resolve({
          likelyWarpFailure: true,
          status: null,
          kind: "request",
          message: "kgoose probe timed out",
        });
      }, STARTUP_PROBE_TIMEOUT_MS);
    });
    return await Promise.race([probePromise, timeout]);
  } catch (probeError) {
    console.error("Failed to probe kgoose connectivity:", probeError);
    return null;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

export function useAppStartup() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [probe, setProbe] = useState<KgooseProbeReport | null>(null);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is bumped by `retry()` to force a re-run
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const tStartup = performance.now();
      perfLog("[perf:startup] useAppStartup begin");
      setReady(false);
      setError(null);
      setProbe(null);

      await runChatRuntimeStartup();
      perfLog(
        `[perf:startup] useAppStartup complete in ${(performance.now() - tStartup).toFixed(1)}ms`,
      );
    })()
      .catch(async (err) => {
        console.error("Failed to complete app startup:", err);
        const probeResult = await runStartupConnectivityProbe();
        if (!cancelled) {
          setProbe(probeResult);
          setError(err);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  return { ready, error, probe, retry };
}
