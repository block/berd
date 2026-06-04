import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
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
import { ArrowUpCircle } from "lucide-react";
import {
  checkAgentInstalled,
  installAgent,
  authenticateAgent,
  onAgentSetupOutput,
  updateAgent,
} from "@/features/providers/api/agentSetup";
import {
  describeAgentVersion,
  type AgentBinaryReadout,
} from "../lib/agentVersionDisplay";
import { rerunDoctorReport } from "@/shared/api/useDoctorReport";
import type { AgentProviderReadiness } from "@/features/providers/hooks/useAgentProviderStatus";
import type { DoctorCheck } from "@/shared/api/doctor";
import { ProviderSetupOutput } from "./ProviderSetupOutput";
import { AgentVersionInfo } from "./AgentVersionInfo";
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
import type { ProviderDisplayInfo } from "@/shared/types/providers";

type SetupPhase = "idle" | "checking" | "installing" | "authenticating";

interface OutputLine {
  id: number;
  text: string;
}

const MAX_OUTPUT_LINES = 50;

interface AgentProviderCardProps {
  provider: ProviderDisplayInfo;
  // Per-agent readiness derived from the shared doctor report. `undefined`
  // until that provider's check lands in the report.
  readiness?: AgentProviderReadiness;
  // The provider's raw doctor check, used to surface install source / version
  // / update-available. `undefined` until the report (and freshness) land.
  versionCheck?: DoctorCheck;
  // True only during the shared report's cold first fetch, so a warm-cache
  // revisit paints instantly instead of re-spinning.
  statusLoading?: boolean;
  onStartTroubleshootingChat?: (
    request: AgentSetupTroubleshootingRequest,
  ) => void;
  onProviderReady?: (providerId: string) => void;
}

export function AgentProviderCard({
  provider,
  readiness,
  versionCheck,
  statusLoading = false,
  onStartTroubleshootingChat,
  onProviderReady,
}: AgentProviderCardProps) {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const isBuiltIn = provider.status === "built_in";
  const supportsInstall = provider.supportsInstall === true;
  const supportsAuth = provider.supportsAuth === true;
  const hasBinary = !!provider.binaryName;
  const setupFailureSimulation = getAgentSetupFailureSimulation(provider.id);
  const forceMissingForSimulation = Boolean(setupFailureSimulation);
  const [setupPhase, setSetupPhase] = useState<SetupPhase>("idle");
  const [setupOutput, setSetupOutput] = useState<OutputLine[]>([]);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupFailureAnalysis, setSetupFailureAnalysis] =
    useState<AgentSetupFailureAnalysis | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const outputLengthRef = useRef(0);
  const setupOutputLinesRef = useRef<OutputLine[]>([]);
  const lineCounterRef = useRef(0);
  const isMountedRef = useRef(true);
  const unlistenRef = useRef<(() => void) | null>(null);

  const icon = getProviderIcon(provider.id, "size-6");
  const isActive = setupPhase !== "idle";

  // Resolve display state from the shared report, with local-only overrides
  // (dev failure simulation, built-in/no-binary agents that are always
  // present). The spinner is gated on the report's cold first fetch only.
  const isChecking =
    !isBuiltIn && !forceMissingForSimulation && hasBinary && statusLoading;
  const resolvedReadiness: AgentProviderReadiness = forceMissingForSimulation
    ? "not_installed"
    : isBuiltIn || !hasBinary
      ? "ready"
      : (readiness ?? "not_installed");
  const isInstalled =
    resolvedReadiness === "ready" || resolvedReadiness === "not_ready";

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

  // Targeted post-install/auth verification (single user-initiated probe, not a
  // mount-time storm). The shared report is the source of truth for display;
  // this only confirms the CLI landed on PATH so we can surface a clear error.
  const refreshInstallStatus = useCallback(async (): Promise<boolean> => {
    if (forceMissingForSimulation) return false;
    if (isBuiltIn || !hasBinary) return true;
    try {
      return await checkAgentInstalled(provider.id);
    } catch {
      return false;
    }
  }, [forceMissingForSimulation, hasBinary, isBuiltIn, provider.id]);

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

    if (supportsInstall && resolvedReadiness === "not_installed") {
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

      // The binary may now be present; refresh every surface from one report.
      // Use `rerunDoctorReport` (not bare `invalidateDoctorReport`) so the
      // freshness pass re-runs and version/install-source/update badges
      // repopulate — invalidation alone refetches through the fast,
      // freshness-off `runDoctor` queryFn and blanks them out.
      void rerunDoctorReport(queryClient);

      if (hasBinary && provider.binaryName) {
        setSetupPhase("checking");
        const installed = await refreshInstallStatus();
        if (!isMountedRef.current) return;
        if (!installed) {
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
        onProviderReady?.(provider.id);
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
      const installed = await refreshInstallStatus();
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
      // Auth state changed: refresh all surfaces, and keep the progress UI up
      // until the report reflects the new state so the card doesn't flash back
      // to "sign in" before the refetch settles. `rerunDoctorReport` also
      // re-kicks the freshness pass so version badges don't blank out.
      await rerunDoctorReport(queryClient);
      if (!isMountedRef.current) return;
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

  // Run every actionable readout's source-aware update command in sequence.
  // The doctor crate derives each command from `(install_source, package_id)`
  // (e.g. `npm install -g <pkg>@latest`, `brew upgrade <pkg>`), so a Claude
  // Code card with `claude` (native) + `claude-agent-acp` (npm) updates each
  // binary with the correct recipe under one click. Never chains into auth —
  // the agent is already set up; we're only refreshing binaries.
  async function runUpdates(readouts: AgentBinaryReadout[]) {
    if (readouts.length === 0) return;
    setSetupError(null);
    setSetupFailureAnalysis(null);
    setSetupOutput([]);
    setupOutputLinesRef.current = [];
    lineCounterRef.current = 0;
    setSetupPhase("installing");

    clearListener();
    const unlisten = await onAgentSetupOutput(provider.id, appendOutput);
    if (!isMountedRef.current) {
      unlisten();
      return;
    }
    unlistenRef.current = unlisten;

    try {
      for (const readout of readouts) {
        if (!readout.updateFixType || !readout.updateCommand) continue;
        await updateAgent(
          provider.id,
          readout.updateFixType,
          readout.updateCommand,
        );
        if (!isMountedRef.current) return;
      }
      clearListener();
      if (!isMountedRef.current) return;
      // Re-run the freshness pass so the updated versions repopulate the
      // readout instead of collapsing to a bare "Installed via <source>".
      await rerunDoctorReport(queryClient);
      if (!isMountedRef.current) return;
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

  const isReady = isBuiltIn || resolvedReadiness === "ready";
  const needsAuth = resolvedReadiness === "not_ready" && supportsAuth;
  const needsInstall = resolvedReadiness === "not_installed" && supportsInstall;

  if (provider.showOnlyWhenInstalled && !isInstalled) return null;

  function renderStatusIndicator() {
    if (setupError) {
      return (
        <div className="flex h-6 flex-shrink-0 items-center">
          <IconAlertTriangle className="size-4 text-destructive" />
        </div>
      );
    }

    // Spin until the shared report *and* its freshness sibling have both
    // settled, so the fast `runDoctor` pass doesn't paint a tick (or a
    // sign-in button) before freshness reveals an "Update available"
    // affordance. Built-ins / no-binary agents bypass this — `isChecking` is
    // gated on `!isBuiltIn && hasBinary`, so they tick immediately.
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

    if (isBuiltIn || isReady) {
      return (
        <div className="flex h-6 flex-shrink-0 items-center">
          <IconCheck className="size-4 text-success duration-200 motion-safe:animate-in motion-safe:fade-in" />
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

  const versionDisplay = versionCheck
    ? describeAgentVersion(versionCheck)
    : null;
  const actionableReadouts =
    versionDisplay?.readouts.filter(
      (r) => r.updateAvailable && r.updateFixType && r.updateCommand,
    ) ?? [];
  const showUpdateButton =
    !isActive && !setupError && actionableReadouts.length > 0;

  return (
    <div
      className={cn(
        "flex flex-col rounded-md bg-background p-3 transition-colors",
        isActive && "bg-linear-to-b from-primary/10 to-primary/10",
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
          {versionCheck && !isActive ? (
            <AgentVersionInfo check={versionCheck} className="mt-1" />
          ) : null}
        </div>
        {renderStatusIndicator()}
      </div>

      {renderSetupProgress()}

      {showUpdateButton && (
        <div className="mt-3 flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="xs"
            leftIcon={<ArrowUpCircle aria-hidden="true" />}
            onClick={() => void runUpdates(actionableReadouts)}
            className="text-warning"
          >
            {t("providers.agents.applyUpdates")}
          </Button>
        </div>
      )}

      {setupError && !isActive && (
        <div className="mt-3 space-y-2 border-t pt-3">
          <div className="rounded-sm bg-destructive/10 px-3 py-2.5">
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
