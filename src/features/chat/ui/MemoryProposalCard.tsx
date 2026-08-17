import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Brain } from "lucide-react";
import {
  approveProposal,
  dismissProposal,
  listProposals,
  type MemoryProposal,
} from "@/features/me/lib/meProposals";
import { Button } from "@/shared/ui/button";

/**
 * Inline approval card for `propose_memory` tool calls.
 *
 * The memory MCP server can only queue proposals; this card is one of the
 * two surfaces that resolve them (Settings → Memory is the other — both
 * read the same queue, so a proposal approved in either place disappears
 * from both). Non-blocking by design: the tool call already returned, so
 * the conversation never waits on the card.
 */

/** Goose namespaces extension tools as `extension__tool`. */
export function isMemoryProposalTool(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  return trimmed === "propose_memory" || trimmed.endsWith("__propose_memory");
}

type CardState =
  | { status: "checking" }
  | { status: "pending"; proposal: MemoryProposal }
  | { status: "approved" }
  | { status: "dismissed" }
  | { status: "reviewed" }; // resolved elsewhere (Settings, another card)

interface MemoryProposalCardProps {
  /** Tool-call arguments as sent by the agent. */
  arguments: Record<string, unknown>;
}

export function MemoryProposalCard({
  arguments: args,
}: MemoryProposalCardProps) {
  const { t } = useTranslation("settings");
  const content = typeof args.content === "string" ? args.content.trim() : "";
  const topic =
    typeof args.topic === "string" && args.topic.trim()
      ? args.topic.trim()
      : null;
  const [state, setState] = useState<CardState>({ status: "checking" });

  const findPending = useCallback(async () => {
    if (!content) {
      setState({ status: "reviewed" });
      return;
    }
    // Tool-call args don't carry the server-generated id, so the card
    // locates its proposal by content+topic. Safe: the server dedupes
    // identical pending proposals, so this resolves to at most one
    // record — and approve/dismiss then operate on that record's id.
    const pending = await listProposals();
    const match = pending.find(
      (p) => p.content === content && (p.topic ?? null) === topic,
    );
    setState(
      match ? { status: "pending", proposal: match } : { status: "reviewed" },
    );
  }, [content, topic]);

  useEffect(() => {
    void findPending();
  }, [findPending]);

  const handleApprove = async (proposal: MemoryProposal) => {
    try {
      await approveProposal(proposal);
      setState({ status: "approved" });
    } catch {
      // Queue state is truth; re-check rather than guessing.
      await findPending();
    }
  };

  const handleDismiss = async (proposal: MemoryProposal) => {
    try {
      await dismissProposal(proposal);
      setState({ status: "dismissed" });
    } catch {
      await findPending();
    }
  };

  const topicLabel = topic
    ? t("me.proposals.topicLabel", { topic })
    : t("me.proposals.generalLabel");

  return (
    <div
      data-role="memory-proposal-card"
      className="flex items-start justify-between gap-4 rounded-md border bg-muted/50 px-4 py-3"
    >
      <div className="flex min-w-0 items-start gap-3">
        <Brain
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">
            {t("me.proposalCard.title")}
          </p>
          <p className="mt-1 text-xs text-foreground">{content}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{topicLabel}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {state.status === "pending" ? (
          <>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void handleDismiss(state.proposal)}
            >
              {t("me.proposals.dismiss")}
            </Button>
            <Button
              size="xs"
              variant="primary"
              onClick={() => void handleApprove(state.proposal)}
            >
              {t("me.proposals.approve")}
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            {state.status === "approved" && t("me.proposalCard.approved")}
            {state.status === "dismissed" && t("me.proposalCard.dismissed")}
            {state.status === "reviewed" && t("me.proposalCard.reviewed")}
          </span>
        )}
      </div>
    </div>
  );
}
