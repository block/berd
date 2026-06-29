import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  createSystemNotificationMessage,
  type Message,
} from "@/shared/types/messages";
import { normalizeKgooseJson, type KgooseJson } from "@/shared/api/kgooseJson";
import {
  applyKgooseMessageDelta,
  asKgooseMessagesResponse,
  asKgooseStreamResponse,
  type KgooseMessageDelta,
  type KgooseMessagesResponse,
  type KgooseSessionStatus,
} from "@/shared/api/kgooseMessages";

export const AUTOMATION_BUILDER_STREAM_EVENT = "automation-builder-stream";
export const AUTOMATION_APPROVAL_TOOL_NAME = "tile__preview_automation";
export const AUTOMATION_CREATE_TOOL_NAME = "tile__create_automation";
export const TILE_RENDER_TOOL_NAME = "tile__render_tile";
export const USER_RESPONSE_CONFIRM_AUTOMATION =
  "User accepted the automation, so it MUST be saved using tile__create_automation.";
export const USER_RESPONSE_CONFIRM_TILE =
  "User accepted the tile, so it MUST be saved using tile__persist_tile.";
export const USER_RESPONSE_REVISE_AUTOMATION_PREFIX =
  "User did not accept the automation draft yet. Do not save or persist the tile. Revise the proposed automation using this feedback, then call tile__render_tile again with render_type='automation' and tile_type='summary':";
const SUMMARY_TILE_TYPE = 4;
const DATABRICKS_MODEL_PROVIDER = 1;
const AUTOMATION_BUILDER_MODEL = {
  name: "goose-claude-4-6-opus",
  provider: DATABRICKS_MODEL_PROVIDER,
};

const AUTOMATION_PREFERENCE_PROMPT_BASE =
  "The user came from the Create Automation UI. Only create an automation; dashboard tiles and builderbot automations are not supported in this app. For previews, use tile__render_tile with render_type='automation' and tile_type='summary'. Before calling render_tile, always call tile__describe_tile('summary') FIRST and shape the data argument to that schema exactly. render_type='automation' does not change the summary schema: data must be exactly { title: string, summary: string, details: string }, with details as a markdown string. Do not use any other tile_type. Do not set space_id or spaceId; external systems persist the accepted summary preview as an automation outside the dashboard. The automation instructions you generate must end with a step that explicitly says to call tile__render_tile with render_type='automation', tile_type='summary', schema-valid summary data, and schedule.";

export function buildAutomationPreferencePrompt(
  now: Date = new Date(),
): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hhmm = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(now);
  return `${AUTOMATION_PREFERENCE_PROMPT_BASE} The user's current local time is ${hhmm} in time zone ${timeZone}. When the user does not specify a time of day for the schedule, default the schedule's hour and minute to this current local time (${hhmm}); do not invent another default time.`;
}

export interface AutomationEditContext {
  title?: string;
  schedule?: string;
  timeZone?: string;
  instructions: string[];
  humanReadableInstructions: string[];
}

export function buildAutomationEditContextPrompt(
  context: AutomationEditContext,
): string {
  const titleLine = context.title
    ? `Title: ${context.title}`
    : "Title: (untitled)";
  const scheduleLine = context.schedule
    ? `Schedule (cron): ${context.schedule}${context.timeZone ? ` in ${context.timeZone}` : ""}`
    : "Schedule: not set";
  const instructionsList =
    context.humanReadableInstructions.length > 0
      ? context.humanReadableInstructions
      : context.instructions;
  const instructionsBlock =
    instructionsList.length > 0
      ? `Current instructions:\n${instructionsList.map((step, i) => `${i + 1}. ${step}`).join("\n")}`
      : "Current instructions: (none)";

  return [
    "The user is editing an existing automation. Help them refine it.",
    "Treat the state below as the current automation. Only propose a new draft (via tile__render_tile with render_type='automation', tile_type='summary') after the user describes what they want to change.",
    "If the user asks an open-ended question first, answer it without emitting a draft.",
    "",
    titleLine,
    scheduleLine,
    instructionsBlock,
  ].join("\n");
}

export type AutomationBuilderStatus = KgooseSessionStatus;

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

export type AutomationBuilderMessagesResponse = KgooseMessagesResponse;

export type AutomationBuilderDelta = KgooseMessageDelta;

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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
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

export function asMessagesResponse(
  value: unknown,
): AutomationBuilderMessagesResponse {
  return asKgooseMessagesResponse(value);
}

export function asStreamResponse(
  value: unknown,
):
  | { type: "messages"; response: AutomationBuilderMessagesResponse }
  | { type: "delta"; delta: AutomationBuilderDelta }
  | null {
  return asKgooseStreamResponse(value);
}

export function applyAutomationBuilderDelta(
  messages: Message[],
  delta: AutomationBuilderDelta,
): Message[] {
  return applyKgooseMessageDelta(messages, delta);
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
      client: "berd",
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
  editContext?: AutomationEditContext,
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
    const hiddenMessages = [
      {
        hidden: true,
        messageContents: [
          {
            type: "MESSAGE_TYPE_TEXT",
            text: { text: buildAutomationPreferencePrompt() },
          },
        ],
      },
    ];
    if (editContext) {
      hiddenMessages.push({
        hidden: true,
        messageContents: [
          {
            type: "MESSAGE_TYPE_TEXT",
            text: { text: buildAutomationEditContextPrompt(editContext) },
          },
        ],
      });
    }
    return {
      ...basePushRequest(sessionId),
      messages: [...hiddenMessages, userMessage],
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

export function buildAutomationRevisionRequest(
  sessionId: string,
  toolRequestId: string,
  text: string,
) {
  return buildToolResponseRequest(
    sessionId,
    toolRequestId,
    `${USER_RESPONSE_REVISE_AUTOMATION_PREFIX} ${text.trim()}`,
  );
}

export async function pushAutomationBuilderUserMessage(
  text: string,
  sessionId?: string,
  editContext?: AutomationEditContext,
): Promise<PushAutomationBuilderResponse> {
  const request = buildAutomationBuilderUserMessageRequest(
    text,
    sessionId,
    editContext,
  );
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

export async function reviseAutomationDraft(
  sessionId: string,
  toolRequestId: string,
  text: string,
): Promise<PushAutomationBuilderResponse> {
  const response = await invoke<unknown>("push_automation_builder_messages", {
    request: buildAutomationRevisionRequest(sessionId, toolRequestId, text),
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
