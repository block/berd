import { useTranslation } from "react-i18next";
import { isAgentBuilderVisible } from "@/features/chat/lib/chatCapabilityVisibility";
import {
  useChatSessionStore,
  type ChatSession,
} from "@/features/chat/stores/chatSessionStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { useSecurityConfirmationStore } from "@/features/security/stores/securityConfirmationStore";

export interface SessionAddressedComposerAdmissionOptions {
  sessionId: string | null;
  /**
   * A surface may already own the current session snapshot before the shared
   * store catches up (notably ChatView during draft-session promotion).
   */
  sessionSnapshot?: ChatSession | null;
  readOnlyReason?: string;
  /** Canvas and other secondary in-window surfaces cannot write to a session
   * whose lifecycle is owned by a separate session window. */
  readOnlyWhenOpenInAnotherWindow?: boolean;
}

export interface SessionAddressedComposerAdmission {
  readOnlyReason?: string;
  blockingReason?: string;
  securityConfirmationPending: boolean;
  blocked: boolean;
}

interface DeriveSessionAddressedComposerAdmissionOptions {
  session: ChatSession | null;
  readOnlyReason?: string;
  securityConfirmationPending: boolean;
  sessionCreationFailureFallback: string;
  executionTargetFailureReason: string;
}

/** Pure model shared by every composer addressed to an existing session. */
export function deriveSessionAddressedComposerAdmission({
  session,
  readOnlyReason,
  securityConfirmationPending,
  sessionCreationFailureFallback,
  executionTargetFailureReason,
}: DeriveSessionAddressedComposerAdmissionOptions): SessionAddressedComposerAdmission {
  const agentBuilderOpen = isAgentBuilderVisible(session, {
    readOnly: Boolean(readOnlyReason),
  });
  const blockingReason =
    readOnlyReason ??
    (session?.creationState === "failed"
      ? (session.creationError ?? sessionCreationFailureFallback)
      : agentBuilderOpen && session?.targetAgentDraftState === "failed"
        ? executionTargetFailureReason
        : undefined);

  return {
    readOnlyReason,
    blockingReason,
    securityConfirmationPending,
    blocked: Boolean(blockingReason) || securityConfirmationPending,
  };
}

/**
 * Owns existing-session composer admission. Presentation surfaces consume this
 * model; they do not independently infer session lifecycle or security state.
 */
export function useSessionAddressedComposerAdmission({
  sessionId,
  sessionSnapshot,
  readOnlyReason: assertedReadOnlyReason,
  readOnlyWhenOpenInAnotherWindow = false,
}: SessionAddressedComposerAdmissionOptions): SessionAddressedComposerAdmission {
  const { t } = useTranslation("chat");
  const storedSession = useChatSessionStore((state) =>
    sessionId && !sessionSnapshot
      ? ((state.sessions ?? []).find(
          (candidate) => candidate.id === sessionId,
        ) ?? null)
      : null,
  );
  const openInSessionWindow = useSessionWindowStore((state) =>
    readOnlyWhenOpenInAnotherWindow && sessionId
      ? state.isOpenInWindow(sessionId)
      : false,
  );
  const securityConfirmationPending = useSecurityConfirmationStore((state) =>
    sessionId ? (state.pendingBySessionId[sessionId]?.length ?? 0) > 0 : false,
  );
  const readOnlyReason =
    assertedReadOnlyReason ??
    (openInSessionWindow ? t("sessionWindow.readOnlyStatus") : undefined);

  return deriveSessionAddressedComposerAdmission({
    session: sessionSnapshot ?? storedSession,
    readOnlyReason,
    securityConfirmationPending,
    sessionCreationFailureFallback: t("toolbar.sessionStartFailed"),
    executionTargetFailureReason: t("toolbar.agentBuilderPrepareFailed"),
  });
}
