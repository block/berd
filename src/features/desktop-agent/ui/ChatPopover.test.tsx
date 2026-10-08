import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatPopover } from "./ChatPopover";
import type { ChatMessage } from "../lib/chatModels";
import type { PerchView } from "../hooks/usePerch";
import type { SessionView } from "../hooks/useSession";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ text }: { text: string }) => <span>{text}</span>,
}));

const perch = {
  phase: "unperched",
  appName: null,
  title: null,
  lastError: null,
  artifactUrlNow: vi.fn(async () => null),
  captureNow: vi.fn(async () => null),
} as unknown as PerchView;

function session(messages: ChatMessage[]): SessionView {
  return {
    messages,
    pendingSelection: null,
    attached: true,
    connectionError: null,
    reconnectExhausted: false,
    lastSendError: null,
    sendStalled: false,
    agentSendInFlight: false,
    activity: "none",
    sendBusy: () => false,
    send: vi.fn(async () => true),
    retry: vi.fn(),
    stop: vi.fn(),
  } as unknown as SessionView;
}

function setScrollMetrics(
  el: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number },
) {
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    value: metrics.scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    value: metrics.clientHeight,
  });
}

const message = (id: string, text: string): ChatMessage => ({
  id,
  role: "assistant",
  createdAt: 0,
  content: [{ type: "text", text }],
  isStreaming: false,
});

describe("ChatPopover transcript following", () => {
  it("scrolls to the bottom when messages append or streaming text extends", () => {
    const first = [message("m1", "hello")];
    const view = render(
      <ChatPopover session={session(first)} perch={perch} variant="full" />,
    );
    const transcript = view.container.querySelector(
      ".transcript",
    ) as HTMLElement;
    setScrollMetrics(transcript, { scrollHeight: 100, clientHeight: 50 });

    act(() => {
      view.rerender(
        <ChatPopover
          session={session([message("m1", "hello"), message("m2", "world")])}
          perch={perch}
          variant="full"
        />,
      );
    });
    expect(transcript.scrollTop).toBe(100);

    setScrollMetrics(transcript, { scrollHeight: 180, clientHeight: 50 });
    act(() => {
      view.rerender(
        <ChatPopover
          session={session([message("m1", "hello"), message("m2", "world!!!")])}
          perch={perch}
          variant="full"
        />,
      );
    });
    expect(transcript.scrollTop).toBe(180);
  });

  it("preserves scroll position after the user scrolls away from bottom", () => {
    const view = render(
      <ChatPopover
        session={session([message("m1", "hello")])}
        perch={perch}
        variant="full"
      />,
    );
    const transcript = view.container.querySelector(
      ".transcript",
    ) as HTMLElement;
    setScrollMetrics(transcript, { scrollHeight: 300, clientHeight: 100 });
    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);

    act(() => {
      view.rerender(
        <ChatPopover
          session={session([message("m1", "hello"), message("m2", "later")])}
          perch={perch}
          variant="full"
        />,
      );
    });

    expect(transcript.scrollTop).toBe(100);
  });
});
