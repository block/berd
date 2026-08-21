export const SNAPSHOT_FORMAT = "buzz-agent-snapshot" as const;
export const SNAPSHOT_VERSION = 1 as const;
export const SNAPSHOT_PNG_KEYWORD = "buzz_agent_snapshot" as const;
export const MAX_SNAPSHOT_PNG_BYTES = 10 * 1024 * 1024;
export const MAX_SNAPSHOT_AVATAR_ANIMATION_BYTES = 5 * 1024 * 1024;
export const MAX_SNAPSHOT_IMAGE_DIMENSION = 8_192;
export const MAX_SNAPSHOT_IMAGE_PIXELS = 16_777_216;
export const MAX_SNAPSHOT_PNG_CHUNKS = 4_096;
export const MAX_SNAPSHOT_NAME_LENGTH = 200;
export const MAX_SNAPSHOT_PROMPT_LENGTH = 200_000;
// A 2 MiB decoded PNG expands to roughly 4/3 of its size in base64, plus the
// data URL prefix. Keep this wire-string cap aligned with avatarUrl.ts's
// decoded-byte safety limit.
export const MAX_SNAPSHOT_AVATAR_DATA_URL_LENGTH =
  Math.ceil((2 * 1024 * 1024) / 3) * 4 + "data:image/png;base64,".length;
export const MAX_SNAPSHOT_AVATAR_URL_LENGTH = 2_048;
export const MAX_SNAPSHOT_PROVIDER_MODEL_LENGTH = 512;
const MAX_SNAPSHOT_CARD_COPY_RAW_LENGTH = 4_096;

export interface SnapshotV1Definition {
  name?: string;
  systemPrompt?: string | null;
  runtime?: string | null;
  model?: string | null;
  modelProviderId?: string | null;
  provider?: string | null;
  parallelism?: number | null;
  respondTo?: string | null;
  respondToAllowlist?: string[];
  namePool?: string[];
  idleTimeoutSeconds?: number | null;
  maxTurnDurationSeconds?: number | null;
  [field: string]: unknown;
}

export interface SnapshotV1Profile {
  displayName?: string;
  about?: string | null;
  avatarDataUrl?: string | null;
  avatarUrl?: string | null;
  [field: string]: unknown;
}

export interface SnapshotV1MemoryEntry {
  slug: string;
  body: string;
  [field: string]: unknown;
}

export interface SnapshotV1Memory {
  level: "none" | "core" | "everything";
  entries: SnapshotV1MemoryEntry[];
  [field: string]: unknown;
}

export interface SnapshotV1 {
  format: typeof SNAPSHOT_FORMAT;
  version: typeof SNAPSHOT_VERSION;
  definition: SnapshotV1Definition;
  profile?: SnapshotV1Profile;
  memory?: SnapshotV1Memory;
  [field: string]: unknown;
}

export class AgentSnapshotError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid-png"
      | "too-large"
      | "missing-snapshot"
      | "duplicate-snapshot"
      | "invalid-base64"
      | "invalid-utf8"
      | "invalid-json"
      | "wrong-format"
      | "unsupported-version"
      | "invalid-snapshot",
  ) {
    super(message);
    this.name = "AgentSnapshotError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(
  object: Record<string, unknown>,
  field: string,
  maxLength?: number,
): void {
  const value = object[field];
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new AgentSnapshotError(
      `${field} must be a string`,
      "invalid-snapshot",
    );
  }
  if (
    typeof value === "string" &&
    maxLength !== undefined &&
    value.length > maxLength
  ) {
    throw new AgentSnapshotError(`${field} is too long`, "invalid-snapshot");
  }
}

/** Validates untrusted JSON while deliberately accepting unknown v1 fields. */
export function validateSnapshotV1(value: unknown): SnapshotV1 {
  if (!isRecord(value)) {
    throw new AgentSnapshotError(
      "Snapshot must be a JSON object",
      "invalid-snapshot",
    );
  }
  if (value.format !== SNAPSHOT_FORMAT) {
    throw new AgentSnapshotError("Unsupported snapshot format", "wrong-format");
  }
  if (value.version !== SNAPSHOT_VERSION) {
    throw new AgentSnapshotError(
      "Unsupported snapshot version",
      "unsupported-version",
    );
  }
  if (!isRecord(value.definition)) {
    throw new AgentSnapshotError(
      "Snapshot definition is missing",
      "invalid-snapshot",
    );
  }
  if (value.profile !== undefined && !isRecord(value.profile)) {
    throw new AgentSnapshotError(
      "Snapshot profile must be an object",
      "invalid-snapshot",
    );
  }

  optionalString(value.definition, "name", MAX_SNAPSHOT_NAME_LENGTH);
  optionalString(value.definition, "systemPrompt", MAX_SNAPSHOT_PROMPT_LENGTH);
  optionalString(value.definition, "model", MAX_SNAPSHOT_PROVIDER_MODEL_LENGTH);
  optionalString(
    value.definition,
    "modelProviderId",
    MAX_SNAPSHOT_PROVIDER_MODEL_LENGTH,
  );
  optionalString(
    value.definition,
    "provider",
    MAX_SNAPSHOT_PROVIDER_MODEL_LENGTH,
  );
  const profile = isRecord(value.profile) ? value.profile : undefined;
  if (profile) {
    optionalString(profile, "displayName", MAX_SNAPSHOT_NAME_LENGTH);
    optionalString(profile, "about", MAX_SNAPSHOT_CARD_COPY_RAW_LENGTH);
    optionalString(
      profile,
      "avatarDataUrl",
      MAX_SNAPSHOT_AVATAR_DATA_URL_LENGTH,
    );
    optionalString(profile, "avatarUrl", MAX_SNAPSHOT_AVATAR_URL_LENGTH);
  }

  const definitionName =
    typeof value.definition.name === "string"
      ? value.definition.name.trim()
      : "";
  const displayName =
    profile && typeof profile.displayName === "string"
      ? profile.displayName.trim()
      : "";
  if (!definitionName && !displayName) {
    throw new AgentSnapshotError(
      "Snapshot requires a non-empty name or display name",
      "invalid-snapshot",
    );
  }

  if (value.memory !== undefined) {
    if (!isRecord(value.memory)) {
      throw new AgentSnapshotError(
        "Snapshot memory must be an object",
        "invalid-snapshot",
      );
    }
    if (
      !(["none", "core", "everything"] as unknown[]).includes(
        value.memory.level,
      )
    ) {
      throw new AgentSnapshotError(
        "Snapshot memory level is invalid",
        "invalid-snapshot",
      );
    }
    if (value.memory.entries === undefined) {
      // Buzz omits empty vectors on encode and restores them through serde's
      // default on decode. Mirror that wire behavior for interoperability.
      value.memory.entries = [];
    }
    if (!Array.isArray(value.memory.entries)) {
      throw new AgentSnapshotError(
        "Snapshot memory entries must be an array",
        "invalid-snapshot",
      );
    }
    for (const entry of value.memory.entries) {
      if (!isRecord(entry)) {
        throw new AgentSnapshotError(
          "Snapshot memory entries must be objects",
          "invalid-snapshot",
        );
      }
      optionalString(entry, "slug");
      optionalString(entry, "body");
    }
  }

  return value as unknown as SnapshotV1;
}
