import { describe, expect, it } from "vitest";

import { parseInline, parseMarkdown } from "./markdown";

describe("parseInline", () => {
  it("passes plain text through as a single span", () => {
    expect(parseInline("hello world")).toEqual([
      { kind: "text", text: "hello world" },
    ]);
  });

  it("parses bold, italic, and code spans", () => {
    expect(parseInline("a **b** *c* _d_ `e`")).toEqual([
      { kind: "text", text: "a " },
      { kind: "bold", text: "b" },
      { kind: "text", text: " " },
      { kind: "italic", text: "c" },
      { kind: "text", text: " " },
      { kind: "italic", text: "d" },
      { kind: "text", text: " " },
      { kind: "code", text: "e" },
    ]);
  });

  it("parses http(s) links and rejects other schemes", () => {
    expect(parseInline("[docs](https://example.com/a)")).toEqual([
      { kind: "link", text: "docs", href: "https://example.com/a" },
    ]);
    // javascript: scheme never becomes a link — stays literal text.
    const spans = parseInline("[x](javascript:alert(1))");
    expect(spans.every((s) => s.kind !== "link")).toBe(true);
  });

  it("code spans win over emphasis inside them", () => {
    expect(parseInline("`a *b* c`")).toEqual([
      { kind: "code", text: "a *b* c" },
    ]);
  });

  it("lone asterisks stay literal", () => {
    expect(parseInline("2 * 3 * 4")).toEqual([
      { kind: "text", text: "2 * 3 * 4" },
    ]);
  });
});

describe("parseMarkdown", () => {
  it("splits paragraphs on blank lines", () => {
    const blocks = parseMarkdown("one\n\ntwo");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      spans: [{ kind: "text", text: "one" }],
    });
  });

  it("parses headings h1-h4", () => {
    const blocks = parseMarkdown("# Title\n#### Sub");
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 1 });
    expect(blocks[1]).toMatchObject({ kind: "heading", level: 4 });
  });

  it("parses fenced code and never inline-parses its body", () => {
    const blocks = parseMarkdown("```ts\nconst a = **not bold**;\n```");
    expect(blocks).toEqual([
      { kind: "code", language: "ts", text: "const a = **not bold**;" },
    ]);
  });

  it("an unclosed fence still renders as code", () => {
    const blocks = parseMarkdown("```\nunterminated");
    expect(blocks).toEqual([
      { kind: "code", language: "", text: "unterminated" },
    ]);
  });

  it("parses unordered and ordered lists", () => {
    const blocks = parseMarkdown("- a\n- b\n\n1. x\n2. y");
    expect(blocks[0]).toMatchObject({ kind: "list", ordered: false });
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ kind: "list", ordered: true });
  });

  it("parses block quotes and strips the markers", () => {
    const blocks = parseMarkdown("> quoted\n> more");
    expect(blocks[0]).toMatchObject({ kind: "quote" });
  });

  it("empty input produces no blocks", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n")).toEqual([]);
  });
});
