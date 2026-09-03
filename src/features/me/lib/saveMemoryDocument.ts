import {
  readTextFile,
  resolveMemoryProposal,
  writeTextFile,
} from "@/shared/api/system";
import { removedMemoryEntries } from "./editSummary";
import {
  CredentialMemoryError,
  looksLikeCredential,
} from "./memoryCredentialGuard";

/** One reviewed Settings edit for either the spine or a topic document. */
export async function saveMemoryDocument({
  path,
  contents,
  topic,
}: {
  path: string;
  contents: string;
  topic: string | null;
}): Promise<void> {
  if (looksLikeCredential(contents)) throw new CredentialMemoryError();

  const before = await readTextFile(path)
    .then((payload) => payload.contents)
    .catch(() => "");
  const removed = removedMemoryEntries(before, contents);

  // The edit must land before its deletions become durable suppression
  // decisions. A failed write must not suppress content still in the file.
  await writeTextFile(path, contents);
  for (const entry of removed) {
    await resolveMemoryProposal(`manual-delete-${crypto.randomUUID()}`, {
      content: entry,
      topic,
    });
  }
}
