import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useMemoryProposals } from "../hooks/useMemoryProposals";
import { showMemoryProposalToast } from "../lib/memoryProposalToast";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import { ToastActionButton, ToastActionGroup } from "@/shared/ui/sonner";

/** Proposal notifications. Sessionless MCP proposals are shown globally. */
export function MemoryProposalToasts({
  sessionId,
  sessionlessOnly = false,
}: {
  sessionId?: string;
  sessionlessOnly?: boolean;
}) {
  const { t } = useTranslation("settings");
  const { proposals, decline } = useMemoryProposals(sessionId, {
    sessionlessOnly,
  });

  useEffect(() => {
    if (!sessionlessOnly && !sessionId) return;
    for (const proposal of proposals) {
      showMemoryProposalToast({
        proposal,
        destination: proposal.topic
          ? t("me.proposals.topicLabel", { topic: proposal.topic })
          : t("me.proposals.generalLabel"),
        title: t("me.proposals.title"),
        reviewLabel: t("me.proposals.review"),
        declineLabel: t("me.proposals.dismiss"),
        onReview: () => requestOpenSettings("me"),
        onDecline: (item) => void decline(item),
        renderActions: ({ reviewLabel, declineLabel, onReview, onDecline }) => (
          <ToastActionGroup>
            <ToastActionButton emphasis="secondary" onClick={onDecline}>
              {declineLabel}
            </ToastActionButton>
            <ToastActionButton onClick={onReview}>
              {reviewLabel}
            </ToastActionButton>
          </ToastActionGroup>
        ),
      });
    }
  }, [proposals, sessionId, sessionlessOnly, decline, t]);

  return null;
}
