import { describe, expect, it } from "vitest";
import { detectProviderErrorNotice } from "../providerErrorNotice";

describe("detectProviderErrorNotice", () => {
  it("matches the Anthropic thinking-history 400 surfaced as assistant text", () => {
    const text =
      'Ran into this error: Request failed: Bad request (400): {"message":"messages.5.content.1: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response."}.\n\nPlease retry if you think this is a transient or recoverable error.';
    expect(detectProviderErrorNotice(text)).toBe("anthropicThinkingHistory");
  });

  it("matches a redacted_thinking-only variant", () => {
    const text =
      "redacted_thinking blocks in the latest assistant message cannot be modified";
    expect(detectProviderErrorNotice(text)).toBe("anthropicThinkingHistory");
  });

  it("returns null for ordinary assistant text", () => {
    expect(
      detectProviderErrorNotice("Here is the summary you asked for."),
    ).toBeNull();
  });

  it("returns null for an unrelated provider error", () => {
    expect(
      detectProviderErrorNotice(
        "Ran into this error: Bad request (400): prompt is too long",
      ),
    ).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(detectProviderErrorNotice("")).toBeNull();
  });
});
