import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { listenBerdctlRequests } from "@/features/berdctl/bridge/berdctlPlugin";
import {
  handleBerdctlRequest,
  setBerdctlDesired,
} from "@/features/berdctl/bridge/lifecycle";
import {
  clearBerdctlQueryClient,
  registerBerdctlQueryClient,
} from "@/features/berdctl/bridge/runtimeContext";
import { BERDCTL_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import { installStartupSessionDeepLinkHandler } from "./startupDeepLinks";
import { useBerdctlQueuedMessageDrain } from "./useBerdctlQueuedMessageDrain";

/**
 * Null-rendering bridge between the berdctl broker (Rust plugin) and the
 * renderer command registry. Mounted once in the main window (main.tsx); the
 * session-window branch must never render it. All real state lives in the
 * module-scoped lifecycle singleton (see bridge/lifecycle.ts), which keeps
 * the broker StrictMode double-mount safe.
 */
export function BerdctlBridge() {
  const experiment = useExperiment(BERDCTL_EXPERIMENT_ID);
  const enabled = experiment?.enabled ?? false;
  const queryClient = useQueryClient();

  useBerdctlQueuedMessageDrain();

  // Share the app's react-query cache with the command layer (doctor report).
  useEffect(() => {
    registerBerdctlQueryClient(queryClient);
    return () => {
      clearBerdctlQueryClient(queryClient);
    };
  }, [queryClient]);

  // Request listener: the only consumer of "berdctl:request". Mounted
  // unconditionally — it is inert while the broker is stopped, and keeping it
  // up avoids a race between enable and the first forwarded command.
  useEffect(() => {
    const unlisten = listenBerdctlRequests((request) => {
      void handleBerdctlRequest(request);
    });
    return () => {
      void unlisten.then((cleanup) => cleanup());
    };
  }, []);

  useEffect(() => installStartupSessionDeepLinkHandler(), []);

  // Broker lifecycle: declare desired state; the lifecycle reconciler
  // serializes start/stop and goes inert if the plugin is not in this build.
  // useExperiment already subscribes to same-window and cross-window changes.
  useEffect(() => {
    setBerdctlDesired(enabled);
    return () => {
      setBerdctlDesired(false);
    };
  }, [enabled]);

  return null;
}
