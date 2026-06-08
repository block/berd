import * as acpApi from "./acpApi";
import { perfLog } from "@/shared/lib/perfLog";

interface PreparedSession {
  providerId: string;
  workingDir: string;
  /**
   * Last model id this window successfully applied via setModel. Tracked so
   * repeat applies of the same model skip the wire call.
   */
  modelId?: string;
}

const prepared = new Map<string, PreparedSession>();

export async function prepareSession(
  sessionId: string,
  providerId: string,
  workingDir: string,
): Promise<void> {
  const sid = sessionId.slice(0, 8);

  const existing = prepared.get(sessionId);
  if (existing) {
    const tReuse = performance.now();
    let changed = false;
    if (existing.workingDir !== workingDir) {
      await acpApi.updateWorkingDir(sessionId, workingDir);
      existing.workingDir = workingDir;
      changed = true;
    }
    if (existing.providerId !== providerId) {
      const tProv = performance.now();
      await acpApi.setProvider(sessionId, providerId);
      perfLog(
        `[perf:prepare] ${sid} reuse setProvider(${providerId}) in ${(performance.now() - tProv).toFixed(1)}ms`,
      );
      existing.providerId = providerId;
      // A provider change rebuilds the backend provider with that provider's
      // default model, so the last model we applied no longer reflects
      // backend state.
      delete existing.modelId;
      changed = true;
    }
    perfLog(
      `[perf:prepare] ${sid} reuse existing session (updates=${changed}) in ${(performance.now() - tReuse).toFixed(1)}ms`,
    );
    return;
  }

  const tLoad = performance.now();
  await acpApi.loadSession(sessionId, workingDir);
  perfLog(
    `[perf:prepare] ${sid} registry loadSession ok in ${(performance.now() - tLoad).toFixed(1)}ms`,
  );

  const tProv = performance.now();
  await acpApi.setProvider(sessionId, providerId);
  perfLog(
    `[perf:prepare] ${sid} registry setProvider(${providerId}) in ${(performance.now() - tProv).toFixed(1)}ms`,
  );

  const entry = { providerId, workingDir };
  prepared.set(sessionId, entry);

  return;
}

/**
 * Apply a model to a session, skipping the wire call when this window already
 * applied the same model.
 */
export async function applySessionModel(
  sessionId: string,
  modelId: string,
): Promise<void> {
  const sid = sessionId.slice(0, 8);
  const entry = prepared.get(sessionId);
  if (entry?.modelId === modelId) {
    perfLog(`[perf:prepare] ${sid} skip setModel(${modelId}) — unchanged`);
    return;
  }

  try {
    await acpApi.setModel(sessionId, modelId);
  } catch (error) {
    // Drop the cached value so the next attempt retries over the wire.
    if (entry) {
      delete entry.modelId;
    }
    throw error;
  }

  if (entry) {
    entry.modelId = modelId;
  }
}

export function isSessionPrepared(sessionId: string): boolean {
  return prepared.has(sessionId);
}

/** Provider id the session is currently prepared against, if known. */
export function getPreparedProviderId(sessionId: string): string | undefined {
  return prepared.get(sessionId)?.providerId;
}

export function registerPreparedSession(
  sessionId: string,
  providerId: string,
  workingDir: string,
): () => void {
  const previousEntry = prepared.get(sessionId);
  const entry = { providerId, workingDir };

  prepared.set(sessionId, entry);

  return () => {
    prepared.delete(sessionId);
    if (previousEntry) {
      prepared.set(sessionId, previousEntry);
    }
  };
}
