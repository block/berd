export interface AcpModelConfigSnapshot {
  modelId: string;
  modelName: string;
}

export interface AcpSessionConfigSelectOption {
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

export interface AcpSessionConfigSnapshotHandlers {
  applyModelConfigSnapshot?: (
    sessionId: string,
    snapshot: AcpModelConfigSnapshot,
  ) => void;
  applyReasoningEffortConfigSnapshot?: (
    sessionId: string,
    snapshot: AcpReasoningEffortConfigSnapshot,
  ) => void;
}

let snapshotHandlers: AcpSessionConfigSnapshotHandlers = {};

export function setSessionConfigSnapshotHandlers(
  handlers: AcpSessionConfigSnapshotHandlers,
): void {
  snapshotHandlers = handlers;
}

export function clearSessionConfigSnapshotHandlers(): void {
  snapshotHandlers = {};
}

export function applySessionConfigOptionsSnapshot(
  sessionId: string,
  source: unknown,
): void {
  dispatchSessionConfigSnapshots(sessionId, source, snapshotHandlers);
}

// Single fan-out used by both entry points: the registry-backed
// `applySessionConfigOptionsSnapshot` (for shared callers that can't import
// chat code) and the chat adapter's direct call. Keeping the model/reasoning
// dispatch here means a new config category is added in one place.
export function dispatchSessionConfigSnapshots(
  sessionId: string,
  source: unknown,
  handlers: AcpSessionConfigSnapshotHandlers,
): void {
  const snapshots = readSessionConfigOptionsSnapshots(source);
  if (snapshots.model) {
    if (handlers.applyModelConfigSnapshot) {
      handlers.applyModelConfigSnapshot(sessionId, snapshots.model);
    } else {
      warnUnhandledSnapshot("model", sessionId);
    }
  }
  if (snapshots.reasoningEffort) {
    if (handlers.applyReasoningEffortConfigSnapshot) {
      handlers.applyReasoningEffortConfigSnapshot(
        sessionId,
        snapshots.reasoningEffort,
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

  const modelName =
    modelOption.options.find((model) => model.id === modelOption.currentValue)
      ?.name ?? modelOption.currentValue;

  return { modelId: modelOption.currentValue, modelName };
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
