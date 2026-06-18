import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageBubble } from "../MessageBubble";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import type {
  Message,
  SystemNotificationContent,
} from "@/shared/types/messages";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { openPath } from "@tauri-apps/plugin-opener";
const mockWriteText = vi.fn().mockResolvedValue(undefined);

const providerCatalogEntries: ProviderCatalogEntry[] = [
  {
    id: "claude-acp",
    displayName: "Claude Code",
    category: "agent",
    description: "Anthropic's agentic coding tool",
    setupMethod: "cli_auth",
    binaryName: "claude-agent-acp",
    group: "default",
    aliases: ["claude-acp", "claude_code", "claude"],
  },
  {
    id: "codex-acp",
    displayName: "Codex",
    category: "agent",
    description: "OpenAI's coding agent",
    setupMethod: "cli_auth",
    binaryName: "codex-acp",
    group: "default",
    aliases: ["codex-acp", "codex_cli", "codex"],
  },
];

vi.mock("@mcp-ui/client", () => ({
  UI_EXTENSION_CONFIG: { mimeTypes: ["text/html;profile=mcp-app"] },
  AppRenderer: (props: { toolName?: string }) => (
    <div data-testid="mock-app-renderer">
      {props.toolName ?? "app-renderer"}
    </div>
  ),
}));

vi.mock("@/shared/api/gooseServeHost", () => ({
  getGooseServeHostInfo: vi.fn().mockResolvedValue({
    httpBaseUrl: "http://127.0.0.1:4242",
    secretKey: "test-secret",
  }),
}));

vi.mock("@/shared/theme/ThemeProvider", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

vi.mock("@/shared/hooks/useAvatarSrc", () => ({
  useAvatarImage: vi.fn((avatar: unknown) => {
    if (avatar === "app-avatar:builder") return "asset:///avatars/builder.png";
    return typeof avatar === "string" && avatar.startsWith("http")
      ? avatar
      : undefined;
  }),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
}));

function userMessage(text: string, overrides: Partial<Message> = {}): Message {
  return {
    id: "u1",
    role: "user",
    created: Date.now(),
    content: [{ type: "text", text }],
    ...overrides,
  };
}

function assistantMessage(
  content: Message["content"],
  overrides: Partial<Message> = {},
): Message {
  return {
    id: "a1",
    role: "assistant",
    created: Date.now(),
    content,
    ...overrides,
  };
}

function expectNoVisibleText(container: HTMLElement, text: string) {
  const visibleTextNodes = [...container.querySelectorAll("span")].filter(
    (node) => node.textContent === text && !node.classList.contains("sr-only"),
  );
  expect(visibleTextNodes).toHaveLength(0);
}

describe("MessageBubble", () => {
  beforeEach(() => {
    useAgentStore.setState({ personas: [] });
    useProviderCatalogStore.getState().setEntries(providerCatalogEntries);
    vi.mocked(openPath).mockClear();
    mockWriteText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: mockWriteText,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    useProviderCatalogStore.getState().reset();
  });

  it("renders user message with correct alignment", () => {
    const { container } = render(
      <MessageBubble message={userMessage("hey")} />,
    );
    const el = container.querySelector('[data-role="user-message"]');
    expect(el).toBeInTheDocument();
    // User messages use flex-row-reverse
    expect(el?.className).toContain("flex-row-reverse");
  });

  it("keeps user messages capped while allowing assistant messages to fill the transcript lane", () => {
    const { container } = render(
      <>
        <MessageBubble message={userMessage("hello")} />
        <MessageBubble
          message={assistantMessage([{ type: "text", text: "response" }])}
        />
      </>,
    );

    const userContent = container.querySelector(
      '[data-role="user-message-content"]',
    );
    const assistantContent = container.querySelector(
      '[data-role="assistant-message-content"]',
    );

    expect(userContent).toHaveClass(
      "max-w-[var(--chat-user-message-max-width)]",
    );
    expect(assistantContent).toHaveClass("w-full");
    expect(assistantContent?.className).not.toContain("max-w-[85%]");
  });

  it("renders assistant message with avatar", () => {
    const { container } = render(
      <MessageBubble
        message={assistantMessage([{ type: "text", text: "hi" }])}
      />,
    );
    const el = container.querySelector('[data-role="assistant-message"]');
    expect(el).toBeInTheDocument();
    expect(el?.className).toContain("flex-row");
    expect(el?.className).not.toContain("flex-row-reverse");
  });

  it("renders text content", () => {
    render(<MessageBubble message={userMessage("hello world")} />);
    expect(screen.getByText("hello world")).toBeInTheDocument();
  });

  it("labels steered user messages", () => {
    const message = userMessage("adjust course");
    message.metadata = {
      ...message.metadata,
      delivery: "steer",
    };

    render(<MessageBubble message={message} />);

    const label = screen.getByText("Steered");
    expect(label).toBeInTheDocument();
    expect(label).toHaveAttribute("data-role", "steer-message-label");
    expect(label).not.toHaveAttribute("data-slot", "badge");
    expect(label).toHaveClass("leading-4");
    expect(label.parentElement).toHaveClass("items-start");
    expect(label.parentElement).not.toHaveClass("items-end");
    expect(label.closest(".bg-message-user-bg")).toHaveClass("py-2");
    expect(label.closest(".bg-message-user-bg")).not.toHaveClass("py-2.5");
  });

  it("labels goosectl cross-session user messages", () => {
    const message = userMessage("from another session");
    message.metadata = {
      ...message.metadata,
      origin: "goosectl_cross_session",
    };

    render(<MessageBubble message={message} />);

    const label = screen.getByText("Sent by Goose from another session");
    expect(label).toBeInTheDocument();
    expect(label).toHaveAttribute(
      "data-role",
      "goosectl-cross-session-message-label",
    );
    expect(label.closest(".bg-message-user-bg")).toHaveTextContent(
      "from another session",
    );
  });

  it("renders provenance and steer labels together", () => {
    const message = userMessage("steered from another session");
    message.metadata = {
      ...message.metadata,
      delivery: "steer",
      origin: "goosectl_cross_session",
    };

    render(<MessageBubble message={message} />);

    expect(
      screen.getByText("Sent by Goose from another session"),
    ).toBeInTheDocument();
    expect(screen.getByText("Steered")).toBeInTheDocument();
  });

  it("renders compaction notifications as centered success messages", () => {
    const { container } = render(
      <MessageBubble
        message={{
          id: "s1",
          role: "system",
          created: Date.now(),
          content: [
            {
              type: "systemNotification",
              notificationType: "compaction",
              text: "Conversation compacted.",
            },
          ],
          metadata: {
            userVisible: true,
            agentVisible: false,
          },
        }}
      />,
    );

    expect(screen.getByText("Conversation compacted.")).toBeInTheDocument();
    expect(container.querySelector(".text-success")).toBeInTheDocument();
  });

  it("wraps long unbroken words so the bubble cannot overflow horizontally", () => {
    const longWord = "a".repeat(160);
    render(<MessageBubble message={userMessage(longWord)} />);
    const paragraph = screen.getByText(longWord);
    expect(paragraph).toHaveClass("wrap-anywhere");
  });

  it("renders user text inside a bubble shell", () => {
    const { container } = render(
      <MessageBubble message={userMessage("hello world")} />,
    );

    expect(
      container.querySelector(
        '[data-role="user-message"] .rounded-sm.bg-message-user-bg',
      ),
    ).toBeInTheDocument();
  });

  it("renders multiple content blocks", () => {
    const msg = assistantMessage([
      { type: "text", text: "first block" },
      { type: "text", text: "second block" },
    ]);
    render(<MessageBubble message={msg} />);
    expect(screen.getByText("first block")).toBeInTheDocument();
    expect(screen.getByText("second block")).toBeInTheDocument();
  });

  it("renders a reserved actions tray for assistant messages", () => {
    const onRetryMessage = vi.fn();
    const { container } = render(
      <MessageBubble
        message={assistantMessage([{ type: "text", text: "response" }])}
        onRetryMessage={onRetryMessage}
      />,
    );

    expect(
      container.querySelector('[data-role="assistant-message"] .pb-9'),
    ).toBeInTheDocument();
    expect(
      container.querySelector(
        '[data-role="assistant-message"] [data-role="message-actions"]',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("renders a response-start action for completed assistant messages", async () => {
    const user = userEvent.setup();
    const onJumpToResponseStart = vi.fn();
    render(
      <MessageBubble
        message={assistantMessage([{ type: "text", text: "response" }])}
        onJumpToResponseStart={onJumpToResponseStart}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Jump to response start" }),
    );

    expect(onJumpToResponseStart).toHaveBeenCalledWith("a1");
  });

  it("renders a dismissible response-start hint", async () => {
    const user = userEvent.setup();
    const onJumpToResponseStartHintDismiss = vi.fn();
    render(
      <MessageBubble
        message={assistantMessage([{ type: "text", text: "response" }])}
        onJumpToResponseStart={vi.fn()}
        showJumpToResponseStartHint
        onJumpToResponseStartHintDismiss={onJumpToResponseStartHintDismiss}
      />,
    );

    const hint = screen.getByRole("dialog");
    expect(hint).toHaveTextContent("Jump to response start");
    expect(hint).toHaveTextContent(
      "For long replies, this takes you back to the top.",
    );

    await user.click(
      screen.getByRole("button", {
        name: "Dismiss response start tip",
      }),
    );

    expect(onJumpToResponseStartHintDismiss).toHaveBeenCalledWith("a1");
  });

  it("suppresses copy tooltip while response-start hint is visible", async () => {
    const user = userEvent.setup();
    render(
      <MessageBubble
        message={assistantMessage([{ type: "text", text: "response" }])}
        onJumpToResponseStart={vi.fn()}
        showJumpToResponseStartHint
      />,
    );

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Jump to response start",
    );
    const copyButton = screen.getByRole("button", { name: "Copy" });

    await user.hover(copyButton);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("does not show assistant actions while the message is streaming", () => {
    const { container } = render(
      <MessageBubble
        message={assistantMessage([{ type: "text", text: "response" }])}
        isStreaming
        onRetryMessage={vi.fn()}
        onJumpToResponseStart={vi.fn()}
      />,
    );

    expect(
      container.querySelector(
        '[data-role="assistant-message"] [data-role="message-actions"]',
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /copy/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Jump to response start" }),
    ).not.toBeInTheDocument();
  });

  it("can keep assistant actions visible without hover", () => {
    const { container } = render(
      <MessageBubble
        message={assistantMessage([{ type: "text", text: "response" }])}
        actionsAlwaysVisible
      />,
    );

    const actions = container.querySelector(
      '[data-role="assistant-message"] [data-role="message-actions"]',
    );
    expect(actions).toHaveClass("opacity-100", "pointer-events-auto");
  });

  it("keeps whole assistant messages on the legacy outer spacing contract", () => {
    const { container } = render(
      <MessageBubble
        message={assistantMessage([{ type: "text", text: "response" }])}
      />,
    );

    const messageRoot = container.querySelector(
      '[data-role="assistant-message"]',
    );
    expect(messageRoot).toHaveClass("py-1");
    expect(messageRoot).not.toHaveAttribute("data-message-fragment-role");
  });

  it("can suppress entry animation for virtualized rows", () => {
    const { container } = render(
      <MessageBubble
        message={assistantMessage([{ type: "text", text: "response" }])}
        animateEntry={false}
      />,
    );

    const messageRoot = container.querySelector(
      '[data-role="assistant-message"]',
    );
    expect(messageRoot).not.toHaveClass("animate-in", "fade-in");
  });

  it("stitches assistant text fragments without repeated row padding", () => {
    const message = assistantMessage([{ type: "text", text: "full response" }]);
    const { container } = render(
      <>
        <MessageBubble
          message={message}
          contentOverride={[{ type: "text", text: "first chunk" }]}
          fragmentRole="start"
        />
        <MessageBubble
          message={message}
          contentOverride={[{ type: "text", text: "middle chunk" }]}
          fragmentRole="middle"
        />
        <MessageBubble
          message={message}
          contentOverride={[{ type: "text", text: "final chunk" }]}
          fragmentRole="end"
        />
      </>,
    );

    const start = container.querySelector(
      '[data-message-fragment-role="start"]',
    );
    const middle = container.querySelector(
      '[data-message-fragment-role="middle"]',
    );
    const end = container.querySelector('[data-message-fragment-role="end"]');

    expect(start).toHaveClass("pt-1", "pb-0");
    expect(start).not.toHaveClass("py-1");
    expect(middle).toHaveClass("-mt-1", "py-0");
    expect(end).toHaveClass("-mt-1", "pt-0", "pb-1");
  });

  it("reserves assistant action space only on terminal fragments", () => {
    const message = assistantMessage([{ type: "text", text: "full response" }]);
    const { container } = render(
      <>
        <MessageBubble
          message={message}
          contentOverride={[{ type: "text", text: "first chunk" }]}
          fragmentRole="start"
        />
        <MessageBubble
          message={message}
          contentOverride={[{ type: "text", text: "final chunk" }]}
          fragmentRole="end"
        />
      </>,
    );

    const startContent = container.querySelector(
      '[data-message-fragment-role="start"] [data-role="assistant-message-content"]',
    );
    const endContent = container.querySelector(
      '[data-message-fragment-role="end"] [data-role="assistant-message-content"]',
    );

    expect(startContent).not.toHaveClass("pb-9");
    expect(startContent?.querySelector('[data-role="message-actions"]')).toBe(
      null,
    );
    expect(endContent).toHaveClass("pb-9");
    expect(
      endContent?.querySelector('[data-role="message-actions"]'),
    ).toBeInTheDocument();
  });

  it("keeps the action tray timestamp on one line", () => {
    const { container } = render(
      <MessageBubble
        message={assistantMessage([{ type: "text", text: "response" }])}
      />,
    );

    const timestamp = container.querySelector(
      '[data-role="assistant-message"] [data-role="message-timestamp"]',
    );
    expect(timestamp).toHaveClass("whitespace-nowrap");
    expect(timestamp).toHaveClass("shrink-0");
    expect(timestamp).toHaveClass("text-[13px]");
    expect(timestamp).toHaveClass("leading-relaxed");
    expect(timestamp).toHaveClass("pl-2");
    expect(timestamp).toHaveClass("pr-1");
    expect(timestamp).not.toHaveClass("text-sm");
    expect(timestamp).not.toHaveClass("text-[10px]");
  });

  it("anchors assistant and user actions on opposite sides of the timestamp", () => {
    const { container } = render(
      <>
        <MessageBubble
          message={assistantMessage([{ type: "text", text: "response" }])}
          onRetryMessage={vi.fn()}
        />
        <MessageBubble message={userMessage("draft")} onEditMessage={vi.fn()} />
      </>,
    );

    const assistantActions = container.querySelector(
      '[data-role="assistant-message"] [data-role="message-actions"]',
    );
    const userActions = container.querySelector(
      '[data-role="user-message"] [data-role="message-actions"]',
    );

    expect(
      Array.from(assistantActions?.firstElementChild?.children ?? []).map(
        (element) => element.tagName,
      ),
    ).toEqual(["BUTTON", "BUTTON", "SPAN"]);
    expect(
      Array.from(userActions?.firstElementChild?.children ?? []).map(
        (element) => element.tagName,
      ),
    ).toEqual(["SPAN", "BUTTON", "BUTTON"]);

    const userTimestamp = userActions?.querySelector(
      '[data-role="message-timestamp"]',
    );
    expect(userTimestamp).toHaveClass("pl-1");
    expect(userTimestamp).toHaveClass("pr-2");
  });

  it("keeps copy confirmation visible until it resets", async () => {
    vi.useFakeTimers();
    const { container } = render(
      <MessageBubble
        message={assistantMessage([
          { type: "text", text: "response" },
          { type: "text", text: "second response" },
        ])}
      />,
    );

    const actions = container.querySelector(
      '[data-role="assistant-message"] [data-role="message-actions"]',
    );
    expect(actions).toHaveAttribute("data-copy-confirmed", "false");
    const copyButton = screen.getByRole("button", { name: /copy/i });
    expect(copyButton).not.toHaveClass("bg-accent");

    await act(async () => {
      fireEvent.click(copyButton);
      await Promise.resolve();
    });

    expect(mockWriteText).toHaveBeenCalledWith("response\nsecond response");
    expect(actions).toHaveAttribute("data-copy-confirmed", "true");
    expect(copyButton).toHaveClass("bg-accent");

    await act(async () => {
      vi.advanceTimersByTime(1999);
    });
    expect(actions).toHaveAttribute("data-copy-confirmed", "true");
    expect(copyButton).toHaveClass("bg-accent");

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(actions).toHaveAttribute("data-copy-confirmed", "false");
    expect(copyButton).not.toHaveClass("bg-accent");
  });

  it("renders tool request content as ToolCallCard", () => {
    const msg = assistantMessage([
      {
        type: "toolRequest",
        id: "tr-1",
        name: "readFile",
        arguments: { path: "/tmp" },
        status: "completed",
      },
    ]);
    render(<MessageBubble message={msg} />);
    expect(screen.getByText("readFile")).toBeInTheDocument();
  });

  it("renders metadata attachments and opens them on click", async () => {
    const user = userEvent.setup();

    render(
      <MessageBubble
        message={userMessage("See attached", {
          metadata: {
            attachments: [
              {
                type: "file",
                name: "report.pdf",
                path: "/Users/test/report.pdf",
              },
              {
                type: "directory",
                name: "screenshots",
                path: "/Users/test/screenshots",
              },
            ],
          },
        })}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /open attachment report\.pdf/i }),
    );
    expect(vi.mocked(openPath)).toHaveBeenCalledWith("/Users/test/report.pdf");
    expect(
      screen.getByRole("button", { name: /open attachment screenshots/i }),
    ).toBeInTheDocument();
  });

  it("renders standalone tool responses without dropping surrounding text", () => {
    const msg = assistantMessage([
      { type: "text", text: "Working on it." },
      {
        type: "toolResponse",
        id: "tool-result-1",
        name: "readFile",
        result: "file contents here",
        isError: false,
      },
      { type: "text", text: "Done." },
    ]);

    render(<MessageBubble message={msg} />);

    expect(screen.getByText("Working on it.")).toBeInTheDocument();
    expect(screen.getByText("readFile")).toBeInTheDocument();
    expect(screen.getByText("Done.")).toBeInTheDocument();
  });

  it("merges matched tool requests and responses into one tool card", () => {
    const msg = assistantMessage([
      { type: "text", text: "Checking that now." },
      {
        type: "toolRequest",
        id: "tool-1",
        name: "readFile",
        arguments: { path: "/tmp/demo.txt" },
        status: "in_progress",
      },
      {
        type: "toolResponse",
        id: "tool-1",
        name: "readFile",
        result: "done",
        isError: false,
      },
    ]);

    render(<MessageBubble message={msg} />);

    expect(screen.getByText("Checking that now.")).toBeInTheDocument();
    expect(screen.getAllByText("readFile")).toHaveLength(1);
  });

  it("keeps expanded tool steps open when a streamed chain grows", async () => {
    const user = userEvent.setup();
    const initialContent: Message["content"] = [
      {
        type: "toolRequest",
        id: "tool-1",
        name: "Read config",
        arguments: {},
        status: "completed",
      },
      {
        type: "toolResponse",
        id: "tool-1",
        name: "Read config",
        result: "config contents",
        isError: false,
      },
      {
        type: "toolRequest",
        id: "tool-2",
        name: "Run checks",
        arguments: {},
        status: "in_progress",
      },
    ];
    const { rerender } = render(
      <MessageBubble message={assistantMessage(initialContent)} isStreaming />,
    );

    await user.click(screen.getByRole("button", { name: /read config/i }));
    expect(screen.getByText("config contents")).toBeVisible();

    rerender(
      <MessageBubble
        message={assistantMessage([
          ...initialContent,
          {
            type: "toolRequest",
            id: "tool-3",
            name: "Inspect output",
            arguments: {},
            status: "in_progress",
          },
        ])}
        isStreaming
      />,
    );

    expect(screen.getByText("config contents")).toBeVisible();
  });

  it("renders tool cards inline between surrounding assistant text blocks", () => {
    const msg = assistantMessage([
      { type: "text", text: "Lemme check..." },
      {
        type: "toolRequest",
        id: "tool-1",
        name: "readFile",
        arguments: {},
        status: "in_progress",
      },
      {
        type: "toolResponse",
        id: "tool-1",
        name: "readFile",
        result: "done",
        isError: false,
      },
      { type: "text", text: "Results from checking." },
    ]);

    const { container } = render(<MessageBubble message={msg} />);
    const bubbleText = container.querySelector(
      '[data-role="assistant-message"]',
    )?.textContent;

    expect(bubbleText).toContain("Lemme check...");
    expect(bubbleText).toContain("readFile");
    expect(bubbleText).toContain("Results from checking.");
    expect(bubbleText?.indexOf("Lemme check...")).toBeLessThan(
      bubbleText?.indexOf("readFile") ?? Number.POSITIVE_INFINITY,
    );
    expect(bubbleText?.indexOf("readFile")).toBeLessThan(
      bubbleText?.indexOf("Results from checking.") ?? Number.POSITIVE_INFINITY,
    );
  });

  it("does not render a duplicate blank tool card for fallback responses", () => {
    const msg = assistantMessage([
      { type: "text", text: "Lemme check..." },
      {
        type: "toolRequest",
        id: "tool-1",
        name: "readFile",
        arguments: {},
        status: "in_progress",
      },
      {
        type: "toolResponse",
        id: "tool-response-1",
        name: "",
        result: "done",
        isError: false,
      },
      { type: "text", text: "Results from checking." },
    ]);

    render(<MessageBubble message={msg} />);

    expect(screen.getAllByText("readFile")).toHaveLength(1);
    expect(screen.queryByText("Tool result")).not.toBeInTheDocument();
  });

  it("renders thinking content as Reasoning block", () => {
    const msg = assistantMessage([{ type: "thinking", text: "deep thoughts" }]);
    render(<MessageBubble message={msg} />);
    expect(screen.getByText(/thought for/i)).toBeInTheDocument();
  });

  it("prefers the message persona name over the provider identity", () => {
    render(
      <MessageBubble
        message={assistantMessage([{ type: "text", text: "hi" }], {
          metadata: { personaName: "Builder", providerId: "codex-acp" },
        })}
      />,
    );

    expect(screen.getByText("Builder")).toBeInTheDocument();
    expect(
      screen.queryByText(
        (text, el) => el?.tagName === "SPAN" && text === "Codex",
      ),
    ).not.toBeInTheDocument();
  });

  it("renders a custom persona avatar in the assistant gutter", () => {
    useAgentStore.setState({
      personas: [
        {
          id: "persona-1",
          displayName: "Builder",
          avatar: "https://example.test/builder.png",
          systemPrompt: "",
          isBuiltin: false,
          writable: true,
        },
      ],
    });

    const { container } = render(
      <MessageBubble
        message={assistantMessage([{ type: "text", text: "hi" }], {
          metadata: { personaId: "persona-1", personaName: "Builder" },
        })}
      />,
    );

    const gutterAvatar = container.querySelector(
      '[data-role="assistant-persona-avatar"]',
    );
    expect(gutterAvatar).toHaveClass("size-9");
    expect(gutterAvatar?.querySelector("img")).toHaveAttribute(
      "src",
      "https://example.test/builder.png",
    );
    expect(gutterAvatar?.querySelector("img")).toHaveAttribute("alt", "");
    expect(gutterAvatar?.querySelector(".sr-only")).toHaveTextContent(
      "Builder",
    );
    expectNoVisibleText(container, "Builder");
  });

  it("keeps custom persona identity in the gutter while avatar media is unavailable", () => {
    useAgentStore.setState({
      personas: [
        {
          id: "persona-1",
          displayName: "Builder",
          avatar: "app-avatar:gloopy-1",
          systemPrompt: "",
          isBuiltin: false,
          writable: true,
        },
      ],
    });

    const { container } = render(
      <MessageBubble
        message={assistantMessage([{ type: "text", text: "hi" }], {
          metadata: { personaId: "persona-1", personaName: "Builder" },
        })}
      />,
    );

    const gutterAvatar = container.querySelector(
      '[data-role="assistant-persona-avatar"]',
    );
    expect(gutterAvatar).toHaveClass("size-9");
    expect(gutterAvatar?.querySelector("img")).toBeNull();
    expect(gutterAvatar?.querySelector(".sr-only")).toHaveTextContent(
      "Builder",
    );
    expectNoVisibleText(container, "Builder");
  });

  it("does not render an assistant name when message identity metadata is missing", () => {
    render(
      <MessageBubble
        message={assistantMessage([{ type: "text", text: "hi" }])}
      />,
    );

    const nameSpans = screen.queryAllByText((_text, el) => {
      if (el?.tagName !== "SPAN") return false;
      return el.classList.contains("font-normal");
    });
    expect(nameSpans).toHaveLength(0);
  });

  it("uses the message provider identity for the assistant label and icon", () => {
    render(
      <MessageBubble
        message={assistantMessage([{ type: "text", text: "hi" }], {
          metadata: { providerId: "claude-acp" },
        })}
      />,
    );

    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByTitle("Claude")).toBeInTheDocument();
  });

  it("renders identity for an in-progress assistant message with a provider", () => {
    render(
      <MessageBubble
        message={assistantMessage([], {
          metadata: { completionStatus: "inProgress", providerId: "codex-acp" },
        })}
        isStreaming
      />,
    );

    expect(
      screen.getByText(
        (text, el) => el?.tagName === "SPAN" && text === "Codex",
      ),
    ).toBeInTheDocument();
  });

  it("collapses low-signal internal tool steps behind a toggle", async () => {
    const user = userEvent.setup();
    const msg = assistantMessage([
      {
        type: "toolRequest",
        id: "tool-1",
        name: "Create PDF about whales",
        arguments: {},
        status: "completed",
      },
      {
        type: "toolRequest",
        id: "tool-2",
        name: "Write whales.pdf",
        arguments: {},
        status: "completed",
      },
      {
        type: "toolRequest",
        id: "tool-3",
        name: "python3 create_whales.py",
        arguments: {},
        status: "completed",
      },
      {
        type: "toolRequest",
        id: "tool-4",
        name: "ls -lh whales.pdf",
        arguments: {},
        status: "completed",
      },
    ]);

    const { container } = render(<MessageBubble message={msg} />);

    // Completed-on-mount chains render collapsed; expand the parent card first.
    const chainHeader = container.querySelector<HTMLButtonElement>(
      '[data-role="tool-chain-card"] > button[aria-expanded]',
    );
    if (!chainHeader) throw new Error("expected tool-chain-card header");
    await user.click(chainHeader);

    expect(screen.getByText("Create PDF about whales")).toBeInTheDocument();
    expect(screen.getByText("Write whales.pdf")).toBeInTheDocument();
    expect(screen.queryByText("python3 create_whales.py")).toBeNull();
    expect(screen.queryByText("ls -lh whales.pdf")).toBeNull();
    expect(screen.getByText("Show internal steps (2)")).toBeInTheDocument();

    await user.click(screen.getByText("Show internal steps (2)"));

    expect(screen.getByText("python3 create_whales.py")).toBeInTheDocument();
    expect(screen.getByText("ls -lh whales.pdf")).toBeInTheDocument();
  });

  function notificationMessage(
    action: SystemNotificationContent["action"],
    id = "n1",
  ): Message {
    return {
      id,
      role: "system",
      created: Date.now(),
      content: [
        {
          type: "systemNotification",
          notificationType: "warning",
          text: "Folder is missing",
          action,
        },
      ],
    };
  }

  const editProjectAction = {
    type: "editProject",
    projectId: "project-7",
  } as const;

  it("renders an edit-project action inside a system notification", async () => {
    const user = userEvent.setup();
    const onEditProject = vi.fn();

    render(
      <MessageBubble
        message={notificationMessage(editProjectAction)}
        onEditProject={onEditProject}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit project" }));

    expect(onEditProject).toHaveBeenCalledWith("project-7");
  });

  it("omits the edit-project action when no handler is provided", () => {
    render(<MessageBubble message={notificationMessage(editProjectAction)} />);

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("falls back to the change-folder action for edit-project notifications without a project-settings surface", async () => {
    const user = userEvent.setup();
    const onOpenContextPanel = vi.fn();

    render(
      <MessageBubble
        message={notificationMessage(editProjectAction)}
        onOpenContextPanel={onOpenContextPanel}
      />,
    );

    expect(screen.queryByRole("button", { name: "Edit project" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Change folder" }));

    expect(onOpenContextPanel).toHaveBeenCalledTimes(1);
  });

  it("renders an open-context-panel action inside a system warning notification", async () => {
    const user = userEvent.setup();
    const onOpenContextPanel = vi.fn();

    render(
      <MessageBubble
        message={notificationMessage({ type: "openContextPanel" })}
        onOpenContextPanel={onOpenContextPanel}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Change folder" }));

    expect(onOpenContextPanel).toHaveBeenCalledTimes(1);
  });

  it("omits the open-context-panel action when no handler is provided", () => {
    render(
      <MessageBubble
        message={notificationMessage({ type: "openContextPanel" })}
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
  });
});
