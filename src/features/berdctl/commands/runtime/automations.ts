import {
  getAutomationTile,
  getAutomationTiles,
  type AutomationTile,
} from "@/features/automations/api/kgooseAutomations";
import { getProfileCapabilitySnapshot } from "@/shared/profile/capabilities";

import { CommandError } from "../types";

/** Wire summary of one automation, as `automation list` returns it. */
export interface AutomationSummary {
  automation_id: string;
  title: string;
  schedule: string;
  time_zone: string;
  status: string;
  latest_run_status: string;
  schedule_paused: boolean;
  paused_reason?: string;
  last_success_at?: string;
}

/** `automation get`'s detail: the summary plus instructions and run wiring. */
export interface AutomationDetail extends AutomationSummary {
  instructions: string[];
  human_readable_instructions: string[];
  allow_human_input?: boolean;
  enable_notifications?: boolean;
  latest_chat_session_id?: string;
  created?: string;
  updated?: string;
}

/** Refuse before touching KGoose when the build/runtime has no Automations
 *  surface — the same capability that gates the Automations view. */
export function requireAutomationsCapability(): void {
  if (!getProfileCapabilitySnapshot("automations")) {
    throw new CommandError(
      "automations_disabled",
      "Automations are disabled in this build or runtime configuration.",
    );
  }
}

export async function fetchAutomationTiles(): Promise<AutomationTile[]> {
  requireAutomationsCapability();
  const { tiles } = await getAutomationTiles();
  return tiles;
}

export async function findAutomationOrThrow(
  automationId: string,
): Promise<AutomationTile> {
  requireAutomationsCapability();
  const { tileInfo } = await getAutomationTile(automationId);
  if (!tileInfo?.id) {
    throw new CommandError(
      "automation_not_found",
      `No automation "${automationId}"; list automations with ` +
        "`berdctl automation list`.",
    );
  }
  return tileInfo;
}

function asWireString(value: string | number | undefined): string {
  return value === undefined ? "" : String(value);
}

export function summarizeAutomationTile(
  tile: AutomationTile,
): AutomationSummary {
  const summary: AutomationSummary = {
    automation_id: tile.id ?? "",
    title: tile.title ?? "",
    schedule: tile.schedule ?? "",
    time_zone: tile.timeZone ?? "",
    status: asWireString(tile.status),
    latest_run_status: asWireString(tile.latestRunStatus),
    schedule_paused: tile.schedulePaused === true,
  };
  if (tile.pausedReason) summary.paused_reason = tile.pausedReason;
  if (tile.lastSuccessAt) summary.last_success_at = tile.lastSuccessAt;
  return summary;
}

export function detailAutomationTile(tile: AutomationTile): AutomationDetail {
  const detail: AutomationDetail = {
    ...summarizeAutomationTile(tile),
    instructions: tile.instructions ?? [],
    human_readable_instructions: tile.humanReadableInstructions ?? [],
  };
  if (typeof tile.allowHumanInput === "boolean") {
    detail.allow_human_input = tile.allowHumanInput;
  }
  if (typeof tile.enableNotifications === "boolean") {
    detail.enable_notifications = tile.enableNotifications;
  }
  if (tile.latestChatSessionId) {
    detail.latest_chat_session_id = tile.latestChatSessionId;
  }
  if (tile.created) detail.created = tile.created;
  if (tile.updated) detail.updated = tile.updated;
  return detail;
}
