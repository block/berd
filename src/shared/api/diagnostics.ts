import { invoke } from "@tauri-apps/api/core";

export type DiagnosticLevel = "info" | "warn" | "error";
export type DiagnosticCategory = "startup" | "gooseServe" | "renderer";

export interface DiagnosticEventInput {
  level: DiagnosticLevel;
  category: DiagnosticCategory;
  event: string;
  elapsedMs?: number;
  fields?: Record<string, string | number | boolean | null | undefined>;
}

export async function writeDiagnosticEvent(
  input: DiagnosticEventInput,
): Promise<void> {
  if (!window.__TAURI_INTERNALS__) {
    return;
  }

  await invoke("write_diagnostic_event", {
    input: {
      ...input,
      fields: input.fields ? compactFields(input.fields) : undefined,
    },
  });
}

function compactFields(
  fields: Record<string, string | number | boolean | null | undefined>,
) {
  return Object.fromEntries(
    Object.entries(fields).filter((entry) => entry[1] !== undefined),
  );
}
