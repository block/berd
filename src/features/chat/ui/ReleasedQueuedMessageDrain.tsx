import { useReleasedQueuedMessageDrain } from "@/features/chat/hooks/useReleasedQueuedMessageDrain";

export function ReleasedQueuedMessageDrain() {
  useReleasedQueuedMessageDrain();
  return null;
}
