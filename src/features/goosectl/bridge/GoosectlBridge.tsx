import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { listenGoosectlRequests } from "@/features/goosectl/bridge/goosectlPlugin";
import {
  handleGoosectlRequest,
  setGoosectlDesired,
} from "@/features/goosectl/bridge/lifecycle";
import {
  clearGoosectlQueryClient,
  registerGoosectlQueryClient,
} from "@/features/goosectl/bridge/runtimeContext";
import { GOOSECTL_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import { useGoosectlQueuedMessageDrain } from "./useGoosectlQueuedMessageDrain";

/**
 * Null-rendering bridge between the goosectl broker (Rust plugin) and the
 * renderer command registry. Mounted once in the main window (main.tsx); the
 * session-window branch must never render it. All real state lives in the
 * module-scoped lifecycle singleton (see bridge/lifecycle.ts), which keeps
 * the broker StrictMode double-mount safe.
 */
export function GoosectlBridge() {
  const experiment = useExperiment(GOOSECTL_EXPERIMENT_ID);
  const enabled = experiment?.enabled ?? false;
  const queryClient = useQueryClient();

  useGoosectlQueuedMessageDrain();

  // Share the app's react-query cache with the command layer (doctor report).
  useEffect(() => {
    registerGoosectlQueryClient(queryClient);
    return () => {
      clearGoosectlQueryClient(queryClient);
    };
  }, [queryClient]);

  // Request listener: the only consumer of "goosectl:request". Mounted
  // unconditionally — it is inert while the broker is stopped, and keeping it
  // up avoids a race between enable and the first forwarded command.
  useEffect(() => {
    const unlisten = listenGoosectlRequests((request) => {
      void handleGoosectlRequest(request);
    });
    return () => {
      void unlisten.then((cleanup) => cleanup());
    };
  }, []);

  // Broker lifecycle: declare desired state; the lifecycle reconciler
  // serializes start/stop and goes inert if the plugin is not in this build.
  // useExperiment already subscribes to same-window and cross-window changes.
  useEffect(() => {
    setGoosectlDesired(enabled);
    return () => {
      setGoosectlDesired(false);
    };
  }, [enabled]);

  return null;
}
