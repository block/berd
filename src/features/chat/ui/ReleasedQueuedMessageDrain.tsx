import { useReleasedQueuedMessageDrain } from "@/features/chat/hooks/useReleasedQueuedMessageDrain";

export function ReleasedQueuedMessageDrain({
  sessionId,
  ownerReady = true,
}: {
  sessionId?: string;
  ownerReady?: boolean;
} = {}) {
  useReleasedQueuedMessageDrain(sessionId, ownerReady);
  return null;
}
