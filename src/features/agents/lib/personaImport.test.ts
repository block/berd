import { describe, expect, it } from "vitest";
import {
  MAX_PERSONA_IMPORT_BYTES,
  validatePersonaImportFile,
} from "./personaImport";

describe("validatePersonaImportFile", () => {
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
