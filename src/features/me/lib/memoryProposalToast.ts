import { toast } from "sonner";
import type { MemoryProposal } from "./meProposals";

const shown = new Set<string>();
const TOAST_DURATION_MS = 10_000;

export function resetMemoryProposalToasts(): void {
  shown.clear();
}

export function showMemoryProposalToast({
  proposal,
  title,
  destination,
  reviewLabel,
  declineLabel,
  onReview,
  onDecline,
  renderActions,
}: {
  proposal: MemoryProposal;
  title: string;
  destination: string;
  reviewLabel: string;
  declineLabel: string;
  onReview: (proposal: MemoryProposal) => void;
  onDecline: (proposal: MemoryProposal) => void;
  renderActions: (args: {
    reviewLabel: string;
    declineLabel: string;
    onReview: () => void;
    onDecline: () => void;
  }) => React.ReactNode;
}): void {
  if (shown.has(proposal.id)) return;
  shown.add(proposal.id);
  let toastId: string | number | undefined;
  const dismiss = () => toastId !== undefined && toast.dismiss(toastId);
  toastId = toast(title, {
    description: `${proposal.content} · ${destination}`,
    duration: TOAST_DURATION_MS,
    action: renderActions({
      reviewLabel,
      declineLabel,
      onReview: () => {
        dismiss();
        onReview(proposal);
      },
      onDecline: () => {
        dismiss();
        onDecline(proposal);
      },
    }),
  });
}
