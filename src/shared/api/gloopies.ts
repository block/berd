import { invoke } from "@tauri-apps/api/core";

export type GloopieErrorCode =
  | "networkAccess"
  | "contentBlocked"
  | "unavailable";

/**
 * Longest prompt the backend accepts. Mirrors the 1-300 character check in
 * `generate_gloopie_options`/`animate_gloopie_option` (src-tauri/src/commands/
 * gloopies.rs). The receiver keeps its own limit — this only stops the user
 * typing past a boundary that would come back as a generic "unavailable".
 */
export const GLOOPIE_PROMPT_MAX_LENGTH = 300;

export class GloopieGenerationError extends Error {
  code: GloopieErrorCode;

  constructor(message: string, code: GloopieErrorCode) {
    super(message);
    this.name = "GloopieGenerationError";
    this.code = code;
  }
}

export interface GloopieOptionResult {
  id: string;
  avatarRef: string;
}

interface GloopieGenerateOptionsResponse {
  options: GloopieOptionResult[];
}

interface GloopieAnimateResponse {
  avatarRef: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGloopieErrorCode(value: unknown): value is GloopieErrorCode {
  return (
    value === "networkAccess" ||
    value === "contentBlocked" ||
    value === "unavailable"
  );
}

export function normalizeGloopieGenerationError(
  error: unknown,
): GloopieGenerationError {
  if (error instanceof GloopieGenerationError) {
    return error;
  }

  if (isRecord(error) && isGloopieErrorCode(error.code)) {
    return new GloopieGenerationError(
      typeof error.message === "string" && error.message.length > 0
        ? error.message
        : "The gloopie creator is unavailable right now. Try again.",
      error.code,
    );
  }

  if (error instanceof Error) {
    return new GloopieGenerationError(error.message, "unavailable");
  }

  if (typeof error === "string" && error.length > 0) {
    return new GloopieGenerationError(error, "unavailable");
  }

  return new GloopieGenerationError(
    "The gloopie creator is unavailable right now. Try again.",
    "unavailable",
  );
}

export function canUseNativeGloopieGeneration(): boolean {
  return Boolean(window.__TAURI_INTERNALS__);
}

export async function generateGloopieOptions({
  object,
}: {
  object: string;
}): Promise<GloopieOptionResult[]> {
  try {
    const response = await invoke<GloopieGenerateOptionsResponse>(
      "generate_gloopie_options",
      { object },
    );
    return response.options;
  } catch (error) {
    throw normalizeGloopieGenerationError(error);
  }
}

export async function animateGloopieOption({
  avatarRef,
  object,
}: {
  avatarRef: string;
  object: string;
}): Promise<string> {
  try {
    const response = await invoke<GloopieAnimateResponse>(
      "animate_gloopie_option",
      { avatarRef, object },
    );
    return response.avatarRef;
  } catch (error) {
    throw normalizeGloopieGenerationError(error);
  }
}
