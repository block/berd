import { useMemo, type ComponentProps, type RefObject } from "react";
import { TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID } from "@/features/experiments/experimentDefinitions";
import { useExperiment } from "@/features/experiments/experimentPreferences";
import type { TranscriptSearchBackend } from "@/features/chat/lib/transcriptSearchBackend";
import { MessageTimeline } from "./MessageTimeline";
import { VirtualMessageTimeline } from "./VirtualMessageTimeline";
import { createLoadedTranscriptState } from "../transcript/virtual/react/useTranscriptVirtualTimeline";
import { useChatStore } from "../stores/chatStore";

type MessageTimelineProps = ComponentProps<typeof MessageTimeline>;

interface VirtualMessageTimelineGateProps extends MessageTimelineProps {
  sessionId: string;
  /** Filled by the virtual timeline with its indexed search backend. The
      classic timeline mounts everything, so the search controller falls back
      to direct DOM matching when this stays null. */
  searchBackendRef?: RefObject<TranscriptSearchBackend | null>;
}

export function VirtualMessageTimelineGate({
  sessionId,
  searchBackendRef,
  ...timelineProps
}: VirtualMessageTimelineGateProps) {
  const virtualRendererExperiment = useExperiment(
    TRANSCRIPT_VIRTUAL_RENDERER_EXPERIMENT_ID,
  );

  const virtualRendererEnabled = virtualRendererExperiment?.enabled ?? false;
  const loadedTranscriptEpoch = useChatStore(
    (state) => state.loadedTranscriptEpochBySession[sessionId] ?? 0,
  );
  const loadedTranscript = useMemo(
    () =>
      virtualRendererEnabled
        ? createLoadedTranscriptState(sessionId, loadedTranscriptEpoch)
        : null,
    [loadedTranscriptEpoch, sessionId, virtualRendererEnabled],
  );

  if (!loadedTranscript) {
    return <MessageTimeline {...timelineProps} />;
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
