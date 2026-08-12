import { perfLog } from "@/shared/lib/perfLog";
import type { MessageMetadata } from "@/shared/types/messages";

export interface ActiveMessagePreset {
  messageId: string;
  metadata?: Pick<MessageMetadata, "personaId" | "personaName">;
}

const activeMessagePresets = new Map<string, ActiveMessagePreset>();

interface LivePerf {
  sendStartedAt: number;
  firstChunkAt: number | null;
  chunkCount: number;
}

const livePerf = new Map<string, LivePerf>();

export function setActiveMessageId(
  sessionId: string,
  messageId: string,
  metadata?: ActiveMessagePreset["metadata"],
): void {
  activeMessagePresets.set(sessionId, { messageId, metadata });
  livePerf.set(sessionId, {
    sendStartedAt: performance.now(),
    firstChunkAt: null,
    chunkCount: 0,
  });
}

export function getActiveMessagePreset(
  sessionId: string,
): ActiveMessagePreset | undefined {
  return activeMessagePresets.get(sessionId);
}

export function recordLiveAgentMessageChunk(sessionId: string): void {
  const perf = livePerf.get(sessionId);
  if (!perf) {
    return;
  }

  perf.chunkCount += 1;
  if (perf.firstChunkAt === null) {
    perf.firstChunkAt = performance.now();
    const sid = sessionId.slice(0, 8);
    perfLog(
      `[perf:stream] ${sid} first agent_message_chunk at ttft=${(perf.firstChunkAt - perf.sendStartedAt).toFixed(1)}ms`,
    );
  }
}

export function clearActiveMessageId(sessionId: string): void {
  activeMessagePresets.delete(sessionId);
  const perf = livePerf.get(sessionId);
  if (perf) {
    const sid = sessionId.slice(0, 8);
    const total = performance.now() - perf.sendStartedAt;
    const ttft =
      perf.firstChunkAt !== null
        ? (perf.firstChunkAt - perf.sendStartedAt).toFixed(1)
        : "n/a";
    perfLog(
      `[perf:stream] ${sid} stream ended - ttft=${ttft}ms total=${total.toFixed(1)}ms chunks=${perf.chunkCount}`,
    );
    livePerf.delete(sessionId);
  }
}

export function clearActiveMessageTracking(): void {
  activeMessagePresets.clear();
  livePerf.clear();
}
