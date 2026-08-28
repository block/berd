import { useMemo, type ComponentProps, type RefObject } from "react";
import { TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import type { TranscriptSearchBackend } from "@/features/chat/lib/transcriptSearchBackend";
import { MessageTimeline } from "./MessageTimeline";
import { VirtualMessageTimeline } from "./VirtualMessageTimeline";
import { createLoadedTranscriptState } from "../transcript/virtual/react/useTranscriptVirtualTimeline";

type MessageTimelineProps = ComponentProps<typeof MessageTimeline>;

export type TranscriptRendererPolicy = "auto" | "classic";

interface VirtualMessageTimelineGateProps extends MessageTimelineProps {
  sessionId: string;
  rendererPolicy?: TranscriptRendererPolicy;
  /** Filled by the virtual timeline with its indexed search backend. The
      classic timeline mounts everything, so the search controller falls back
      to direct DOM matching when this stays null. */
  searchBackendRef?: RefObject<TranscriptSearchBackend | null>;
}

export function VirtualMessageTimelineGate({
  sessionId,
  rendererPolicy = "auto",
  searchBackendRef,
  ...timelineProps
}: VirtualMessageTimelineGateProps) {
  const virtualRendererExperiment = useExperiment(
    TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID,
  );

  const virtualRendererEnabled = virtualRendererExperiment?.enabled ?? false;
  const useVirtualRenderer =
    rendererPolicy === "auto" && virtualRendererEnabled;
  const loadedTranscript = useMemo(
    () => (useVirtualRenderer ? createLoadedTranscriptState(sessionId) : null),
    [sessionId, useVirtualRenderer],
  );

  if (!loadedTranscript) {
    return <MessageTimeline feedbackSessionId={sessionId} {...timelineProps} />;
  }

  return (
    <VirtualMessageTimeline
      loadedTranscript={loadedTranscript}
      sessionId={sessionId}
      searchBackendRef={searchBackendRef}
      {...timelineProps}
    />
  );
}
