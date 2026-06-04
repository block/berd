import { describe, expect, it } from "vitest";
import {
  isRunnableShellLanguage,
  normalizeRunnableShellCommand,
} from "./runnableShellCommand";

describe("runIt", () => {
  it("recognizes shell flavored code fence languages", () => {
    expect(isRunnableShellLanguage("bash")).toBe(true);
    expect(isRunnableShellLanguage("sh")).toBe(true);
    expect(isRunnableShellLanguage("pwsh")).toBe(true);
    expect(isRunnableShellLanguage("fish")).toBe(true);
    expect(isRunnableShellLanguage("console")).toBe(false);
    expect(isRunnableShellLanguage("shellsession")).toBe(false);
    expect(isRunnableShellLanguage("terminal")).toBe(false);
    expect(isRunnableShellLanguage("typescript")).toBe(false);
  });

  it("normalizes line endings and trims surrounding whitespace", () => {
    expect(normalizeRunnableShellCommand("\npnpm test\r\n")).toBe("pnpm test");
  });
});
