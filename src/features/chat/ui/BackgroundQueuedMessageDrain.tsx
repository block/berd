import { useBackgroundQueuedMessageDrain } from "@/features/chat/hooks/useBackgroundQueuedMessageDrain";

export function BackgroundQueuedMessageDrain({
  sessionId,
  ownerReady = true,
}: {
  sessionId?: string;
  ownerReady?: boolean;
} = {}) {
  useBackgroundQueuedMessageDrain(sessionId, ownerReady);
  return null;
}
