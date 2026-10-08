import { act, fireEvent, render, screen } from "@testing-library/react";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function perch(overrides: Partial<PerchView> = {}): PerchView {
  return {
    phase: "unperched",
    appName: null,
    title: null,
    lastError: null,
    beginTargeting: vi.fn(),
    endTargetingAndMaybePerch: vi.fn(),
    cancelTargeting: vi.fn(),
    dismount: vi.fn(),
    artifactUrlNow: vi.fn(async () => null),
    captureNow: vi.fn(async () => null),
    ...overrides,
  } as unknown as PerchView;
}

function session(
  messages: ChatMessage[],
  overrides: Partial<SessionView> = {},
): SessionView {
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
    ...overrides,
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
      <ChatPopover session={session(first)} perch={perch()} variant="full" />,
    );
    const transcript = view.container.querySelector(
      ".transcript",
    ) as HTMLElement;
    setScrollMetrics(transcript, { scrollHeight: 100, clientHeight: 50 });

    act(() => {
      view.rerender(
        <ChatPopover
          session={session([message("m1", "hello"), message("m2", "world")])}
          perch={perch()}
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
          perch={perch()}
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
        perch={perch()}
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
          perch={perch()}
          variant="full"
        />,
      );
    });

    expect(transcript.scrollTop).toBe(100);
  });
});

describe("ChatPopover perched capture send state", () => {
  it("blocks a second submit while capture is pending", async () => {
    const capture = deferred<{ data: string; mimeType: string } | null>();
    const send = vi.fn(async () => true);
    render(
      <ChatPopover
        session={session([], { send })}
        perch={perch({
          phase: "perched",
          appName: "Safari",
          artifactUrlNow: vi.fn(async () => null),
          captureNow: vi.fn(() => capture.promise),
        })}
        variant="composer"
      />,
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "summarize" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("hint.capturing")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "second" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(send).not.toHaveBeenCalled();

    await act(async () =>
      capture.resolve({ data: "abc", mimeType: "image/png" }),
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it("sends text-only and releases capture state when capture fails", async () => {
    const send = vi.fn(async () => true);
    render(
      <ChatPopover
        session={session([], { send })}
        perch={perch({
          phase: "perched",
          appName: "Safari",
          captureNow: vi.fn(async () => null),
        })}
        variant="composer"
      />,
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "what is here" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("hint.capturing")).toBeInTheDocument();
    await act(async () => await Promise.resolve());

    expect(send).toHaveBeenCalledWith(
      "what is here",
      undefined,
      expect.any(Function),
    );
    expect(screen.queryByText("hint.capturing")).not.toBeInTheDocument();
  });
});
