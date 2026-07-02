import { describe, expect, it } from "vitest";
import { formatAcpErrorMessage, isProviderNotSetError } from "../acpErrors";

function requestError(message: string, data?: unknown) {
  const error = new Error(message) as Error & { code: number; data?: unknown };
  error.name = "RequestError";
  error.code = -32603;
  error.data = data;
  return error;
}

describe("formatAcpErrorMessage", () => {
  it("surfaces ACP data directly when the JSON-RPC message is generic", () => {
    expect(
      formatAcpErrorMessage(
        requestError(
          "Internal error",
          "Failed to fetch provider supported models: missing API key",
        ),
      ),
    ).toBe("Failed to fetch provider supported models: missing API key");
  });

  it("includes structured data without interpreting the payload shape", () => {
    expect(
      formatAcpErrorMessage(
        requestError("Internal error", {
          details: "Error getting agent reply: provider timed out",
        }),
      ),
    ).toBe(
      'Internal error: {"details":"Error getting agent reply: provider timed out"}',
    );
  });

  it("keeps structured data visible when it has no obvious message field", () => {
    expect(
      formatAcpErrorMessage(
        requestError("Invalid params", {
          providerId: "missing_provider",
        }),
      ),
    ).toBe('Invalid params: {"providerId":"missing_provider"}');
  });

  it("preserves existing string and Error fallbacks", () => {
    expect(formatAcpErrorMessage("plain failure")).toBe("plain failure");
    expect(formatAcpErrorMessage(new Error("network down"))).toBe(
      "network down",
    );
    expect(formatAcpErrorMessage(requestError("Internal error", ""))).toBe(
      "Internal error",
    );
    expect(formatAcpErrorMessage("", "fallback")).toBe("fallback");
  });
});

describe("isProviderNotSetError", () => {
  it("detects the wrapped provider-not-set failure from ACP data", () => {
    expect(
      isProviderNotSetError(
        requestError(
          "Internal error",
          "Failed to get provider: Provider not set",
        ),
      ),
    ).toBe(true);
  });

  it("detects the bare provider-not-set message regardless of case", () => {
    expect(isProviderNotSetError(new Error("provider not set"))).toBe(true);
    expect(isProviderNotSetError("Provider Not Set")).toBe(true);
  });

  it("ignores unrelated failures", () => {
    expect(isProviderNotSetError(new Error("network down"))).toBe(false);
    expect(
      isProviderNotSetError(requestError("Internal error", "missing API key")),
    ).toBe(false);
    expect(isProviderNotSetError(undefined)).toBe(false);
    expect(isProviderNotSetError(null)).toBe(false);
  });
});
