import type {
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolCallContent,
} from "@agentclientprotocol/sdk";
import {
  allowOptionId,
  SECURITY_ALERT_MARKER,
  useSecurityConfirmationStore,
} from "@/features/security/stores/securityConfirmationStore";
import {
  alertLacksExplanation,
  extractConfidence,
  inferSecurityExplanation,
} from "@/features/security/lib/inferExplanation";
import { readDefaultProviderReadiness } from "@/features/providers/defaultProviderReadiness";

function textFromContentBlock(block: ContentBlock): string | null {
  if (block.type === "text") {
    return block.text;
  }
  return null;
}

function collectContentText(
  content: ToolCallContent[] | null | undefined,
): string {
  if (!content) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "content") {
      const text = textFromContentBlock(item.content);
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n\n");
}

function stringifyCommand(rawInput: unknown): string | null {
  if (rawInput == null) {
    return null;
  }
  if (typeof rawInput === "string") {
    return rawInput;
  }
  if (typeof rawInput === "object") {
    const record = rawInput as Record<string, unknown>;
    const command = record.command ?? record.cmd ?? record.script;
    if (typeof command === "string") {
      return command;
    }
    try {
      return JSON.stringify(rawInput, null, 2);
    } catch {
      return null;
    }
  }
  return String(rawInput);
}

function isSecurityRequest(alertText: string): boolean {
  return alertText.includes(SECURITY_ALERT_MARKER);
}

/**
 * ACP permission handler. Security findings (identified by the backend's
 * "🔒 Security Alert" marker) are surfaced to the user via a confirmation
 * modal; all other permission requests are auto-approved to preserve Berd's
 * existing no-friction tool behavior.
 *
 * When the alert lacks a human-readable explanation (ML-only detections),
 * a lightweight LLM call infers a likely reason for the flag and surfaces it
 * in the modal alongside the detection confidence.
 */
export function handleSecurityPermissionRequest(
  request: RequestPermissionRequest,
): Promise<RequestPermissionResponse> {
  const alertText = collectContentText(request.toolCall.content);

  if (!isSecurityRequest(alertText)) {
    return Promise.resolve({
      outcome: { outcome: "selected", optionId: allowOptionId(request) },
    });
  }

  const command = stringifyCommand(request.toolCall.rawInput);

  // Show the modal immediately — inference runs in the background
  const promise = new Promise<RequestPermissionResponse>((resolve) => {
    useSecurityConfirmationStore.getState().enqueue({
      request,
      title: request.toolCall.title ?? "Tool call",
      command,
      alertText,
      resolve,
    });
  });

  // If the alert only has confidence (no explanation), infer one
  if (command && alertLacksExplanation(alertText)) {
    const store = useSecurityConfirmationStore.getState();
    store.setInferredExplanation({ status: "loading" });

    const confidence = extractConfidence(alertText);
    readDefaultProviderReadiness()
      .then(async (readiness) => {
        if (readiness.status === "needs_setup") {
          return { status: "needs_setup" as const };
        }

        // If readiness could not be confirmed, still try the inference. The
        // actual Goose request is the most reliable availability check and
        // preserves explanations during transient readiness-check failures.
        const text = await inferSecurityExplanation(command, confidence);
        return text
          ? { status: "done" as const, text }
          : { status: "failed" as const };
      })
      .then((result) => {
        const current = useSecurityConfirmationStore.getState();
        // Only update if the same alert is still pending
        if (current.pending?.request === request) {
          current.setInferredExplanation(result);
        }
      })
      .catch(() => {
        const current = useSecurityConfirmationStore.getState();
        if (current.pending?.request === request) {
          current.setInferredExplanation({ status: "failed" });
        }
      });
  }

  return promise;
}
