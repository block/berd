import type {
  ActionRequiredContent,
  ImageContent,
  McpAppContent,
  Message,
  MessageContent,
  MessageMetadata,
  RedactedThinkingContent,
  ReasoningContent,
  SystemNotificationContent,
  TextContent,
  ThinkingContent,
  ToolRequestContent,
  ToolResponseContent,
} from "@/shared/types/messages";

export interface RevisionParts {
  renderRevision: string;
  heightRevision: string;
}

export function buildMessageRevisions(
  message: Message,
  visibleContent: readonly MessageContent[] = message.content,
): RevisionParts {
  if (visibleContent.length === 1 && visibleContent[0]?.type === "text") {
    return buildSingleTextMessageRevisions(message, visibleContent[0]);
  }

  const contentRevisions = buildContentRevisionParts(visibleContent);

  return {
    renderRevision: [
      "message",
      message.id,
      message.role,
      String(message.created),
      renderMetadataRevision(message.metadata),
      contentRevisions.renderRevision,
    ].join(":"),
    heightRevision: [
      "message-height",
      message.id,
      message.role,
      heightMetadataRevision(message.metadata),
      contentRevisions.heightRevision,
    ].join(":"),
  };
}

function buildSingleTextMessageRevisions(
  message: Message,
  content: TextContent,
): RevisionParts {
  const revision = textRevision(content.text);
  const renderRevision = `message:${message.id}:${message.role}:${String(
    message.created,
  )}:${renderMetadataRevision(message.metadata)}:text:${revision}:${annotationsRevision(
    content.annotations,
  )}:${speechRevision(content)}`;
  const heightRevision = `message-height:${message.id}:${
    message.role
  }:${heightMetadataRevision(message.metadata)}:text-height:${revision}:${speechRevision(
    content,
  )}`;

  return {
    renderRevision,
    heightRevision,
  };
}

function buildContentRevisionParts(
  content: readonly MessageContent[],
): RevisionParts {
  if (content.length === 0) {
    return {
      renderRevision: "",
      heightRevision: "",
    };
  }

  const renderRevisions: string[] = [];
  const heightRevisions: string[] = [];

  for (const block of content) {
    const revisions = buildSingleContentRevisionParts(block);
    renderRevisions.push(revisions.renderRevision);
    heightRevisions.push(revisions.heightRevision);
  }

  return {
    renderRevision: renderRevisions.join("|"),
    heightRevision: heightRevisions.join("|"),
  };
}

function buildSingleContentRevisionParts(
  content: MessageContent,
): RevisionParts {
  switch (content.type) {
    case "text": {
      const revision = textRevision(content.text);
      return {
        renderRevision: [
          "text",
          revision,
          annotationsRevision(content.annotations),
          speechRevision(content),
        ].join(":"),
        heightRevision: ["text-height", revision, speechRevision(content)].join(
          ":",
        ),
      };
    }
    case "image":
    case "toolRequest":
    case "toolResponse":
    case "mcpApp":
    case "thinking":
    case "redactedThinking":
    case "reasoning":
    case "actionRequired":
    case "systemNotification":
      return {
        renderRevision: buildContentRenderRevision(content),
        heightRevision: buildContentHeightRevision(content),
      };
    default:
      return assertNever(content);
  }
}

function speechRevision(content: TextContent): string {
  const speech = content.speech;
  if (!speech) return "";
  return [
    speech.status,
    speech.spokenThrough ?? "",
    speech.confidence ?? "",
    speech.interruptionCause ?? "",
  ].join(":");
}

export function buildContentRenderRevision(content: MessageContent): string {
  switch (content.type) {
    case "text":
      return textRenderRevision(content);
    case "image":
      return imageRenderRevision(content);
    case "toolRequest":
      return toolRequestRenderRevision(content);
    case "toolResponse":
      return toolResponseRenderRevision(content);
    case "mcpApp":
      return mcpAppRenderRevision(content);
    case "thinking":
      return thinkingRenderRevision(content);
    case "redactedThinking":
      return redactedThinkingRenderRevision(content);
    case "reasoning":
      return reasoningRenderRevision(content);
    case "actionRequired":
      return actionRequiredRenderRevision(content);
    case "systemNotification":
      return systemNotificationRenderRevision(content);
    default:
      return assertNever(content);
  }
}

export function buildContentHeightRevision(content: MessageContent): string {
  switch (content.type) {
    case "text":
      return textHeightRevision(content);
    case "image":
      return imageHeightRevision(content);
    case "toolRequest":
      return toolRequestHeightRevision(content);
    case "toolResponse":
      return toolResponseHeightRevision(content);
    case "mcpApp":
      return mcpAppHeightRevision(content);
    case "thinking":
      return thinkingHeightRevision(content);
    case "redactedThinking":
      return "redactedThinking";
    case "reasoning":
      return reasoningHeightRevision(content);
    case "actionRequired":
      return actionRequiredHeightRevision(content);
    case "systemNotification":
      return systemNotificationHeightRevision(content);
    default:
      return assertNever(content);
  }
}

export function buildBlockId(content: MessageContent, index: number): string {
  switch (content.type) {
    case "toolRequest":
    case "toolResponse":
    case "mcpApp":
    case "actionRequired":
      return `${content.type}:${content.id}`;
    case "text":
    case "image":
    case "thinking":
    case "redactedThinking":
    case "reasoning":
    case "systemNotification":
      return `${content.type}:${index}`;
    default:
      return assertNever(content);
  }
}

export function stableValueRevision(value: unknown): string {
  if (Array.isArray(value) && value.length === 0) {
    return EMPTY_ARRAY_REVISION;
  }

  return hashString(stableStringify(value));
}

const EMPTY_ARRAY_REVISION = hashString("[]");
const DEFAULT_RENDER_METADATA_REVISION = [
  "metadata",
  "",
  EMPTY_ARRAY_REVISION,
  EMPTY_ARRAY_REVISION,
  "",
  "",
  "",
  "",
  "",
].join(":");
const DEFAULT_HEIGHT_METADATA_REVISION = [
  "metadata-height",
  "",
  EMPTY_ARRAY_REVISION,
  EMPTY_ARRAY_REVISION,
  "",
  "",
].join(":");

function textRenderRevision(content: TextContent): string {
  return [
    "text",
    textRevision(content.text),
    annotationsRevision(content.annotations),
  ].join(":");
}

function textHeightRevision(content: TextContent): string {
  return ["text-height", textRevision(content.text)].join(":");
}

function imageRenderRevision(content: ImageContent): string {
  return [
    "image",
    content.mimeType ?? "",
    textRevision(content.data ?? ""),
    content.uri ?? "",
    annotationsRevision(content.annotations),
  ].join(":");
}

function imageHeightRevision(content: ImageContent): string {
  return [
    "image-height",
    content.mimeType ?? "",
    textRevision(content.data ?? ""),
    content.uri ?? "",
  ].join(":");
}

function toolRequestRenderRevision(content: ToolRequestContent): string {
  return [
    "toolRequest",
    content.id,
    content.name,
    content.toolName ?? "",
    content.extensionName ?? "",
    content.status,
    content.toolKind ?? "",
    content.subagentAgentName ?? "",
    content.subagentTaskLabel ?? "",
    String(content.subagentTaskIsConfigured ?? false),
    stableValueRevision(content.arguments),
    stableValueRevision(content.locations ?? []),
    String(content.startedAt ?? ""),
    stableValueRevision(content.chainSummary ?? null),
    annotationsRevision(content.annotations),
  ].join(":");
}

function toolRequestHeightRevision(content: ToolRequestContent): string {
  return [
    "toolRequest-height",
    content.id,
    content.name,
    content.toolName ?? "",
    content.extensionName ?? "",
    content.status,
    content.toolKind ?? "",
    content.subagentAgentName ?? "",
    content.subagentTaskLabel ?? "",
    String(content.subagentTaskIsConfigured ?? false),
    stableValueRevision(content.arguments),
    stableValueRevision(content.locations ?? []),
    stableValueRevision(content.chainSummary ?? null),
  ].join(":");
}

function toolResponseRenderRevision(content: ToolResponseContent): string {
  return [
    "toolResponse",
    content.id,
    content.name,
    textRevision(content.result),
    stableValueRevision(content.structuredContent ?? null),
    String(content.isError),
    annotationsRevision(content.annotations),
  ].join(":");
}

function toolResponseHeightRevision(content: ToolResponseContent): string {
  return [
    "toolResponse-height",
    content.id,
    content.name,
    textRevision(content.result),
    stableValueRevision(content.structuredContent ?? null),
    String(content.isError),
  ].join(":");
}

function mcpAppRenderRevision(content: McpAppContent): string {
  return ["mcpApp", content.id, stableValueRevision(content.payload)].join(":");
}

function mcpAppHeightRevision(content: McpAppContent): string {
  return [
    "mcpApp-height",
    content.id,
    stableValueRevision(content.payload),
  ].join(":");
}

function thinkingRenderRevision(content: ThinkingContent): string {
  return [
    "thinking",
    textRevision(content.text),
    annotationsRevision(content.annotations),
  ].join(":");
}

function thinkingHeightRevision(content: ThinkingContent): string {
  return ["thinking-height", textRevision(content.text)].join(":");
}

function redactedThinkingRenderRevision(
  content: RedactedThinkingContent,
): string {
  return ["redactedThinking", annotationsRevision(content.annotations)].join(
    ":",
  );
}

function reasoningRenderRevision(content: ReasoningContent): string {
  return [
    "reasoning",
    textRevision(content.text),
    annotationsRevision(content.annotations),
  ].join(":");
}

function reasoningHeightRevision(content: ReasoningContent): string {
  return ["reasoning-height", textRevision(content.text)].join(":");
}

function actionRequiredRenderRevision(content: ActionRequiredContent): string {
  return [
    "actionRequired",
    content.id,
    content.actionType,
    content.message ?? "",
    content.toolName ?? "",
    stableValueRevision(content.arguments ?? null),
    stableValueRevision(content.schema ?? null),
    annotationsRevision(content.annotations),
  ].join(":");
}

function actionRequiredHeightRevision(content: ActionRequiredContent): string {
  return [
    "actionRequired-height",
    content.id,
    content.actionType,
    content.message ?? "",
    content.toolName ?? "",
    stableValueRevision(content.arguments ?? null),
    stableValueRevision(content.schema ?? null),
  ].join(":");
}

function systemNotificationRenderRevision(
  content: SystemNotificationContent,
): string {
  return [
    "systemNotification",
    content.notificationType,
    textRevision(content.text),
    annotationsRevision(content.annotations),
  ].join(":");
}

function systemNotificationHeightRevision(
  content: SystemNotificationContent,
): string {
  return [
    "systemNotification-height",
    content.notificationType,
    textRevision(content.text),
  ].join(":");
}

function renderMetadataRevision(metadata: MessageMetadata | undefined): string {
  if (!metadata) {
    return "metadata:none";
  }

  if (hasDefaultRevisionMetadata(metadata)) {
    return DEFAULT_RENDER_METADATA_REVISION;
  }

  return [
    "metadata",
    metadata.completionStatus ?? "",
    metadata.delivery ?? "",
    metadata.origin ?? "",
    metadata.voiceConversationDebugEvent ?? "",
    stableValueRevision(metadata.attachments ?? []),
    stableValueRevision(metadata.chips ?? []),
    metadata.personaId ?? "",
    metadata.personaName ?? "",
    metadata.providerId ?? "",
    metadata.targetPersonaId ?? "",
    metadata.targetPersonaName ?? "",
  ].join(":");
}

function heightMetadataRevision(metadata: MessageMetadata | undefined): string {
  if (!metadata) {
    return "metadata-height:none";
  }

  if (hasDefaultRevisionMetadata(metadata)) {
    return DEFAULT_HEIGHT_METADATA_REVISION;
  }

  return [
    "metadata-height",
    metadata.completionStatus ?? "",
    metadata.delivery ?? "",
    metadata.origin ?? "",
    metadata.voiceConversationDebugEvent ?? "",
    stableValueRevision(metadata.attachments ?? []),
    stableValueRevision(metadata.chips ?? []),
    metadata.personaName ?? "",
    metadata.targetPersonaName ?? "",
  ].join(":");
}

function annotationsRevision(annotations: unknown): string {
  return annotations == null ? "" : stableValueRevision(annotations);
}

function hasDefaultRevisionMetadata(metadata: MessageMetadata): boolean {
  return (
    !metadata.completionStatus &&
    !metadata.delivery &&
    !metadata.origin &&
    !metadata.voiceConversationDebugEvent &&
    !metadata.attachments?.length &&
    !metadata.chips?.length &&
    !metadata.personaId &&
    !metadata.personaName &&
    !metadata.providerId &&
    !metadata.targetPersonaId &&
    !metadata.targetPersonaName
  );
}

function textRevision(value: string): string {
  return `${value.length}:${hashString(value)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled message content type: ${JSON.stringify(value)}`);
}
