import { describe, expect, it } from "vitest";
import { speechTextSpans } from "./speechText";
// Model the controller's actual raw cursor, including a completion update
// with no text append. Streaming calls never claim their prefix is final.
function streamedSpans(source: string, split: number) {
  const prefix = speechTextSpans(source.slice(0, split), 0, false);
  const rest = speechTextSpans(source, prefix.consumedThrough, false);
  const completed = speechTextSpans(source, rest.consumedThrough, true);
  return [...prefix.spans, ...rest.spans, ...completed.spans];
}
describe("client speech text", () => {
  it("sanitizes links after an unmatched backtick in completed prose", () => {
    const source = "Use ` when needed, then see [docs](https://example.com).";
    expect(
      speechTextSpans(source)
        .spans.map((span) => span.text)
        .join(""),
    ).toBe("Use ` when needed, then see docs.");
  });
  it("buffers malformed prose until completion without replay at every split", () => {
    const source = "Use ` when needed, then see [docs](https://example.com).";
    for (let split = 0; split <= source.length; split++) {
      const prefix = speechTextSpans(source.slice(0, split), 0, false);
      const rest = speechTextSpans(source, prefix.consumedThrough, false);
      expect(
        [...prefix.spans, ...rest.spans].map((span) => span.text).join(""),
      ).toBe("Use ");
      expect(rest.consumedThrough).toBe(source.indexOf("`"));
      expect(
        streamedSpans(source, split)
          .map((span) => span.text)
          .join(""),
      ).toBe("Use ` when needed, then see docs.");
    }
  });
  it("releases malformed prose when its paragraph ends", () => {
    const source = "Use ` then [docs](https://example.com).\n\nNext.";
    const result = speechTextSpans(source, 0, false);
    expect(result.consumedThrough).toBe(source.length);
    expect(result.spans.map((span) => span.text).join("")).toBe(
      "Use ` then docs.\n\nNext.",
    );
  });
  it("never leaks destinations across any streaming boundary", () => {
    const source = "See [café docs](https://example.com/a_(b)) now.";
    for (let split = 0; split <= source.length; split++) {
      const spoken = streamedSpans(source, split)
        .map((span) => span.text)
        .join("");
      expect(spoken).toBe("See café docs now.");
    }
  });
  it("preserves trailing prose after angle-bracket destinations at every streaming boundary", () => {
    const source =
      "See [the page](<https://example.com/a(b>) for the next steps.";
    for (let split = 0; split <= source.length; split++) {
      const spans = streamedSpans(source, split);
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
      const spans = streamedSpans(source, split);
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
      const spans = streamedSpans(source, split);
      expect(spans.map((span) => span.text).join("")).toBe(expected);
      for (const span of spans)
        expect(source.slice(span.sourceStart, span.sourceEnd)).toBe(span.text);
    }
  });
  it.each([
    "Call `callbacks[index](result)` next.",
    "Call ``callbacks[index](result)`` next.",
    "Code:\n```js\ncallbacks[index](result)\n```\nDone.",
    "Code:\n~~~js\ncallbacks[index](result)\n~~~\nDone.",
    "Code:\n````js\n```\ncallbacks[index](result)\n````\nDone.",
  ])("preserves literal link-like syntax inside code: %s", (source) => {
    for (let split = 0; split <= source.length; split++) {
      const spans = streamedSpans(source, split);
      expect(spans.map((span) => span.text).join("")).toBe(source);
      for (const span of spans)
        expect(source.slice(span.sourceStart, span.sourceEnd)).toBe(span.text);
    }
  });
  it.each([
    "> Code:\n> ```js\n> callbacks[index](result)\n> ```\nDone.",
    "- Code:\n  ```js\n  callbacks[index](result)\n  ```\nDone.",
    "> Code:\n>\n>     callbacks[index](result)\nDone.",
  ])("preserves code in Markdown containers: %s", (source) => {
    for (let split = 0; split <= source.length; split++) {
      const spans = streamedSpans(source, split);
      expect(spans.map((span) => span.text).join("")).toBe(source);
      for (const span of spans)
        expect(source.slice(span.sourceStart, span.sourceEnd)).toBe(span.text);
    }
  });
  it("does not mistake an indented paragraph continuation for code", () => {
    const source = "See the manual:\n    [docs](https://example.com) now.";
    for (let split = 0; split <= source.length; split++) {
      const spans = streamedSpans(source, split);
      expect(spans.map((span) => span.text).join("")).toBe(
        "See the manual:\n    docs now.",
      );
    }
  });
  it("recognizes links again after code ends", () => {
    const source =
      "`callbacks[index](result)` then [the docs](https://example.com).";
    expect(
      speechTextSpans(source)
        .spans.map((span) => span.text)
        .join(""),
    ).toBe("`callbacks[index](result)` then the docs.");
  });
  it.each([
    "Run:\n\n    callbacks[index](result)\nThen continue.",
    "Run:\n\n\tcallbacks[index](result)\nThen continue.",
  ])("preserves indented literal code: %s", (source) => {
    for (let split = 0; split <= source.length; split++) {
      const spans = streamedSpans(source, split);
      expect(spans.map((span) => span.text).join("")).toBe(source);
      for (const span of spans)
        expect(source.slice(span.sourceStart, span.sourceEnd)).toBe(span.text);
    }
  });
  it.each([
    [
      "1. Read the manual:\n    [the docs](https://example.com/path) then continue.",
      "1. Read the manual:\n    the docs then continue.",
    ],
    [
      "- Read the manual:\n    [the docs](https://example.com/path) then continue.",
      "- Read the manual:\n    the docs then continue.",
    ],
    [
      "1. Read:\n    - [the docs](https://example.com/path) then continue.",
      "1. Read:\n    - the docs then continue.",
    ],
    [
      "1. Read:\n\n       callbacks[index](result)\n",
      "1. Read:\n\n       callbacks[index](result)\n",
    ],
  ])("distinguishes list continuation from indented code: %s", (source, expected) => {
    for (let split = 0; split <= source.length; split++) {
      const spans = streamedSpans(source, split);
      expect(spans.map((span) => span.text).join("")).toBe(expected);
      for (const span of spans)
        expect(source.slice(span.sourceStart, span.sourceEnd)).toBe(span.text);
    }
  });
  it("suppresses indented multiline destinations at every streaming split", () => {
    const source = "See [docs](\n    https://example.com/private/path\n) now.";
    for (let split = 0; split <= source.length; split++) {
      const spans = streamedSpans(source, split);
      expect(spans.map((span) => span.text).join("")).toBe("See docs now.");
      for (const span of spans)
        expect(source.slice(span.sourceStart, span.sourceEnd)).toBe(span.text);
    }
  });
  it("preserves streamed UTF-16 boundaries and source offsets", () => {
    const source = "See [👋 docs](https://example.com) now 👋.";
    for (let split = 0; split <= source.length; split++) {
      const spans = streamedSpans(source, split);
      expect(spans.map((span) => span.text).join("")).toBe(
        "See 👋 docs now 👋.",
      );
      for (const span of spans)
        expect(source.slice(span.sourceStart, span.sourceEnd)).toBe(span.text);
    }
  });
  it("maps spoken characters back to the literal source", () => {
    const source = "See [the docs](https://example.com) now.";
    const { spans } = speechTextSpans(source);
    for (const span of spans)
      expect(source.slice(span.sourceStart, span.sourceEnd)).toBe(span.text);
    const { spans: resumed } = speechTextSpans(source, source.indexOf("docs"));
    expect(resumed.map((span) => span.text).join("")).toBe("docs now.");
  });
  it("preserves plain text", () => {
    expect(
      speechTextSpans("Hello (world). https://example.com")
        .spans.map((span) => span.text)
        .join(""),
    ).toBe("Hello (world). https://example.com");
  });
});
