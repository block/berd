import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { Loader2, ShieldAlert, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import {
  allowOptionId,
  blockOptionId,
  type PendingSecurityConfirmation,
  useSecurityConfirmationStore,
} from "@/features/security/stores/securityConfirmationStore";
import {
  extractConfidence,
  meaningfulAlertExplanation,
} from "@/features/security/lib/inferExplanation";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";

const FINDING_ID_PREFIX = "Finding ID:";

interface ParsedAlert {
  explanation: string;
  confidence: number | null;
  findingId: string | null;
}

function parseAlert(alertText: string): ParsedAlert {
  let findingId: string | null = null;

  const findingIndex = alertText.lastIndexOf(FINDING_ID_PREFIX);
  if (findingIndex !== -1) {
    findingId = alertText.slice(findingIndex + FINDING_ID_PREFIX.length).trim();
  }

  return {
    explanation: meaningfulAlertExplanation(alertText),
    confidence: extractConfidence(alertText),
    findingId,
  };
}

export function useHasPendingSecurityConfirmation(sessionId: string): boolean {
  return useSecurityConfirmationStore(
    (state) => (state.pendingBySessionId[sessionId]?.length ?? 0) > 0,
  );
}

export function useRegisterSecurityConfirmationSurface(sessionId: string) {
  const mountSurface = useSecurityConfirmationStore(
    (state) => state.mountSurface,
  );
  const unmountSurface = useSecurityConfirmationStore(
    (state) => state.unmountSurface,
  );

  useLayoutEffect(() => {
    mountSurface(sessionId);
    return () => unmountSurface(sessionId);
  }, [mountSurface, sessionId, unmountSurface]);
}

export function SecurityConfirmationPanel({
  sessionId,
  manageFocus = true,
  contextLabel,
}: {
  sessionId: string;
  manageFocus?: boolean;
  contextLabel?: string;
}) {
  const { t } = useTranslation("settings");
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const previousPendingRequestRef = useRef<
    PendingSecurityConfirmation["request"] | null
  >(null);
  const pending = useSecurityConfirmationStore(
    (state) => state.pendingBySessionId[sessionId]?.[0] ?? null,
  );
  const pendingRequest = pending?.request;
  const resolveWith = useSecurityConfirmationStore(
    (state) => state.resolveWith,
  );
  const blockAll = useSecurityConfirmationStore((state) => state.blockAll);

  if (
    pending &&
    previousPendingRequestRef.current === null &&
    restoreFocusRef.current === null
  ) {
    const activeElement = document.activeElement;
    restoreFocusRef.current =
      activeElement instanceof HTMLElement && activeElement !== document.body
        ? activeElement
        : null;
  }
  previousPendingRequestRef.current = pending?.request ?? null;

  useEffect(() => {
    if (!pendingRequest || !manageFocus) {
      return;
    }

    panelRef.current?.focus({ preventScroll: true });
    const restoreFocus = restoreFocusRef.current;
    return () => {
      window.requestAnimationFrame(() => {
        const stillPending =
          (useSecurityConfirmationStore.getState().pendingBySessionId[sessionId]
            ?.length ?? 0) > 0;
        if (!stillPending) {
          if (restoreFocus?.isConnected) {
            restoreFocus.focus({ preventScroll: true });
          }
          restoreFocusRef.current = null;
        }
      });
    };
  }, [manageFocus, pendingRequest, sessionId]);

  if (!pending) {
    return null;
  }

  const { explanation, confidence, findingId } = parseAlert(pending.alertText);
  const inferredExplanation = pending.inferredExplanation;

  const handleBlock = () => {
    resolveWith(sessionId, pending.request, blockOptionId(pending.request));
  };

  const handleAllow = () => {
    resolveWith(sessionId, pending.request, allowOptionId(pending.request));
  };

  const handleConnectGoose = () => {
    // Setup replaces this composer, so fail closed for every queued tool call
    // in this session before navigating away to provider settings.
    blockAll(sessionId);
    requestOpenSettings("providers");
  };

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid="security-confirmation-panel"
      className="max-h-[min(65vh,36rem)] overflow-y-auto rounded-lg border border-destructive/30 bg-card p-4 shadow-[var(--shadow-chat)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {!manageFocus ? (
        <p className="sr-only" role="alert">
          {t("securityConfirmation.title")}.{" "}
          {t("securityConfirmation.description")}
          {contextLabel ? ` ${contextLabel}` : null}
        </p>
      ) : null}
      <div className="space-y-3">
        {contextLabel ? (
          <p className="font-medium text-muted-foreground text-xs">
            {contextLabel}
          </p>
        ) : null}
        <div className="space-y-1">
          <h2
            id={titleId}
            className="flex items-center gap-2 font-display font-semibold text-base text-foreground"
          >
            <ShieldAlert className="h-5 w-5 shrink-0 text-destructive" />
            {t("securityConfirmation.title")}
          </h2>
          <p id={descriptionId} className="text-muted-foreground text-sm">
            {t("securityConfirmation.description")}
          </p>
        </div>

        {confidence != null ? (
          <div className="flex items-center gap-2">
            <span className="font-medium text-muted-foreground text-xs">
              {t("securityConfirmation.detectionConfidence")}
            </span>
            <span className="rounded-full bg-destructive/10 px-2 py-0.5 font-semibold text-destructive text-xs">
              {Math.round(confidence * 100)}%
            </span>
          </div>
        ) : null}

        {explanation ? (
          <p className="break-words text-foreground text-sm">{explanation}</p>
        ) : null}

        {inferredExplanation.status !== "idle" ? (
          <div role="status" aria-live="polite" aria-atomic="true">
            {inferredExplanation.status === "loading" ? (
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 p-3">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
                <span className="text-muted-foreground text-xs">
                  {t("securityConfirmation.inferring")}
                </span>
              </div>
            ) : null}

            {inferredExplanation.status === "done" ? (
              <div className="space-y-1.5 rounded-md border border-border bg-muted/50 p-3">
                <div className="flex items-center gap-1.5">
                  <TriangleAlert className="h-3.5 w-3.5 text-warning" />
                  <span className="font-medium text-muted-foreground text-xs">
                    {t("securityConfirmation.inferredLabel")}
                  </span>
                </div>
                <p className="break-words text-foreground text-sm">
                  {inferredExplanation.text}
                </p>
              </div>
            ) : null}

            {inferredExplanation.status === "failed" ? (
              <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 p-3">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                <p className="text-muted-foreground text-xs">
                  {t("securityConfirmation.inferenceFailed")}
                </p>
              </div>
            ) : null}

            {inferredExplanation.status === "needs_setup" ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/50 p-3">
                <div className="flex min-w-0 items-start gap-2">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  <p className="text-muted-foreground text-xs">
                    {t("securityConfirmation.connectGooseDescription")}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleConnectGoose}
                >
                  {t("securityConfirmation.connectGoose")}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {pending.command ? (
          <div className="min-w-0 space-y-1">
            <p className="font-medium text-muted-foreground text-xs">
              {t("securityConfirmation.commandLabel")}
            </p>
            <pre className="max-h-32 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">
              {pending.command}
            </pre>
          </div>
        ) : null}

        {findingId ? (
          <p className="break-all text-muted-foreground text-xs">
            {t("securityConfirmation.findingId", { id: findingId })}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2 border-border border-t pt-3">
          <Button type="button" variant="outline" onClick={handleAllow}>
            {t("securityConfirmation.allow")}
          </Button>
          <Button
            type="button"
            variant="primary"
            destructive
            onClick={handleBlock}
          >
            {t("securityConfirmation.block")}
          </Button>
        </div>
      </div>
    </section>
  );
}

export function SecurityConfirmationFallback() {
  const { t } = useTranslation("settings");
  const sessionId = useSecurityConfirmationStore((state) => {
    const pendingSessionIds = Object.keys(state.pendingBySessionId).filter(
      (candidate) => (state.pendingBySessionId[candidate]?.length ?? 0) > 0,
    );
    const hasInlineConfirmation = pendingSessionIds.some(
      (candidate) => (state.mountedSurfaceCountBySessionId[candidate] ?? 0) > 0,
    );
    if (hasInlineConfirmation) {
      return undefined;
    }
    return pendingSessionIds.find(
      (candidate) =>
        (state.mountedSurfaceCountBySessionId[candidate] ?? 0) === 0,
    );
  });
  const sessionTitle = useChatSessionStore(
    (state) =>
      state.sessions.find((session) => session.id === sessionId)?.title,
  );

  if (!sessionId) {
    return null;
  }

  const contextLabel = sessionTitle
    ? t("securityConfirmation.backgroundChat", { title: sessionTitle })
    : t("securityConfirmation.backgroundChatUnknown");

  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex justify-end">
      <div className="pointer-events-auto w-full max-w-[var(--chat-composer-max-width)]">
        <SecurityConfirmationPanel
          sessionId={sessionId}
          manageFocus={false}
          contextLabel={contextLabel}
        />
      </div>
    </div>
  );
}
