import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageBubble } from "../MessageBubble";
import { EXPERIMENT_PREFERENCES_STORAGE_KEY } from "@/features/experiments/experimentPreferences";
import { findTranscriptMatches } from "@/features/chat/lib/transcriptSearch";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import type {
  Message,
  SystemNotificationContent,
} from "@/shared/types/messages";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { ArtifactPolicyProvider } from "@/features/chat/hooks/ArtifactPolicyContext";
import {
  TranscriptRowStateProvider,
  createTranscriptRowStateRegistry,
} from "@/features/chat/transcript/row-state";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
const mockPathExists = vi.hoisted(() =>
  vi.fn<(path: string) => Promise<boolean>>(),
);
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
  useAvatarMedia: vi.fn((avatar: unknown) =>
    avatar === "user-avatar:custom"
      ? {
          src: "asset:///avatars/custom.webm",
          mediaType: "video",
          posterSrc: "asset:///avatars/custom.png",
        }
      : undefined,
  ),
}));

vi.mock("@/shared/api/system", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/system")>();
  return {
    ...actual,
    pathExists: (path: string) => mockPathExists(path),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, scheme?: string) =>
    `${scheme ?? "asset"}://${path}`,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  openUrl: vi.fn(),
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

/**
 * jsdom has no layout, so `scrollHeight` is always 0 and the clamp would never
 * see overflow. Stub the clamp content element's scrollHeight to drive the
 * overflow branch deterministically.
 */
function withUserMessageScrollHeight(scrollHeight: number) {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.role === "user-message-clamp-content"
        ? scrollHeight
        : 0;
    },
  });
  scrollHeightDescriptors.push(descriptor);
}

const LONG_USER_PROMPT = `very long prompt ${"details ".repeat(80)}`;

const scrollHeightDescriptors: (PropertyDescriptor | undefined)[] = [];

function restoreScrollHeight() {
  while (scrollHeightDescriptors.length > 0) {
    const descriptor = scrollHeightDescriptors.pop();
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", descriptor);
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)
        .scrollHeight;
    }
  }
}

describe("MessageBubble", () => {
  beforeEach(() => {
    localStorage.removeItem(EXPERIMENT_PREFERENCES_STORAGE_KEY);
    useAgentStore.setState({ personas: [] });
    useProviderCatalogStore.getState().setEntries(providerCatalogEntries);
    vi.mocked(openPath).mockClear();
    vi.mocked(openUrl).mockClear();
    mockPathExists.mockReset();
    mockPathExists.mockResolvedValue(false);
    mockWriteText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: mockWriteText,
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    restoreScrollHeight();
    useProviderCatalogStore.getState().reset();
  });

  it("does not rerender an old bubble when later streaming text changes", () => {
    const oldMessage = assistantMessage(
      [{ type: "text", text: "old artifact [report](report.md)" }],
      { id: "old", created: 1 },
    );
    const firstStreamingMessage = assistantMessage(
      [{ type: "text", text: "streaming" }],
      { id: "streaming", created: 2 },
    );
    const memoizedMessageBubble = MessageBubble as unknown as {
      type: (
        props: Parameters<typeof MessageBubble>[0],
      ) => ReturnType<typeof MessageBubble>;
    };
    const originalRender = memoizedMessageBubble.type;
    const renderSpy = vi.fn(originalRender);
    memoizedMessageBubble.type = renderSpy;

    try {
      function Harness({ streamingText }: { streamingText: string }) {
        const streamingMessage = {
          ...firstStreamingMessage,
          content: [{ type: "text" as const, text: streamingText }],
        };

        return (
          <ArtifactPolicyProvider
            messages={[oldMessage, streamingMessage]}
            sessionCwd="/work"
          >
            <MessageBubble message={oldMessage} animateEntry={false} />
          </ArtifactPolicyProvider>
        );
      }

      const { rerender } = render(<Harness streamingText="streaming" />);
      expect(renderSpy).toHaveBeenCalledTimes(1);

      rerender(<Harness streamingText="streaming more text" />);

      expect(renderSpy).toHaveBeenCalledTimes(1);
    } finally {
      memoizedMessageBubble.type = originalRender;
    }
  });

  it("opens artifact links against the latest cwd after it changes", async () => {
    const user = userEvent.setup();
    mockPathExists.mockResolvedValue(true);
    const message = assistantMessage([{ type: "text", text: "open report" }], {
      id: "artifact-link",
      created: 1,
    });

    const { container, rerender } = render(
      <ArtifactPolicyProvider messages={[message]} sessionCwd="/old">
        <MessageBubble message={message} animateEntry={false} />
      </ArtifactPolicyProvider>,
    );

    rerender(
      <ArtifactPolicyProvider messages={[message]} sessionCwd="/new">
        <MessageBubble message={message} animateEntry={false} />
      </ArtifactPolicyProvider>,
    );

    const content = container.querySelector<HTMLElement>(
      '[data-role="assistant-message-content"] > div',
    );
    if (!content) throw new Error("expected assistant content container");
    const link = document.createElement("a");
    link.setAttribute("href", "report.md");
    link.textContent = "report";
    content.appendChild(link);

    await user.click(link);

    await waitFor(() => {
      expect(mockPathExists).toHaveBeenCalledWith("/new/report.md");
      expect(vi.mocked(openPath)).toHaveBeenCalledWith("/new/report.md");
    });
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

  it("does not nest a scroll container inside the user bubble", () => {
    const { container } = render(
      <MessageBubble message={userMessage("long prompt")} />,
    );

    const userBubble = container.querySelector(
      '[data-role="user-message"] .bg-message-user-bg',
    );

    // The transcript scroller owns vertical scrolling; a nested scroll area
    // would trap the wheel over long user messages.
    expect(userBubble).not.toHaveClass(
      "max-h-[640px]",
      "overflow-y-auto",
      "overscroll-contain",
      "scrollbar-subtle",
    );
  });

  it("leaves short user messages off the clamp measurement path", () => {
    withUserMessageScrollHeight(80);

    const { container } = render(
      <MessageBubble message={userMessage("short prompt")} />,
    );

    expect(
      container.querySelector('[data-user-message-clamped="true"]'),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "View more" }),
    ).not.toBeInTheDocument();
  });

  it("clamps an overflowing user message and expands it in place", async () => {
    withUserMessageScrollHeight(2000);
    const user = userEvent.setup();

    const { container } = render(
      <MessageBubble message={userMessage(LONG_USER_PROMPT)} />,
    );

    const clamp = container.querySelector('[data-role="user-message-clamp"]');
    expect(clamp).toHaveAttribute("data-user-message-clamped", "true");

    const viewMore = await screen.findByRole("button", { name: "View more" });
    expect(viewMore).toHaveAttribute("aria-expanded", "false");

    await user.click(viewMore);

    // Expanding releases the clamp entirely rather than revealing a scroller.
    expect(clamp).toHaveAttribute("data-user-message-clamped", "false");
    const viewLess = await screen.findByRole("button", { name: "View less" });
    expect(viewLess).toHaveAttribute("aria-expanded", "true");

    await user.click(viewLess);
    expect(clamp).toHaveAttribute("data-user-message-clamped", "true");
  });

  it("pins the transcript before expanding so bottom-follow cannot override it", async () => {
    withUserMessageScrollHeight(2000);
    const user = userEvent.setup();
    const onPinScrollAnchor = vi.fn();
    const registry = createTranscriptRowStateRegistry();

    render(
      <TranscriptRowStateProvider
        registry={registry}
        sessionId="session-1"
        rowId="row-1"
        onPinScrollAnchor={onPinScrollAnchor}
      >
        <MessageBubble message={userMessage(LONG_USER_PROMPT)} />
      </TranscriptRowStateProvider>,
    );

    // Expanding grows the row. While the transcript follows the bottom, that
    // height change would reconcile to the new bottom and scroll the reader
    // past the text they just revealed, so the row must pin first.
    await user.click(await screen.findByRole("button", { name: "View more" }));
    expect(onPinScrollAnchor).toHaveBeenCalledTimes(1);

    // Collapsing shrinks the row and must not fling the reader either.
    await user.click(await screen.findByRole("button", { name: "View less" }));
    expect(onPinScrollAnchor).toHaveBeenCalledTimes(2);
  });

  it("keeps metadata and structural content outside the prose preview", () => {
    withUserMessageScrollHeight(2000);

    const { container } = render(
      <MessageBubble
        message={userMessage("very long prompt", {
          content: [
            { type: "text", text: LONG_USER_PROMPT },
            { type: "image", data: "abc123", mimeType: "image/png" },
          ],
          metadata: {
            chips: [{ type: "skill", id: "s1", label: "writing" }],
          },
        })}
      />,
    );

    const clamp = container.querySelector('[data-role="user-message-clamp"]');
    expect(clamp).not.toBeNull();

    const chip = screen.getByText("writing");
    const inlineImage = screen.getByRole("button", {
      name: "View Attached",
    });
    expect(clamp?.contains(chip)).toBe(false);
    expect(clamp?.contains(inlineImage)).toBe(false);
  });

  it("preserves interleaved user content block order", () => {
    withUserMessageScrollHeight(80);

    const { container } = render(
      <MessageBubble
        message={userMessage("first", {
          content: [
            { type: "text", text: "first" },
            { type: "image", data: "abc123", mimeType: "image/png" },
            { type: "text", text: "last" },
          ],
        })}
      />,
    );

    const bubble = container.querySelector<HTMLElement>(".bg-message-user-bg");
    const paragraphs = container.querySelectorAll<HTMLElement>(
      ".bg-message-user-bg p",
    );
    const first = paragraphs[0];
    const image = screen.getByRole("button", { name: "View Attached" });
    const last = paragraphs[1];
    expect(first.compareDocumentPosition(image)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(image.compareDocumentPosition(last)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(bubble).not.toBeNull();
    expect(bubble).toContainElement(first);
    expect(bubble).toContainElement(last);
  });

  it("keeps URLs inside the visible preview clickable", () => {
    withUserMessageScrollHeight(2000);

    render(
      <MessageBubble
        message={userMessage(
          `Read https://example.com ${"details ".repeat(80)}`,
        )}
      />,
    );

    expect(
      screen.getByRole("link", { name: "https://example.com" }),
    ).toBeInTheDocument();
  });

  it("find-in-conversation searches revealed preview text only", () => {
    withUserMessageScrollHeight(2000);
    const prefix = `visible needle ${"details ".repeat(80)}`;
    const suffix = "concealed phrase";

    const { container } = render(
      <MessageBubble message={userMessage(`${prefix}${suffix}`)} />,
    );
    const clamp = container.querySelector<HTMLElement>(
      '[data-role="user-message-clamp"]',
    );
    expect(clamp).not.toBeNull();
    if (!clamp) throw new Error("Expected user message clamp");

    expect(findTranscriptMatches(clamp, "visible needle")).toHaveLength(1);
    expect(findTranscriptMatches(clamp, suffix)).toHaveLength(0);
  });

  it("does not leave URLs below the preview in the tab order", async () => {
    withUserMessageScrollHeight(2000);
    const user = userEvent.setup();

    render(
      <MessageBubble
        message={userMessage(`${"details ".repeat(80)}https://example.com`)}
      />,
    );

    expect(
      screen.queryByRole("link", { name: "https://example.com" }),
    ).toBeNull();

    await user.click(await screen.findByRole("button", { name: "View more" }));

    expect(
      screen.getByRole("link", { name: "https://example.com" }),
    ).toBeInTheDocument();
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

  it("renders one visible copy of short user text", () => {
    render(<MessageBubble message={userMessage("hello world")} />);
    expect(screen.getAllByText("hello world")).toHaveLength(1);
  });

  it("replaces the Anthropic thinking-history 400 with a friendly notice", () => {
    render(
      <MessageBubble
        message={assistantMessage([
          {
            type: "text",
            text: 'Ran into this error: Request failed: Bad request (400): {"message":"messages.5.content.1: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response."}.\n\nPlease retry if you think this is a transient or recoverable error.',
          },
        ])}
      />,
    );
    expect(
      screen.getByText(/its earlier reasoning history is no longer in a form/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/cannot be modified/i)).toBeNull();
  });

  it("leaves ordinary assistant text untouched", () => {
    render(
      <MessageBubble
        message={assistantMessage([
          { type: "text", text: "Here is the summary." },
        ])}
      />,
    );
    expect(screen.getByText("Here is the summary.")).toBeInTheDocument();
  });

  it("does not label a steering user message before delivery", () => {
    const message = userMessage("adjust course");
    message.metadata = {
      ...message.metadata,
      delivery: "steering",
    };

    render(<MessageBubble message={message} />);

    expect(screen.queryByText("Steered")).not.toBeInTheDocument();
  });

  it("labels delivered steer user messages", () => {
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

  it("labels berdctl cross-session user messages", () => {
    const message = userMessage("from another session");
    message.metadata = {
      ...message.metadata,
      origin: "berdctl_cross_session",
    };

    render(<MessageBubble message={message} />);

    const label = screen.getByText("Sent by Berd from another session");
    expect(label).toBeInTheDocument();
    expect(label).toHaveAttribute(
      "data-role",
      "berdctl-cross-session-message-label",
    );
    expect(label.closest(".bg-message-user-bg")).toHaveTextContent(
      "from another session",
    );
  });

  it("shows a sender descriptor without replacing trusted Berd provenance", () => {
    const message = userMessage("[monitor: PR checks] complete");
    message.metadata = {
      ...message.metadata,
      origin: "berdctl_cross_session",
      berdSenderLabel: "Morgan",
    };

    render(<MessageBubble message={message} />);

    expect(
      screen.getByText("Sent by Berd from another session · source: Morgan"),
    ).toBeInTheDocument();
  });

  it("renders provenance and steer labels together", () => {
    const message = userMessage("steered from another session");
    message.metadata = {
      ...message.metadata,
      delivery: "steer",
      origin: "berdctl_cross_session",
    };

    render(<MessageBubble message={message} />);

    expect(
      screen.getByText("Sent by Berd from another session"),
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
    const { container } = render(
      <MessageBubble message={userMessage(longWord)} />,
    );
    const paragraph = container.querySelector(
      '[data-role="user-message-clamp-content"] p',
    );
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

  it.each([
    ["speaking", "Speaking"],
    ["spoken", "Spoken"],
    ["interrupted", "Interrupted"],
    ["notSpoken", "Not spoken"],
    ["failed", "Failed"],
  ] as const)("decorates one assistant text block with %s speech state", (status, label) => {
    const { container } = render(
      <MessageBubble
        message={assistantMessage([
          {
            type: "text",
            text: "One visible assistant response.",
            speech: { status },
          },
        ])}
      />,
    );

    const block = container.querySelector(
      `[data-voice-speech-status="${status}"]`,
    );
    expect(block).toHaveTextContent(label);
    expect(screen.getAllByText("One visible assistant response.")).toHaveLength(
      1,
    );
  });

  it("strikes only the estimated unspoken suffix after barge-in", () => {
    const { container } = render(
      <MessageBubble
        message={assistantMessage([
          {
            type: "text",
            text: "One. Two. Three.",
            speech: {
              status: "interrupted",
              spokenThrough: "One. Two".length,
              confidence: "medium",
            },
          },
        ])}
      />,
    );

    const block = container.querySelector(
      '[data-voice-speech-status="interrupted"]',
    );
    expect(block).toHaveTextContent("One. Two");
    expect(block?.querySelector("[data-voice-unspoken]")).toHaveTextContent(
      ". Three.",
    );
    expect(block?.querySelector("[data-voice-unspoken]")).not.toHaveTextContent(
      "One. Two",
    );
    expect(block?.querySelector("del")).toBeNull();
    expect(block?.querySelector(".sr-only")).toHaveTextContent("Not spoken:");
  });

  it("updates the strike when unchanged text becomes interrupted", () => {
    const text = "One. Two. Three.";
    const { container, rerender } = render(
      <MessageBubble
        message={assistantMessage([
          { type: "text", text, speech: { status: "speaking" } },
        ])}
      />,
    );
    expect(container.querySelector("[data-voice-unspoken]")).toBeNull();

    rerender(
      <MessageBubble
        message={assistantMessage([
          {
            type: "text",
            text,
            speech: {
              status: "interrupted",
              spokenThrough: "One. Two".length,
              confidence: "medium",
            },
          },
        ])}
      />,
    );

    expect(container.querySelector("[data-voice-unspoken]")).toHaveTextContent(
      ". Three.",
    );
  });

  it("keeps required list and table children structurally valid", () => {
    const text =
      "- Heard item\n- Unheard item\n\n| Name |\n| --- |\n| Heard |\n| Unheard |";
    const { container } = render(
      <MessageBubble
        message={assistantMessage([
          {
            type: "text",
            text,
            speech: {
              status: "interrupted",
              spokenThrough: "- Heard item".length,
              confidence: "medium",
            },
          },
        ])}
      />,
    );

    const list = container.querySelector("ul");
    expect(list).toBeInTheDocument();
    expect(
      [...(list?.children ?? [])].every((child) => child.tagName === "LI"),
    ).toBe(true);
    expect(list?.children[1]).toHaveTextContent("Unheard item");
    expect(list?.children[1]).toHaveAttribute("data-voice-unspoken", "true");
    const table = container.querySelector("table");
    expect(table).toBeInTheDocument();
    expect(table?.querySelector("tbody")?.parentElement).toBe(table);
    expect(
      [...(table?.querySelector("tbody")?.children ?? [])].every(
        (child) => child.tagName === "TR",
      ),
    ).toBe(true);
  });

  it("strikes every paragraph after the estimated interruption cutoff", () => {
    const { container } = render(
      <MessageBubble
        message={assistantMessage([
          {
            type: "text",
            text: "Heard text. Unheard first paragraph.\n\nUnheard second paragraph.\n\nUnheard third paragraph.",
            speech: {
              status: "interrupted",
              spokenThrough: "Heard text.".length,
              confidence: "medium",
            },
          },
        ])}
      />,
    );

    const block = container.querySelector(
      '[data-voice-speech-status="interrupted"]',
    );
    const paragraphs = block?.querySelectorAll("p");
    expect(paragraphs).toHaveLength(3);
    expect(
      paragraphs?.[0]?.querySelector("[data-voice-unspoken]"),
    ).toHaveTextContent("Unheard first paragraph.");
    expect(
      paragraphs?.[0]?.querySelector("[data-voice-unspoken]"),
    ).not.toHaveTextContent("Heard text.");
    expect(
      paragraphs?.[1]?.querySelector("[data-voice-unspoken]"),
    ).toHaveTextContent("Unheard second paragraph.");
    expect(
      paragraphs?.[2]?.querySelector("[data-voice-unspoken]"),
    ).toHaveTextContent("Unheard third paragraph.");
  });

  it("preserves Markdown structure while striking the unspoken range", async () => {
    const spoken = "Heard. ";
    const text = `${spoken}**bold** [link](https://example.com)\n\n- list item\n\n\`inline\`\n\n\`\`\`ts\nconst value = 1;\n\`\`\``;
    const { container } = render(
      <MessageBubble
        message={assistantMessage([
          {
            type: "text",
            text,
            speech: {
              status: "interrupted",
              spokenThrough: spoken.length,
              confidence: "medium",
            },
          },
        ])}
      />,
    );

    const block = container.querySelector(
      '[data-voice-speech-status="interrupted"]',
    );
    await waitFor(() => {
      expect(
        block?.querySelector('[data-streamdown="strong"][data-voice-unspoken]'),
      ).toHaveTextContent("bold");
      expect(
        block?.querySelector(
          'a[href="https://example.com/"][data-voice-unspoken]',
        ),
      ).toHaveTextContent("link");
      expect(block?.querySelector("li[data-voice-unspoken]")).toHaveTextContent(
        "list item",
      );
      expect(
        block
          ?.querySelector('[data-streamdown="inline-code"]')
          ?.closest("[data-voice-unspoken]"),
      ).toHaveTextContent("inline");
      expect(
        block?.querySelector(
          '[data-voice-unspoken] [data-streamdown="code-block"]',
        ),
      ).toBeTruthy();
      expect(block?.querySelector("pre code")).toHaveTextContent(
        "const value = 1;",
      );
      expect(block?.querySelectorAll(".sr-only")).toHaveLength(1);
    });
  });

  it("keeps void Markdown elements valid after the delivery boundary", async () => {
    const spoken = "Heard.\n\n";
    const text = `${spoken}![alt text](https://example.com/image.png)\n\n- [ ] task\n\nline  \nbreak\n\n---`;
    const { container } = render(
      <MessageBubble
        message={assistantMessage([
          {
            type: "text",
            text,
            speech: {
              status: "interrupted",
              spokenThrough: spoken.length,
              confidence: "medium",
            },
          },
        ])}
      />,
    );

    await waitFor(() => {
      const block = container.querySelector(
        '[data-voice-speech-status="interrupted"]',
      );
      expect(block?.querySelector("img")).toBeInTheDocument();
      expect(
        block?.querySelector('input[type="checkbox"]'),
      ).toBeInTheDocument();
      expect(block?.querySelector("br")).toBeInTheDocument();
      expect(block?.querySelector("hr")).toBeInTheDocument();
      expect(block?.querySelector("img")).toHaveAttribute(
        "data-voice-unspoken",
        "true",
      );
      expect(block?.querySelector("img")).toHaveAttribute(
        "alt",
        "Not spoken: alt text",
      );
    });
  });

  it("conservatively marks an image intersected by the delivery boundary", async () => {
    const text = "Heard ![multi word alt](https://example.com/image.png)";
    const { container } = render(
      <MessageBubble
        message={assistantMessage([
          {
            type: "text",
            text,
            speech: {
              status: "interrupted",
              spokenThrough: "Heard ![multi".length,
              confidence: "low",
            },
          },
        ])}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("img")).toHaveAttribute(
        "data-voice-unspoken",
        "true",
      );
      expect(container.querySelector("img")).toHaveAttribute(
        "alt",
        "Not spoken: multi word alt",
      );
    });
  });

  it("preserves decorative image semantics at the delivery boundary", async () => {
    const { container } = render(
      <MessageBubble
        message={assistantMessage([
          {
            type: "text",
            text: "![](https://example.com/decorative.png)",
            speech: {
              status: "notSpoken",
            },
          },
        ])}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("img")).toHaveAttribute("alt", "");
      expect(container.querySelector(".sr-only")).toHaveTextContent(
        "Not spoken:",
      );
    });
  });

  it("maps Markdown entities and escapes at the delivery boundary", () => {
    const spoken = "Heard &amp;";
    const text = `${spoken} escaped \\*asterisk\\*.`;
    const { container } = render(
      <MessageBubble
        message={assistantMessage([
          {
            type: "text",
            text,
            speech: {
              status: "interrupted",
              spokenThrough: spoken.length,
              confidence: "medium",
            },
          },
        ])}
      />,
    );

    const unheard = container.querySelector("[data-voice-unspoken]");
    expect(unheard).toHaveTextContent("escaped *asterisk*.");
    expect(unheard).not.toHaveTextContent("Heard &");
  });

  it("preserves provider-error presentation after interrupted delivery", () => {
    const rawError =
      "Ran into this error: thinking blocks in the latest assistant message cannot be modified";
    const { container } = render(
      <MessageBubble
        message={assistantMessage([
          {
            type: "text",
            text: rawError,
            speech: {
              status: "interrupted",
              spokenThrough: "Ran into this error:".length,
              confidence: "medium",
            },
          },
        ])}
      />,
    );

    const block = container.querySelector(
      '[data-voice-speech-status="interrupted"]',
    );
    expect(block).toHaveTextContent(
      "This chat can't continue with a Claude model",
    );
    expect(block?.querySelector("del")).toBeNull();
    expect(block).not.toHaveTextContent(rawError);
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

  it("renders and invokes fork-from-here for completed assistant messages", async () => {
    const user = userEvent.setup();
    const onForkFromMessage = vi.fn();
    render(
      <MessageBubble
        message={assistantMessage([{ type: "text", text: "response" }])}
        onForkFromMessage={onForkFromMessage}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Fork session from here" }),
    );

    expect(onForkFromMessage).toHaveBeenCalledWith("a1");
  });

  it("uses an explicit original message id for projected-row actions", async () => {
    const user = userEvent.setup();
    const onForkFromMessage = vi.fn();
    render(
      <MessageBubble
        message={{
          ...assistantMessage([{ type: "text", text: "response" }]),
          id: "a1:companion-mcpApp-tool-1",
        }}
        actionMessageId="a1"
        onForkFromMessage={onForkFromMessage}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Fork session from here" }),
    );

    expect(onForkFromMessage).toHaveBeenCalledWith("a1");
  });

  it("renders and invokes fork-from-here for completed user messages", async () => {
    const user = userEvent.setup();
    const onForkFromMessage = vi.fn();
    render(
      <MessageBubble
        message={userMessage("prompt")}
        onForkFromMessage={onForkFromMessage}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Fork session from here" }),
    );

    expect(onForkFromMessage).toHaveBeenCalledWith("u1");
  });

  it("hides fork-from-here for streaming assistant messages", () => {
    render(
      <MessageBubble
        message={assistantMessage([{ type: "text", text: "response" }])}
        isStreaming
        onForkFromMessage={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Fork session from here" }),
    ).not.toBeInTheDocument();
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

  it("reserves assistant action space without showing actions while the message is streaming", () => {
    const { container } = render(
      <MessageBubble
        message={assistantMessage([{ type: "text", text: "response" }])}
        isStreaming
        onRetryMessage={vi.fn()}
        onJumpToResponseStart={vi.fn()}
      />,
    );

    expect(
      container.querySelector('[data-role="assistant-message"] .pb-9'),
    ).toBeInTheDocument();
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
    expect(middle).toHaveClass("py-0");
    expect(middle).not.toHaveClass("-mt-1");
    expect(end).toHaveClass("pt-0", "pb-1");
    expect(end).not.toHaveClass("-mt-1");
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
    expect(screen.getByText(/readfile/i)).toBeInTheDocument();
  });

  it("renders metadata attachments as uniform tiles and opens files on click", async () => {
    const user = userEvent.setup();

    const { container } = render(
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

    expect(
      container.querySelectorAll('[data-role="message-attachment-tile"]'),
    ).toHaveLength(2);

    await user.click(
      screen.getByRole("button", { name: /open attachment report\.pdf/i }),
    );
    expect(vi.mocked(openPath)).toHaveBeenCalledWith("/Users/test/report.pdf");
    expect(
      screen.getByRole("button", { name: /open attachment screenshots/i }),
    ).toBeInTheDocument();
  });

  it("deduplicates attached image blocks into a thumbnail that opens a preview", async () => {
    const user = userEvent.setup();

    const { container } = render(
      <MessageBubble
        message={userMessage("See attached", {
          content: [
            { type: "text", text: "See attached" },
            { type: "image", data: "abc123", mimeType: "image/png" },
          ],
          metadata: {
            attachments: [
              {
                type: "file",
                name: "diagram.png",
                path: "/Users/test/diagram.png",
                mimeType: "image/png",
              },
            ],
          },
        })}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: /view full-size attachment diagram\.png/i,
      }),
    ).toBeInTheDocument();
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,abc123",
    );

    await user.click(
      screen.getByRole("button", {
        name: /view full-size attachment diagram\.png/i,
      }),
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByAltText("Preview of diagram.png")).toHaveLength(1);
  });

  it("opens URL attachments from attachment tiles", async () => {
    const user = userEvent.setup();

    render(
      <MessageBubble
        message={userMessage("See attached", {
          metadata: {
            attachments: [
              {
                type: "url",
                name: "report.csv",
                url: "https://example.com/report.csv",
                mimeType: "text/csv",
              },
            ],
          },
        })}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /open attachment report\.csv/i }),
    );

    expect(vi.mocked(openUrl)).toHaveBeenCalledWith(
      "https://example.com/report.csv",
    );
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
    expect(screen.getByText(/readfile/i)).toBeInTheDocument();
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
    expect(screen.getAllByText(/readfile/i)).toHaveLength(1);
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
    expect(bubbleText).toContain("ReadFile");
    expect(bubbleText).toContain("Results from checking.");
    expect(bubbleText?.indexOf("Lemme check...")).toBeLessThan(
      bubbleText?.indexOf("ReadFile") ?? Number.POSITIVE_INFINITY,
    );
    expect(bubbleText?.indexOf("ReadFile")).toBeLessThan(
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

    expect(screen.getAllByText(/readfile/i)).toHaveLength(1);
    expect(screen.queryByText("Tool result")).not.toBeInTheDocument();
  });

  it("renders thinking content regardless of stored experiment state", () => {
    localStorage.setItem(
      EXPERIMENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        experiments: { "agent-work-transcript": { enabled: false } },
      }),
    );
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

  it("renders a generated custom gloopie in the assistant gutter", () => {
    useAgentStore.setState({
      personas: [
        {
          id: "persona-1",
          displayName: "Builder",
          avatar: "user-avatar:custom",
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
    expect(gutterAvatar?.querySelector("img")).toHaveAttribute(
      "src",
      "asset:///avatars/custom.png",
    );
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
      '[data-role="tool-chain-card"] button[aria-expanded]',
    );
    if (!chainHeader) throw new Error("expected tool-chain-card header");
    await user.click(chainHeader);

    expect(screen.getByText("Create PDF about whales")).toBeInTheDocument();
    expect(screen.getByText("Write whales.pdf")).toBeInTheDocument();
    expect(screen.queryByText(/python3 create_whales\.py/i)).toBeNull();
    expect(screen.queryByText(/ls -lh whales\.pdf/i)).toBeNull();
    expect(screen.getByText("Show internal steps (2)")).toBeInTheDocument();

    await user.click(screen.getByText("Show internal steps (2)"));

    expect(screen.getByText(/python3 create_whales\.py/i)).toBeInTheDocument();
    expect(screen.getByText(/ls -lh whales\.pdf/i)).toBeInTheDocument();
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

  it("prefers the direct folder picker over revealing the context panel", async () => {
    const user = userEvent.setup();
    const onChangeFolder = vi.fn();
    const onOpenContextPanel = vi.fn();

    render(
      <MessageBubble
        message={notificationMessage({ type: "openContextPanel" })}
        onChangeFolder={onChangeFolder}
        onOpenContextPanel={onOpenContextPanel}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Change folder" }));

    expect(onChangeFolder).toHaveBeenCalledTimes(1);
    expect(onOpenContextPanel).not.toHaveBeenCalled();
  });

  it("uses the direct folder picker for edit-project notifications without a project-settings surface", async () => {
    const user = userEvent.setup();
    const onChangeFolder = vi.fn();

    render(
      <MessageBubble
        message={notificationMessage(editProjectAction)}
        onChangeFolder={onChangeFolder}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Change folder" }));

    expect(onChangeFolder).toHaveBeenCalledTimes(1);
  });

  it("omits the open-context-panel action when no handler is provided", () => {
    render(
      <MessageBubble
        message={notificationMessage({ type: "openContextPanel" })}
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a speech failure while marking only its estimated unspoken suffix", () => {
    const { container } = render(
      <MessageBubble
        message={assistantMessage([
          {
            type: "text",
            text: "An unusually long heard prefix. Unheard suffix.",
            speech: {
              status: "failed",
              spokenThrough: "An unusually long heard prefix".length,
              confidence: "medium",
            },
          },
        ])}
      />,
    );

    const block = container.querySelector(
      '[data-voice-speech-status="failed"]',
    );
    expect(block).toHaveTextContent("Failed");
    expect(block?.querySelector("[data-voice-unspoken]")).toHaveTextContent(
      ". Unheard suffix.",
    );
    expect(block?.querySelector(".sr-only")).toHaveTextContent("Not spoken:");
  });
});
