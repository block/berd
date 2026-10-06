import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageResponse } from "./message";

describe("MessageResponse math with the real renderer", () => {
  it("renders fractions and multiple bracket equations as KaTeX", () => {
    const { container } = render(
      <MessageResponse mode="static">
        {String.raw`Before \[\frac{x^2}{100} \le y\] then \[a+b=c\] after`}
      </MessageResponse>,
    );
    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.querySelectorAll(".katex-display")).toHaveLength(2);
    expect(container.querySelector(".katex-error")).toBeNull();
    expect(container.textContent).not.toContain(String.raw`\[`);
    expect(container.textContent).toContain("Before");
  });

  it.each([
    String.raw`\[x^2\]`,
    "Before \\[a\n+ b\\] after",
    "> \\[a\n> + b\\]",
    "- Formula \\[a\n  + b\\] afterwards",
    "- Formula \\[a\n  - b\\] afterwards",
    "- Formula \\[a\n  + \\beta\\] afterwards",
    "- Formula \\[a\n  + b^2\\] afterwards",
    "> - Formula \\[a\n>   + b\\] afterwards",
    "- Outer\n  - Inner \\[a\n    + b\\] afterwards",
    "1. Formula \\[a\n   + b\\] afterwards\n2. Unrelated prose",
    "- Formula \\[a\n  + b\\] afterwards\n- Unrelated prose",
  ])("renders a display equation in its Markdown container: %s", (content) => {
    const { container } = render(
      <MessageResponse mode="static">{content}</MessageResponse>,
    );
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
    expect(container.querySelector(".katex-error")).toBeNull();
    if (content.startsWith(">"))
      expect(
        container.querySelector("blockquote .katex-display"),
      ).not.toBeNull();
    if (content.includes("- "))
      expect(container.querySelector("li .katex-display")).not.toBeNull();
  });

  it.each([
    "- First \\[x\n- Second y\\]",
    "- Parent \\[x\n  - Child y\\]",
    "1. Parent \\[x\n   1. Child y\\]",
    "> - Parent \\[x\n>   - Child y\\]",
    "- Parent \\[x\n  + Child y\\]",
    "- Parent \\[x\n  * Child b\\]",
    "- Parent \\[x\n  - Child y\n  z\\]",
    "1. First \\[x\n2. Second y\\]",
    "> - First \\[x\n> - Second y\\]",
    "- First \\[x\n+ Second y\\]",
  ])("preserves both list items when a delimiter pair spans them: %s", (content) => {
    const { container } = render(
      <MessageResponse mode="static">{content}</MessageResponse>,
    );
    const items = container.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain(
      content.includes("Parent") ? "Parent" : "First",
    );
    expect(items[1].textContent).toContain(
      content.includes("Child") ? "Child" : "Second",
    );
    expect(container.querySelector(".katex-display")).toBeNull();
    expect(container.querySelector(".katex-error")).toBeNull();
  });

  it("preserves sibling list items as a cross-item delimiter pair streams in", () => {
    const content = "- First \\[x\n- Second y";
    const { container, rerender } = render(
      <MessageResponse>{content}</MessageResponse>,
    );
    expect(container.querySelectorAll("li")).toHaveLength(2);
    rerender(<MessageResponse>{content + "\\]"}</MessageResponse>);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector(".katex-display")).toBeNull();
    expect(container.querySelectorAll("li")[1].textContent).toContain("Second");
    rerender(
      <MessageResponse>{"- First \\[x\\]\n- Second y"}</MessageResponse>,
    );
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
  });

  it("preserves parent and child as the closing delimiter streams in", () => {
    const source = "- Parent \\[x\n  - Child y";
    const { container, rerender } = render(
      <MessageResponse>{source}</MessageResponse>,
    );
    for (const suffix of ["", "\\", "\\]"]) {
      rerender(<MessageResponse>{source + suffix}</MessageResponse>);
      expect(container.querySelectorAll("li")).toHaveLength(2);
      expect(container.querySelector("li li")?.textContent).toContain("Child");
      expect(container.querySelector(".katex-display")).toBeNull();
    }
  });

  it.each([
    [
      "\\[unfinished\n\n## Next section\n\nHere is the closing marker \\]",
      "h2",
    ],
    [
      "- \\[unfinished\n\n  ## Next section\n\n  Here is the closing marker \\]",
      "li h2",
    ],
    [
      "> \\[unfinished\n>\n> ## Next section\n>\n> Here is the closing marker \\]",
      "blockquote h2",
    ],
    ["\\[unfinished\n\nNext section\n============\n\nClosing \\]", "h1"],
    ["\\[unfinished\n\n***\n\nClosing \\]", "hr"],
    ["\\[unfinished\n\n| Value |\n| --- |\n| prose |\n\nClosing \\]", "table"],
    ["\\[unfinished\n\n>\n\nClosing \\]", "blockquote"],
    ["\\[unfinished\n\n-\n\nClosing \\]", "li"],
  ])("preserves intervening blocks through the actual renderer: %s", (source, selector) => {
    const { container, rerender } = render(
      <MessageResponse mode="static">{source}</MessageResponse>,
    );
    expect(container.querySelector(selector)).not.toBeNull();
    expect(container.querySelector(".katex-display")).toBeNull();
    rerender(
      <MessageResponse mode="static">
        {source + "\n\n\\[live\\]"}
      </MessageResponse>,
    );
    expect(container.querySelector(selector)).not.toBeNull();
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
  });

  it("preserves a heading as the closing delimiter streams in", () => {
    const source = "\\[unfinished\n\n## Next section\n\nClosing ";
    const { container, rerender } = render(
      <MessageResponse>{source}</MessageResponse>,
    );
    for (const suffix of ["", "\\", "\\]"]) {
      rerender(<MessageResponse>{source + suffix}</MessageResponse>);
      expect(container.querySelector("h2")?.textContent).toBe("Next section");
      expect(container.querySelector(".katex-display")).toBeNull();
    }
  });

  it.each([
    "-\tFormula \\[x\\] afterwards\n- Next item",
    "1.\tFormula \\[x\\] afterwards\n2. Next item",
    "12.\tFormula \\[x\\] afterwards\n13. Next item",
    "123.\tFormula \\[x\\] afterwards\n124. Next item",
    "> -\tFormula \\[x\\] afterwards\n> - Next item",
    "- Outer\n  -\tFormula \\[x\\] afterwards\n  - Next item",
    "-\tFormula \\[a\n\t+ b\\] afterwards\n- Next item",
  ])("keeps tab-indented math and tail inside their list item: %s", (source) => {
    const { container, rerender } = render(
      <MessageResponse mode="static">{source}</MessageResponse>,
    );
    const items = container.querySelectorAll("li");
    const formula = container.querySelector(".katex-display")?.closest("li");
    expect(items).toHaveLength(source.includes("Outer") ? 3 : 2);
    expect(formula).toBeTruthy();
    expect(formula?.textContent).toContain("Formula");
    expect(formula?.textContent).toContain("afterwards");
    expect(items[items.length - 1].textContent?.trim()).toBe("Next item");
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector(".katex-error")).toBeNull();
    const cutoff = source.indexOf("afterwards");
    rerender(
      <MessageResponse mode="static" strikethroughFrom={cutoff}>
        {source}
      </MessageResponse>,
    );
    expect(
      container.querySelector('[data-voice-unspoken="true"]')?.textContent,
    ).toContain("afterwards");
    expect(container.querySelector("li .katex-display")).not.toBeNull();
  });

  it.each([
    "  - \\[x\\] after\n  - Next",
    "   - \\[x\\] after\n   - Next",
    "-    \\[x\\] after\n- Next",
    "> > - \\[x\\] after\n> > - Next",
    "-\n  \\[x\\] after\n- Next",
    "- \\[x\\] after\n- Next",
    "+ \\[x\\] after\n+ Next",
    "* \\[x\\] after\n* Next",
    "1. \\[x\\] after\n2. Next",
    "12. \\[x\\] after\n13. Next",
    "123) \\[x\\] after\n124) Next",
    "-\t\\[x\\] after\n- Next",
    "1.\t\\[x\\] after\n2. Next",
    "123.\t\\[x\\] after\n124. Next",
    "> - \\[x\\] after\n> - Next",
    "> 1. \\[x\\] after\n> 2. Next",
    "- Outer\n  - \\[x\\] after\n  - Next",
    "- Outer\n  -\t\\[x\\] after\n  - Next",
    "> - Outer\n>   - \\[x\\] after\n>   - Next",
    "- > \\[x\\] after\n- Next",
    "- \\[a\n  + b\\] after\n- Next",
    "- \\[x\\] after\r\n- Next",
    "- \\[x\\] after and \\[y\\] also\n- Next",
    "- Intro\n\n  \\[x\\] after\n- Next",
  ])("keeps item-start equations, tail and following item in the same list: %s", (source) => {
    const { container, rerender } = render(
      <MessageResponse mode="static">{source}</MessageResponse>,
    );
    const verify = () => {
      const items = container.querySelectorAll("li");
      const next = items[items.length - 1];
      const owner = items[items.length - 2];
      expect(items).toHaveLength(source.includes("Outer") ? 3 : 2);
      const displays = container.querySelectorAll(".katex-display");
      expect(displays).toHaveLength(source.includes("also") ? 2 : 1);
      for (const display of displays) expect(display.closest("li")).toBe(owner);
      expect(owner.textContent).toContain("after");
      expect(next.textContent?.trim()).toBe("Next");
      expect(owner.parentElement).toBe(next.parentElement);
      expect(container.querySelector("pre")).toBeNull();
      expect(container.querySelector(".katex-error")).toBeNull();
      if (source.includes("[ ]") || source.includes("[x]"))
        expect(
          container.querySelectorAll('input[type="checkbox"]'),
        ).toHaveLength(2);
    };
    verify();
    rerender(
      <MessageResponse
        mode="static"
        strikethroughFrom={source.indexOf("after")}
      >
        {source}
      </MessageResponse>,
    );
    verify();
    expect(
      container.querySelector('[data-voice-unspoken="true"]')?.textContent,
    ).toContain("after");
  });

  it.each([
    ["- ", "\n- Next"],
    ["1. ", "\n2. Next"],
    ["-\t", "\n- Next"],
    ["> - ", "\n> - Next"],
    ["- Outer\n  - ", "\n  - Next"],
  ])("retains item-start equation ownership when the close streams in: %s", (prefix, following) => {
    const { container, rerender } = render(
      <MessageResponse>{prefix}</MessageResponse>,
    );
    for (const equation of ["\\[x", "\\[x\\", "\\[x\\]"]) {
      rerender(
        <MessageResponse>
          {prefix + equation + " after" + following}
        </MessageResponse>,
      );
      const items = container.querySelectorAll("li");
      const owner = items[items.length - 2];
      const next = items[items.length - 1];
      expect(items).toHaveLength(prefix.includes("Outer") ? 3 : 2);
      expect(owner.textContent).toContain("after");
      expect(owner.parentElement).toBe(next.parentElement);
      if (equation.endsWith("\\]"))
        expect(next.textContent?.trim()).toBe("Next");
      else expect(next.textContent).toContain("Next");
      if (equation.endsWith("\\]"))
        expect(container.querySelector(".katex-display")?.closest("li")).toBe(
          owner,
        );
      else expect(container.querySelector(".katex-display")).toBeNull();
    }
  });

  it.each([
    " ",
    "x",
    "X",
  ])("preserves checkbox semantics and source for task math: %s", (state) => {
    const source = `- [${state}] \\[x\\] after\n- [ ] Next`;
    const { container } = render(
      <MessageResponse mode="static">{source}</MessageResponse>,
    );
    const items = container.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("[x] after");
    expect(items[1].textContent?.trim()).toBe("Next");
    const checkboxes = container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0].checked).toBe(state !== " ");
    expect(checkboxes[1].checked).toBe(false);
    expect(container.querySelector(".katex-display")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("retains a later child under an equation-first parent", () => {
    const { container } = render(
      <MessageResponse mode="static">
        {"- \\[x\\] after\n  - Child\n- Next"}
      </MessageResponse>,
    );
    const rootList = container.querySelector("ul");
    const items = rootList?.children;
    expect(items).toHaveLength(2);
    expect(container.querySelector(".katex-display")?.closest("li")).toBe(
      items?.[0],
    );
    expect(items?.[0].querySelector("li")?.textContent?.trim()).toBe("Child");
    expect(items?.[1].textContent?.trim()).toBe("Next");
  });

  it("renders an equation-only item at end of source", () => {
    const { container } = render(
      <MessageResponse mode="static">{"- \\[x\\]"}</MessageResponse>,
    );
    const item = container.querySelector("li");
    expect(container.querySelectorAll("ul")).toHaveLength(1);
    expect(container.querySelectorAll("li")).toHaveLength(1);
    expect(container.querySelector(".katex-display")?.closest("li")).toBe(item);
    expect(container.querySelector(".katex-error")).toBeNull();
  });

  it("allows a later task-item paragraph and a plain child to render math", () => {
    const source =
      "- [ ] Task\n\n  \\[x\\] after\n\n  - \\[y\\] child\n- [ ] Next";
    const { container } = render(
      <MessageResponse mode="static">{source}</MessageResponse>,
    );
    const items = container.querySelectorAll("li");
    const math = container.querySelectorAll(".katex-display");
    expect(items).toHaveLength(3);
    expect(math).toHaveLength(2);
    expect(math[0].closest("li")).toBe(items[0]);
    expect(math[1].closest("li")).toBe(items[1]);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(
      2,
    );
  });

  it("preserves raw HTML code and GFM autolink destinations", () => {
    const { container } = render(
      <MessageResponse mode="static">
        {String.raw`<code>$\rightarrow$</code> https://example.com/$\alpha$ and \[x^2\]`}
      </MessageResponse>,
    );
    expect(container.querySelector("code")?.textContent).toBe(
      String.raw`$\rightarrow$`,
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/$%5Calpha$",
    );
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
  });

  it("updates a partially streamed formula once its closing delimiter arrives", () => {
    const { container, rerender } = render(
      <MessageResponse>{String.raw`\[x^2`}</MessageResponse>,
    );
    expect(container.querySelector(".katex")).toBeNull();
    rerender(<MessageResponse>{String.raw`\[x^2\]`}</MessageResponse>);
    expect(container.querySelectorAll(".katex")).toHaveLength(1);
  });

  it("preserves unfinished inline code through the streaming renderer", () => {
    const { container, rerender } = render(
      <MessageResponse>{"`\\[literal\\]"}</MessageResponse>,
    );
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe(
      String.raw`\[literal\]`,
    );
    rerender(
      <MessageResponse>{"`\\[literal\\]` then \\[x^2\\]"}</MessageResponse>,
    );
    expect(container.querySelector("code")?.textContent).toBe(
      String.raw`\[literal\]`,
    );
    expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
  });

  it("keeps currency, shell text and actual code literal while showing symbols", () => {
    const { container } = render(
      <MessageResponse mode="static">
        {"Revenue $20 and $10; $PATH; $\\rightarrow$. Code `\\[x^2\\]`."}
      </MessageResponse>,
    );
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("Revenue $20 and $10; $PATH; →.");
    expect(container.querySelector("code")?.textContent).toBe(
      String.raw`\[x^2\]`,
    );
  });

  it("keeps the voice cutoff aligned after symbol shortening", () => {
    const content = String.raw`$\alpha$ heard $\rightarrow$ unheard`;
    const { container } = render(
      <MessageResponse
        mode="static"
        strikethroughFrom={content.indexOf("unheard")}
      >
        {content}
      </MessageResponse>,
    );
    expect(
      container.querySelector('[data-voice-unspoken="true"]')?.textContent,
    ).toBe("unheard");
    expect(screen.getByText("Not spoken:")).toBeTruthy();
  });
});
