import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RunnableCodeBlock } from "./runnable-code-block";

vi.mock("streamdown", () => ({
  CodeBlock: ({
    children,
    code,
  }: {
    children?: ReactNode;
    code: string;
    language: string;
    isIncomplete?: boolean;
  }) => (
    <div data-testid="code-block">
      <div data-testid="code-block-actions">{children}</div>
      <pre>
        <code data-testid="code-content">{code}</code>
      </pre>
    </div>
  ),
  CodeBlockCopyButton: () => (
    <button type="button" aria-label="Copy code">
      copy
    </button>
  ),
  CodeBlockDownloadButton: () => (
    <button type="button" aria-label="Download file">
      download
    </button>
  ),
}));

function selectText(node: Node, start: number, end: number) {
  const selection = window.getSelection();
  selection?.removeAllRanges();
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  selection?.addRange(range);
}

describe("RunnableCodeBlock", () => {
  it("runs the full bash code when the run button is clicked without a selection", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();

    render(
      <RunnableCodeBlock code={"pnpm test\n"} language="bash" onRun={onRun} />,
    );

    await user.click(screen.getByRole("button", { name: "Run in terminal" }));

    expect(onRun).toHaveBeenCalledWith("pnpm test", undefined);
  });

  it("runs only selected text when the selection is inside the code block", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    const code = "pnpm test\npnpm lint\npnpm build";

    render(<RunnableCodeBlock code={code} language="bash" onRun={onRun} />);

    const codeText = screen.getByTestId("code-content").firstChild;
    expect(codeText).toBeInstanceOf(Text);
    selectText(codeText as Text, code.indexOf("pnpm lint"), code.length);

    await user.click(screen.getByRole("button", { name: "Run in terminal" }));

    expect(onRun).toHaveBeenCalledWith("pnpm lint\npnpm build", undefined);
  });

  it("falls back to the full command when selection is outside the code block", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();

    render(
      <>
        <p data-testid="outside-text">outside selection</p>
        <RunnableCodeBlock code="pnpm test" language="bash" onRun={onRun} />
      </>,
    );

    const outsideText = screen.getByTestId("outside-text").firstChild;
    expect(outsideText).toBeInstanceOf(Text);
    selectText(outsideText as Text, 0, "outside".length);

    await user.click(screen.getByRole("button", { name: "Run in terminal" }));

    expect(onRun).toHaveBeenCalledWith("pnpm test", undefined);
  });

  it("passes newTerminal option when Cmd+clicking the run button", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();

    render(
      <RunnableCodeBlock code="pnpm test" language="bash" onRun={onRun} />,
    );

    const button = screen.getByRole("button", { name: "Run in terminal" });
    await user.keyboard("{Meta>}");
    await user.click(button);
    await user.keyboard("{/Meta}");

    expect(onRun).toHaveBeenCalledWith("pnpm test", { newTerminal: true });
  });

  it("does not pass newTerminal option on regular click", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();

    render(
      <RunnableCodeBlock code="pnpm test" language="bash" onRun={onRun} />,
    );

    await user.click(screen.getByRole("button", { name: "Run in terminal" }));

    expect(onRun).toHaveBeenCalledWith("pnpm test", undefined);
  });

  it("does not show run controls for incomplete streamed code", () => {
    render(
      <RunnableCodeBlock
        code="pnpm test"
        language="bash"
        isIncomplete
        onRun={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Run in terminal" }),
    ).not.toBeInTheDocument();
  });

  it("does not show run controls for transcript-style code fences", () => {
    render(
      <RunnableCodeBlock
        code={"$ echo hi\nhi"}
        language="terminal"
        onRun={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Run in terminal" }),
    ).not.toBeInTheDocument();
  });
});
