import { describe, expect, it } from "vitest";
import {
  MAX_PERSONA_IMPORT_BYTES,
  formatAgentError,
  validatePersonaImportFile,
} from "./personaImport";

describe("validatePersonaImportFile", () => {
  it("accepts persona markdown and JSON imports", () => {
    expect(
      validatePersonaImportFile({
        name: "scout.persona.md",
        type: "text/markdown",
      }),
    ).toBeNull();
    expect(
      validatePersonaImportFile({
        name: "scout.persona.json",
        type: "application/json",
      }),
    ).toBeNull();
  });

  it("accepts browser-renamed duplicate persona markdown downloads", () => {
    expect(
      validatePersonaImportFile({
        name: "scout.persona (1).md",
        type: "text/markdown",
      }),
    ).toBeNull();
  });

  it("accepts plain markdown agent imports", () => {
    expect(
      validatePersonaImportFile({
        name: "scout.md",
        type: "text/markdown",
      }),
    ).toBeNull();
  });

  it("rejects persona imports larger than the configured cap", () => {
    expect(
      validatePersonaImportFile({
        name: "scout.agent.json",
        type: "application/json",
        size: MAX_PERSONA_IMPORT_BYTES + 1,
      }),
    ).toEqual({
      key: "view.importTooLarge",
      options: { maxSize: "4 MB" },
    });
  });
});

describe("formatAgentError", () => {
  it("surfaces ACP error data before falling back to the generic message", () => {
    const error = new Error("Invalid params") as Error & { data: string };
    error.name = "RequestError";
    error.data = "A source named 'reviewer' already exists";

    expect(formatAgentError(error, "Import failed")).toBe(
      "A source named 'reviewer' already exists",
    );
  });
});
