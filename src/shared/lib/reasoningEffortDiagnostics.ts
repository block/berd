import { logRendererEvent } from "@/shared/api/rendererTelemetry";

type ReasoningEffortLogValue = string | number | boolean | null | undefined;

export type ReasoningEffortLogFields = Record<string, ReasoningEffortLogValue>;

interface ReasoningEffortConfigForLog {
  configId?: string | null;
  currentValue?: string | null;
  options?: Array<unknown> | null;
}

const LOG_PREFIX = "[reasoning-effort]";
const MAX_FIELD_LENGTH = 160;

function isTestEnvironment(): boolean {
  try {
    return import.meta.env?.MODE === "test";
  } catch {
    return false;
  }
}

function normalizeFieldValue(
  value: ReasoningEffortLogValue,
): ReasoningEffortLogValue {
  if (typeof value !== "string") {
    return value;
  }
  return value.length > MAX_FIELD_LENGTH
    ? `${value.slice(0, MAX_FIELD_LENGTH)}...`
    : value;
}

function serializeFields(fields: ReasoningEffortLogFields): string {
  const normalized: Record<
    string,
    Exclude<ReasoningEffortLogValue, undefined>
  > = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    normalized[key] = normalizeFieldValue(value) ?? null;
  }

  if (Object.keys(normalized).length === 0) {
    return "";
  }

  return ` ${JSON.stringify(normalized)}`;
}

export function shortLogId(id: string | null | undefined): string | null {
  return id ? id.slice(0, 8) : null;
}

export function reasoningEffortConfigLogFields(
  prefix: string,
  config: ReasoningEffortConfigForLog | null | undefined,
): ReasoningEffortLogFields {
  return {
    [`${prefix}ConfigId`]: config?.configId ?? null,
    [`${prefix}CurrentValue`]: config?.currentValue ?? null,
    [`${prefix}OptionCount`]: config?.options?.length ?? null,
  };
}

export function logReasoningEffortInfo(
  event: string,
  fields: ReasoningEffortLogFields = {},
): void {
  if (isTestEnvironment()) {
    return;
  }

  const message = `${LOG_PREFIX} ${event}${serializeFields(fields)}`;

  // eslint-disable-next-line no-console
  console.info(message);
  void logRendererEvent("info", message);
}
