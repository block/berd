import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClickableImage } from "@/features/chat/ui/ClickableImage";
import { CodeBlock } from "@/shared/ui/ai-elements/code-block";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import {
  VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE,
  VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE,
} from "./index";

vi.mock("shiki", () => ({
  createHighlighter: vi.fn(() => new Promise(() => {})),
}));

describe("dynamic transcript layout markers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks clickable images as layout-pending until load settles", async () => {
    render(<ClickableImage src="asset://preview.png" alt="Preview" />);

    const button = screen.getByRole("button", { name: /preview/i });
    expect(button).toHaveAttribute(
      VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE,
      "image-loading",
    );
    expect(button).toHaveAttribute(
      VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE,
      "192",
    );

    fireEvent.load(screen.getByAltText("Preview"));

    await waitFor(() => {
      expect(button).not.toHaveAttribute(VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE);
    });
    expect(button).toHaveAttribute(
      VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE,
      "192",
    );
  });

  it("marks code blocks while highlighting is unsettled", () => {
    const { container } = render(
      <CodeBlock code="const value = 1;" language="typescript" />,
    );

    const pending = container.querySelector(
      `[${VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE}]`,
    );
    expect(pending).toHaveAttribute(
      VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE,
      "code-highlighting",
    );
  });

  it("marks Streamdown while streaming animation is active", async () => {
    const { container, rerender } = render(
      <MessageResponse isAnimating>Streaming markdown</MessageResponse>,
    );

    expect(
      container.querySelector(
        `[${VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE}="streamdown-async"]`,
      ),
    ).toBeTruthy();

    rerender(
      <MessageResponse isAnimating={false}>Streaming markdown</MessageResponse>,
    );

    await waitFor(() => {
      expect(
        container.querySelector(
          `[${VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE}="streamdown-async"]`,
        ),
      ).toBeNull();
    });
  });

  it("marks Streamdown after markdown content changes", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <MessageResponse>Initial markdown</MessageResponse>,
    );

    expect(
      container.querySelector(
        `[${VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE}="streamdown-async"]`,
      ),
    ).toBeNull();

    rerender(<MessageResponse>Updated markdown</MessageResponse>);

    expect(
      container.querySelector(
        `[${VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE}="streamdown-async"]`,
      ),
    ).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(220);
    });

    expect(
      container.querySelector(
        `[${VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE}="streamdown-async"]`,
      ),
    ).toBeNull();
  });
});
