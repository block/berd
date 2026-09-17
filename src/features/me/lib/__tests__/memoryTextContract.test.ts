import { describe, expect, it } from "vitest";

import {
  normalizeMemoryDocumentText,
  normalizeMemoryProposalText,
  normalizeMemoryProposalTopic,
  UnsafeMemoryTextError,
} from "../memoryTextContract";

describe("memory text contract", () => {
  it("normalizes proposal text consistently", () => {
    expect(normalizeMemoryProposalText("  cafe\u0301\r\n")).toBe("café");
  });

  it("normalizes document text without trimming reviewed bytes", () => {
    expect(normalizeMemoryDocumentText("# Cafe\u0301\r\n\n")).toBe(
      "# Café\n\n",
    );
  });

  it("normalizes reviewed topics before display and approval", () => {
    expect(normalizeMemoryProposalTopic(" Travel\r\n ")).toBe("Travel");
    expect(normalizeMemoryProposalTopic(" ")).toBeNull();
    expect(normalizeMemoryProposalTopic(null)).toBeNull();
  });

  it("rejects bidi, zero-width, C0, and C1 controls", () => {
    for (const text of [
      "abc\u202etxt",
      "abc\u2066txt\u2069",
      "ghp_16Chars\u200bAtLeastHere00",
      "abc\u0007txt",
      "abc\u0085txt",
      "abc\u{e0020}txt",
      "abc\u{e0100}txt",
    ]) {
      expect(() => normalizeMemoryProposalText(text), text).toThrow(
        UnsafeMemoryTextError,
      );
    }
  });

  it("preserves ordinary accents, non-Latin text, and non-ZWJ emoji", () => {
    const text = "São Paulo résumé Привет 中文 🚀";
    expect(normalizeMemoryProposalText(text)).toBe(text);
  });

  it("rejects unsafe topic text and emoji ZWJ sequences deliberately", () => {
    expect(() => normalizeMemoryProposalTopic("Tra\u202evel")).toThrow(
      UnsafeMemoryTextError,
    );
    expect(() => normalizeMemoryProposalText("family 👨‍👩‍👧‍👦")).toThrow(
      UnsafeMemoryTextError,
    );
  });
});
