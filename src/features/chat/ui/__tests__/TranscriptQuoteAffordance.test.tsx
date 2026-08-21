import { fireEvent, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import type { Message } from "@/shared/types/messages";
import { TranscriptQuoteAffordance } from "../TranscriptQuoteAffordance";

const message: Message = {
  id: "message-1",
  role: "assistant",
  created: 1,
  content: [{ type: "text", text: "Select this plain text" }],
};

function Fixture() {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div className="relative">
      <div ref={rootRef} data-testid="transcript-root">
        <div
          data-quote-message-id="message-1"
          data-quote-message-role="assistant"
        >
          <div data-quote-surface="true">Select this plain text</div>
        </div>
      </div>
      <TranscriptQuoteAffordance
        messages={[message]}
        rootRef={rootRef}
        sessionId="session-1"
      />
    </div>
  );
}

function selectTranscriptText(root: HTMLElement) {
  const textNode = root.querySelector("[data-quote-surface]")?.firstChild;
  if (!textNode) throw new Error("missing transcript text");

  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, 6);
  Object.defineProperty(range, "getBoundingClientRect", {
    value: () => ({
      bottom: 40,
      height: 20,
      left: 20,
      right: 80,
      top: 20,
      width: 60,
      x: 20,
      y: 20,
      toJSON: () => ({}),
    }),
  });
  Object.defineProperty(root, "getBoundingClientRect", {
    value: () => ({
      bottom: 400,
      height: 400,
      left: 0,
      right: 600,
      top: 0,
      width: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
  const selection = window.getSelection();
  if (!selection) throw new Error("selection unavailable");
  selection.removeAllRanges();
  selection.addRange(range);
}

describe("TranscriptQuoteAffordance", () => {
  it("stays hidden while a drag selection is still in progress", () => {
    renderWithProviders(<Fixture />);
    const root = screen.getByTestId("transcript-root");

    fireEvent.pointerDown(root);
    selectTranscriptText(root);
    // Mid-drag the browser emits selectionchange as the range grows; the
    // affordance must not appear until the pointer is released.
    fireEvent(document, new Event("selectionchange"));

    expect(
      screen.queryByRole("button", { name: "Quote in message" }),
    ).not.toBeInTheDocument();

    fireEvent.pointerUp(document);

    expect(
      screen.getByRole("button", { name: "Quote in message" }),
    ).toBeInTheDocument();
  });

  it("stages a keyboard selection from the document context-menu shortcut", () => {
    renderWithProviders(<Fixture />);
    const root = screen.getByTestId("transcript-root");
    root.tabIndex = -1;
    root.focus();
    selectTranscriptText(root);
    fireEvent.keyUp(root, { key: "Shift" });

    fireEvent.keyDown(document, { key: "F10", shiftKey: true });

    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Quote added to message",
    );
  });

  it("shows after the user finishes selecting transcript text", async () => {
    const nativeAddEventListener = document.addEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation(
      (type, listener, options) => {
        // Tauri's macOS WebKit view does not reliably emit selectionchange
        // when a drag selection finishes. The transcript's pointer boundary
        // must therefore be sufficient to update the affordance.
        if (type === "selectionchange") return;
        nativeAddEventListener(type, listener, options);
      },
    );
    renderWithProviders(<Fixture />);
    const root = screen.getByTestId("transcript-root");
    const textNode = root.querySelector("[data-quote-surface]")?.firstChild;
    if (!textNode) throw new Error("missing transcript text");

    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 6);
    Object.defineProperty(range, "getBoundingClientRect", {
      value: () => ({
        bottom: 40,
        height: 20,
        left: 20,
        right: 80,
        top: 20,
        width: 60,
        x: 20,
        y: 20,
        toJSON: () => ({}),
      }),
    });
    Object.defineProperty(root, "getBoundingClientRect", {
      value: () => ({
        bottom: 400,
        height: 400,
        left: 0,
        right: 600,
        top: 0,
        width: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    const selection = window.getSelection();
    if (!selection) throw new Error("selection unavailable");
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.pointerUp(root);

    expect(
      await screen.findByRole("button", { name: "Quote in message" }),
    ).toBeInTheDocument();
  });
});
