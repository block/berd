import { describe, expect, it } from "vitest";
import {
  isPersonaMarkdownImportFileName,
  isSupportedPersonaImportFileName,
} from "./personaImportFileName";

describe("personaImportFileName", () => {
  it.each([
    "agent.md",
    "agent.persona.md",
    "agent.persona (2).md",
    "AGENT.MD",
  ])("accepts Markdown agent file %s", (fileName) => {
    expect(isPersonaMarkdownImportFileName(fileName)).toBe(true);
    expect(isSupportedPersonaImportFileName(fileName)).toBe(true);
  });

  it.each([
    "agent.txt",
    "agent.md.json",
    "agent",
  ])("rejects non-Markdown file %s", (fileName) => {
    expect(isPersonaMarkdownImportFileName(fileName)).toBe(false);
  });
});
