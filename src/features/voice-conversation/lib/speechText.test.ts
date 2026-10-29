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
  it("preserves trailing prose after angle-bracket destinations at every streaming boundary", () => {
    const source =
      "See [the page](<https://example.com/a(b>) for the next steps.";
    for (let split = 0; split <= source.length; split++) {
      const spans = [
        ...speechTextSpans(source.slice(0, split)),
        ...speechTextSpans(source, split),
      ];
      expect(spans.map((span) => span.text).join("")).toBe(
        "See the page for the next steps.",
      );
      for (const span of spans)
        expect(source.slice(span.sourceStart, span.sourceEnd)).toBe(span.text);
    }
  });
  it.each([
    [
      "See [docs](https://example.com 'Read (first') Important instructions.",
      "See docs Important instructions.",
    ],
    [
      'See [docs](https://example.com "Read (first") Important instructions.',
      "See docs Important instructions.",
    ],
    [
      "See [docs](https://example.com/it's) Important instructions.",
      "See docs Important instructions.",
    ],
    [
      "See [docs](<https://example.com/a(b> 'Read (first') Important instructions.",
      "See docs Important instructions.",
    ],
  ])("retains prose after titled links: %s", (source, expected) => {
    for (let split = 0; split <= source.length; split++) {
      const spans = [
        ...speechTextSpans(source.slice(0, split)),
        ...speechTextSpans(source, split),
      ];
      expect(spans.map((span) => span.text).join("")).toBe(expected);
      for (const span of spans)
        expect(source.slice(span.sourceStart, span.sourceEnd)).toBe(span.text);
    }
  });
  it.each([
    [
      String.raw`Use \[brackets](not a link) now`,
      String.raw`Use \[brackets](not a link) now`,
    ],
    [
      String.raw`Use \[brackets\](not a link) now`,
      String.raw`Use \[brackets\](not a link) now`,
    ],
    [
      String.raw`Use [brackets\](not a link) now`,
      "Use brackets](not a link) now",
    ],
    [
      String.raw`See [escaped \] label](https://example.com) now`,
      "See escaped ] label now",
    ],
    [
      String.raw`See \\[docs](https://example.com) now`,
      String.raw`See \\docs now`,
    ],
  ])("preserves escaped brackets across streaming splits: %s", (source, expected) => {
    for (let split = 0; split <= source.length; split++) {
      const spans = [
        ...speechTextSpans(source.slice(0, split)),
        ...speechTextSpans(source, split),
      ];
      expect(spans.map((span) => span.text).join("")).toBe(expected);
      for (const span of spans)
        expect(source.slice(span.sourceStart, span.sourceEnd)).toBe(span.text);
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
