import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ExpandableCard } from "@/shared/ui/card";
import { CollapseReveal } from "@/shared/ui/collapse-reveal";
import { SettingsRow } from "@/shared/ui/settings-row";
import { Spinner } from "@/shared/ui/spinner";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
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
  AgentSetupUpdateFixType,
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

const autoInstallStarts = new Set<string>();

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
  onInstallComplete?: (providerId: string) => void;
  onDisclosureOpenChange?: (open: boolean) => void;
  // Optional collapsible region rendered inside the card below the header
  // row (the goose card hosts its model providers here). Purely
  // presentational: the parent owns the content.
  expandedContent?: ReactNode;
  expandableLabel?: ReactNode;
  collapsedSummary?: ReactNode;
  collapsedSupplement?: ReactNode;
  statusIndicator?: ReactNode;
  // Makes a custom status indicator an explicit shortcut into the card's
  // expandable setup details (for example, Goose's model-provider setup).
  statusIndicatorOpensDetails?: boolean;
  /** Goose keeps its expandable harness card; other agents use SettingsRow. */
  presentation?: "card" | "row";
  /** Adds an inline disclosure card below the settings row when expandable details are present. */
  showDisclosure?: boolean;
  /** Starts installation on mount once readiness has finished loading. */
  autoStartInstall?: boolean;
  /** Hides the pre-install card action while an automatic install starts. */
  autoInstallProgressOnly?: boolean;
  /** Development-only visual setup simulation; never invokes the backend. */
  simulateAutoInstall?: boolean;
  /** Surface-specific card treatment; onboarding uses a white setup panel. */
  className?: string;
}

export function AgentProviderCard({
  provider,
  readiness,
  versionCheck,
  statusLoading = false,
  onStartTroubleshootingChat,
  onProviderReady,
  onInstallComplete,
  onDisclosureOpenChange,
  expandedContent,
  expandableLabel,
  collapsedSummary,
  collapsedSupplement,
  statusIndicator,
  statusIndicatorOpensDetails = false,
  presentation = "row",
  showDisclosure = false,
  autoStartInstall = false,
  autoInstallProgressOnly = false,
  simulateAutoInstall = false,
  className,
}: AgentProviderCardProps) {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const isBuiltIn = provider.status === "built_in";
  const supportsInstall = provider.supportsInstall === true;
  const supportsAuth = provider.supportsAuth === true;
  const hasBinary = !!provider.binaryName;
  const bundledBridge = provider.bundledBridge === true;
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
  const [expandedOpen, setExpandedOpen] = useState(false);
  const inlineDisclosureRegionId = useId();
  const reportedRef = useRef(false);
  const outputRef = useRef<HTMLDivElement>(null);
  const outputLengthRef = useRef(0);
  const autoInstallStartedRef = useRef(autoInstallStarts.has(provider.id));
  const handleInstallRef = useRef<() => Promise<void>>(async () => {});

  const icon = getProviderIcon(provider.id, "size-6");

  const status = operation?.status;
  const phase = operation?.phase ?? "idle";
  const isRunning = status === "running";
  const isAwaitingAutoInstall =
    autoStartInstall &&
    autoInstallProgressOnly &&
    !autoInstallStartedRef.current &&
    status == null;
  const isActive = isRunning || finalizing || isAwaitingAutoInstall;
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
  // commands the setup plan carries. Bundled readouts never qualify: the
  // crate stamps them (install source "bundled") and derives no update
  // command for them — they update with Berd itself.
  const actionableReadouts =
    versionDisplay?.readouts.filter(
      (r) => r.updateAvailable && r.updateFixType && r.updateCommand,
    ) ?? [];
  const hasActionableUpdate = actionableReadouts.length > 0;
  // Required binaries the report says are missing while others are present
  // (e.g. Amp's CLI is on PATH but the amp-acp bridge isn't). Surfaced in
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

  // Build the per-readout update fix identities the backend runs after the
  // install loop. Readout *derivation* stays here (it already has the doctor
  // report) to decide *whether* an update is actionable; only the typed fix
  // slot crosses to Rust, which re-resolves the exact command from the crate's
  // trusted freshness readout.
  function buildUpdateFixTypes(): AgentSetupUpdateFixType[] {
    return actionableReadouts.flatMap((readout) =>
      readout.updateFixType === "updateMain" ||
      readout.updateFixType === "updateBridge"
        ? [readout.updateFixType]
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

  async function handleInstall() {
    if (!supportsInstall) return;
    if (setupFailureSimulation) {
      runSimulatedFailure("install");
      return;
    }
    // Pass the pending updates so a partial install with stale binaries (the
    // "Fix" state) is brought fully current in one pass; for a plain "Install"
    // this list is empty. The backend command is idempotent per provider, so a
    // StrictMode remount can safely reconnect to an operation already starting.
    try {
      await startSetup(provider.id, "install", {
        installFixType,
        updateFixTypes: buildUpdateFixTypes(),
        verifyInstall,
        ...(bundledBridge ? { bundledBridge } : {}),
      });
    } catch (error) {
      setOperation(provider.id, {
        action: "install",
        phase: "idle",
        status: "failed",
        output: [],
        error: formatAcpErrorMessage(
          error,
          t("providers.agents.errors.installStart"),
        ),
      });
    } finally {
      autoInstallStarts.delete(provider.id);
    }
  }

  handleInstallRef.current = handleInstall;

  useEffect(() => {
    if (
      !autoStartInstall ||
      autoInstallStartedRef.current ||
      isChecking ||
      isRunning ||
      finalizing ||
      resolvedReadiness !== "not_installed" ||
      !supportsInstall
    ) {
      return;
    }
    autoInstallStartedRef.current = true;
    autoInstallStarts.add(provider.id);
    if (simulateAutoInstall) {
      setOperation(provider.id, {
        action: "install",
        phase: "installing",
        status: "running",
        output: [
          t("providers.agents.progress.preparingProvider", {
            name: provider.displayName,
          }),
          t("providers.agents.progress.installingForBerd", {
            name: provider.displayName,
          }),
        ],
        error: null,
      });
      window.setTimeout(() => {
        const current = useAgentSetupStore.getState().getStatus(provider.id);
        if (current?.status !== "running") return;
        setOperation(provider.id, {
          action: "install",
          phase: "idle",
          status: "succeeded",
          output: [
            t("providers.agents.progress.installedProvider", {
              name: provider.displayName,
            }),
          ],
          error: null,
        });
        autoInstallStarts.delete(provider.id);
      }, 1_800);
      return;
    }
    void handleInstallRef.current();
  }, [
    autoStartInstall,
    isChecking,
    isRunning,
    finalizing,
    resolvedReadiness,
    supportsInstall,
    simulateAutoInstall,
    provider.id,
    provider.displayName,
    setOperation,
    t,
  ]);

  function handleUpdate() {
    if (!hasActionableUpdate) return;
    if (setupFailureSimulation) {
      runSimulatedFailure("update");
      return;
    }
    void startSetup(provider.id, "update", {
      installFixType: null,
      updateFixTypes: buildUpdateFixTypes(),
      verifyInstall,
      ...(bundledBridge ? { bundledBridge } : {}),
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
      updateFixTypes: [],
      verifyInstall,
      ...(bundledBridge ? { bundledBridge } : {}),
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
        if (action === "install") {
          onInstallComplete?.(provider.id);
        }
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
    onInstallComplete,
  ]);

  useEffect(() => {
    if (outputRef.current && outputLengthRef.current !== outputLines.length) {
      outputLengthRef.current = outputLines.length;
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  });

  const handleExpandedOpenChange = useCallback(
    (nextOpen: boolean) => {
      setExpandedOpen(nextOpen);
      onDisclosureOpenChange?.(nextOpen);
    },
    [onDisclosureOpenChange],
  );

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

  useEffect(() => {
    if (isActive || setupError) {
      handleExpandedOpenChange(true);
    }
  }, [isActive, setupError, handleExpandedOpenChange]);

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
        className="flex-shrink-0"
      >
        {label}
      </Button>
    );
  }

  function renderSignInButton() {
    return (
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => handleAuth()}
        className="flex-shrink-0"
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
    if (statusIndicator) {
      return statusIndicator;
    }

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
      isAwaitingAutoInstall || phase === "installing"
        ? t("providers.agents.progress.installing", {
            name: provider.displayName,
          })
        : phase === "preparingRuntime"
          ? t("providers.agents.progress.preparingRuntime")
          : phase === "authenticating"
            ? t("providers.waitingForSignIn")
            : t("providers.agents.progress.verifyingInstallation");

    return (
      <div className="space-y-2">
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
  const versionDetails =
    versionCheck && !isActive ? (
      <AgentVersionInfo check={versionCheck} />
    ) : null;
  const hasSupplementaryProviderDetails =
    (!isActive && missingComponents.length > 0) ||
    isActive ||
    Boolean(setupError && !isActive);
  const providerDetails =
    (!showDisclosure && versionDetails) || hasSupplementaryProviderDetails ? (
      <div className="space-y-3">
        {!showDisclosure ? versionDetails : null}
        {!isActive && missingComponents.length > 0 ? (
          <div className="flex flex-col gap-1">
            {missingComponents.map((name) => (
              <span key={name} className="break-words text-xs text-destructive">
                {t("providers.agents.missingComponent", { name })}
              </span>
            ))}
          </div>
        ) : null}

        {renderSetupProgress()}

        {setupError && !isActive && (
          <div className="space-y-2">
            <div className="rounded-sm bg-destructive/10 px-3 py-2.5">
              <div className="flex flex-col gap-2">
                <p className="min-w-0 text-xs font-medium leading-relaxed text-destructive">
                  {setupFailureMessage}
                </p>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={handleRetry}
                  >
                    {t("common:actions.retry")}
                  </Button>
                  {setupFailureAnalysis && onStartTroubleshootingChat ? (
                    <Button
                      type="button"
                      variant="primary"
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
    ) : null;
  const hasExpandableDetails =
    Boolean(providerDetails) || Boolean(expandedContent);
  const shouldCollapseDetails =
    hasExpandableDetails && (showDisclosure || statusIndicatorOpensDetails);
  const actionableStatusIndicator =
    statusIndicator && statusIndicatorOpensDetails && shouldCollapseDetails ? (
      <button
        type="button"
        onClick={() => handleExpandedOpenChange(true)}
        aria-expanded={expandedOpen}
        className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {statusIndicator}
      </button>
    ) : (
      statusIndicator
    );
  const renderedStatusIndicator =
    actionableStatusIndicator ?? renderStatusIndicator();

  const rowAction = renderedStatusIndicator ? (
    <div className="flex min-h-6 items-center justify-end gap-1.5">
      {renderedStatusIndicator}
    </div>
  ) : null;

  const description = (
    <div className="space-y-1">
      <p>{provider.description}</p>
      {showDisclosure && versionDetails ? <div>{versionDetails}</div> : null}
    </div>
  );

  const directDetails = hasExpandableDetails ? (
    <div className="space-y-3">
      {providerDetails}
      {expandedContent}
    </div>
  ) : null;

  const legacyDisclosureDetails =
    !showDisclosure && shouldCollapseDetails && hasExpandableDetails ? (
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="mb-2 min-w-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="sr-only">
            {t("providers.agents.expandLabel", { name: provider.displayName })}
          </span>
          <span aria-hidden="true">{provider.displayName}</span>
        </button>
      </CollapsibleTrigger>
    ) : null;

  const collapsedDetails = hasExpandableDetails ? (
    <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
      <div className="space-y-3">
        {providerDetails}
        {expandedContent}
      </div>
    </CollapsibleContent>
  ) : null;

  const expandableAccessibleName =
    typeof expandableLabel === "string"
      ? expandableLabel
      : provider.displayName;
  const expandableActionLabel = t(
    expandedOpen
      ? "providers.agents.collapseLabel"
      : "providers.agents.expandLabel",
    { name: expandableAccessibleName },
  );

  const inlineExpandableDetails =
    showDisclosure && hasExpandableDetails ? (
      <div className="group/model-provider-disclosure rounded-sm border border-border">
        <div className="relative">
          <button
            type="button"
            aria-controls={inlineDisclosureRegionId}
            aria-label={expandableActionLabel}
            aria-expanded={expandedOpen}
            onClick={() => handleExpandedOpenChange(!expandedOpen)}
            className="flex w-full items-center justify-between gap-3 rounded-sm px-5 py-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm text-foreground">
                {expandableLabel ?? provider.displayName}
              </span>
              {collapsedSummary ? (
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {collapsedSummary}
                </span>
              ) : null}
            </span>
          </button>
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-5 bottom-0 border-t border-border/60 transition-opacity duration-300 motion-reduce:transition-none",
              expandedOpen
                ? "opacity-100 group-hover/model-provider-disclosure:opacity-0"
                : "opacity-0",
            )}
          />
        </div>
        <CollapseReveal
          id={inlineDisclosureRegionId}
          open={expandedOpen}
          pace="deliberate"
        >
          <div className="px-5 pt-3 pb-5">
            <div className="space-y-3">
              {providerDetails}
              {expandedContent}
            </div>
          </div>
        </CollapseReveal>
      </div>
    ) : null;

  const details = showDisclosure ? (
    inlineExpandableDetails
  ) : shouldCollapseDetails ? (
    <>
      {legacyDisclosureDetails}
      {collapsedDetails}
    </>
  ) : (
    directDetails
  );

  const row = (
    <SettingsRow
      leading={icon}
      label={provider.displayName}
      description={description}
      align="start"
      action={rowAction}
      details={details}
      detailsClassName={icon ? "ml-10" : undefined}
    />
  );

  function renderSummaryContent() {
    return (
      <div className="min-w-0 flex-1 text-left">
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
    );
  }

  const summaryRow = hasExpandableDetails ? (
    <div className="flex items-start justify-between gap-3">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {renderSummaryContent()}
        </button>
      </CollapsibleTrigger>
      {actionableStatusIndicator ?? renderStatusIndicator()}
    </div>
  ) : (
    <div className="flex items-start justify-between gap-3">
      {renderSummaryContent()}
      {actionableStatusIndicator ?? renderStatusIndicator()}
    </div>
  );

  const expandedDetails = hasExpandableDetails ? (
    <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
      <div className="mt-3 space-y-3">
        {providerDetails}
        {expandedContent ? <div>{expandedContent}</div> : null}
      </div>
    </CollapsibleContent>
  ) : null;

  const cardContent = hasExpandableDetails ? (
    <Collapsible open={expandedOpen} onOpenChange={handleExpandedOpenChange}>
      {summaryRow}
      {expandedDetails}
    </Collapsible>
  ) : (
    summaryRow
  );

  const canOpenCollapsedCard = hasExpandableDetails && !expandedOpen;
  const canOpenCollapsedStack = Boolean(collapsedSupplement && !expandedOpen);
  const openCollapsedCard = () => {
    if (canOpenCollapsedCard) {
      handleExpandedOpenChange(true);
    }
  };
  const handleCardSurfaceClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (
      target?.closest(
        "button, a, input, textarea, select, [role='button'], [data-no-card-toggle]",
      )
    ) {
      return;
    }
    openCollapsedCard();
  };

  const rowContent = shouldCollapseDetails ? (
    <Collapsible open={expandedOpen} onOpenChange={handleExpandedOpenChange}>
      {row}
    </Collapsible>
  ) : (
    row
  );

  const card =
    presentation === "row" || showDisclosure ? (
      rowContent
    ) : (
      <ExpandableCard
        interactive={canOpenCollapsedCard}
        onClick={canOpenCollapsedCard ? handleCardSurfaceClick : undefined}
        className={cn("border border-border", className)}
      >
        {cardContent}
      </ExpandableCard>
    );

  if (!collapsedSupplement) {
    return card;
  }

  return (
    <div
      className={cn(
        "relative overflow-visible transition-[padding-bottom] duration-200 ease-out motion-reduce:transition-none",
        expandedOpen ? "pb-0" : "pb-11",
      )}
    >
      <div className="relative z-10">{card}</div>
      <div
        aria-hidden={expandedOpen}
        role={canOpenCollapsedStack ? "button" : undefined}
        tabIndex={canOpenCollapsedStack ? 0 : -1}
        onClick={canOpenCollapsedStack ? openCollapsedCard : undefined}
        onKeyDown={
          canOpenCollapsedStack
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openCollapsedCard();
                }
              }
            : undefined
        }
        className={cn(
          "absolute inset-x-0 bottom-0 z-0 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
          expandedOpen
            ? "translate-y-3 opacity-0"
            : "-translate-y-1 opacity-100",
          canOpenCollapsedStack &&
            "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {collapsedSupplement}
      </div>
    </div>
  );
}
