import {
  approveMemoryProposal as approveMemoryProposalInBackend,
  resolveMemoryProposal,
} from "@/shared/api/system";
import {
  CredentialMemoryError,
  looksLikeCredential,
} from "./memoryCredentialGuard";
import type { MemoryProposal } from "./meProposals";
import { loadMeFile } from "./meFile";
import { publishMeFile } from "./mePublish";

export { CredentialMemoryError } from "./memoryCredentialGuard";

export async function approveMemoryProposal(
  proposal: MemoryProposal,
  content = proposal.content,
  topic = proposal.topic,
): Promise<void> {
  const edited = content.trim();
  if (!edited) throw new Error("Memory content is required.");
  if (looksLikeCredential(edited)) throw new CredentialMemoryError();

  const result = await approveMemoryProposalInBackend(
    proposal.id,
    edited,
    topic?.trim() || null,
  );
  if (result.approved && result.refreshProjection) {
    // Projection is derived output. Approval remains complete if this
    // best-effort refresh fails and will be repaired by the next refresh.
    const state = await loadMeFile();
    if (state.status === "present") {
      await publishMeFile(state.contents).catch(() => {});
    }
  }
}

export async function declineMemoryProposal(
  proposal: MemoryProposal,
): Promise<void> {
  await resolveMemoryProposal(proposal.id, {
    content: proposal.content,
    topic: proposal.topic,
  });
}
