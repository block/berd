import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/shared/ui/ai-elements/code-block";

const mockWriteText = vi.fn().mockResolvedValue(undefined);

describe("mounted code copy contract", () => {
  beforeEach(() => {
    mockWriteText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: mockWriteText,
      },
    });
  });

  it("copies exact mounted code-block source text through the exposed control", async () => {
    const source = [
      "function selectedCodeContract() {",
      '  return "mounted-code-copy";',
      "}",
    ].join("\n");

    render(
      <CodeBlock code={source} language="typescript">
        <CodeBlockCopyButton />
      </CodeBlock>,
    );

    await userEvent.click(screen.getByRole("button", { name: /copy/i }));
    await vi.waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith(source);
    });
  });
});
