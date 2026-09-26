import {
  cancelSession,
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

const CLEANUP_TIMEOUT_MS = 3_000;
const TIMED_OUT = Symbol("zeroToolOneShotTimedOut");

/**
 * Run a hidden, tool-free one-shot with an explicit provider/model.
 *
 * Both security explanations and memory extraction feed untrusted text to a
 * model. The temporary session has every extension removed before prompting,
 * and is deleted afterward so it never accumulates in session history. Every
 * lifecycle step is bounded and best-effort; one-shot failure must not affect
 * the foreground chat.
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
  const deadline = Date.now() + timeoutMs;
  let sessionId: string | null = null;
  try {
    const sessionPromise = observe(
      newSession("/tmp", {
        hidden: true,
        providerId: target.providerId,
      }),
    );
    const session = await withTimeout(sessionPromise, remainingMs(deadline));
    if (session === TIMED_OUT) {
      void sessionPromise.then((lateSession) =>
        boundedCleanup(lateSession.sessionId),
      );
      return null;
    }
    sessionId = session.sessionId;

    const setup = observe(
      setupZeroToolSession(sessionId, systemPrompt, target),
    );
    const configured = await withTimeout(setup, remainingMs(deadline));
    if (configured === TIMED_OUT) return null;

    const output = await withTimeout(
      promptForText(sessionId, [{ type: "text", text: userPrompt }], timeoutMs),
      remainingMs(deadline),
    );
    return output === TIMED_OUT ? null : output;
  } catch {
    return null;
  } finally {
    if (sessionId) {
      await boundedCleanup(sessionId);
    }
  }
}

async function setupZeroToolSession(
  sessionId: string,
  systemPrompt: string,
  target: OneShotExecutionTarget,
): Promise<void> {
  if (target.modelId) await setModel(sessionId, target.modelId);
  await removeAllSessionExtensions(sessionId);
  await setSessionSystemPrompt(sessionId, systemPrompt);
}

async function boundedCleanup(sessionId: string): Promise<void> {
  await withTimeout(
    (async () => {
      try {
        await cancelSession(sessionId);
      } catch {
        // Best-effort cancellation.
      }
    })(),
    CLEANUP_TIMEOUT_MS,
  );
  await withTimeout(
    (async () => {
      try {
        await deleteSession(sessionId);
      } catch {
        // Best-effort cleanup must not hide a useful one-shot result.
      }
    })(),
    CLEANUP_TIMEOUT_MS,
  );
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

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function observe<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMED_OUT> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timeoutId = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
