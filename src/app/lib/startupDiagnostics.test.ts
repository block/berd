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

  it("classifies runtime config failures as configuration startup failures", () => {
    const issue = buildStartupDiagnosticIssue(
      Object.assign(
        new Error(
          "Runtime config unavailable: missing from fakeEndpoint: No fake response",
        ),
        { name: "RuntimeConfigUnavailableError" },
      ),
      {
        likelyWarpFailure: true,
        status: 302,
        kind: "http_status",
        message: "redirect to access",
      },
    );

    expect(issue.kind).toBe("runtime-config");
    expect(issue.titleKey).toBe("common:startup.error.runtimeConfig.title");
    expect(issue.descriptionKey).toBe(
      "common:startup.error.runtimeConfig.description",
    );
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

  it("upgrades an unknown error to network-warp when the probe reports a likely WARP failure", () => {
    const issue = buildStartupDiagnosticIssue(new Error("Invalid params"), {
      likelyWarpFailure: true,
      status: 302,
      kind: "http_status",
      message: "redirect to access",
    });

    expect(issue.kind).toBe("network-warp");
    expect(issue.titleKey).toBe("common:startup.error.networkWarp.title");
    expect(issue.descriptionKey).toBe(
      "common:startup.error.networkWarp.description",
    );
  });

  it("keeps goose-serve classification even when probe reports a WARP failure", () => {
    const issue = buildStartupDiagnosticIssue(
      new Error("Failed to spawn goose serve (binary: goosed): denied"),
      {
        likelyWarpFailure: true,
        status: null,
        kind: "request",
        message: "connect error",
      },
    );

    expect(issue.kind).toBe("goose-serve");
  });

  it("leaves classification as unknown when probe reports no WARP failure", () => {
    const issue = buildStartupDiagnosticIssue(new Error("Invalid params"), {
      likelyWarpFailure: false,
      status: 404,
      kind: "http_status",
      message: "upstream 404",
    });

    expect(issue.kind).toBe("unknown");
  });

  it("captures the probe report on the issue whenever a probe was run", () => {
    const warpIssue = buildStartupDiagnosticIssue(new Error("Invalid params"), {
      likelyWarpFailure: true,
      status: 302,
      kind: "http_status",
      message: "kgoose probe to https://kgoose/ returned 302 Found",
    });
    expect(warpIssue.connectivityProbe).not.toBeNull();
    expect(JSON.parse(warpIssue.connectivityProbe ?? "{}")).toEqual({
      likelyWarpFailure: true,
      status: 302,
      kind: "http_status",
      message: "kgoose probe to https://kgoose/ returned 302 Found",
    });

    const unknownIssue = buildStartupDiagnosticIssue(
      new Error("Invalid params"),
      {
        likelyWarpFailure: false,
        status: 404,
        kind: "http_status",
        message: "upstream 404",
      },
    );
    expect(unknownIssue.kind).toBe("unknown");
    expect(JSON.parse(unknownIssue.connectivityProbe ?? "{}")).toEqual({
      likelyWarpFailure: false,
      status: 404,
      kind: "http_status",
      message: "upstream 404",
    });

    const gooseServeIssue = buildStartupDiagnosticIssue(
      new Error("Failed to spawn goose serve (binary: goosed): denied"),
      {
        likelyWarpFailure: true,
        status: null,
        kind: "request",
        message: "connect error",
      },
    );
    expect(gooseServeIssue.kind).toBe("goose-serve");
    expect(JSON.parse(gooseServeIssue.connectivityProbe ?? "{}")).toEqual({
      likelyWarpFailure: true,
      status: null,
      kind: "request",
      message: "connect error",
    });
  });

  it("omits the probe report when no probe was run", () => {
    const issue = buildStartupDiagnosticIssue(new Error("boom"));
    expect(issue.connectivityProbe).toBeNull();
  });

  it("appends the probe report to the diagnostic report whenever it is present", () => {
    const issue = buildStartupDiagnosticIssue(new Error("Invalid params"), {
      likelyWarpFailure: false,
      status: 404,
      kind: "http_status",
      message: "kgoose probe to https://kgoose/ returned 404 Not Found",
    });

    const report = buildStartupDiagnosticReport(issue);

    expect(report).toContain("connectivity probe:");
    expect(report).toContain(
      "kgoose probe to https://kgoose/ returned 404 Not Found",
    );
  });
});
