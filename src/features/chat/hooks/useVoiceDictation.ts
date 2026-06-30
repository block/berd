import { useCallback, useMemo, useRef } from "react";
import { useProfileCapability } from "@/shared/profile/capabilities";
import { isPromiseLike } from "@/shared/lib/isPromiseLike";
import type { ChatAttachmentDraft } from "@/shared/types/messages";
import { useOpenAiRealtimeDictation } from "./useOpenAiRealtimeDictation";
import {
  DEFAULT_AUTO_SUBMIT_PHRASES_RAW,
  getAutoSubmitMatch,
  parseAutoSubmitPhrases,
  replaceTrailingTranscribedText,
} from "../lib/voiceInput";

interface UseVoiceDictationOptions {
  text: string;
  setText: (value: string) => void;
  attachments: ChatAttachmentDraft[];
  clearAttachments: () => void;
  selectedPersonaId: string | null;
  onSend: (
    text: string,
    personaId?: string,
    attachments?: ChatAttachmentDraft[],
  ) => boolean | Promise<boolean>;
  onAutoSubmit?: (text: string) => boolean | Promise<boolean>;
  resetTextarea: () => void;
  /**
   * When true, auto-submit on trigger phrase will NOT call `onSend`.
   * Instead, the trigger phrase is stripped and the remaining transcription
   * is left in the textarea for the user to review and send manually.
   */
  isSendLocked?: boolean;
}

export function useVoiceDictation({
  text,
  setText,
  attachments,
  clearAttachments,
  selectedPersonaId,
  onSend,
  onAutoSubmit,
  resetTextarea,
  isSendLocked = false,
}: UseVoiceDictationOptions) {
  const autoSubmitPhrases = useMemo(
    () => parseAutoSubmitPhrases(DEFAULT_AUTO_SUBMIT_PHRASES_RAW),
    [],
  );
  const stopRecordingRef = useRef<() => void>(() => {});
  const textRef = useRef(text);
  textRef.current = text;
  const lastRealtimeTranscriptRef = useRef("");

  const finishAutoSubmit = useCallback(
    (merged: string) => {
      if (isSendLocked) {
        setText(merged);
        textRef.current = merged;
        return;
      }

      const sendResult = onAutoSubmit
        ? onAutoSubmit(merged.trim())
        : onSend(
            merged.trim(),
            selectedPersonaId ?? undefined,
            attachments.length > 0 ? attachments : undefined,
          );

      if (isPromiseLike<boolean>(sendResult)) {
        void sendResult
          .then((accepted) => {
            if (accepted === false) {
              setText(merged);
              textRef.current = merged;
              return;
            }
            setText("");
            textRef.current = "";
            lastRealtimeTranscriptRef.current = "";
            clearAttachments();
            resetTextarea();
          })
          .catch(() => {
            setText(merged);
            textRef.current = merged;
          });
        return;
      }

      if (sendResult === false) {
        setText(merged);
        textRef.current = merged;
        return;
      }

      setText("");
      textRef.current = "";
      lastRealtimeTranscriptRef.current = "";
      clearAttachments();
      resetTextarea();
    },
    [
      attachments,
      clearAttachments,
      isSendLocked,
      onAutoSubmit,
      onSend,
      resetTextarea,
      selectedPersonaId,
      setText,
    ],
  );

  const handleRealtimeTranscript = useCallback(
    (transcript: string) => {
      const previousTranscript = lastRealtimeTranscriptRef.current;
      const latest = textRef.current;
      const merged = replaceTrailingTranscribedText(
        latest,
        previousTranscript,
        transcript,
      );
      const match = getAutoSubmitMatch(transcript, autoSubmitPhrases);

      if (!match) {
        setText(merged);
        textRef.current = merged;
        lastRealtimeTranscriptRef.current = transcript;
        return;
      }

      const textWithoutPhrase = replaceTrailingTranscribedText(
        latest,
        previousTranscript,
        match.textWithoutPhrase,
      );
      if (!textWithoutPhrase.trim()) {
        return;
      }

      stopRecordingRef.current();
      finishAutoSubmit(textWithoutPhrase);
    },
    [autoSubmitPhrases, finishAutoSubmit, setText],
  );

  // Single shared chokepoint for both ChatInput and GlobalComposerPill: a
  // disabled `voiceDictation` capability forces the dictation off (no mic
  // permission/secret requests) and propagates `isEnabled=false`, so the
  // toolbar hides the mic button on both surfaces. Read reactively so a
  // runtime/endpoint `featureToggles.voiceDictation` flip re-renders and hides
  // the mic button live, rather than leaving it stale until an unrelated
  // re-render samples a fresh snapshot.
  const voiceDictationEnabled = useProfileCapability("voiceDictation");

  const dictation = useOpenAiRealtimeDictation({
    disabled: !voiceDictationEnabled,
    onRecordingStart: () => {
      lastRealtimeTranscriptRef.current = "";
    },
    onTranscriptText: handleRealtimeTranscript,
  });
  stopRecordingRef.current = dictation.stopRecording;

  return {
    ...dictation,
    isEnabled: voiceDictationEnabled && dictation.isEnabled,
  };
}
