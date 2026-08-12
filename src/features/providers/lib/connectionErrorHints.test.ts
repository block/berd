import { describe, expect, it } from "vitest";
import { connectionHintKeyForError } from "./connectionErrorHints";

describe("connectionHintKeyForError", () => {
  it("maps auth failures to the key-rejected hint", () => {
    expect(connectionHintKeyForError("HTTP 401 Unauthorized")).toBe(
      "providers.connectionHints.keyRejected",
    );
    expect(connectionHintKeyForError("invalid_api_key: bad key")).toBe(
      "providers.connectionHints.keyRejected",
    );
    expect(connectionHintKeyForError("403 Forbidden")).toBe(
      "providers.connectionHints.keyRejected",
    );
  });

  it("maps 404s to the wrong-URL hint", () => {
    expect(connectionHintKeyForError("status 404 Not Found")).toBe(
      "providers.connectionHints.urlLooksWrong",
    );
  });

  it("maps connection-level failures to the unreachable hint", () => {
    expect(connectionHintKeyForError("connection refused")).toBe(
      "providers.connectionHints.unreachable",
    );
    expect(connectionHintKeyForError("error: ECONNREFUSED 127.0.0.1")).toBe(
      "providers.connectionHints.unreachable",
    );
    expect(connectionHintKeyForError("request timed out after 30s")).toBe(
      "providers.connectionHints.unreachable",
    );
    expect(connectionHintKeyForError("dns error: ENOTFOUND api.example")).toBe(
      "providers.connectionHints.unreachable",
    );
  });

  it("maps throttling to the rate-limited hint", () => {
    expect(connectionHintKeyForError("429 Too Many Requests")).toBe(
      "providers.connectionHints.rateLimited",
    );
  });

  it("prefers the auth hint when an error matches multiple signatures", () => {
    // "401 ... not found" style compound errors should read as auth failures.
    expect(connectionHintKeyForError("401 model not found")).toBe(
      "providers.connectionHints.keyRejected",
    );
  });

  it("returns null for unrecognized or empty errors", () => {
    expect(connectionHintKeyForError("something exploded")).toBeNull();
    expect(connectionHintKeyForError("")).toBeNull();
    expect(connectionHintKeyForError("   ")).toBeNull();
  });
});
