import { describe, expect, it } from "vitest";

import { looksLikeCredential } from "../memoryCredentialGuard";

describe("looksLikeCredential", () => {
  it("rejects well-known token shapes", () => {
    const secrets = [
      "Deploy key: sk-proj-abc123def456ghi789jkl012mno",
      "Use ghp_16CharsAtLeastHere00 for the repo",
      "Slack bot token xoxb-1234567890-abcdefghij",
      "AWS key AKIAIOSFODNN7EXAMPLE",
      "Maps key AIzaSyA1234567890abcdefghijklmnopqrstuv",
      "GitLab token glpat-abcdefghij1234567890",
      "-----BEGIN RSA PRIVATE KEY-----",
      "Session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
    ];
    for (const secret of secrets) {
      expect(looksLikeCredential(secret), secret).toBe(true);
    }
  });

  it("rejects a labelled secret with a credential-shaped value", () => {
    expect(looksLikeCredential("Wifi password: Tr0ub4dor&3xK9")).toBe(true);
    expect(looksLikeCredential("api_key = 8f4b2c9e1a7d3f5b6c8e")).toBe(true);
    expect(looksLikeCredential("PIN: 4829")).toBe(true);
  });

  it("rejects an opaque blob even without a label", () => {
    expect(
      looksLikeCredential(
        "Remember this: aGVsbG93b3JsZDEyMzQ1Njc4OTBhYmNkZWZnaGlqa2xtbg",
      ),
    ).toBe(true);
    expect(
      looksLikeCredential("d41d8cd98f00b204e9800998ecf8427e9a1b2c3d"),
    ).toBe(true);
  });

  it("keeps entries that talk about credentials without carrying one", () => {
    const legitimate = [
      "Uses 1Password for passwords.",
      "Always ask before rotating an API key.",
      "Never save my passwords in a file.",
      "Password reset emails go to my work address.",
      "Prefers passkeys over passwords when a site supports them.",
      "Keeps SSH keys on a hardware token.",
    ];
    for (const entry of legitimate) {
      expect(looksLikeCredential(entry), entry).toBe(false);
    }
  });

  it("keeps ordinary memory entries", () => {
    const ordinary = [
      "Keep responses to the shortest useful answer by default.",
      "Youngest has soccer practice Monday, Tuesday, and Thursday evenings.",
      "Git branch names: use `clay/` as the prefix, not `claydelk/`.",
      "Vegetarian, and allergic to shellfish.",
      "Prefers aisle seats and avoids red-eye flights.",
      "Always ask before deleting something or connecting a new service.",
    ];
    for (const entry of ordinary) {
      expect(looksLikeCredential(entry), entry).toBe(false);
    }
  });

  it("ignores empty content", () => {
    expect(looksLikeCredential("")).toBe(false);
    expect(looksLikeCredential("   ")).toBe(false);
  });
});
