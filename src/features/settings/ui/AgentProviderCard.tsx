import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import {
  IconCheck,
  IconAlertTriangle,
  IconMessageCircle,
  IconPlus,
} from "@tabler/icons-react";
import {
  checkAgentAuth,
  installAgent,
  authenticateAgent,
  onAgentSetupOutput,
} from "@/features/providers/api/agentSetup";
import { getProviderInventory } from "@/features/providers/api/inventory";
import { useProviderInventoryStore } from "@/features/providers/stores/providerInventoryStore";
import { ProviderSetupOutput } from "./ProviderSetupOutput";
import {
  analyzeAgentSetupFailure,
  buildAgentSetupTroubleshootingRequest,
  type AgentSetupFailureAnalysis,
  type AgentSetupTroubleshootingRequest,
} from "@/features/providers/lib/agentSetupTroubleshooting";
import {
  getAgentSetupFailureSimulation,
  getSimulatedAgentSetupFailureLines,
} from "@/features/providers/lib/agentSetupFailureSimulation";
import type {
  ProviderDisplayInfo,
  ProviderSetupStatus,
} from "@/shared/types/providers";

type SetupPhase = "idle" | "checking" | "installing" | "authenticating";
type InstallStatus = "installed" | "missing";
type AuthStatus = "checking" | "authenticated" | "unauthenticated" | "unknown";

interface OutputLine {
  id: number;
  text: string;
}

const MAX_OUTPUT_LINES = 50;

interface AgentProviderCardProps {
  provider: ProviderDisplayInfo;
  onStartTroubleshootingChat?: (
    request: AgentSetupTroubleshootingRequest,
  ) => void;
}

function deriveInstalled(status: ProviderSetupStatus): boolean {
  return status === "built_in" || status === "connected";
}

export function AgentProviderCard({
  provider,
  onStartTroubleshootingChat,
}: AgentProviderCardProps) {
  const { t } = useTranslation(["settings", "common"]);
  const isBuiltIn = provider.status === "built_in";
  const supportsInstall = provider.supportsInstall === true;
  const supportsAuth = provider.supportsAuth === true;
  const supportsAuthStatus = provider.supportsAuthStatus === true;
  const hasBinary = !!provider.binaryName;
  const setupFailureSimulation = getAgentSetupFailureSimulation(provider.id);
  const forceMissingForSimulation = Boolean(setupFailureSimulation);
  const inventoryInstalled =
    !forceMissingForSimulation && deriveInstalled(provider.status);
  const [setupPhase, setSetupPhase] = useState<SetupPhase>("idle");
  const [setupOutput, setSetupOutput] = useState<OutputLine[]>([]);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupFailureAnalysis, setSetupFailureAnalysis] =
    useState<AgentSetupFailureAnalysis | null>(null);
  const [installStatus, setInstallStatus] = useState<InstallStatus>(
    inventoryInstalled ? "installed" : "missing",
  );
  const [authStatus, setAuthStatus] = useState<AuthStatus>(
    supportsAuthStatus && inventoryInstalled && !isBuiltIn
      ? "checking"
      : "unknown",
  );
  const outputRef = useRef<HTMLDivElement>(null);
  const outputLengthRef = useRef(0);
  const setupOutputLinesRef = useRef<OutputLine[]>([]);
  const lineCounterRef = useRef(0);
  const isMountedRef = useRef(true);
  const unlistenRef = useRef<(() => void) | null>(null);

  const icon = getProviderIcon(provider.id, "size-6");
  const isActive = setupPhase !== "idle";
  const authStorageKey = `agent-provider-auth:${provider.id}`;
  const mergeInventoryEntries = useProviderInventoryStore(
    (state) => state.mergeEntries,
  );

  const setAuthHint = useCallback(
    (value: boolean) => {
      if (value) {
        localStorage.setItem(authStorageKey, "true");
      } else {
        localStorage.removeItem(authStorageKey);
      }
    },
    [authStorageKey],
  );

  const getAuthHint = useCallback(() => {
    return localStorage.getItem(authStorageKey) === "true";
  }, [authStorageKey]);

  const clearListener = useCallback(() => {
    unlistenRef.current?.();
    unlistenRef.current = null;
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      clearListener();
    };
  }, [clearListener]);

  useEffect(() => {
    const installed =
      !forceMissingForSimulation && deriveInstalled(provider.status);
    const nextInstallStatus = installed ? "installed" : "missing";
    setInstallStatus((current) =>
      current === nextInstallStatus ? current : nextInstallStatus,
    );

    if (!installed) {
      setAuthStatus("unknown");
      setAuthHint(false);
      return;
    }

    if (isBuiltIn) {
      setAuthStatus("unknown");
      return;
    }

    if (supportsAuthStatus) {
      setAuthStatus("checking");
      checkAgentAuth(provider.id)
        .then((authenticated) => {
          if (!isMountedRef.current) return;
          setAuthStatus(authenticated ? "authenticated" : "unauthenticated");
        })
        .catch(() => {
          if (!isMountedRef.current) return;
          setAuthStatus("unauthenticated");
        });
      return;
    }

    setAuthStatus(getAuthHint() ? "authenticated" : "unknown");
  }, [
    getAuthHint,
    isBuiltIn,
    provider.id,
    provider.status,
    supportsAuthStatus,
    setAuthHint,
    forceMissingForSimulation,
  ]);

  const refreshInstallStatusFromInventory =
    useCallback(async (): Promise<boolean> => {
      const entries = await getProviderInventory([provider.id], {
        includeRawSupportedModels: false,
      });
      if (!isMountedRef.current) return false;
      mergeInventoryEntries(entries);
      const inventoryEntry = entries.find(
        (entry) => entry.providerId === provider.id,
      );
      const installed =
        !forceMissingForSimulation &&
        (isBuiltIn ||
          (inventoryEntry?.category === "agent" && inventoryEntry.configured));
      setInstallStatus(installed ? "installed" : "missing");
      if (!installed) {
        setAuthStatus("unknown");
        setAuthHint(false);
      }
      return installed;
    }, [
      forceMissingForSimulation,
      isBuiltIn,
      mergeInventoryEntries,
      provider.id,
      setAuthHint,
    ]);

  useEffect(() => {
    if (outputRef.current && outputLengthRef.current !== setupOutput.length) {
      outputLengthRef.current = setupOutput.length;
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  });

  const appendOutput = useCallback((line: string) => {
    lineCounterRef.current += 1;
    const entry: OutputLine = { id: lineCounterRef.current, text: line };
    const next = [...setupOutputLinesRef.current, entry];
    const trimmed =
      next.length > MAX_OUTPUT_LINES ? next.slice(-MAX_OUTPUT_LINES) : next;
    setupOutputLinesRef.current = trimmed;
    setSetupOutput(trimmed);
  }, []);

  async function handleConnect() {
    setSetupError(null);
    setSetupFailureAnalysis(null);
    setSetupOutput([]);
    setupOutputLinesRef.current = [];
    lineCounterRef.current = 0;

    if (supportsInstall && installStatus === "missing") {
      await runInstall();
    } else if (supportsAuth) {
      await runAuth();
    }
  }

  async function runInstall() {
    if (!supportsInstall) return;
    setSetupPhase("installing");

    clearListener();
    const unlisten = await onAgentSetupOutput(provider.id, appendOutput);
    if (!isMountedRef.current) {
      unlisten();
      return;
    }
    unlistenRef.current = unlisten;

    try {
      if (setupFailureSimulation) {
        for (const line of getSimulatedAgentSetupFailureLines(
          provider,
          setupFailureSimulation,
        )) {
          appendOutput(line);
        }
        throw new Error("Command exited with code 1");
      }

      await installAgent(provider.id);
      clearListener();
      if (!isMountedRef.current) return;

      if (hasBinary && provider.binaryName) {
        setSetupPhase("checking");
        const installed = await refreshInstallStatusFromInventory();
        if (!isMountedRef.current) return;
        if (!installed) {
          setAuthStatus("unknown");
          setAuthHint(false);
          const message = t(
            "providers.agents.errors.installVerificationFailed",
          );
          setSetupError(message);
          setSetupFailureAnalysis(
            analyzeAgentSetupFailure(message, setupOutputLinesRef.current),
          );
          setSetupPhase("idle");
          return;
        }
      }

      if (supportsAuth) {
        await runAuth();
      } else {
        if (!isMountedRef.current) return;
        setSetupPhase("idle");
      }
    } catch (err) {
      clearListener();
      if (!isMountedRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setSetupError(message);
      setSetupFailureAnalysis(
        analyzeAgentSetupFailure(message, setupOutputLinesRef.current),
      );
      setSetupPhase("idle");
    }
  }

  async function runAuth() {
    if (!supportsAuth) return;
    setSetupPhase("authenticating");
    setSetupOutput([]);
    setupOutputLinesRef.current = [];

    clearListener();
    const unlisten = await onAgentSetupOutput(provider.id, appendOutput);
    if (!isMountedRef.current) {
      unlisten();
      return;
    }
    unlistenRef.current = unlisten;

    try {
      await authenticateAgent(provider.id);
      clearListener();
      if (!isMountedRef.current) return;
      const installed = await refreshInstallStatusFromInventory();
      if (!isMountedRef.current) return;
      if (!installed) {
        const message = t("providers.agents.errors.installVerificationFailed");
        setSetupError(message);
        setSetupFailureAnalysis(
          analyzeAgentSetupFailure(message, setupOutputLinesRef.current),
        );
        setSetupPhase("idle");
        return;
      }
      setAuthHint(true);
      setAuthStatus("authenticated");
      setSetupPhase("idle");
    } catch (err) {
      clearListener();
      if (!isMountedRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setSetupError(message);
      setSetupFailureAnalysis(
        analyzeAgentSetupFailure(message, setupOutputLinesRef.current),
      );
      setSetupPhase("idle");
    }
  }

  function handleRetry() {
    setSetupError(null);
    setSetupFailureAnalysis(null);
    void handleConnect();
  }

  function getSetupFailureMessage() {
    if (!setupError) return null;

    if (!setupFailureAnalysis) {
      return setupError;
    }

    return t("providers.agents.errors.genericSetupFailure");
  }

  function handleTroubleshoot() {
    if (!setupError || !setupFailureAnalysis || !onStartTroubleshootingChat) {
      return;
    }

    const userMessage = getSetupFailureMessage() ?? setupError;
    onStartTroubleshootingChat(
      buildAgentSetupTroubleshootingRequest({
        provider,
        analysis: setupFailureAnalysis,
        userMessage,
        commandError: setupError,
      }),
    );
  }

  const isReady =
    isBuiltIn ||
    (installStatus === "installed" && !supportsAuth) ||
    (installStatus === "installed" && authStatus === "authenticated");
  const needsAuth =
    installStatus === "installed" &&
    supportsAuth &&
    authStatus !== "checking" &&
    authStatus !== "authenticated";
  const needsInstall = installStatus === "missing" && supportsInstall;
  const isChecking = installStatus === "installed" && authStatus === "checking";

  if (provider.showOnlyWhenInstalled && installStatus !== "installed")
    return null;

  function renderStatusIndicator() {
    if (isBuiltIn || isReady) {
      return (
        <div className="flex h-6 flex-shrink-0 items-center">
          <IconCheck className="size-4 text-success duration-200 motion-safe:animate-in motion-safe:fade-in" />
        </div>
      );
    }

    if (setupError) {
      return (
        <div className="flex h-6 flex-shrink-0 items-center">
          <IconAlertTriangle className="size-4 text-destructive" />
        </div>
      );
    }

    if (isChecking || isActive) {
      return (
        <div
          role="status"
          aria-label={
            isChecking
              ? t("providers.agents.status.checking")
              : t("providers.agents.status.inProgress")
          }
          className="flex h-6 flex-shrink-0 items-center"
        >
          <Spinner
            role="presentation"
            aria-hidden="true"
            className="size-4 text-foreground"
          />
        </div>
      );
    }

    if (needsAuth && !isActive) {
      return (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => void handleConnect()}
          className="flex-shrink-0 text-muted-foreground"
          aria-label={t("providers.agents.signInLabel", {
            name: provider.displayName,
          })}
        >
          {t("providers.agents.signIn")}
        </Button>
      );
    }

    if (needsInstall && !isActive) {
      return (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => void handleConnect()}
          className="flex-shrink-0 text-muted-foreground"
          aria-label={t("providers.agents.installLabel", {
            name: provider.displayName,
          })}
        >
          <IconPlus className="size-4" />
        </Button>
      );
    }

    return null;
  }

  function renderSetupOutput(scrollToEnd = false) {
    if (setupOutput.length === 0) return null;

    return (
      <ProviderSetupOutput
        lines={setupOutput}
        scrollRef={scrollToEnd ? outputRef : undefined}
      />
    );
  }

  function renderSetupProgress() {
    if (!isActive) return null;

    const phaseLabel =
      setupPhase === "installing"
        ? t("providers.agents.progress.installing", {
            name: provider.displayName,
          })
        : setupPhase === "authenticating"
          ? t("providers.waitingForSignIn")
          : t("providers.agents.progress.verifyingInstallation");

    const stepInfo =
      setupPhase === "installing" && supportsAuth
        ? t("providers.agents.progress.step", { step: 1, total: 2 })
        : setupPhase === "authenticating" && supportsInstall
          ? t("providers.agents.progress.step", { step: 2, total: 2 })
          : null;

    return (
      <div className="mt-3 space-y-2 border-t pt-3">
        <div className="flex items-center gap-2">
          <Spinner className="size-3.5 text-primary" />
          <div className="min-w-0 flex-1">
            <span className="text-xs font-medium">{phaseLabel}</span>
            {stepInfo && (
              <span className="ml-2 text-xxs text-muted-foreground">
                {stepInfo}
              </span>
            )}
          </div>
        </div>

        {renderSetupOutput(true)}
      </div>
    );
  }

  const setupFailureMessage = getSetupFailureMessage();

  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border bg-background p-3 transition-colors",
        isActive &&
          "border-primary/50 bg-linear-to-b from-primary/10 to-primary/10",
      )}
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          {icon ? (
            <div className="flex size-6 items-center justify-center [&>*]:size-6">
              {icon}
            </div>
          ) : null}
          <span className={cn("block text-sm", icon && "mt-2")}>
            {provider.displayName}
          </span>
          <p className="mt-1 text-xs text-muted-foreground">
            {provider.description}
          </p>
        </div>
        {renderStatusIndicator()}
      </div>

      {renderSetupProgress()}

      {setupError && !isActive && (
        <div className="mt-3 space-y-2 border-t pt-3">
          <div className="rounded-md bg-destructive/10 px-3 py-2.5">
            <div className="flex flex-col gap-2">
              <p className="min-w-0 text-xs font-medium leading-relaxed text-destructive">
                {setupFailureMessage}
              </p>
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost-light"
                  size="xs"
                  onClick={handleRetry}
                >
                  {t("common:actions.retry")}
                </Button>
                {setupFailureAnalysis && onStartTroubleshootingChat ? (
                  <Button
                    type="button"
                    variant="default"
                    size="xs"
                    leftIcon={<IconMessageCircle aria-hidden="true" />}
                    onClick={handleTroubleshoot}
                    className="w-fit"
                  >
                    {t("providers.agents.troubleshootInChat")}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
          {renderSetupOutput()}
        </div>
      )}
    </div>
  );
}
