import {
  approveMemoryProposal as approveMemoryProposalInBackend,
  resolveMemoryProposal,
} from "@/shared/api/system";
import {
  CredentialMemoryError,
  looksLikeCredential,
} from "./memoryCredentialGuard";
import {
  normalizeMemoryProposalText,
  normalizeMemoryProposalTopic,
} from "./memoryTextContract";
import type { MemoryProposal } from "./meProposals";

export { CredentialMemoryError } from "./memoryCredentialGuard";
export { UnsafeMemoryTextError } from "./memoryTextContract";

export async function approveMemoryProposal(
  proposal: MemoryProposal,
  content = proposal.content,
  topic = proposal.topic,
): Promise<void> {
  const reviewed = normalizeMemoryProposalText(content);
  if (!reviewed) throw new Error("Memory content is required.");
  if (looksLikeCredential(reviewed)) throw new CredentialMemoryError();

  const reviewedTopic = normalizeMemoryProposalTopic(topic);
  await approveMemoryProposalInBackend(proposal.id, reviewed, reviewedTopic);
}

export async function declineMemoryProposal(
  proposal: MemoryProposal,
): Promise<void> {
  await resolveMemoryProposal(proposal.id, {
    content: proposal.content,
    topic: proposal.topic,
  });
}
