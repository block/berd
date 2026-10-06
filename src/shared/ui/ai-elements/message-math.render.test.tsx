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
