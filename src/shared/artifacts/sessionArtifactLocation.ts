import { resolvePath } from "@/shared/api/pathResolver";
import { ensureDirectory } from "@/shared/api/system";

export const ARTIFACT_ROOT_STORAGE_KEY = "goose:artifact-root-path";
export const ARTIFACT_ROOT_CHANGED_EVENT = "goose:artifact-root-path-changed";
export const DEFAULT_ARTIFACT_ROOT_FOLDER_NAME = "goose artifacts";

export interface SessionArtifactLocationOptions {
  artifactRootOverride?: string | null;
}

function trimValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function hasTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(
      (window as typeof window & { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__,
    )
  );
}

function fallbackDefaultArtifactRootPath(): string {
  return `~/${DEFAULT_ARTIFACT_ROOT_FOLDER_NAME}`;
}

export async function defaultArtifactRootPath(): Promise<string> {
  if (!hasTauriRuntime()) {
    return fallbackDefaultArtifactRootPath();
  }

  try {
    return (
      await resolvePath({
        parts: ["~", DEFAULT_ARTIFACT_ROOT_FOLDER_NAME],
      })
    ).path;
  } catch {
    return fallbackDefaultArtifactRootPath();
  }
}

export function getArtifactRootPreference(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return trimValue(window.localStorage.getItem(ARTIFACT_ROOT_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function setArtifactRootPreference(path: string | null): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const trimmed = trimValue(path);
    if (trimmed) {
      window.localStorage.setItem(ARTIFACT_ROOT_STORAGE_KEY, trimmed);
    } else {
      window.localStorage.removeItem(ARTIFACT_ROOT_STORAGE_KEY);
    }
    window.dispatchEvent(new Event(ARTIFACT_ROOT_CHANGED_EVENT));
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
}

export async function resolveArtifactRootPath(
  override?: string | null,
): Promise<string> {
  const configured = trimValue(override) ?? getArtifactRootPreference();
  if (configured) {
    if (!hasTauriRuntime()) {
      return configured;
    }

    try {
      return (await resolvePath({ parts: [configured] })).path;
    } catch {
      return configured;
    }
  }

  return defaultArtifactRootPath();
}

export function getOptimisticArtifactCwd({
  artifactRootOverride,
}: SessionArtifactLocationOptions = {}): string {
  return (
    trimValue(artifactRootOverride) ??
    getArtifactRootPreference() ??
    fallbackDefaultArtifactRootPath()
  );
}

export async function resolveSessionArtifactCwd(
  options: SessionArtifactLocationOptions = {},
): Promise<string> {
  const path = await resolveArtifactRootPath(options.artifactRootOverride);

  if (hasTauriRuntime()) {
    await ensureDirectory(path);
  }

  return path;
}
