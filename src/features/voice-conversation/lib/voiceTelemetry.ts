import { track } from "@/shared/telemetry/client";
import { berdVoiceConversationStarted } from "@/shared/telemetry/events";

/** A native voice conversation completed startup successfully. */
export function trackVoiceConversationStarted(): void {
  track(berdVoiceConversationStarted());
}
