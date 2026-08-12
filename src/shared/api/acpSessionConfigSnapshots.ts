import {
  logReasoningEffortInfo,
  reasoningEffortConfigLogFields,
  shortLogId,
} from "@/shared/lib/reasoningEffortDiagnostics";
import { normalizeConcreteModelId } from "@/shared/lib/modelIdentity";

export interface AcpModelConfigSnapshot {
  modelId: string;
  modelName: string;
}

interface AcpSessionConfigSelectOption {
  id: string;
  name?: string;
  description?: string;
  currentValue: string;
  options: Array<{ id: string; name: string }>;
}

export interface AcpReasoningEffortConfigSnapshot {
  configId: string;
  currentValue: string;
  options: Array<{ id: string; name: string }>;
}

export interface AcpSessionConfigSnapshots {
  model: AcpModelConfigSnapshot | null;
  reasoningEffort: AcpReasoningEffortConfigSnapshot | null;
}

interface AcpSessionExecutionConfigSnapshot {
  providerId: string;
  modelId: string;
}

export interface AcpSessionConfigSnapshotContext {
  origin: "notification" | "response";
  requestId?: string;
  providerId?: string;
  modelId?: string;
  reasoningEffortValue?: string;
}

export interface AcpSessionConfigSnapshotHandlers {
  applyConfigSnapshots?: (
    sessionId: string,
    snapshots: AcpSessionConfigSnapshots,
    context: AcpSessionConfigSnapshotContext,
  ) => void;
  applyModelConfigSnapshot?: (
    sessionId: string,
    snapshot: AcpModelConfigSnapshot,
    context: AcpSessionConfigSnapshotContext,
  ) => void;
  applyReasoningEffortConfigSnapshot?: (
    sessionId: string,
    snapshot: AcpReasoningEffortConfigSnapshot,
    context: AcpSessionConfigSnapshotContext,
  ) => void;
}

let snapshotHandlers: AcpSessionConfigSnapshotHandlers = {};

export function setSessionConfigSnapshotHandlers(
  handlers: AcpSessionConfigSnapshotHandlers,
): void {
  snapshotHandlers = handlers;
}

export function applySessionConfigOptionsSnapshot(
  sessionId: string,
  source: unknown,
  context: AcpSessionConfigSnapshotContext,
): void {
  dispatchSessionConfigSnapshots(sessionId, source, snapshotHandlers, context);
}

// Single fan-out used by both entry points: the registry-backed
// `applySessionConfigOptionsSnapshot` (for shared callers that can't import
// chat code) and the chat adapter's direct call. Keeping the model/reasoning
// dispatch here means a new config category is added in one place.
export function dispatchSessionConfigSnapshots(
  sessionId: string,
  source: unknown,
  handlers: AcpSessionConfigSnapshotHandlers,
  context: AcpSessionConfigSnapshotContext,
): void {
  const snapshots = readSessionConfigOptionsSnapshots(source);
  logReasoningEffortInfo("snapshot dispatch", {
    sessionId: shortLogId(sessionId),
    origin: context.origin,
    requestId: context.requestId ? shortLogId(context.requestId) : null,
    providerId: context.providerId ?? null,
    modelId: context.modelId ?? null,
    hasModelSnapshot: Boolean(snapshots.model),
    hasReasoningEffortSnapshot: Boolean(snapshots.reasoningEffort),
    ...reasoningEffortConfigLogFields(
      "reasoningEffort",
      snapshots.reasoningEffort,
    ),
    ...getConfigOptionsLogFields(source),
  });
  if (handlers.applyConfigSnapshots) {
    handlers.applyConfigSnapshots(sessionId, snapshots, context);
    return;
  }
  if (snapshots.model) {
    if (handlers.applyModelConfigSnapshot) {
      handlers.applyModelConfigSnapshot(sessionId, snapshots.model, context);
    } else {
      warnUnhandledSnapshot("model", sessionId);
    }
  }
  if (snapshots.reasoningEffort) {
    if (handlers.applyReasoningEffortConfigSnapshot) {
      handlers.applyReasoningEffortConfigSnapshot(
        sessionId,
        snapshots.reasoningEffort,
        context,
      );
    } else {
      warnUnhandledSnapshot("reasoningEffort", sessionId);
    }
  }
}

// A snapshot arrived but no handler is wired up — surface the misconfiguration
// instead of dropping it silently. The shared (registry) path hits this when
// `registerChatSessionConfigSnapshotHandlers()` hasn't run during startup; the
// chat path always passes concrete handlers, so it never trips this.
function warnUnhandledSnapshot(kind: string, sessionId: string): void {
  console.warn(
    `Dropped ACP ${kind} config snapshot: no snapshot handler registered. ` +
      "Ensure registerChatSessionConfigSnapshotHandlers() runs during startup.",
    { sessionId: sessionId.slice(0, 8) },
  );
}

export function readSessionConfigOptionsSnapshots(
  source: unknown,
): AcpSessionConfigSnapshots {
  return {
    model: getModelConfigSnapshot(source),
    reasoningEffort: getReasoningEffortConfigSnapshot(source),
  };
}

export function readSessionExecutionConfigSnapshot(
  source: unknown,
): AcpSessionExecutionConfigSnapshot | null {
  const provider = getSelectConfigOption(
    source,
    (option) => option.id === "provider" || option.category === "provider",
  );
  const model = getModelConfigSnapshot(source);
  if (!provider || !model) {
    return null;
  }
  return { providerId: provider.currentValue, modelId: model.modelId };
}

function getModelConfigSnapshot(
  source: unknown,
): AcpModelConfigSnapshot | null {
  const modelOption = getSelectConfigOption(
    source,
    (option) => option.category === "model",
  );
  if (!modelOption) {
    return null;
  }

  const modelId = normalizeConcreteModelId(modelOption.currentValue);
  if (!modelId) {
    return null;
  }

  const modelName =
    modelOption.options.find((model) => model.id === modelId)?.name ?? modelId;

  return { modelId, modelName };
}

function getReasoningEffortConfigSnapshot(
  source: unknown,
): AcpReasoningEffortConfigSnapshot | null {
  const option = getSelectConfigOption(
    source,
    (candidate) =>
      candidate.category === "thought_level" ||
      candidate.id === "thinking_effort",
  );
  if (!option) {
    return null;
  }

  return {
    configId: option.id,
    currentValue: option.currentValue,
    options: option.options,
  };
}

function getSelectConfigOption(
  source: unknown,
  predicate: (option: Record<string, unknown>) => boolean,
): AcpSessionConfigSelectOption | null {
  const options = getConfigOptions(source);
  if (!options) {
    return null;
  }

  const configOption = options.find(
    (option) => isRecord(option) && predicate(option),
  );
  if (!isRecord(configOption)) {
    return null;
  }

  const select = isRecord(configOption.kind) ? configOption.kind : configOption;
  if (select.type !== "select") {
    return null;
  }

  const id = getStringProperty(configOption, "id");
  const currentValue = getStringProperty(select, "currentValue");
  if (!id || !currentValue) {
    return null;
  }

  return {
    id,
    name: getStringProperty(configOption, "name"),
    description: getStringProperty(configOption, "description"),
    currentValue,
    options: getSelectOptions(select.options),
  };
}

function getConfigOptions(source: unknown): unknown[] | null {
  if (!isRecord(source)) {
    return null;
  }
  const configUpdate = source as {
    options?: unknown;
    configOptions?: unknown;
  };
  const options = Array.isArray(configUpdate.configOptions)
    ? configUpdate.configOptions
    : configUpdate.options;
  return Array.isArray(options) ? options : null;
}

function getConfigOptionsLogFields(source: unknown): {
  configOptionCount: number | null;
  configOptionIds: string | null;
  configOptionCategories: string | null;
} {
  const options = getConfigOptions(source);
  if (!options) {
    return {
      configOptionCount: null,
      configOptionIds: null,
      configOptionCategories: null,
    };
  }

  const ids = options
    .flatMap((option) =>
      isRecord(option) ? (getStringProperty(option, "id") ?? []) : [],
    )
    .slice(0, 20);
  const categories = options
    .flatMap((option) =>
      isRecord(option) ? (getStringProperty(option, "category") ?? []) : [],
    )
    .slice(0, 20);

  return {
    configOptionCount: options.length,
    configOptionIds: ids.length > 0 ? ids.join(",") : null,
    configOptionCategories: categories.length > 0 ? categories.join(",") : null,
  };
}

function getSelectOptions(
  options: unknown,
): Array<{ id: string; name: string }> {
  if (Array.isArray(options)) {
    return options.flatMap((value) => {
      if (!isRecord(value)) {
        return [];
      }
      const id = getStringProperty(value, "value");
      if (id) {
        return [{ id, name: getStringProperty(value, "name") ?? id }];
      }
      if (!Array.isArray(value.options)) {
        return [];
      }
      return getSelectOptions(value.options);
    });
  }

  if (!isRecord(options)) {
    return [];
  }

  const type = getStringProperty(options, "type");
  if (type === "ungrouped") {
    const values = options.values;
    if (!Array.isArray(values)) {
      return [];
    }
    return values.flatMap((value) => {
      if (!isRecord(value)) {
        return [];
      }
      const id = getStringProperty(value, "value");
      if (!id) {
        return [];
      }
      return [{ id, name: getStringProperty(value, "name") ?? id }];
    });
  }

  if (type !== "grouped" || !Array.isArray(options.groups)) {
    return [];
  }

  return options.groups.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.options)) {
      return [];
    }
    return group.options.flatMap((value) => {
      if (!isRecord(value)) {
        return [];
      }
      const id = getStringProperty(value, "value");
      if (!id) {
        return [];
      }
      return [{ id, name: getStringProperty(value, "name") ?? id }];
    });
  });
}

function getStringProperty(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
