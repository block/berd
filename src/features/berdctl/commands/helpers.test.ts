import { describe, expect, it } from "vitest";

import { berdctlErrorDetail } from "./helpers";

function requestError(message: string, data?: unknown) {
  const error = new Error(message) as Error & { code: number; data?: unknown };
  error.name = "RequestError";
  error.code = -32603;
  error.data = data;
  return error;
}

describe("berdctlErrorDetail", () => {
  it("surfaces the ACP error data payload that String(error) drops", () => {
    expect(
      berdctlErrorDetail(requestError("Internal error", "database is locked")),
    ).toBe("database is locked");
  });

  it("keeps structured data visible without interpreting the payload shape", () => {
    expect(
      berdctlErrorDetail(
        requestError("Internal error", { providerId: "missing_provider" }),
      ),
    ).toBe('Internal error: {"providerId":"missing_provider"}');
  });

  it("falls back to the error message when there is no data payload", () => {
    expect(berdctlErrorDetail(new Error("network down"))).toBe("network down");
  });

  it("caps pre-formatted string detail without reformatting it", () => {
    expect(berdctlErrorDetail("short detail")).toBe("short detail");
    const capped = berdctlErrorDetail("x".repeat(5000));
    expect(capped).toHaveLength(2001);
    expect(capped.endsWith("…")).toBe(true);
  });

  it("bounds oversized string payloads so the wire result stays bounded", () => {
    const detail = berdctlErrorDetail(
      requestError("Internal error", "x".repeat(5000)),
    );
    expect(detail).toHaveLength(2001);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("bounds oversized structured payloads before serializing them", () => {
    const detail = berdctlErrorDetail(
      requestError("Internal error", { blob: "x".repeat(5000) }),
    );
    expect(detail.length).toBeLessThanOrEqual(2001);
    expect(detail.endsWith("…")).toBe(true);
  });
});
