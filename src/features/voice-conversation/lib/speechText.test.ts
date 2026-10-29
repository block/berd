import { describe, expect, it } from "vitest";
import { speechTextSpans } from "./speechText";
describe("client speech text", () => {
  it("never leaks destinations across any streaming boundary", () => {
    const source = "See [café docs](https://example.com/a_(b)) now.";
    for (let split = 0; split <= source.length; split++) {
      const spoken = [
        ...speechTextSpans(source.slice(0, split)),
        ...speechTextSpans(source, split),
      ]
        .map((span) => span.text)
        .join("");
      expect(spoken).toBe("See café docs now.");
    }
  });
  it("maps spoken characters back to the literal source", () => {
    const source = "See [the docs](https://example.com) now.";
    const spans = speechTextSpans(source);
    for (const span of spans)
      expect(source.slice(span.sourceStart, span.sourceEnd)).toBe(span.text);
    const resumed = speechTextSpans(source, source.indexOf("docs"));
    expect(resumed.map((span) => span.text).join("")).toBe("docs now.");
  });
  it("preserves plain text", () => {
    expect(
      speechTextSpans("Hello (world). https://example.com")
        .map((span) => span.text)
        .join(""),
    ).toBe("Hello (world). https://example.com");
  });
});
