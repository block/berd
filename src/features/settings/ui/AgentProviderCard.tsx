import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import {
  IconCheck,
  IconAlertTriangle,
  IconMessageCircle,
  IconPlus,
  IconTool,
} from "@tabler/icons-react";
import { ArrowUpCircle } from "lucide-react";
import type {
  AgentSetupAction,
  AgentSetupUpdateCommand,
} from "@/features/providers/api/agentSetup";
import { useAgentSetupStore } from "@/features/providers/stores/agentSetupStore";
import {
  describeAgentVersion,
  missingAgentComponents,
} from "../lib/agentVersionDisplay";
import { rerunDoctorReport } from "@/shared/api/useDoctorReport";
import type { AgentProviderReadiness } from "@/features/providers/hooks/useAgentProviderStatus";
import type { DoctorCheck, FixType } from "@/shared/api/doctor";
import { ProviderSetupOutput } from "./ProviderSetupOutput";
import { AgentVersionInfo } from "./AgentVersionInfo";
import {
  analyzeAgentSetupFailure,
  buildAgentSetupTroubleshootingRequest,
  type AgentSetupTroubleshootingRequest,
} from "@/features/providers/lib/agentSetupTroubleshooting";
import {
  getAgentSetupFailureSimulation,
  getSimulatedAgentSetupFailureLines,
} from "@/features/providers/lib/agentSetupFailureSimulation";
import type { ProviderDisplayInfo } from "@/shared/types/providers";

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
  // The backend can't see the catalog, so it relies on the plan to decide
  // whether to probe PATH after a fix. A built-in or binary-less provider has
  // nothing to resolve on disk, so verification is skipped and a clean run is
  // success — the same short-circuit the old in-card `refreshInstallStatus` did.
  const verifyInstall = hasBinary && !isBuiltIn;
  const setupFailureSimulation = getAgentSetupFailureSimulation(provider.id);
  const forceMissingForSimulation = Boolean(setupFailureSimulation);

  // Setup progress is backend-owned: read the latest snapshot from the store
  // (kept current by the app-level `agent-setup:state` listener) so this card is
  // a pure view that rehydrates on remount and survives a full window reload.
  const operation = useAgentSetupStore((state) =>
    state.operations.get(provider.id),
  );
  const startSetup = useAgentSetupStore((state) => state.startSetup);
  const setOperation = useAgentSetupStore((state) => state.setOperation);
  const clearSetupStatus = useAgentSetupStore((state) => state.clear);

  // Keep the spinner up while we run the (frontend-only) post-success
  // `rerunDoctorReport`, so the card doesn't flash back to "Install"/"Sign in"
  // between the backend reporting success and the doctor report repainting.
  const [finalizing, setFinalizing] = useState(false);
  const reportedRef = useRef(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const outputLengthRef = useRef(0);

  const icon = getProviderIcon(provider.id, "size-6");

  const status = operation?.status;
  const phase = operation?.phase ?? "idle";
  const isRunning = status === "running";
  const isActive = isRunning || finalizing;
  const outputLines = operation?.output ?? [];

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

  // Version / update / partial-install readout from the shared report. Derived
  // here (above the setup handlers) so the handlers and rendered actions share
  // one source of truth.
  const versionDisplay = versionCheck
    ? describeAgentVersion(versionCheck)
    : null;
  // Per-readout updates the crate can actually run (a newer version *and* a
  // runnable source-aware command). Drives both the Update/Fix label and the
  // commands the setup plan carries.
  const actionableReadouts =
    versionDisplay?.readouts.filter(
      (r) => r.updateAvailable && r.updateFixType && r.updateCommand,
    ) ?? [];
  const hasActionableUpdate = actionableReadouts.length > 0;
  // Required binaries the report says are missing while others are present
  // (e.g. Codex's CLI is on PATH but the codex-acp bridge isn't). Surfaced in
  // danger text so a partial install isn't mistaken for a healthy one.
  const missingComponents = versionCheck
    ? missingAgentComponents(versionCheck, provider.binaryName)
    : [];
  // Which install recipe the backend's install loop should seed with. The crate
  // flags a missing ACP bridge (main CLI present) with fixType="bridge", so
  // dispatch that recipe instead of the static main-CLI one; anything else (an
  // absent check, or the update/auth fix types) falls back to "command".
  const installFixType: Extract<FixType, "command" | "bridge"> =
    versionCheck?.fixType === "bridge" ? "bridge" : "command";

  // Build the per-readout update commands the backend runs after the install
  // loop. Readout *derivation* stays here (it already has the doctor report);
  // only the resulting recipe crosses to Rust.
  function buildUpdateCommands(): AgentSetupUpdateCommand[] {
    return actionableReadouts.flatMap((readout) =>
      (readout.updateFixType === "updateMain" ||
        readout.updateFixType === "updateBridge") &&
      readout.updateCommand
        ? [{ fixType: readout.updateFixType, command: readout.updateCommand }]
        : [],
    );
  }

  // Dev-only: inject a *real* terminal failure into the store so the whole
  // downstream view path (analysis, troubleshoot builder) runs for real,
  // without invoking the backend (which can't see the localStorage hook).
  function runSimulatedFailure(action: AgentSetupAction) {
    if (!setupFailureSimulation) return;
    setOperation(provider.id, {
      action,
      phase: "idle",
      status: "failed",
      output: getSimulatedAgentSetupFailureLines(
        provider,
        setupFailureSimulation,
      ),
      error: "Command exited with code 1",
    });
  }

  function handleInstall() {
    if (!supportsInstall) return;
    if (setupFailureSimulation) {
      runSimulatedFailure("install");
      return;
    }
    // Pass the pending updates so a partial install with stale binaries (the
    // "Fix" state) is brought fully current in one pass; for a plain "Install"
    // this list is empty.
    void startSetup(provider.id, "install", {
      installFixType,
      updateCommands: buildUpdateCommands(),
      verifyInstall,
    });
  }

  function handleUpdate() {
    if (!hasActionableUpdate) return;
    if (setupFailureSimulation) {
      runSimulatedFailure("update");
      return;
    }
    void startSetup(provider.id, "update", {
      installFixType: null,
      updateCommands: buildUpdateCommands(),
      verifyInstall,
    });
  }

  function handleAuth() {
    if (!supportsAuth) return;
    if (setupFailureSimulation) {
      runSimulatedFailure("auth");
      return;
    }
    void startSetup(provider.id, "auth", {
      installFixType: null,
      updateCommands: [],
      verifyInstall,
    });
  }

  // When the backend reports success, run the React-Query refresh the backend
  // can't (it owns no query cache), exactly once, then clear the terminal entry
  // so it doesn't re-trigger on a later remount.
  useEffect(() => {
    if (status !== "succeeded") {
      reportedRef.current = false;
      return;
    }
    if (reportedRef.current) return;
    reportedRef.current = true;

    const succeededOperation = operation;
    const action = succeededOperation?.action;
    setFinalizing(true);
    void (async () => {
      try {
        // `rerunDoctorReport` (not a bare invalidate) re-runs the freshness
        // pass so version/install-source/update badges repopulate instead of
        // blanking out.
        await rerunDoctorReport(queryClient);
        if (action === "auth" || (action === "install" && !supportsAuth)) {
          onProviderReady?.(provider.id);
        }
        clearSetupStatus(provider.id);
      } catch (nextError) {
        const message = formatAcpErrorMessage(
          nextError,
          "Couldn't refresh provider status",
        );
        console.error("Failed to finalize agent provider setup:", nextError);
        setOperation(provider.id, {
          action: action ?? "install",
          phase: "idle",
          status: "failed",
          output: succeededOperation?.output ?? [],
          error: message,
        });
      } finally {
        setFinalizing(false);
      }
    })();
  }, [
    status,
    operation?.action,
    operation,
    supportsAuth,
    provider.id,
    queryClient,
    clearSetupStatus,
    setOperation,
    onProviderReady,
  ]);

  useEffect(() => {
    if (outputRef.current && outputLengthRef.current !== outputLines.length) {
      outputLengthRef.current = outputLines.length;
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  });

  // Failure surface, derived from the store's raw `{ error, output }`. The
  // backend reports `installVerificationFailed` as a sentinel the card
  // localizes; any other error is the raw command failure.
  const rawError = status === "failed" ? (operation?.error ?? null) : null;
  const setupError =
    rawError === "installVerificationFailed"
      ? t("providers.agents.errors.installVerificationFailed")
      : rawError;
  const setupFailureAnalysis = setupError
    ? analyzeAgentSetupFailure(
        setupError,
        outputLines.map((text) => ({ text })),
      )
    : null;

  function handleRetry() {
    const action = operation?.action;
    switch (action) {
      case "auth":
        handleAuth();
        return;
      case "update":
        handleUpdate();
        return;
      default:
        handleInstall();
    }
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
  const needsSetupAction = needsInstall || hasActionableUpdate;

  if (provider.showOnlyWhenInstalled && !isInstalled) return null;

  // Shared setup call-to-action style for Install / Update / Fix states.
  function renderActionButton(
    label: string,
    ariaLabel: string,
    icon: ReactNode,
    onClick: () => void,
  ) {
    return (
      <Button
        type="button"
        variant="outline"
        size="xs"
        leftIcon={icon}
        onClick={onClick}
        aria-label={ariaLabel}
        className="flex-shrink-0 text-warning"
      >
        {label}
      </Button>
    );
  }

  function renderSignInButton() {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => handleAuth()}
        className="flex-shrink-0 text-muted-foreground"
        aria-label={t("providers.agents.signInLabel", {
          name: provider.displayName,
        })}
      >
        {t("providers.agents.signIn")}
      </Button>
    );
  }

  function renderSetupActionButton() {
    if (needsInstall) {
      return hasActionableUpdate
        ? renderActionButton(
            t("providers.agents.fix"),
            t("providers.agents.fixLabel", { name: provider.displayName }),
            <IconTool aria-hidden="true" />,
            () => handleInstall(),
          )
        : renderActionButton(
            t("providers.agents.install"),
            t("providers.agents.installLabel", { name: provider.displayName }),
            <IconPlus aria-hidden="true" />,
            () => handleInstall(),
          );
    }

    if (hasActionableUpdate) {
      return renderActionButton(
        t("providers.agents.applyUpdates"),
        t("providers.agents.updateLabel", { name: provider.displayName }),
        <ArrowUpCircle aria-hidden="true" />,
        () => handleUpdate(),
      );
    }

    return null;
  }

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

    const setupActionButton = renderSetupActionButton();

    if (needsAuth && needsSetupAction && setupActionButton) {
      return (
        <div className="flex flex-shrink-0 items-center gap-1.5">
          {setupActionButton}
          {renderSignInButton()}
        </div>
      );
    }

    // Installed and usable: a green tick when nothing is pending, otherwise the
    // amber Update button takes the tick's slot (one click runs every
    // actionable per-readout update command).
    if (isReady) {
      if (setupActionButton) return setupActionButton;
      return (
        <div className="flex h-6 flex-shrink-0 items-center">
          <IconCheck className="size-4 text-success duration-200 motion-safe:animate-in motion-safe:fade-in" />
        </div>
      );
    }

    if (needsAuth) {
      return renderSignInButton();
    }

    // Missing one or more required tools: "Install" when only an install is
    // needed, or "Fix" when the agent is *also* out of date (e.g. Codex's main
    // CLI is on PATH with a pending update but the codex-acp bridge isn't
    // installed). The setup action still resolves install/update issues in one
    // click, but sign-in is intentionally separate.
    if (setupActionButton) return setupActionButton;

    return null;
  }

  function renderSetupOutput(scrollToEnd = false) {
    if (outputLines.length === 0) return null;

    return (
      <ProviderSetupOutput
        lines={outputLines.map((text, index) => ({ id: index, text }))}
        scrollRef={scrollToEnd ? outputRef : undefined}
      />
    );
  }

  function renderSetupProgress() {
    if (!isActive) return null;

    const phaseLabel =
      phase === "installing"
        ? t("providers.agents.progress.installing", {
            name: provider.displayName,
          })
        : phase === "authenticating"
          ? t("providers.waitingForSignIn")
          : t("providers.agents.progress.verifyingInstallation");

    return (
      <div className="mt-3 space-y-2 border-t pt-3">
        <div className="flex items-center gap-2">
          <Spinner className="size-3.5 text-primary" />
          <div className="min-w-0 flex-1">
            <span className="text-xs font-medium">{phaseLabel}</span>
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
          {!isActive && missingComponents.length > 0 ? (
            <div className="mt-1 flex flex-col gap-1">
              {missingComponents.map((name) => (
                <span
                  key={name}
                  className="break-words text-xs text-destructive"
                >
                  {t("providers.agents.missingComponent", { name })}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {renderStatusIndicator()}
      </div>

      {renderSetupProgress()}

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
