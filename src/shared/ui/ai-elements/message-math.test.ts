import { describe, expect, it } from "vitest";
import { normalizeMessageMath, prepareMessageMath } from "./message-math";

const normalize = (source: string) => normalizeMessageMath(source).content;
const display = (body: string) => `\n\n$$\n${body}\n$$\n\n`;

describe("message math normalization", () => {
  it("renders bracket display equations with fractions and inequalities", () => {
    const equation = String.raw`\frac{a^2}{b} \le \text{limit}_{n}`;
    expect(normalize(`Before \\[${equation}\\] after`)).toBe(
      `Before ${display(equation)} after`,
    );
    expect(normalize(`\\[\n${equation}\n\\]`)).toBe(display(equation));
  });

  it("handles separate equations and symbols without changing formula commands", () => {
    expect(
      normalize(
        String.raw`$\alpha$ then \[x\] $\rightarrow$ \[\text{value}\] $\Omega$`,
      ),
    ).toBe(`α then ${display("x")} → ${display(String.raw`\text{value}`)} Ω`);
  });

  it.each([
    String.raw`\(a^2\)`,
    "$a^2$",
    "$\\unknownCommand$",
    "Revenue $20; margin $10.",
    "Run $PATH and $HOME; use snake_case.",
    "[ordinary brackets]",
    String.raw`\[unfinished`,
    String.raw`\\[literal\\]`,
    String.raw`\$\rightarrow$`,
    String.raw`$$\rightarrow$$`,
    "$$\n\\[literal\\]\n$$",
  ])("leaves unsupported, escaped, ordinary and existing math unchanged: %s", (source) => {
    expect(normalize(source)).toBe(source);
  });

  it.each([
    "`\\[literal\\]`",
    "``\\[literal ` text\\]``",
    "`first```\\[literal\\]`",
    "```tex\n\\[literal\\]\n```",
    "````tex\n```\n\\[literal\\]\n````",
    "~~~tex\n$\\rightarrow$\n~~~",
    "> ```tex\n> \\[literal\\]\n> ```",
    "- example\n    ~~~tex\n    \\[literal\\]\n  ~~~",
    "```tex\n> ```\n\\[literal\\]\n```",
    "```tex\r\n\\[literal\\]\r\n```",
    "```tex\n    ```\n\\[literal\\]\n```",
    "<pre>\\[literal\\]</pre>",
    "[link](https://example.com/\\[literal\\])",
  ])("preserves parser-recognized code and markup: %s", (source) => {
    expect(normalize(source)).toBe(source);
    expect(normalize(`${source}\n\n\\[live\\]`)).toBe(
      `${source}\n\n${display("live")}`,
    );
  });

  it("protects indented code and unclosed streaming fences", () => {
    const indented = "    \\[literal\\]\n";
    expect(normalize(indented)).toBe(indented);
    const unclosed = "```tex\n\\[unfinished\n\n\\[live\\]";
    expect(normalize(unclosed)).toBe(unclosed);
  });

  it.each([
    String.raw`before \[live\] then ` + "`" + String.raw`\[literal\]`,
    "`" + String.raw`$\alpha$`,
    "``" + String.raw`\[literal\]`,
  ])("preserves the remainder of an incomplete inline code span: %s", (source) => {
    const expected = source.replace(String.raw`\[live\]`, () =>
      display("live"),
    );
    expect(normalize(source)).toBe(expected);
  });

  it("does not let an escaped backtick hide live math", () => {
    expect(normalize("\\` " + String.raw`\[live\]`)).toBe(
      "\\` " + display("live"),
    );
  });

  it.each([
    "- item\n      ~~~text\n      text\n",
    "```text `invalid`\n",
    "    ```\n    literal\n\n",
  ])("does not let invalid pseudo-fences hide following equations: %s", (prefix) => {
    const rendered = normalize(`${prefix}\\[live\\]`);
    expect(rendered).toContain("$$\n");
    expect(rendered).toMatch(/\n[ ]*live\n[ ]*\$\$/);
    expect(rendered).not.toContain(String.raw`\[live\]`);
  });

  it("distinguishes even and odd backslash runs at both delimiters", () => {
    expect(normalize(String.raw`\\\[x\\\]`)).toBe(
      String.raw`\\` + display(String.raw`x\\`),
    );
    expect(normalize(String.raw`\[x\\] remains incomplete`)).toBe(
      String.raw`\[x\\] remains incomplete`,
    );
  });

  it("leaves a split streaming delimiter unchanged until complete", () => {
    const chunks = ["\\", "\\[", "\\[x^2", "\\[x^2\\", "\\[x^2\\]"];
    expect(chunks.map(normalize)).toEqual([
      ...chunks.slice(0, -1),
      display("x^2"),
    ]);
  });

  it("is idempotent for normalized equations and symbols", () => {
    const source = String.raw`$\leq$ \[\frac{a}{b}\] $\rightarrow$`;
    expect(normalize(normalize(source))).toBe(normalize(source));
  });

  it("maps the voice boundary after multiple shortened symbols", () => {
    const source = String.raw`$\alpha$ heard $\rightarrow$ unheard`;
    const cutoff = source.indexOf("unheard");
    const result = normalizeMessageMath(source, cutoff);
    expect(result).toEqual({
      content: "α heard → unheard",
      cutoff: "α heard → ".length,
    });
    expect(normalizeMessageMath(source, 4).cutoff).toBe(0);
    expect(normalizeMessageMath("Nothing changed", 4)).toEqual({
      content: "Nothing changed",
      cutoff: 4,
    });
  });

  it.each([
    String.raw`<code>$\rightarrow$ \[literal\]</code>`,
    String.raw`<span><pre>\[literal\]</pre></span>`,
    String.raw`<code class="math">$\alpha$</code>`,
    String.raw`<code title="a > b">$\alpha$</code>`,
    String.raw`<code>\[unfinished`,
    String.raw`<span style="--math: $\alpha$">ordinary</span>`,
    String.raw`https://example.com/$\alpha$`,
    String.raw`www.example.com/$\alpha$`,
    String.raw`<https://example.com/$\alpha$>`,
  ])("preserves HTML code bodies, attributes, and GFM destinations: %s", (source) => {
    expect(normalize(source)).toBe(source);
  });

  it("keeps inline HTML code unchanged while converting following prose", () => {
    const source = String.raw`<span><code>\[literal\] $\alpha$</code></span>`;
    expect(normalize(source + String.raw` then $\rightarrow$`)).toBe(
      source + " then →",
    );
  });

  it.each([
    [String.raw`\[x\]`, display("x")],
    ["\\[a\n\nb\\]", display("a\n\nb")],
    [String.raw`> \[x\]`, "> \n>\n> $$\n> x\n> $$\n>\n> "],
    ["> \\[a\n> + b\\]", "> \n>\n> $$\n> a\n> + b\n> $$\n>\n> "],
    ["> \\[a\n>+ b\\]", "> \n>\n> $$\n> a\n> + b\n> $$\n>\n> "],
    [String.raw`- \[x\]`, "- \n\n  $$\n  x\n  $$\n\n  "],
    ["- \\[a\n  + b\\]", "- \n\n  $$\n  a\n  + b\n  $$\n\n  "],
    [String.raw`> - \[x\]`, "> - \n>\n>   $$\n>   x\n>   $$\n>\n>   "],
    ["- outer\n  - \\[x\\]", "- outer\n  - \n\n    $$\n    x\n    $$\n\n    "],
    [String.raw`1. \[x\]`, "1. \n\n   $$\n   x\n   $$\n\n   "],
  ])("emits display blocks with the source container: %s", (source, expected) => {
    expect(normalize(source)).toBe(expected);
    expect(normalize(expected)).toBe(expected);
  });

  it.each([
    String.raw`**before \[x\] after**`,
    String.raw`*before \[x\] after*`,
    String.raw`~~before \[x\] after~~`,
    String.raw`# Heading \[x\] after`,
    "| Value |\n| -- |\n| \\[x\\] |",
    String.raw`<span>before \[x\] after</span>`,
    "\\[root\n\n> quote\\]",
  ])("preserves bracket source where display insertion would change markup: %s", (source) => {
    expect(normalize(source)).toBe(source);
  });

  it("still converts known symbols within inline formatting and table cells", () => {
    expect(normalize(String.raw`**$\alpha$**`)).toBe("**α**");
    expect(normalize("| Value |\n| -- |\n| $\\alpha$ |")).toBe(
      "| Value |\n| -- |\n| α |",
    );
  });

  it.each([
    "- First \\[x\n- Second y\\]",
    "1. First \\[x\n2. Second y\\]",
    "> - First \\[x\n> - Second y\\]",
    "- Parent\n  - First \\[x\n  - Second y\\]",
    "- First \\[x\n+ Second y\\]",
    "\\[root\n> quote\\]",
  ])("preserves delimiters crossing Markdown containers: %s", (source) => {
    const prepared = prepareMessageMath(source);
    expect(prepared.content).toBe(source);
    expect(prepared.remapCutoff(source.indexOf("\\]"))).toBe(
      source.indexOf("\\]"),
    );
    expect(prepared.remapCutoff(source.length)).toBe(source.length);
  });

  it.each([
    "- Parent \\[x\n  - Child y\\]",
    "1. Parent \\[x\n   1. Child y\\]",
    "> - Parent \\[x\n>   - Child y\\]",
    "- Parent \\[x\n  + Child y\\]",
    "- Parent \\[x\n  * b\\]",
    "- Parent \\[x\n  - Child y\n  z\\]",
  ])("preserves equations crossing into a child item: %s", (source) => {
    const prepared = prepareMessageMath(source);
    expect(prepared.content).toBe(source);
    for (let cutoff = 0; cutoff <= source.length; cutoff += 1)
      expect(prepared.remapCutoff(cutoff)).toBe(cutoff);
  });

  it("maps boundaries across inserted display lines and shortened symbols", () => {
    const source = String.raw`$\alpha$ before \[x^2\] after $\rightarrow$ tail`;
    const prepared = prepareMessageMath(source);
    const formulaStart = source.indexOf(String.raw`\[`);
    const formulaEnd = source.indexOf(String.raw`\]`) + 2;
    const outputStart = prepared.content.indexOf(display("x^2"));
    expect(prepared.remapCutoff(formulaStart)).toBe(outputStart);
    expect(prepared.remapCutoff(formulaStart + 4)).toBe(outputStart);
    expect(prepared.remapCutoff(formulaEnd)).toBe(
      outputStart + display("x^2").length,
    );
    expect(prepared.remapCutoff(source.indexOf("tail"))).toBe(
      prepared.content.indexOf("tail"),
    );
    expect(prepared.remapCutoff(source.length)).toBe(prepared.content.length);
    expect(prepared.remapCutoff()).toBeUndefined();
  });

  it.each([
    "+ b",
    "- b",
    "+ 2.5",
    "+ \\beta",
    "+ b^2",
    "- x_{12}",
  ])("keeps a simple algebra continuation: %s", (term) => {
    const source = `- Formula \\[a\n  ${term}\\] afterwards`;
    expect(normalize(source)).toContain(`  a\n  ${term}\n  $$`);
    expect(normalize(source)).not.toContain("\\[");
  });
  it("normalizes equations through the source-size boundary", () => {
    const source = "a".repeat(127_993) + String.raw`\[x^2\]`;
    expect(source).toHaveLength(128_000);
    expect(normalize(source)).toBe("a".repeat(127_993) + display("x^2"));
  });

  it.each([
    "a".repeat(128_000) + String.raw`\[x^2\]`,
    "a".repeat(128_000) + "\n```tex\n" + String.raw`\[literal\]` + "\n```",
  ])("preserves oversized source and voice offsets without parsing", (source) => {
    const prepared = prepareMessageMath(source);
    expect(prepared.content).toBe(source);
    expect(prepared.remapCutoff(128_002)).toBe(128_002);
    expect(prepared.remapCutoff()).toBeUndefined();
  });
});
