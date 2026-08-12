import type { KgooseProbeReport } from "@/shared/api/connectivity";

// Re-exported for back-compat: the probe report type now lives alongside the
// shared `probeKgooseConnectivity` helper, but startup consumers still import
// it from here.
export type { KgooseProbeReport };

export type StartupErrorKind =
  | "goose-serve"
  | "network-warp"
  | "runtime-config"
  | "unknown";

export interface StartupDiagnosticIssue {
  kind: StartupErrorKind;
  titleKey: string;
  descriptionKey: string;
  rawError: string;
  connectivityProbe: string | null;
}

const ERROR_COPY_KEYS = {
  "goose-serve": {
    titleKey: "common:startup.error.gooseServe.title",
    descriptionKey: "common:startup.error.gooseServe.description",
  },
  "network-warp": {
    titleKey: "common:startup.error.networkWarp.title",
    descriptionKey: "common:startup.error.networkWarp.description",
  },
  "runtime-config": {
    titleKey: "common:startup.error.runtimeConfig.title",
    descriptionKey: "common:startup.error.runtimeConfig.description",
  },
  unknown: {
    titleKey: "common:startup.error.unknown.title",
    descriptionKey: "common:startup.error.unknown.description",
  },
} satisfies Record<
  StartupErrorKind,
  { titleKey: string; descriptionKey: string }
>;

export function buildStartupDiagnosticIssue(
  error: unknown,
  probe?: KgooseProbeReport | null,
): StartupDiagnosticIssue {
  const rawError = serializeRawError(error);
  const baseKind = classifyStartupErrorFromRaw(rawError);
  // The Rust probe is authoritative for WARP failures; it can only upgrade
  // an "unknown" classification, never override a `goose-serve` failure
  // where we already have a precise startup reason.
  const kind =
    baseKind === "unknown" && probe?.likelyWarpFailure
      ? "network-warp"
      : baseKind;
  const keys = ERROR_COPY_KEYS[kind];

  return {
    kind,
    titleKey: keys.titleKey,
    descriptionKey: keys.descriptionKey,
    rawError,
    connectivityProbe: probe ? serializeProbe(probe) : null,
  };
}

function serializeProbe(probe: KgooseProbeReport): string {
  return JSON.stringify(probe, null, 2);
}

export function classifyStartupError(error: unknown): StartupErrorKind {
  return classifyStartupErrorFromRaw(serializeRawError(error));
}

function classifyStartupErrorFromRaw(rawError: string): StartupErrorKind {
  const lowerRaw = rawError.toLowerCase();

  if (
    lowerRaw.includes("failed to spawn goose serve") ||
    lowerRaw.includes("goose serve exited before becoming ready") ||
    lowerRaw.includes("timed out waiting for goose serve") ||
    lowerRaw.includes("could not resolve goose binary")
  ) {
    return "goose-serve";
  }

  if (
    lowerRaw.includes("runtimeconfigunavailableerror") ||
    lowerRaw.includes("runtime config unavailable")
  ) {
    return "runtime-config";
  }

  return "unknown";
}

export function serializeRawError(error: unknown): string {
  try {
    const seen = new WeakSet<object>();
    const serialized = serializeValue(error, seen);
    if (serialized !== null && typeof serialized === "object") {
      return JSON.stringify(serialized, null, 2);
    }
    return String(error);
  } catch {
    return String(error);
  }
}

export function buildStartupDiagnosticReport(
  issue: StartupDiagnosticIssue,
): string {
  const sections = [
    `app timestamp: ${new Date().toISOString()}`,
    `kind: ${issue.kind}`,
    "",
    "raw error:",
    issue.rawError,
  ];
  if (issue.connectivityProbe) {
    sections.push("", "connectivity probe:", issue.connectivityProbe);
  }
  return sections.join("\n");
}

function serializeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "undefined") {
    return "undefined";
  }

  if (typeof value === "symbol") {
    return value.toString();
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (value instanceof Error) {
    const errorRecord: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    };
    const errorWithFields = value as Error &
      Partial<Record<"code" | "data" | "cause", unknown>>;

    if (value.stack) {
      errorRecord.stack = value.stack;
    }

    for (const key of ["code", "data", "cause"] as const) {
      if (key in value) {
        errorRecord[key] = serializeValue(errorWithFields[key], seen);
      }
    }

    for (const [key, fieldValue] of Object.entries(value)) {
      if (key in errorRecord) {
        continue;
      }
      errorRecord[key] = serializeValue(fieldValue, seen);
    }

    return errorRecord;
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item, seen));
  }

  const record: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    record[key] = serializeValue(fieldValue, seen);
  }
  return record;
}
