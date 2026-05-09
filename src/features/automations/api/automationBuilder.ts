import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  createSystemNotificationMessage,
  type Message,
  type MessageContent,
  type MessageRole,
} from "@/shared/types/messages";
import { normalizeKgooseJson, type KgooseJson } from "./kgooseAutomations";

export const AUTOMATION_BUILDER_STREAM_EVENT = "automation-builder-stream";
export const AUTOMATION_APPROVAL_TOOL_NAME = "tile__preview_automation";
export const AUTOMATION_CREATE_TOOL_NAME = "tile__create_automation";
export const TILE_RENDER_TOOL_NAME = "tile__render_tile";
export const USER_RESPONSE_CONFIRM_AUTOMATION =
  "User accepted the automation, so it MUST be saved using tile__create_automation.";
export const USER_RESPONSE_CONFIRM_TILE =
  "User accepted the tile, so it MUST be saved using tile__persist_tile.";
const SUMMARY_TILE_TYPE = 4;
const DATABRICKS_MODEL_PROVIDER = 1;
const AUTOMATION_BUILDER_MODEL = {
  name: "goose-claude-4-6-opus",
  provider: DATABRICKS_MODEL_PROVIDER,
};

const AUTOMATION_PREFERENCE_PROMPT =
  "The user came from the Create Automation UI. Only create an automation; dashboard tiles and builderbot automations are not supported in this app. For previews, use tile__render_tile with render_type='automation' and tile_type='summary'. Before calling render_tile, always call tile__describe_tile('summary') FIRST and shape the data argument to that schema exactly. render_type='automation' does not change the summary schema: data must be exactly { title: string, summary: string, details: string }, with details as a markdown string. Do not use any other tile_type. Do not set space_id or spaceId; external systems persist the accepted summary preview as an automation outside the dashboard. The automation instructions you generate must end with a step that explicitly says to call tile__render_tile with render_type='automation', tile_type='summary', schema-valid summary data, and schedule.";

export type AutomationBuilderStatus =
  | "initialized"
  | "idle"
  | "processing"
  | "needClientInput"
  | "terminated"
  | "cancelling"
  | "waitingForPermission"
  | "unknown";

export interface AutomationBuilderStreamEvent {
  streamId: string;
  sessionId: string;
  event:
    | "connected"
    | "messages"
    | "heartbeat"
    | "completed"
    | "error"
    | string;
  id?: string;
  data?: KgooseJson;
  error?: string;
}

export interface PushAutomationBuilderResponse {
  sessionId?: string;
  status?: string | number;
}

export interface CancelAutomationBuilderResponse {
  cancelled?: boolean;
  message?: string;
  sessionStatus?: string | number;
}

export interface CreateAutomationTileResponse {
  tileId?: string;
  success?: boolean;
  errorMsg?: string;
}

interface KgooseMessageContent {
  type?: string | number;
  text?: { text?: string };
  toolRequest?: {
    id?: string;
    status?: string;
    value?: {
      name?: string;
      arguments?: string;
      needsApproval?: boolean;
    };
    error?: string;
    tooltip?: string;
    tooltipCategory?: string;
  };
  toolResponse?: {
    id?: string;
    status?: string;
    results?: Array<{ text?: { text?: string } }>;
    error?: string;
    extensionName?: string;
  };
  thinking?: { thinking?: string };
  redactedThinking?: { data?: string };
}

interface KgooseMessage {
  id?: string;
  role?: string | number;
  created?: string | number;
  content?: KgooseMessageContent[];
  messageContents?: KgooseMessageContent[];
  deleted?: boolean;
  llmCallErrorInfo?: {
    isError?: boolean;
    cause?: string;
  };
}

export interface AutomationBuilderMessagesResponse {
  messages: Message[];
  nextCursor?: string;
  status: AutomationBuilderStatus;
  sessionName?: string;
}

export interface AutomationBuilderDelta {
  streamingMessageId?: string;
  messageContent?: KgooseMessageContent;
  isFinal?: boolean;
  isStart?: boolean;
}

export interface AutomationDraft {
  toolRequestId: string;
  toolName: string;
  title?: string;
  schedule?: string;
  instructions: string[];
  humanReadableInstructions: string[];
  enableNotifications?: boolean;
  timeZone?: string;
  rawArguments: Record<string, unknown>;
  creationMode: "approveTool" | "createTile";
}

export interface AutomationDraftState {
  draft: AutomationDraft | null;
  blockedToolRequest: string | null;
  createRequested: boolean;
  created: boolean;
  createdAutomationId?: string;
  failed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return asRecord(normalizeKgooseJson(parsed));
  } catch {
    return {};
  }
}

function enumLabel(value: string | number | undefined): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function normalizedEnumLabel(value: string | number | undefined): string {
  return enumLabel(value)
    .replace(/^TILE_TYPE_/, "")
    .toLowerCase();
}

function isSummaryTileType(value: string | number | undefined): boolean {
  const normalized = normalizedEnumLabel(value);
  return normalized === String(SUMMARY_TILE_TYPE) || normalized === "summary";
}

function hasSummaryTileType(args: Record<string, unknown>): boolean {
  return (
    isSummaryTileType(args.tileType as string | number | undefined) ||
    isSummaryTileType(args.type as string | number | undefined)
  );
}

function isErrorStatus(value: string | number | undefined): boolean {
  return enumLabel(value).toLowerCase().includes("error");
}

function mapRole(value: string | number | undefined): MessageRole {
  const normalized = enumLabel(value).toLowerCase();
  if (normalized.includes("user") || value === 1) return "user";
  if (normalized.includes("system") || value === 3) return "system";
  return "assistant";
}

function mapTimestamp(value: string | number | undefined): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : Date.now();
}

function mapContent(
  content: KgooseMessageContent,
  index: number,
): MessageContent | null {
  const type = enumLabel(content.type);
  if (content.text || type.includes("TEXT")) {
    return {
      type: "text",
      text: content.text?.text ?? "",
    };
  }

  if (content.toolRequest || type.includes("TOOL_REQUEST")) {
    const request = content.toolRequest ?? {};
    const tool = request.value ?? {};
    const argumentsObject = parseArguments(tool.arguments);
    return {
      type: "toolRequest",
      id: request.id ?? `tool-request-${index}`,
      name: tool.name ?? "tool request",
      toolName: tool.name,
      extensionName: tool.name?.split("__")[0],
      arguments: argumentsObject,
      status: request.status === "error" ? "failed" : "pending",
    };
  }

  if (content.toolResponse || type.includes("TOOL_RESPONSE")) {
    const response = content.toolResponse ?? {};
    const isError = isErrorStatus(response.status) || Boolean(response.error);
    return {
      type: "toolResponse",
      id: response.id ?? `tool-response-${index}`,
      name: response.extensionName ?? "tool response",
      result:
        response.error ??
        response.results
          ?.map((result) => result.text?.text)
          .filter(Boolean)
          .join("\n") ??
        "",
      isError,
    };
  }

  if (content.thinking || type.includes("THINKING")) {
    return {
      type: "thinking",
      text: content.thinking?.thinking ?? "",
    };
  }

  if (content.redactedThinking || type.includes("REDACTED_THINKING")) {
    return { type: "redactedThinking" };
  }

  return null;
}

function mapKgooseMessage(message: KgooseMessage): Message | null {
  if (message.deleted) return null;
  const contents = message.content ?? message.messageContents ?? [];
  const mappedContent = contents
    .map(mapContent)
    .filter((content): content is MessageContent => Boolean(content))
    .filter((content) => {
      return content.type !== "text" || content.text.trim().length > 0;
    });
  if (message.llmCallErrorInfo?.isError && message.llmCallErrorInfo.cause) {
    mappedContent.push({
      type: "systemNotification",
      notificationType: "error",
      text: message.llmCallErrorInfo.cause,
    });
  }
  if (!mappedContent.length) return null;

  return {
    id: message.id ?? crypto.randomUUID(),
    role: mapRole(message.role),
    created: mapTimestamp(message.created),
    content: mappedContent,
    metadata: {
      userVisible: true,
      agentVisible: true,
    },
  };
}

function statusFromKgoose(
  value: string | number | undefined,
): AutomationBuilderStatus {
  const normalized = enumLabel(value).toLowerCase();
  if (normalized.includes("initialized") || value === 1) return "initialized";
  if (normalized.includes("idle") || value === 2) return "idle";
  if (normalized.includes("processing") || value === 3) return "processing";
  if (normalized.includes("need_client_input") || value === 4) {
    return "needClientInput";
  }
  if (normalized.includes("terminated") || value === 5) return "terminated";
  if (normalized.includes("cancelling") || value === 6) return "cancelling";
  if (normalized.includes("waiting_for_permission") || value === 7) {
    return "waitingForPermission";
  }
  return "unknown";
}

export function asMessagesResponse(
  value: unknown,
): AutomationBuilderMessagesResponse {
  const normalized = normalizeKgooseJson(value);
  const record = asRecord(normalized);
  return {
    messages: recordArray(record.messages)
      .map((message) => mapKgooseMessage(message as KgooseMessage))
      .filter((message): message is Message => Boolean(message)),
    nextCursor:
      typeof record.nextCursor === "string" ? record.nextCursor : undefined,
    status: statusFromKgoose(record.status as string | number | undefined),
    sessionName:
      typeof record.sessionName === "string" ? record.sessionName : undefined,
  };
}

export function asStreamResponse(
  value: unknown,
):
  | { type: "messages"; response: AutomationBuilderMessagesResponse }
  | { type: "delta"; delta: AutomationBuilderDelta }
  | null {
  const normalized = normalizeKgooseJson(value);
  const record = asRecord(normalized);
  if (record.getMessagesResponse) {
    return {
      type: "messages",
      response: asMessagesResponse(record.getMessagesResponse),
    };
  }
  if (record.deltaMessageContent) {
    const deltaRecord = asRecord(record.deltaMessageContent);
    const messageContent = asRecord(deltaRecord.messageContent);
    if (
      typeof deltaRecord.streamingMessageId !== "string" ||
      !deltaRecord.streamingMessageId.trim() ||
      !Object.keys(messageContent).length
    ) {
      return null;
    }
    return {
      type: "delta",
      delta: {
        streamingMessageId: deltaRecord.streamingMessageId,
        messageContent: messageContent as KgooseMessageContent,
        isFinal:
          typeof deltaRecord.isFinal === "boolean"
            ? deltaRecord.isFinal
            : undefined,
        isStart:
          typeof deltaRecord.isStart === "boolean"
            ? deltaRecord.isStart
            : undefined,
      },
    };
  }
  return null;
}

export function applyAutomationBuilderDelta(
  messages: Message[],
  delta: AutomationBuilderDelta,
): Message[] {
  const messageId = delta.streamingMessageId;
  if (!messageId || !delta.messageContent) return messages;
  const mappedContent = mapContent(delta.messageContent, 0);
  if (!mappedContent || mappedContent.type !== "text") return messages;
  const text = mappedContent.text;

  const existingIndex = messages.findIndex(
    (message) => message.id === messageId,
  );
  if (existingIndex === -1) {
    return [
      ...messages,
      {
        id: messageId,
        role: "assistant",
        created: Date.now(),
        content: [{ type: "text", text }],
        metadata: {
          userVisible: true,
          agentVisible: true,
          completionStatus: delta.isFinal ? "completed" : "inProgress",
        },
      },
    ];
  }

  return messages.map((message, index) => {
    if (index !== existingIndex) return message;
    const content = [...message.content];
    const lastTextIndex = content.findLastIndex((item) => item.type === "text");
    if (lastTextIndex === -1) {
      content.push({ type: "text", text });
    } else if (delta.isStart) {
      const existingText = content[lastTextIndex];
      if (existingText.type === "text" && existingText.text === text) {
        return message;
      }
      content.push({ type: "text", text });
    } else {
      const existingText = content[lastTextIndex];
      if (existingText.type === "text") {
        content[lastTextIndex] = {
          ...existingText,
          text: `${existingText.text}${text}`,
        };
      }
    }
    return {
      ...message,
      content,
      metadata: {
        ...message.metadata,
        completionStatus: delta.isFinal ? "completed" : "inProgress",
      },
    };
  });
}

export function findAutomationDraftState(
  messages: Message[],
): AutomationDraftState {
  const createToolRequestIds = new Set<string>();
  const state: AutomationDraftState = {
    draft: null,
    blockedToolRequest: null,
    createRequested: false,
    created: false,
    failed: false,
  };

  for (const message of messages) {
    for (const content of message.content) {
      if (content.type === "toolRequest") {
        if (content.toolName === AUTOMATION_CREATE_TOOL_NAME) {
          state.createRequested = true;
          createToolRequestIds.add(content.id);
        }
        const draft = automationDraftFromToolRequest(
          content.id,
          content.toolName ?? content.name,
          content.arguments,
        );
        if (draft) {
          state.draft = draft;
        } else if (
          content.toolName === TILE_RENDER_TOOL_NAME ||
          content.toolName === AUTOMATION_APPROVAL_TOOL_NAME
        ) {
          state.blockedToolRequest =
            "kgoose returned a tile-shaped preview that is not an automation. This builder will not approve it.";
        }
      }
      if (content.type === "toolResponse") {
        if (content.id && createToolRequestIds.has(content.id)) {
          if (content.isError) state.failed = true;
          if (!content.isError) {
            state.created = true;
            state.createdAutomationId =
              parseCreatedAutomationId(content.result) ??
              state.createdAutomationId;
          }
        }
      }
    }
  }

  return state;
}

function automationDraftFromToolRequest(
  toolRequestId: string,
  toolName: string | undefined,
  args: Record<string, unknown>,
): AutomationDraft | null {
  const renderType = normalizedEnumLabel(
    args.renderType as string | number | undefined,
  );
  const hasAutomationRender =
    toolName === TILE_RENDER_TOOL_NAME &&
    renderType === "automation" &&
    hasSummaryTileType(args);
  const isAutomation =
    toolName === AUTOMATION_APPROVAL_TOOL_NAME || hasAutomationRender;

  if (
    !isAutomation ||
    (Object.hasOwn(args, "spaceId") && args.spaceId != null) ||
    (Object.hasOwn(args, "space_id") && args.space_id != null)
  ) {
    return null;
  }

  return {
    toolRequestId,
    toolName: toolName ?? "automation preview",
    title: typeof args.title === "string" ? args.title : undefined,
    schedule: typeof args.schedule === "string" ? args.schedule : undefined,
    instructions: stringArray(args.instructions),
    humanReadableInstructions: stringArray(args.humanReadableInstructions),
    enableNotifications:
      typeof args.enableNotifications === "boolean"
        ? args.enableNotifications
        : undefined,
    timeZone: typeof args.timeZone === "string" ? args.timeZone : undefined,
    rawArguments: args,
    creationMode:
      toolName === TILE_RENDER_TOOL_NAME ? "createTile" : "approveTool",
  };
}

function parseCreatedAutomationId(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = normalizeKgooseJson(JSON.parse(trimmed));
    const record = asRecord(parsed);
    const id = record.automationId ?? record.automationID ?? record.tileId;
    return typeof id === "string" && id.trim() ? id : undefined;
  } catch {
    return undefined;
  }
}

function withTimezone(chatContext: Record<string, unknown>) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timeZone ? { ...chatContext, timeZone } : chatContext;
}

function basePushRequest(sessionId?: string) {
  return {
    ...(sessionId ? { sessionId } : {}),
    chatContext: withTimezone({ source: "SOURCE_REGULAR_CHAT" }),
    sessionName: "New automation",
    metadata: {
      client: "goose-internal",
      feature: "automations-builder",
    },
    profileConfig: {
      userProfile: {
        preferredModel: AUTOMATION_BUILDER_MODEL,
      },
    },
  };
}

export function buildAutomationBuilderUserMessageRequest(
  text: string,
  sessionId?: string,
) {
  const userMessage = {
    messageContents: [
      {
        type: "MESSAGE_TYPE_TEXT",
        text: { text: text.trim() },
      },
    ],
  };
  if (!sessionId) {
    return {
      ...basePushRequest(sessionId),
      messages: [
        {
          hidden: true,
          messageContents: [
            {
              type: "MESSAGE_TYPE_TEXT",
              text: { text: AUTOMATION_PREFERENCE_PROMPT },
            },
          ],
        },
        userMessage,
      ],
    };
  }

  return {
    ...basePushRequest(sessionId),
    messages: [userMessage],
  };
}

function buildToolResponseRequest(
  sessionId: string,
  toolRequestId: string,
  responseText: string,
) {
  return {
    ...basePushRequest(sessionId),
    messages: [
      {
        messageContents: [
          {
            type: "MESSAGE_TYPE_TOOL_RESPONSE",
            toolResponse: {
              id: toolRequestId,
              status: "success",
              results: [
                {
                  text: { text: responseText },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function buildAutomationApprovalRequest(
  sessionId: string,
  toolRequestId: string,
) {
  return buildToolResponseRequest(
    sessionId,
    toolRequestId,
    USER_RESPONSE_CONFIRM_AUTOMATION,
  );
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function buildCreateAutomationTileRequest(draft: AutomationDraft) {
  const timeZone =
    optionalNonEmptyString(draft.timeZone) ??
    Intl.DateTimeFormat().resolvedOptions().timeZone;

  return {
    type: SUMMARY_TILE_TYPE,
    title: optionalNonEmptyString(draft.title),
    schedule: optionalNonEmptyString(draft.schedule),
    instructions: draft.instructions,
    timeZone,
    allowHumanInput:
      typeof draft.rawArguments.allowHumanInput === "boolean"
        ? draft.rawArguments.allowHumanInput
        : undefined,
    enableNotifications: draft.enableNotifications,
  };
}

export function buildTileApprovalAcknowledgementRequest(
  sessionId: string,
  toolRequestId: string,
) {
  return buildToolResponseRequest(
    sessionId,
    toolRequestId,
    USER_RESPONSE_CONFIRM_TILE,
  );
}

export async function pushAutomationBuilderUserMessage(
  text: string,
  sessionId?: string,
): Promise<PushAutomationBuilderResponse> {
  const request = buildAutomationBuilderUserMessageRequest(text, sessionId);
  const response = await invoke<unknown>("push_automation_builder_messages", {
    request,
  });
  return asRecord(
    normalizeKgooseJson(response),
  ) as PushAutomationBuilderResponse;
}

export async function approveAutomationDraft(
  sessionId: string,
  toolRequestId: string,
): Promise<PushAutomationBuilderResponse> {
  const response = await invoke<unknown>("push_automation_builder_messages", {
    request: buildAutomationApprovalRequest(sessionId, toolRequestId),
  });
  return asRecord(
    normalizeKgooseJson(response),
  ) as PushAutomationBuilderResponse;
}

export async function createAutomationTileFromDraft(
  draft: AutomationDraft,
): Promise<CreateAutomationTileResponse> {
  const response = await invoke<unknown>("create_automation_tile", {
    request: buildCreateAutomationTileRequest(draft),
  });
  return asRecord(
    normalizeKgooseJson(response),
  ) as CreateAutomationTileResponse;
}

export async function acknowledgeAutomationTileDraft(
  sessionId: string,
  toolRequestId: string,
): Promise<PushAutomationBuilderResponse> {
  const response = await invoke<unknown>("push_automation_builder_messages", {
    request: buildTileApprovalAcknowledgementRequest(sessionId, toolRequestId),
  });
  return asRecord(
    normalizeKgooseJson(response),
  ) as PushAutomationBuilderResponse;
}

export async function cancelAutomationBuilderMessage(
  sessionId: string,
): Promise<CancelAutomationBuilderResponse> {
  const response = await invoke<unknown>("cancel_automation_builder_message", {
    sessionId,
  });
  return asRecord(
    normalizeKgooseJson(response),
  ) as CancelAutomationBuilderResponse;
}

export async function startAutomationBuilderStream(
  sessionId: string,
  streamId: string,
  lastEventId?: string,
): Promise<void> {
  await invoke("start_automation_builder_stream", {
    sessionId,
    streamId,
    lastEventId,
  });
}

export async function stopAutomationBuilderStream(
  streamId: string,
): Promise<void> {
  await invoke("stop_automation_builder_stream", { streamId });
}

export async function listenToAutomationBuilderStream(
  handler: (event: AutomationBuilderStreamEvent) => void,
): Promise<UnlistenFn> {
  return listen<AutomationBuilderStreamEvent>(
    AUTOMATION_BUILDER_STREAM_EVENT,
    (event) => handler(event.payload),
  );
}

export function automationBuilderErrorMessage(error: unknown): Message {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Automation builder failed.";
  return createSystemNotificationMessage(text, "error");
}
