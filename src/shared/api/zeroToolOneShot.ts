import {
  deleteSession,
  newSession,
  promptForText,
  setModel,
  setSessionSystemPrompt,
} from "@/shared/api/acpApi";
import { getClient } from "@/shared/api/acpConnection";

export interface OneShotExecutionTarget {
  providerId: string;
  modelId?: string;
}

/**
 * Run a hidden, tool-free one-shot with an explicit provider/model.
 *
 * Both security explanations and memory extraction feed untrusted text to a
 * model. The temporary session has every extension removed before prompting,
 * and is deleted afterward so it never accumulates in session history.
 */
export async function runZeroToolOneShot({
  userPrompt,
  systemPrompt,
  target,
  timeoutMs,
}: {
  userPrompt: string;
  systemPrompt: string;
  target: OneShotExecutionTarget;
  timeoutMs: number;
}): Promise<string | null> {
  const session = await newSession("/tmp", {
    hidden: true,
    providerId: target.providerId,
  });
  try {
    if (target.modelId) await setModel(session.sessionId, target.modelId);
    await removeAllSessionExtensions(session.sessionId);
    await setSessionSystemPrompt(session.sessionId, systemPrompt);
    return await promptForText(
      session.sessionId,
      [{ type: "text", text: userPrompt }],
      timeoutMs,
    );
  } finally {
    try {
      await deleteSession(session.sessionId);
    } catch {
      // Best-effort cleanup must not hide a useful one-shot result.
    }
  }
}

async function removeAllSessionExtensions(sessionId: string): Promise<void> {
  const client = await getClient();
  const { extensions } = await client.goose.GooseUnstableSessionExtensionsList({
    sessionId,
  });
  await Promise.all(
    extensions.map(({ extensionKey }) =>
      client.goose.GooseUnstableSessionExtensionsRemove({
        sessionId,
        extensionKey,
      }),
    ),
  );
}
