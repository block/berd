import { DEFAULT_PROJECT_COLOR } from "../lib/projectDefaults";
import { isPillTone, pillCssColor, type PillTone } from "../lib/pillTones";
import type {
  ProjectArtifactContentMode,
  ProjectArtifactInput,
  ProjectArtifactMetadata,
  ProjectArtifactMood,
  ProjectArtifactState,
} from "./types";

const PILL_TONE_HEX: Record<PillTone, string> = {
  pink: "#f4bed1",
  lavender: "#d8c8f4",
  blue: "#b9d9f5",
  sage: "#c2dcc8",
  olive: "#d9ddb0",
  mint: "#b7e4d0",
  peach: "#f5c7a5",
};

const MOODS: ProjectArtifactMood[] = [
  "serene",
  "active",
  "contemplative",
  "energetic",
  "awakening",
  "dormant",
];

const CONTENT_MODES: ProjectArtifactContentMode[] = [
  "planes",
  "sphere",
  "cube",
  "cubeStatic",
];

function hashText(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizedText(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function seedForProjectIdentity(input: ProjectArtifactInput): number {
  const name = normalizedText(input.name) || "Untitled project";
  return hashText(
    [input.projectId, name]
      .filter((part) => part !== undefined && part !== null)
      .join("::"),
  );
}

function normalizedArtifactColor(color: string | null | undefined) {
  const normalized = normalizedText(color) || DEFAULT_PROJECT_COLOR;
  if (isPillTone(normalized) || /^#[0-9a-f]{3,8}$/i.test(normalized)) {
    return normalized;
  }
  return DEFAULT_PROJECT_COLOR;
}

function colorForProject(color: string | null | undefined) {
  const normalized = normalizedArtifactColor(color);
  if (isPillTone(normalized)) {
    return {
      accentColor: PILL_TONE_HEX[normalized],
      accentCssColor: pillCssColor(normalized) ?? PILL_TONE_HEX[normalized],
    };
  }
  if (/^#[0-9a-f]{3,8}$/i.test(normalized)) {
    return { accentColor: normalized, accentCssColor: normalized };
  }
  return {
    accentColor: PILL_TONE_HEX[DEFAULT_PROJECT_COLOR],
    accentCssColor:
      pillCssColor(DEFAULT_PROJECT_COLOR) ??
      PILL_TONE_HEX[DEFAULT_PROJECT_COLOR],
  };
}

function moodForInput(
  input: ProjectArtifactInput,
  seed: number,
): ProjectArtifactMood {
  const promptLength = normalizedText(input.prompt).length;
  const workingDirCount = input.workingDirs?.length ?? 0;
  const sessionCount = input.sessionCount ?? 0;

  if (sessionCount >= 8 || promptLength >= 220) return "active";
  if (sessionCount >= 4) return "energetic";
  if (workingDirCount === 0 && promptLength < 24) return "awakening";
  if (promptLength >= 120 && sessionCount === 0) return "contemplative";
  return MOODS[seed % MOODS.length];
}

function contentModeForInput(
  input: ProjectArtifactInput,
  seed: number,
): ProjectArtifactContentMode {
  const promptLength = normalizedText(input.prompt).length;
  const workingDirCount = input.workingDirs?.length ?? 0;
  const sessionCount = input.sessionCount ?? 0;

  if (sessionCount >= 6) return "cube";
  if (workingDirCount > 1) return "sphere";
  if (promptLength >= 100) return "planes";
  return CONTENT_MODES[seed % CONTENT_MODES.length];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteSeed(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.max(0, Math.floor(number)) >>> 0;
}

function isProjectArtifactMood(value: unknown): value is ProjectArtifactMood {
  return (
    typeof value === "string" && MOODS.includes(value as ProjectArtifactMood)
  );
}

function isProjectArtifactContentMode(
  value: unknown,
): value is ProjectArtifactContentMode {
  return (
    typeof value === "string" &&
    CONTENT_MODES.includes(value as ProjectArtifactContentMode)
  );
}

export function parseProjectArtifactMetadata(
  value: unknown,
): ProjectArtifactMetadata | null {
  if (!isRecord(value)) return null;

  const seed = finiteSeed(value.seed);
  const moodIntensity = finiteNumber(value.moodIntensity);
  if (
    seed === null ||
    moodIntensity === null ||
    typeof value.color !== "string" ||
    !isProjectArtifactMood(value.mood) ||
    !isProjectArtifactContentMode(value.contentMode)
  ) {
    return null;
  }

  return {
    seed,
    color: normalizedArtifactColor(value.color),
    mood: value.mood,
    moodIntensity: Math.max(0, Math.min(1, moodIntensity)),
    contentMode: value.contentMode,
  };
}

function deriveBaseProjectArtifactState(
  input: ProjectArtifactInput,
): ProjectArtifactState {
  const name = normalizedText(input.name) || "Untitled project";
  const seed = seedForProjectIdentity(input);
  const { accentColor, accentCssColor } = colorForProject(input.color);
  const sessionCount = input.sessionCount ?? 0;
  const promptLength = normalizedText(input.prompt).length;
  const moodIntensity = Math.min(
    1,
    0.34 + sessionCount * 0.07 + Math.min(promptLength, 240) / 480,
  );

  return {
    seed,
    name,
    accentColor,
    accentCssColor,
    mood: moodForInput(input, seed),
    moodIntensity,
    contentMode: contentModeForInput(input, seed),
  };
}

export function createProjectArtifactMetadata(
  input: ProjectArtifactInput,
): ProjectArtifactMetadata {
  const state = deriveBaseProjectArtifactState(input);
  return {
    seed: state.seed,
    color: normalizedArtifactColor(input.color),
    mood: state.mood,
    moodIntensity: state.moodIntensity,
    contentMode: state.contentMode,
  };
}

export function deriveProjectArtifactState(
  input: ProjectArtifactInput,
): ProjectArtifactState {
  const state = deriveBaseProjectArtifactState(input);
  const artifact = parseProjectArtifactMetadata(input.artifact);
  if (!artifact) {
    return state;
  }

  const { accentColor, accentCssColor } = colorForProject(artifact.color);
  return {
    ...state,
    seed: artifact.seed,
    accentColor,
    accentCssColor,
    mood: artifact.mood,
    moodIntensity: artifact.moodIntensity,
    contentMode: artifact.contentMode,
  };
}
