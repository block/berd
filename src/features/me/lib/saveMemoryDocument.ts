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
  expectedContents = null,
}: {
  path: string;
  contents: string;
  topic: string | null;
  create?: boolean;
  expectedContents?: string | null;
}): Promise<void> {
  const reviewed = normalizeMemoryDocumentText(contents);
  const reviewedTopic = normalizeMemoryProposalTopic(topic);
  if (looksLikeCredential(reviewed)) throw new CredentialMemoryError();

  if (create) {
    await initializeMemoryStore();
    await createTextFile(path, reviewed);
    return;
  }

  const expected =
    expectedContents === null
      ? null
      : normalizeMemoryDocumentText(expectedContents);
  await saveReviewedMemoryDocument(path, reviewed, reviewedTopic, expected);
}
