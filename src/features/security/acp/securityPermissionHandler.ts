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

  return new Promise<RequestPermissionResponse>((resolve) => {
    useSecurityConfirmationStore.getState().enqueue({
      request,
      title: request.toolCall.title ?? "Tool call",
      command: stringifyCommand(request.toolCall.rawInput),
      alertText,
      resolve,
    });
  });
}
