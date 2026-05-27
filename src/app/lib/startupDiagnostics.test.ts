import { describe, expect, it } from "vitest";
import {
  buildStartupDiagnosticIssue,
  buildStartupDiagnosticReport,
  classifyStartupError,
  serializeRawError,
} from "./startupDiagnostics";

describe("startup diagnostics", () => {
  it("classifies goose serve spawn and timeout failures as backend startup", () => {
    expect(
      classifyStartupError(
        new Error("Failed to spawn goose serve (binary: goosed): denied"),
      ),
    ).toBe("goose-serve");
    expect(
      classifyStartupError(
        new Error("Timed out waiting for goose serve on port 1234"),
      ),
    ).toBe("goose-serve");
  });

  it("leaves unrelated startup errors generic", () => {
    expect(classifyStartupError(new Error("boom"))).toBe("unknown");
  });

  it("serializes direct error fields, causes, data, and enumerable fields", () => {
    const cause = Object.assign(new Error("inner"), { code: "inner-code" });
    const error = Object.assign(new Error("outer"), {
      code: -32603,
      data: { detail: "missing model" },
      cause,
      requestId: "req-123",
    });

    const parsed = JSON.parse(serializeRawError(error));

    expect(parsed).toMatchObject({
      name: "Error",
      message: "outer",
      code: -32603,
      data: { detail: "missing model" },
      cause: {
        name: "Error",
        message: "inner",
        code: "inner-code",
      },
      requestId: "req-123",
    });
    expect(parsed.stack).toEqual(expect.any(String));
  });

  it("serializes plain object payloads", () => {
    expect(
      JSON.parse(serializeRawError({ code: "E_FAIL", ok: false })),
    ).toEqual({
      code: "E_FAIL",
      ok: false,
    });
  });

  it("builds a diagnostic report with classification and raw error", () => {
    const issue = buildStartupDiagnosticIssue(new Error("boom"));

    const report = buildStartupDiagnosticReport(issue);

    expect(report).toContain("kind: unknown");
    expect(report).toContain(issue.rawError);
    expect(report).not.toContain("title key:");
    expect(report).not.toContain("description key:");
  });
});
