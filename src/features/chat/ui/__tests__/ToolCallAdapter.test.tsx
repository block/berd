import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactLinkCandidate } from "@/features/chat/hooks/ArtifactPolicyContext";
import type { ToolCallLocation } from "@/shared/types/messages";
import enChat from "@/shared/i18n/locales/en/chat.json";
import esChat from "@/shared/i18n/locales/es/chat.json";
import { ToolCallAdapter } from "../ToolCallAdapter";
import { useAgentStore } from "@/features/agents/stores/agentStore";

const mockResolveMarkdownHref =
  vi.fn<(href: string) => ArtifactLinkCandidate | null>();
const mockPathExists = vi.fn<(path: string) => Promise<boolean>>();
const mockOpenResolvedPath = vi.fn<(path: string) => Promise<void>>();
const mockOpenInApp =
  vi.fn<(path: string, filename?: string) => Promise<void>>();

const subagentLocaleKeys = Object.keys(enChat.tools.subagent) as Array<
  keyof typeof enChat.tools.subagent
>;

describe("ToolCallAdapter — subagent locale parity", () => {
  it("keeps every subagent law string in English and Spanish", () => {
    const en = enChat.tools.subagent;
    const es = esChat.tools.subagent;
    for (const key of subagentLocaleKeys) {
      expect(en[key], `English key ${key}`).toBeTruthy();
      expect(es[key], `Spanish key ${key}`).toBeTruthy();
    }
  });
});

vi.mock("@/features/chat/hooks/ArtifactPolicyContext", () => ({
  useArtifactActionsContext: () => ({
    resolveMarkdownHref: mockResolveMarkdownHref,
    pathExists: mockPathExists,
    openResolvedPath: mockOpenResolvedPath,
    openInApp: mockOpenInApp,
  }),
}));

beforeEach(() => {
  mockResolveMarkdownHref.mockReturnValue(null);
  useAgentStore.setState({ personas: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderAdapter(
  overrides: Partial<Parameters<typeof ToolCallAdapter>[0]> = {},
) {
  return render(
    <ToolCallAdapter
      name="write_file"
      arguments={{ path: "/project/output.md" }}
      status="completed"
      result="Created /project/output.md"
      {...overrides}
    />,
  );
}

describe("ToolCallAdapter — ArtifactActions", () => {
  it("does NOT render a per-card action for a viewable (markdown) location", () => {
    // Viewable files are owned by the message-level ArtifactChips row; a
    // per-card "View" button here would put two different-looking controls
    // for the same file on one expanded card.
    const locations: ToolCallLocation[] = [
      { path: "/Users/test/project/output.md" },
    ];

    renderAdapter({ locations });

    expect(
      screen.queryByRole("button", { name: /view|open file/i }),
    ).not.toBeInTheDocument();
  });

  it('renders an "Open file" button for a non-viewable location', () => {
    const locations: ToolCallLocation[] = [
      { path: "/Users/test/project/main.rs" },
    ];

    renderAdapter({ arguments: { path: "/project/main.rs" }, locations });

    expect(screen.getByRole("button", { name: /open file/i })).toBeEnabled();
  });

  it("does NOT render artifact actions when no locations are provided", () => {
    renderAdapter();

    expect(
      screen.queryByRole("button", { name: /view|open file/i }),
    ).not.toBeInTheDocument();
  });

  it('shows "More outputs" toggle when there are multiple non-viewable locations', async () => {
    const user = userEvent.setup();
    const locations: ToolCallLocation[] = [
      { path: "/Users/test/project/main.rs" },
      { path: "/Users/test/project/lib.rs" },
    ];

    renderAdapter({ locations });

    const toggle = screen.getByText(/more outputs/i);
    expect(toggle).toBeInTheDocument();

    expect(
      screen.queryByText("/Users/test/project/lib.rs"),
    ).not.toBeInTheDocument();

    await user.click(toggle);

    expect(screen.getByText("/Users/test/project/lib.rs")).toBeInTheDocument();
  });

  it("counts only non-viewable locations toward the overflow toggle", () => {
    // One code file + one markdown file: the markdown is ceded to chips, so
    // there is exactly one action and no "More outputs" disclosure.
    const locations: ToolCallLocation[] = [
      { path: "/Users/test/project/main.rs" },
      { path: "/Users/test/project/notes.md" },
    ];

    renderAdapter({ locations });

    expect(screen.getByRole("button", { name: /open file/i })).toBeEnabled();
    expect(screen.queryByText(/more outputs/i)).not.toBeInTheDocument();
  });

  it("invokes openInApp when an artifact button is clicked", async () => {
    const user = userEvent.setup();
    mockOpenInApp.mockResolvedValue(undefined);
    const locations: ToolCallLocation[] = [
      { path: "/Users/test/project/main.rs" },
    ];

    renderAdapter({ locations });

    await user.click(screen.getByRole("button", { name: /open file/i }));

    expect(mockOpenInApp).toHaveBeenCalledWith("/Users/test/project/main.rs");
  });
});

describe("ToolCallAdapter — subagent laws", () => {
  it("attributes a known agent and describes an explicit task", () => {
    renderAdapter({
      name: "delegate",
      toolName: "delegate",
      arguments: {
        source: "Rivet",
        instructions: "Count markdown files",
      },
    });

    expect(
      screen.getByRole("button", {
        name: /Delegating to Rivet · Count markdown files/i,
      }),
    ).toBeInTheDocument();
  });

  it("renders a matching agent avatar inline before the delegated name", () => {
    useAgentStore.setState({
      personas: [
        {
          id: "rivet",
          displayName: "Rivet",
          avatar: "https://example.test/rivet.png",
          systemPrompt: "Review code",
          isBuiltin: false,
          writable: true,
        },
      ],
    });

    const { container } = renderAdapter({
      name: "delegate",
      toolName: "delegate",
      arguments: {
        source: "Rivet",
        instructions: "Count markdown files",
      },
    });

    const avatar = container.querySelector(
      '[data-agent-identity-avatar="Rivet"] img',
    );
    expect(avatar).toHaveAttribute("src", "https://example.test/rivet.png");
    expect(avatar).toHaveAttribute("alt", "");
    expect(avatar?.parentElement?.previousElementSibling).toHaveTextContent(
      "Delegating to",
    );
    expect(avatar?.parentElement?.nextElementSibling).toHaveTextContent(
      "Rivet · Count markdown files",
    );
  });

  it("places an overlapping agent name at the translated identity slot", () => {
    useAgentStore.setState({
      personas: [
        {
          id: "to",
          displayName: "to",
          avatar: "https://example.test/to.png",
          systemPrompt: "Review code",
          isBuiltin: false,
          writable: true,
        },
      ],
    });

    const { container } = renderAdapter({
      name: "delegate",
      toolName: "delegate",
      arguments: { source: "to", instructions: "Review the code" },
    });

    const avatar = container.querySelector('[data-agent-identity-avatar="to"]');
    expect(avatar?.previousElementSibling).toHaveTextContent("Delegating to");
    expect(avatar?.nextElementSibling).toHaveTextContent(
      "to · Review the code",
    );
  });

  it("retains the delegated avatar when a result is hoisted", () => {
    useAgentStore.setState({
      personas: [
        {
          id: "rivet",
          displayName: "Rivet",
          avatar: "https://example.test/rivet.png",
          systemPrompt: "Review code",
          isBuiltin: false,
          writable: true,
        },
      ],
    });

    const { container } = renderAdapter({
      name: "delegate",
      toolName: "delegate",
      arguments: { source: "Rivet", instructions: "Review the code" },
      result: "Done",
      structuredContent: { outcome: "complete" },
    });

    expect(
      container.querySelector('[data-agent-identity-avatar="Rivet"] img'),
    ).toHaveAttribute("src", "https://example.test/rivet.png");
    expect(
      container.querySelector("[data-tool-title-hoisted]"),
    ).toHaveTextContent("Done");
  });

  it("does not choose an arbitrary avatar for ambiguous display names", () => {
    useAgentStore.setState({
      personas: [
        {
          id: "/agents/first.md",
          displayName: "Rivet",
          avatar: "https://example.test/first.png",
          systemPrompt: "First",
          isBuiltin: false,
          writable: true,
        },
        {
          id: "/agents/second.md",
          displayName: " rivet ",
          avatar: "https://example.test/second.png",
          systemPrompt: "Second",
          isBuiltin: false,
          writable: true,
        },
      ],
    });

    const { container } = renderAdapter({
      name: "delegate",
      toolName: "delegate",
      arguments: { source: "Rivet" },
    });

    expect(
      container.querySelector('[data-agent-avatar-fallback=""]'),
    ).toHaveTextContent("R");
    expect(
      container.querySelector("[data-agent-identity-avatar] img"),
    ).toBeNull();
  });

  it("prefers a canonical source id over ambiguous display names", () => {
    useAgentStore.setState({
      personas: [
        {
          id: "/agents/first.md",
          displayName: "Rivet",
          avatar: "https://example.test/first.png",
          systemPrompt: "First",
          isBuiltin: false,
          writable: true,
        },
        {
          id: "/agents/second.md",
          displayName: "Rivet",
          avatar: "https://example.test/second.png",
          systemPrompt: "Second",
          isBuiltin: false,
          writable: true,
        },
      ],
    });

    const { container } = renderAdapter({
      name: "delegate",
      toolName: "delegate",
      arguments: { source: "second" },
    });

    expect(
      container.querySelector('[data-agent-identity-avatar="second"] img'),
    ).toHaveAttribute("src", "https://example.test/second.png");
  });

  it("falls back after an avatar image fails and retries a changed source", () => {
    useAgentStore.setState({
      personas: [
        {
          id: "rivet",
          displayName: "Rivet",
          avatar: "https://example.test/broken.png",
          systemPrompt: "Review code",
          isBuiltin: false,
          writable: true,
        },
      ],
    });

    const { container, rerender } = renderAdapter({
      name: "delegate",
      toolName: "delegate",
      arguments: { source: "Rivet" },
    });
    const failedImage = container.querySelector(
      "[data-agent-identity-avatar] img",
    );
    expect(failedImage).not.toBeNull();
    act(() => fireEvent.error(failedImage as HTMLImageElement));
    expect(
      container.querySelector('[data-agent-avatar-fallback=""]'),
    ).toHaveTextContent("R");

    act(() =>
      useAgentStore.setState({
        personas: [
          {
            id: "rivet",
            displayName: "Rivet",
            avatar: "https://example.test/recovered.png",
            systemPrompt: "Review code",
            isBuiltin: false,
            writable: true,
          },
        ],
      }),
    );
    rerender(
      <ToolCallAdapter
        name="delegate"
        toolName="delegate"
        arguments={{ source: "Rivet" }}
        status="completed"
      />,
    );
    expect(
      container.querySelector("[data-agent-identity-avatar] img"),
    ).toHaveAttribute("src", "https://example.test/recovered.png");
  });

  it("falls back to an initial for an unmatched delegated agent", () => {
    const { container } = renderAdapter({
      name: "delegate",
      toolName: "delegate",
      arguments: { source: "Rivet" },
    });

    expect(
      container.querySelector('[data-agent-avatar-fallback=""]'),
    ).toHaveTextContent("R");
  });

  it("describes a valid source-only delegation", () => {
    renderAdapter({
      name: "delegate",
      toolName: "delegate",
      arguments: { source: "Rivet" },
    });

    expect(
      screen.getByRole("button", {
        name: /Asking Rivet to run its configured task/i,
      }),
    ).toBeInTheDocument();
  });

  it.each([
    {
      toolName: "delegate",
      arguments: {},
      title: "Delegating to a subagent",
    },
    {
      toolName: "Agent",
      arguments: { subagent_type: "code-reviewer" },
      title: "Delegating to code-reviewer",
    },
    {
      toolName: "spawn_agent",
      arguments: {},
      title: "Delegating to a subagent",
    },
  ])("does not fabricate an unknown task for $toolName activity", ({
    toolName,
    arguments: args,
    title,
  }) => {
    renderAdapter({ name: toolName, toolName, arguments: args });

    expect(
      screen.getByRole("button", { name: new RegExp(`^${title}$`, "i") }),
    ).toBeInTheDocument();
  });

  it("renders lawful Codex follow-up provenance", () => {
    renderAdapter({
      name: "followup_task",
      toolName: "followup_task",
      arguments: {
        target: "/root/reviewer",
        message: "Re-check the cache boundary",
      },
    });

    expect(
      screen.getByRole("button", {
        name: /Delegating to \/root\/reviewer · Re-check the cache boundary/i,
      }),
    ).toBeInTheDocument();
  });

  it.each([
    {
      toolName: "send_message",
      arguments: { target: "/root/reviewer", message: "Review the patch" },
      title: "Sending a message to /root/reviewer · Review the patch",
    },
    {
      toolName: "interrupt_agent",
      arguments: { target: "/root/reviewer" },
      title: "Interrupting /root/reviewer’s current turn",
    },
    {
      toolName: "wait_agent",
      arguments: { targets: ["agent-1", "agent-2"] },
      title: "Waiting on agent-1, agent-2",
    },
  ])("renders truthful Codex $toolName activity", ({
    toolName,
    arguments: args,
    title,
  }) => {
    renderAdapter({ name: toolName, toolName, arguments: args });

    expect(
      screen.getByRole("button", { name: new RegExp(`^${title}$`, "i") }),
    ).toBeInTheDocument();
  });

  it("does not expose a task id as an unknown task description", () => {
    renderAdapter({
      name: "Loading source 20260807_72",
      toolName: "load",
      arguments: { source: "20260807_72" },
    });

    expect(
      screen.getByRole("button", {
        name: /^Waiting on a subagent$/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/20260807_72/)).not.toBeInTheDocument();
  });

  it("retains recovered identity and task on async follow-ups", () => {
    renderAdapter({
      name: "load",
      toolName: "load",
      subagentAgentName: "Rivet",
      subagentTaskLabel: "Count markdown files",
      arguments: { source: "20260807_72" },
    });

    expect(
      screen.getByRole("button", {
        name: /Waiting on Rivet · Count markdown files/i,
      }),
    ).toBeInTheDocument();
  });

  it.each([
    {
      arguments: { source: "20260807_72" },
      title: "Waiting on a delegated task · Count markdown files",
    },
    {
      arguments: { source: "20260807_72", peek: true },
      title: "Checking on a delegated task · Count markdown files",
    },
    {
      arguments: { source: "20260807_72", cancel: true },
      title: "Cancelling a delegated task · Count markdown files",
    },
  ])("describes task-only async $title activity", ({
    arguments: args,
    title,
  }) => {
    renderAdapter({
      name: "load",
      toolName: "load",
      subagentTaskLabel: "Count markdown files",
      arguments: args,
    });

    expect(
      screen.getByRole("button", { name: new RegExp(title, "i") }),
    ).toBeInTheDocument();
  });

  it.each([
    {
      arguments: { source: "20260807_72" },
      title: "Waiting on Rivet",
    },
    {
      arguments: { source: "20260807_72", peek: true },
      title: "Checking on Rivet",
    },
    {
      arguments: { source: "20260807_72", cancel: true },
      title: "Cancelling Rivet",
    },
  ])("attributes agent-only async $title activity without inventing a task", ({
    arguments: args,
    title,
  }) => {
    renderAdapter({
      name: "load",
      toolName: "load",
      subagentAgentName: "Rivet",
      arguments: args,
    });

    expect(
      screen.getByRole("button", { name: new RegExp(`^${title}$`, "i") }),
    ).toBeInTheDocument();
  });

  it("retains a recovered configured task on async follow-ups", () => {
    renderAdapter({
      name: "load",
      toolName: "load",
      subagentAgentName: "Rivet",
      subagentTaskIsConfigured: true,
      arguments: { source: "20260807_72", peek: true },
    });

    expect(
      screen.getByRole("button", {
        name: /Checking Rivet’s configured task/i,
      }),
    ).toBeInTheDocument();
  });
});

describe("ToolCallAdapter — expanded body", () => {
  it("renders the tool name and status badge in the header", () => {
    renderAdapter();
    const header = screen.getByRole("button", { name: /Write_file/i });
    expect(header).toBeInTheDocument();
    expect(screen.getByText("Write_file")).toHaveClass("text-muted-foreground");
  });

  it("sentence-cases the tool title and renames shell to Running command", () => {
    renderAdapter({
      name: "shell · git status --short --branch",
      arguments: { command: "git status --short --branch" },
    });

    expect(
      screen.getByRole("button", {
        name: /Running command · git status --short --branch/i,
      }),
    ).toBeInTheDocument();
  });

  it("keeps the MCP acronym uppercase instead of sentence-casing it", () => {
    renderAdapter({
      name: "mcp: berd-extension-manager  enable extension",
    });

    expect(
      screen.getByRole("button", {
        name: /MCP: berd-extension-manager enable extension/,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Mcp:/)).not.toBeInTheDocument();
  });

  it("shows the text result when expanded", () => {
    renderAdapter({ open: true, structuredContent: undefined });
    expect(screen.getByText(/created \/project\/output\.md/i)).toBeVisible();
  });

  it("renders structured content when present without a text result", () => {
    renderAdapter({
      open: true,
      result: undefined,
      structuredContent: { kind: "summary", count: 3 },
    });

    expect(screen.getByText(/"kind"/)).toBeInTheDocument();
    expect(screen.getByText(/"summary"/)).toBeInTheDocument();
  });

  it("renders the error result when isError is true", () => {
    renderAdapter({ open: true, isError: true, result: "Boom" });
    expect(screen.getByText("Boom")).toHaveClass("text-destructive");
  });

  it("caps and scrolls an inner details viewport in the agent work layout", () => {
    const { container } = renderAdapter({ open: true, agentWorkLayout: true });

    const details = screen.getByRole("region", { name: "Tool details" });
    expect(details).toHaveAttribute("tabindex", "0");
    expect(details).toHaveClass(
      "max-h-48",
      "overflow-y-auto",
      "overscroll-contain",
    );
    expect(
      container.querySelector('[data-role="tool-call-content"]'),
    ).not.toHaveClass("max-h-48", "overflow-y-auto");
  });

  it("does not add a capped details viewport outside the agent work layout", () => {
    const { container } = renderAdapter({ open: true });

    expect(
      container.querySelector('[data-role="agent-work-tool-details"]'),
    ).not.toBeInTheDocument();
  });
});

describe("ToolCallAdapter — text + structured de-dupe matrix", () => {
  it("hides redundant text when result is a stringified copy of structured", () => {
    const structured = { kind: "summary", count: 3 };
    renderAdapter({
      open: true,
      arguments: {},
      result: JSON.stringify(structured),
      structuredContent: structured,
    });

    // The structured payload renders exactly once, not twice.
    const summaryMatches = screen.getAllByText(/"summary"/);
    expect(summaryMatches).toHaveLength(1);
  });

  it("hoists short single-line text into the header when both differ", () => {
    renderAdapter({
      open: true,
      arguments: {},
      result: "Found 3 matches",
      structuredContent: { matches: 3 },
    });

    // The hoisted text renders inside the header subtitle slot.
    const hoisted = document.querySelector("[data-tool-title-hoisted]");
    expect(hoisted).not.toBeNull();
    expect(hoisted?.textContent).toContain("Found 3 matches");

    // Body shows the structured payload but does NOT duplicate the hoisted
    // text — i.e. "Found 3 matches" appears exactly once across the card.
    const allMatches = screen.getAllByText(/Found 3 matches/);
    expect(allMatches).toHaveLength(1);
    expect(screen.getByText(/"matches"/)).toBeInTheDocument();
  });

  it("renders both text and structured in the body when text is multi-line", () => {
    renderAdapter({
      open: true,
      arguments: {},
      result: "line one\nline two\nline three",
      structuredContent: { matches: 3 },
    });

    // No header hoisting for multi-line text.
    expect(document.querySelector("[data-tool-title-hoisted]")).toBeNull();

    // Both blocks render in the body.
    expect(screen.getByText(/line one/)).toBeInTheDocument();
    expect(screen.getByText(/"matches"/)).toBeInTheDocument();
  });

  it("does not hoist text when path-based header hoisting takes precedence", () => {
    // Tool name contains the basename → path-based hoisting activates.
    renderAdapter({
      open: true,
      name: "Write file output.md",
      arguments: { path: "/project/output.md" },
      result: "Wrote file",
      structuredContent: { bytes: 42 },
    });

    // Path-based hoisting wins; result text stays in the body.
    expect(document.querySelector("[data-tool-title-hoisted]")).toBeNull();
    expect(screen.getByText(/wrote file/i)).toBeInTheDocument();
    expect(screen.getByText(/"bytes"/)).toBeInTheDocument();
  });
});
