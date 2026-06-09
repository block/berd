import type { ComponentProps } from "react";
import { TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import { MessageTimeline } from "./MessageTimeline";
import { VirtualMessageTimeline } from "./VirtualMessageTimeline";

type MessageTimelineProps = ComponentProps<typeof MessageTimeline>;

interface VirtualMessageTimelineGateProps extends MessageTimelineProps {
  sessionId: string;
}

export function VirtualMessageTimelineGate({
  sessionId,
  ...timelineProps
}: VirtualMessageTimelineGateProps) {
  const virtualRendererExperiment = useExperiment(
    TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID,
  );

  if (!virtualRendererExperiment?.enabled) {
    return <MessageTimeline {...timelineProps} />;
  }

  return <VirtualMessageTimeline sessionId={sessionId} {...timelineProps} />;
}
