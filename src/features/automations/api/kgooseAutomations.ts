import { invoke } from "@tauri-apps/api/core";
import { normalizeKgooseJson } from "@/shared/api/kgooseJson";
import {
  asKgooseMessagesResponse,
  type KgooseMessagesResponse,
} from "@/shared/api/kgooseMessages";

export interface AutomationTile {
  id?: string;
  creator?: string;
  created?: string;
  updated?: string;
  type?: string | number;
  title?: string;
  schedule?: string;
  instructions?: string[];
  humanReadableInstructions?: string[];
  status?: string | number;
  latestRunStatus?: string | number;
  latestRenderedData?: Record<string, unknown>;
  latestChatSessionId?: string;
  lastSuccessAt?: string;
  spaceId?: string | null;
  requiredConnections?: string[];
  subscribedLabels?: string[];
  toolCallNames?: string[];
  timeZone?: string;
  allowHumanInput?: boolean;
  enableNotifications?: boolean;
  schedulePaused?: boolean;
  pausedReason?: string;
  subscriptionFilters?: {
    statuses?: Array<string | number>;
  };
}

export interface UpdateAutomationTileRequest {
  id: string;
  title?: string;
  schedule?: string;
  updateSchedule?: boolean;
  timeZone?: string;
  instructions?: string[];
  updateInstructions?: boolean;
  enableNotifications?: boolean;
}

export interface CreateAutomationTileRequest {
  type: string | number;
  title?: string;
  schedule?: string;
  timeZone?: string;
  instructions: string[];
  allowHumanInput?: boolean;
  enableNotifications?: boolean;
}

export interface UpdateAutomationTileResponse {
  success?: boolean;
  errorMsg?: string;
  tileId?: string;
  automationId?: string;
}

export interface CreateAutomationTileResponse {
  success?: boolean;
  errorMsg?: string;
  tileId?: string;
  automationId?: string;
}

export interface DeleteAutomationTileResponse {
  success?: boolean;
  errorMsg?: string;
}

export interface RefreshAutomationTileResponse {
  success?: boolean;
  errorMsg?: string;
  refreshSessionId?: string;
}

export interface GenerateAutomationScheduleResponse {
  cronExpression?: string;
  success?: boolean;
  errorMsg?: string;
}

export interface AutomationTileResult {
  sessionId?: string;
  tileId?: string;
  created?: string;
  updated?: string;
  tileResultTimestamp?: string;
  runStatus?: string | number;
  tileData?: Record<string, unknown>;
  tileType?: string | number;
  tileSchemaVersion?: number;
}

export interface GetAutomationTilesResponse {
  tiles: AutomationTile[];
}

export interface GetAutomationTileResponse {
  tileInfo?: AutomationTile;
}

export interface GetAutomationTileResultsResponse {
  tilesResults: AutomationTileResult[];
  historicalLastSevenDaysAvgCost?: number;
  totalLastSevenDaysTokenUsage?: number;
  costLastUpdated?: string;
}

export type GetAutomationSessionMessagesResponse = KgooseMessagesResponse;

const BUILDERBOT_AUTOMATION_TYPES = new Set([
  "18",
  "builderbot_automation",
  "tile_type_builderbot_automation",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter(isRecord) as T[]) : [];
}

function asAutomationTilesResponse(value: unknown): GetAutomationTilesResponse {
  const normalized = normalizeKgooseJson(value);
  if (!isRecord(normalized)) {
    return { tiles: [] };
  }

  return {
    tiles: recordArray<AutomationTile>(normalized.tiles),
  };
}

function asAutomationTileResponse(value: unknown): GetAutomationTileResponse {
  const normalized = normalizeKgooseJson(value);
  if (!isRecord(normalized) || !isRecord(normalized.tileInfo)) {
    return {};
  }

  return { tileInfo: normalized.tileInfo as AutomationTile };
}

function asAutomationTileResultsResponse(
  value: unknown,
): GetAutomationTileResultsResponse {
  const normalized = normalizeKgooseJson(value);
  if (!isRecord(normalized)) {
    return { tilesResults: [] };
  }

  return {
    ...(normalized as Omit<GetAutomationTileResultsResponse, "tilesResults">),
    tilesResults: recordArray<AutomationTileResult>(normalized.tilesResults),
  };
}

function asUpdateAutomationTileResponse(
  value: unknown,
): UpdateAutomationTileResponse {
  const normalized = normalizeKgooseJson(value);
  return isRecord(normalized)
    ? (normalized as UpdateAutomationTileResponse)
    : {};
}

function asCreateAutomationTileResponse(
  value: unknown,
): CreateAutomationTileResponse {
  const normalized = normalizeKgooseJson(value);
  return isRecord(normalized)
    ? (normalized as CreateAutomationTileResponse)
    : {};
}

function asDeleteAutomationTileResponse(
  value: unknown,
): DeleteAutomationTileResponse {
  const normalized = normalizeKgooseJson(value);
  return isRecord(normalized)
    ? (normalized as DeleteAutomationTileResponse)
    : {};
}

function asRefreshAutomationTileResponse(
  value: unknown,
): RefreshAutomationTileResponse {
  const normalized = normalizeKgooseJson(value);
  return isRecord(normalized)
    ? (normalized as RefreshAutomationTileResponse)
    : {};
}

function asGenerateAutomationScheduleResponse(
  value: unknown,
): GenerateAutomationScheduleResponse {
  const normalized = normalizeKgooseJson(value);
  return isRecord(normalized)
    ? (normalized as GenerateAutomationScheduleResponse)
    : {};
}

export function isBuilderBotAutomationTile(tile: AutomationTile): boolean {
  const normalizedType = String(tile.type ?? "").toLowerCase();
  return BUILDERBOT_AUTOMATION_TYPES.has(normalizedType);
}

export function isGenericAutomationTile(tile: AutomationTile): boolean {
  return !tile.spaceId && !isBuilderBotAutomationTile(tile);
}

export function filterAutomationTiles(
  tiles: AutomationTile[],
): AutomationTile[] {
  return tiles.filter(isGenericAutomationTile);
}

export async function getAutomationTiles(): Promise<GetAutomationTilesResponse> {
  const response = await invoke<unknown>("get_automation_tiles");
  const parsed = asAutomationTilesResponse(response);
  return { tiles: filterAutomationTiles(parsed.tiles) };
}

export async function getAutomationTile(
  id: string,
): Promise<GetAutomationTileResponse> {
  const response = await invoke<unknown>("get_automation_tile", { id });
  const parsed = asAutomationTileResponse(response);
  if (parsed.tileInfo && !isGenericAutomationTile(parsed.tileInfo)) {
    return {};
  }
  return parsed;
}

export async function getAutomationTileResults(
  tileId: string,
): Promise<GetAutomationTileResultsResponse> {
  const response = await invoke<unknown>("get_automation_tile_results", {
    tileId,
  });
  return asAutomationTileResultsResponse(response);
}

export async function updateAutomationTile(
  request: UpdateAutomationTileRequest,
): Promise<UpdateAutomationTileResponse> {
  const response = await invoke<unknown>("update_automation_tile", { request });
  return asUpdateAutomationTileResponse(response);
}

export async function createAutomationTile(
  request: CreateAutomationTileRequest,
): Promise<CreateAutomationTileResponse> {
  const response = await invoke<unknown>("create_automation_tile", { request });
  return asCreateAutomationTileResponse(response);
}

export async function deleteAutomationTile(
  id: string,
): Promise<DeleteAutomationTileResponse> {
  const response = await invoke<unknown>("delete_automation_tile", { id });
  return asDeleteAutomationTileResponse(response);
}

export async function refreshAutomationTile(
  id: string,
): Promise<RefreshAutomationTileResponse> {
  const response = await invoke<unknown>("refresh_automation_tile", { id });
  return asRefreshAutomationTileResponse(response);
}

export async function generateAutomationSchedule(
  scheduleDescription: string,
  timeZone?: string,
): Promise<GenerateAutomationScheduleResponse> {
  const response = await invoke<unknown>("generate_automation_schedule", {
    scheduleDescription,
    timeZone,
  });
  return asGenerateAutomationScheduleResponse(response);
}

export async function getAutomationSessionMessages(
  sessionId: string,
): Promise<GetAutomationSessionMessagesResponse> {
  const response = await invoke<unknown>("get_automation_session_messages", {
    sessionId,
  });
  if (isRecord(response)) {
    const messagesResponse =
      response.get_messages_response ?? response.getMessagesResponse;
    if (isRecord(messagesResponse)) {
      return asKgooseMessagesResponse(messagesResponse);
    }
  }
  return asKgooseMessagesResponse(response);
}
