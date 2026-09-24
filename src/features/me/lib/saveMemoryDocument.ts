import {
  initializeMemoryStore,
  createTextFile,
  saveReviewedMemoryDocument,
} from "@/shared/api/system";
import {
  CredentialMemoryError,
  looksLikeCredential,
} from "./memoryCredentialGuard";
import {
  normalizeMemoryDocumentText,
  normalizeMemoryProposalTopic,
} from "./memoryTextContract";

/** One reviewed Settings edit for either the spine or a topic document. */
export async function saveMemoryDocument({
  path,
  contents,
  topic,
  create = false,
}: {
  path: string;
  contents: string;
  topic: string | null;
  create?: boolean;
}): Promise<void> {
  const reviewed = normalizeMemoryDocumentText(contents);
  const reviewedTopic = normalizeMemoryProposalTopic(topic);
  if (looksLikeCredential(reviewed)) throw new CredentialMemoryError();

  if (create) {
    await initializeMemoryStore();
    await createTextFile(path, reviewed);
    return;
  }

  await saveReviewedMemoryDocument(path, reviewed, reviewedTopic);
}
