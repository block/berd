import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE } from "@/features/chat/transcript/measurement";
import {
  TranscriptRowStateProvider,
  createTranscriptRowStateRegistry,
} from "@/features/chat/transcript/row-state";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "./reasoning";

function renderReasoning(
  registry = createTranscriptRowStateRegistry(),
  children = "Stored thoughts",
  stateKey?: string,
) {
  return render(
    <TranscriptRowStateProvider
      registry={registry}
      sessionId="session-1"
      rowId="row-1"
    >
      <Reasoning defaultOpen={false} stateKey={stateKey}>
        <ReasoningTrigger>Toggle reasoning</ReasoningTrigger>
        <ReasoningContent>{children}</ReasoningContent>
      </Reasoning>
    </TranscriptRowStateProvider>,
  );
}

describe("Reasoning row-state adapters", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("restores open state from virtual row state", () => {
    const registry = createTranscriptRowStateRegistry();
    const firstRender = renderReasoning(registry);

    fireEvent.click(screen.getByRole("button", { name: /toggle reasoning/i }));
    expect(
      screen.getByRole("button", { name: /toggle reasoning/i }),
    ).toHaveAttribute("aria-expanded", "true");

    firstRender.unmount();
    renderReasoning(registry);

    expect(
      screen.getByRole("button", { name: /toggle reasoning/i }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("restores keyed reasoning blocks independently after remount", () => {
    const registry = createTranscriptRowStateRegistry();
    const firstRender = render(
      <TranscriptRowStateProvider
        registry={registry}
        sessionId="session-1"
        rowId="row-1"
      >
        <Reasoning defaultOpen={false} stateKey="thinking-0">
          <ReasoningTrigger>Toggle first reasoning</ReasoningTrigger>
          <ReasoningContent>First thoughts</ReasoningContent>
        </Reasoning>
        <Reasoning defaultOpen={false} stateKey="thinking-1">
          <ReasoningTrigger>Toggle second reasoning</ReasoningTrigger>
          <ReasoningContent>Second thoughts</ReasoningContent>
        </Reasoning>
      </TranscriptRowStateProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /toggle second reasoning/i }),
    );
    expect(
      screen.getByRole("button", { name: /toggle first reasoning/i }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", { name: /toggle second reasoning/i }),
    ).toHaveAttribute("aria-expanded", "true");

    firstRender.unmount();
    render(
      <TranscriptRowStateProvider
        registry={registry}
        sessionId="session-1"
        rowId="row-1"
      >
        <Reasoning defaultOpen={false} stateKey="thinking-0">
          <ReasoningTrigger>Toggle first reasoning</ReasoningTrigger>
          <ReasoningContent>First thoughts</ReasoningContent>
        </Reasoning>
        <Reasoning defaultOpen={false} stateKey="thinking-1">
          <ReasoningTrigger>Toggle second reasoning</ReasoningTrigger>
          <ReasoningContent>Second thoughts</ReasoningContent>
        </Reasoning>
      </TranscriptRowStateProvider>,
    );

    expect(
      screen.getByRole("button", { name: /toggle first reasoning/i }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.getByRole("button", { name: /toggle second reasoning/i }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("marks reasoning content layout pending during animation windows", () => {
    vi.useFakeTimers();
    renderReasoning();

    fireEvent.click(screen.getByRole("button", { name: /toggle reasoning/i }));
    const content = screen
      .getByText("Stored thoughts")
      .closest('[data-slot="collapsible-content"]');
    expect(content).toHaveAttribute(
      VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE,
      "reasoning-animation",
    );

    act(() => {
      vi.advanceTimersByTime(220);
    });
    expect(content).not.toHaveAttribute(VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE);
  });

  it("renders external links through the custom link handler, not Streamdown's built-in modal", () => {
    const registry = createTranscriptRowStateRegistry();
    const { container } = render(
      <TranscriptRowStateProvider
        registry={registry}
        sessionId="session-1"
        rowId="row-1"
      >
        <Reasoning defaultOpen>
          <ReasoningTrigger>Toggle reasoning</ReasoningTrigger>
          <ReasoningContent>
            {"See [the PR](https://github.com/squareup/berd/pull/759)"}
          </ReasoningContent>
        </Reasoning>
      </TranscriptRowStateProvider>,
    );

    // Our MarkdownLink renders a real <a> so the app's link handling and the
    // working LinkSafetyModal apply. Streamdown's built-in link safety renders
    // a <button> and its own broken modal, which must not be used here.
    const link = screen.getByRole("link", { name: "the PR" });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/squareup/berd/pull/759",
    );
    expect(link).toHaveAttribute("data-streamdown", "link");
    expect(
      container.querySelector('[data-streamdown="link-safety-modal"]'),
    ).toBeNull();
  });

  it("marks nested Streamdown layout pending while reasoning is streaming", () => {
    const registry = createTranscriptRowStateRegistry();
    const { container } = render(
      <TranscriptRowStateProvider
        registry={registry}
        sessionId="session-1"
        rowId="row-1"
      >
        <Reasoning defaultOpen isStreaming>
          <ReasoningTrigger>Toggle reasoning</ReasoningTrigger>
          <ReasoningContent>Streaming thoughts</ReasoningContent>
        </Reasoning>
      </TranscriptRowStateProvider>,
    );

    expect(
      container.querySelector(
        `[${VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE}="streamdown-async"]`,
      ),
    ).toBeTruthy();
  });
});
