import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolChainCards } from "../ToolChainCards";
import type { ToolChainItem } from "@/features/chat/lib/toolChainGrouping";
import { VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE } from "@/features/chat/transcript/measurement";
import {
  TranscriptRowStateProvider,
  createTranscriptRowStateRegistry,
} from "@/features/chat/transcript/row-state";

const mockOpenInApp = vi.fn().mockResolvedValue(undefined);

vi.mock("@/features/chat/hooks/ArtifactPolicyContext", () => ({
  useArtifactActionsContext: () => ({
    resolveToolCardDisplay: () => ({
      role: "none",
      primaryCandidate: null,
      secondaryCandidates: [],
    }),
    resolveMarkdownHref: () => null,
    pathExists: vi.fn().mockResolvedValue(false),
    openResolvedPath: vi.fn().mockResolvedValue(undefined),
    openInApp: mockOpenInApp,
  }),
}));

let nextId = 0;

function pair(
  name: string,
  options: {
    isError?: boolean;
    status?: ToolChainItem["request"] extends infer R
      ? R extends { status: infer S }
        ? S
        : never
      : never;
    completed?: boolean;
  } = {},
): ToolChainItem {
  const id = `tool-${++nextId}`;
  const completed = options.completed !== false;
  return {
    key: id,
    request: {
      type: "toolRequest",
      id,
      name,
      arguments: {},
      status: options.status ?? "completed",
    },
    response: completed
      ? {
          type: "toolResponse",
          id,
          name,
          result: "ok",
          isError: options.isError ?? false,
        }
      : undefined,
  };
}

function pairWithLocation(name: string, path: string): ToolChainItem {
  const item = pair(name);
  return {
    ...item,
    request: item.request
      ? { ...item.request, locations: [{ path }] }
      : item.request,
  };
}

function completeItem(item: ToolChainItem): ToolChainItem {
  return {
    ...item,
    request: item.request
      ? { ...item.request, status: "completed" }
      : item.request,
    response: {
      type: "toolResponse",
      id: item.request?.id ?? item.response?.id ?? "tool-x",
      name: item.request?.name ?? item.response?.name ?? "",
      result: "ok",
      isError: false,
    },
  };
}

describe("ToolChainCards", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders without a parent header for a single tool item", () => {
    render(<ToolChainCards toolItems={[pair("Read · src/a.ts")]} />);
    expect(
      screen.queryByRole("button", { name: /reviewing files|step/i }),
    ).not.toBeInTheDocument();
  });

  // Re-entry contract: chips are the ONLY way back into the viewer from a
  // chain. The former header "View" action rendered solely when a chain
  // touched exactly one viewable file, so identical documents surfaced as
  // different-looking controls depending on how the run grouped.
  it("shows a chip for a single viewable artifact", async () => {
    mockOpenInApp.mockClear();
    const user = userEvent.setup();
    render(
      <ToolChainCards
        toolItems={[
          pair("Listing notes markdown files"),
          pairWithLocation("Writing notes markdown file", "/p/notes-2.md"),
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /open notes-2\.md/i }));
    expect(mockOpenInApp).toHaveBeenCalledWith("/p/notes-2.md", "notes-2.md");
  });

  it("shows a chip for a lone tool call (ungrouped render)", async () => {
    // A single write_file call is the most common "write me a doc" shape and
    // renders through the ungrouped early-return, not the chain header path.
    // The chip contract must hold there too — this test fails if chips are
    // only wired into the grouped branch.
    mockOpenInApp.mockClear();
    const user = userEvent.setup();
    render(
      <ToolChainCards
        toolItems={[pairWithLocation("Writing notes", "/p/solo.md")]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /open solo\.md/i }));
    expect(mockOpenInApp).toHaveBeenCalledWith("/p/solo.md", "solo.md");
  });

  it("shows a chip per file for a multi-file chain", async () => {
    mockOpenInApp.mockClear();
    const user = userEvent.setup();
    render(
      <ToolChainCards
        toolItems={[
          pairWithLocation("Writing a", "/p/a.md"),
          pairWithLocation("Writing b", "/p/b.md"),
        ]}
      />,
    );

    expect(screen.getByText("a.md")).toBeInTheDocument();
    expect(screen.getByText("b.md")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /open a\.md/i }));
    expect(mockOpenInApp).toHaveBeenCalledWith("/p/a.md", "a.md");
  });

  it("retires the header View action in favor of chips", () => {
    render(
      <ToolChainCards
        toolItems={[
          pair("Listing notes"),
          pairWithLocation("Writing notes", "/p/notes.md"),
        ]}
      />,
    );
    // One consistent control, not a header action plus a chip.
    expect(screen.queryByRole("button", { name: /^view$/i })).toBeNull();
    expect(
      document.querySelector('[data-role="artifact-chips"]'),
    ).toBeInTheDocument();
  });

  it("keeps chips reachable in both collapsed and expanded states", async () => {
    // Chips live outside the collapsible body, so collapse must not take away
    // the way back into the viewer. A completed chain mounts collapsed, so
    // this starts in the state that matters most.
    const user = userEvent.setup();
    render(
      <ToolChainCards
        toolItems={[
          pairWithLocation("Writing a", "/p/a.md"),
          pairWithLocation("Writing b", "/p/b.md"),
        ]}
      />,
    );

    const header = screen.getByRole("button", { expanded: false });
    expect(screen.getByText("a.md")).toBeInTheDocument();
    expect(screen.getByText("b.md")).toBeInTheDocument();

    // Still there once the steps are expanded.
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("a.md")).toBeInTheDocument();
    expect(screen.getByText("b.md")).toBeInTheDocument();
  });

  it("does NOT show a chip row for a non-viewable artifact", () => {
    render(
      <ToolChainCards
        toolItems={[
          pair("Reading config"),
          pairWithLocation("Writing code", "/p/main.rs"),
        ]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /^view$/i }),
    ).not.toBeInTheDocument();
  });

  it("renders a deterministic chain header for multi-tool chains", () => {
    render(
      <ToolChainCards
        toolItems={[pair("Shell · npm test"), pair("Shell · npm run build")]}
      />,
    );
    expect(
      screen.getByRole("button", { name: /running commands.*2 step/i }),
    ).toBeInTheDocument();
  });

  it("uses the active label while any step is still in progress", () => {
    render(
      <ToolChainCards
        toolItems={[
          pair("Shell · npm test", { completed: true }),
          pair("Shell · npm build", {
            status: "in_progress",
            completed: false,
          }),
        ]}
      />,
    );
    expect(
      screen.getByRole("button", { name: /working through 2 steps/i }),
    ).toBeInTheDocument();
  });

  it("collapses and re-expands an active chain when the header is clicked", async () => {
    const user = userEvent.setup();
    render(
      <ToolChainCards
        toolItems={[
          pair("Edit · src/a.ts"),
          pair("Edit · src/b.ts", {
            status: "in_progress",
            completed: false,
          }),
        ]}
      />,
    );
    const header = screen.getByRole("button", {
      name: /working through 2 steps/i,
    });
    expect(header).toHaveAttribute("aria-expanded", "true");
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("starts collapsed when the chain mounts already complete (replay)", async () => {
    const user = userEvent.setup();
    render(
      <ToolChainCards
        toolItems={[pair("Edit · src/a.ts"), pair("Edit · src/b.ts")]}
      />,
    );
    const header = screen.getByRole("button", {
      name: /updating files.*2 steps/i,
    });
    expect(header).toHaveAttribute("aria-expanded", "false");
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
  });

  it("auto-collapses an untouched live chain once every step has completed", () => {
    const a = pair("Edit · src/a.ts");
    const bRequest = pair("Edit · src/b.ts", {
      status: "in_progress",
      completed: false,
    });
    const { rerender } = render(<ToolChainCards toolItems={[a, bRequest]} />);
    const activeHeader = screen.getByRole("button", {
      name: /working through 2 steps/i,
    });
    expect(activeHeader).toHaveAttribute("aria-expanded", "true");

    // Same chain identity, but the second step now has a response — i.e. the
    // chain has just completed in realtime.
    const bComplete = completeItem(bRequest);
    rerender(<ToolChainCards toolItems={[a, bComplete]} />);

    const completedHeader = screen.getByRole("button", {
      name: /updating files.*2 steps/i,
    });
    expect(completedHeader).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps a manually expanded completed chain open when a new step arrives", async () => {
    const user = userEvent.setup();
    const a = pair("Edit · src/a.ts");
    const b = pair("Edit · src/b.ts");
    const c = pair("Edit · src/c.ts");
    const { rerender } = render(<ToolChainCards toolItems={[a, b]} />);

    let header = screen.getByRole("button", {
      name: /updating files.*2 steps/i,
    });
    expect(header).toHaveAttribute("aria-expanded", "false");

    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");

    rerender(<ToolChainCards toolItems={[a, b, c]} />);

    header = screen.getByRole("button", {
      name: /updating files.*3 steps/i,
    });
    expect(header).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps a manually collapsed active chain closed when a new step arrives", async () => {
    const user = userEvent.setup();
    const a = pair("Edit · src/a.ts");
    const b = pair("Edit · src/b.ts", {
      status: "in_progress",
      completed: false,
    });
    const c = pair("Edit · src/c.ts", {
      status: "in_progress",
      completed: false,
    });
    const { rerender } = render(<ToolChainCards toolItems={[a, b]} />);

    let header = screen.getByRole("button", {
      name: /working through 2 steps/i,
    });
    expect(header).toHaveAttribute("aria-expanded", "true");

    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");

    rerender(<ToolChainCards toolItems={[a, b, c]} />);

    header = screen.getByRole("button", {
      name: /working through 3 steps/i,
    });
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps a user-expanded live chain open once every step has completed", async () => {
    const user = userEvent.setup();
    const a = pair("Edit · src/a.ts");
    const bRequest = pair("Edit · src/b.ts", {
      status: "in_progress",
      completed: false,
    });
    const { rerender } = render(<ToolChainCards toolItems={[a, bRequest]} />);

    await user.click(screen.getByRole("button", { name: /edit.*src\/a\.ts/i }));
    expect(screen.getByText("ok")).toBeVisible();

    rerender(<ToolChainCards toolItems={[a, completeItem(bRequest)]} />);

    const completedHeader = screen.getByRole("button", {
      name: /updating files.*2 steps/i,
    });
    expect(completedHeader).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("ok")).toBeVisible();
  });

  it("leaves the parent collapsed when an untouched single tool becomes an active chain", () => {
    const a = pair("Read · src/a.ts");
    const bRequest = pair("Run checks", {
      status: "in_progress",
      completed: false,
    });
    const { rerender } = render(<ToolChainCards toolItems={[a]} />);

    rerender(<ToolChainCards toolItems={[a, bRequest]} />);

    expect(
      screen.getByRole("button", { name: /working through 2 steps/i }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps a live chain open when the user toggles the chain header", async () => {
    const user = userEvent.setup();
    const a = pair("Edit · src/a.ts");
    const bRequest = pair("Edit · src/b.ts", {
      status: "in_progress",
      completed: false,
    });
    const { rerender } = render(<ToolChainCards toolItems={[a, bRequest]} />);

    const activeHeader = screen.getByRole("button", {
      name: /working through 2 steps/i,
    });
    expect(activeHeader).toHaveAttribute("aria-expanded", "true");

    // Toggling the chain header off and back on is the original
    // "user is paying attention" signal — both clicks count as interaction.
    await user.click(activeHeader);
    expect(activeHeader).toHaveAttribute("aria-expanded", "false");
    await user.click(activeHeader);
    expect(activeHeader).toHaveAttribute("aria-expanded", "true");

    rerender(<ToolChainCards toolItems={[a, completeItem(bRequest)]} />);

    const completedHeader = screen.getByRole("button", {
      name: /updating files.*2 steps/i,
    });
    expect(completedHeader).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps a live chain open when the user opens the internal steps disclosure", async () => {
    const user = userEvent.setup();
    const edit = pair("Edit · src/a.ts");
    const lsStep = pair("ls -lh");
    const catStep = pair("cat file.txt");
    const finalStep = pair("Edit · src/b.ts", {
      status: "in_progress",
      completed: false,
    });
    const { rerender } = render(
      <ToolChainCards toolItems={[edit, lsStep, catStep, finalStep]} />,
    );

    const activeHeader = screen.getByRole("button", {
      name: /working through 4 steps/i,
    });
    expect(activeHeader).toHaveAttribute("aria-expanded", "true");

    await user.click(
      screen.getByRole("button", { name: /show internal steps \(2\)/i }),
    );

    rerender(
      <ToolChainCards
        toolItems={[edit, lsStep, catStep, completeItem(finalStep)]}
      />,
    );

    const completedHeader = screen.getByRole("button", {
      name: /updating files.*4 steps/i,
    });
    expect(completedHeader).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps a live chain open after the user opens and closes a tool item", async () => {
    const user = userEvent.setup();
    const a = pair("Edit · src/a.ts");
    const bRequest = pair("Edit · src/b.ts", {
      status: "in_progress",
      completed: false,
    });
    const { rerender } = render(<ToolChainCards toolItems={[a, bRequest]} />);

    // Open the first tool item, then close it again. After this the chain has
    // no expanded items but userInteractedRef has been flipped — closing a
    // tool you just opened still counts as interaction.
    const aHeader = screen.getByRole("button", { name: /edit.*src\/a\.ts/i });
    await user.click(aHeader);
    expect(screen.getByText("ok")).toBeVisible();
    await user.click(aHeader);
    expect(screen.queryByText("ok")).not.toBeInTheDocument();

    rerender(<ToolChainCards toolItems={[a, completeItem(bRequest)]} />);

    const completedHeader = screen.getByRole("button", {
      name: /updating files.*2 steps/i,
    });
    expect(completedHeader).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps an expanded single tool visible when it becomes a grouped chain", async () => {
    const user = userEvent.setup();
    const a = pair("Read · src/a.ts");
    const bRequest = pair("Run checks", {
      status: "in_progress",
      completed: false,
    });
    const { container, rerender } = render(<ToolChainCards toolItems={[a]} />);
    const singleCaret = container.querySelector<HTMLButtonElement>(
      '[data-role="tool-single"] > button',
    );
    if (!singleCaret) throw new Error("expected single tool caret");

    await user.click(singleCaret);
    expect(screen.getByText("ok")).toBeVisible();

    rerender(<ToolChainCards toolItems={[a, bRequest]} />);

    expect(
      screen.getByRole("button", { name: /working through 2 steps/i }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("ok")).toBeVisible();
  });

  it("surfaces error status as a data attribute on the chain wrapper", () => {
    const { container } = render(
      <ToolChainCards
        toolItems={[
          pair("Shell · npm test"),
          pair("Shell · npm build", { isError: true }),
        ]}
      />,
    );
    const wrapper = container.querySelector('[data-role="tool-chain-card"]');
    expect(wrapper?.getAttribute("data-status")).toBe("failed");
  });

  it("renders a step rail row for each child inside a chain", () => {
    const { container } = render(
      <ToolChainCards
        toolItems={[
          pair("Edit · src/a.ts"),
          pair("Edit · src/b.ts"),
          pair("Edit · src/c.ts", {
            status: "in_progress",
            completed: false,
          }),
        ]}
      />,
    );
    const rows = container.querySelectorAll('[data-role="tool-chain-step"]');
    expect(rows).toHaveLength(3);
  });

  it("does not wrap a single tool call in a rail row", () => {
    const { container } = render(
      <ToolChainCards toolItems={[pair("Read · src/a.ts")]} />,
    );
    const rows = container.querySelectorAll('[data-role="tool-chain-step"]');
    expect(rows).toHaveLength(0);
  });

  it("renders a left caret button on a single tool call that toggles its open state", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ToolChainCards toolItems={[pair("Read · src/a.ts")]} />,
    );
    const wrapper = container.querySelector('[data-role="tool-single"]');
    expect(wrapper).not.toBeNull();

    const caret = wrapper?.querySelector(
      ":scope > button",
    ) as HTMLButtonElement;
    expect(caret).toBeTruthy();
    expect(caret).toHaveAttribute("aria-expanded", "false");
    await user.click(caret);
    expect(caret).toHaveAttribute("aria-expanded", "true");
  });

  it("hides the trailing right-side chevron on a single tool call", () => {
    const { container } = render(
      <ToolChainCards toolItems={[pair("Read · src/a.ts")]} />,
    );
    // The shared ToolHeader's trailing chevron is a CollapsibleTrigger
    // styled with the group-data-[state=closed]:-rotate-90 class. With
    // showChevron={false} the icon should not render at all inside the
    // single-tool wrapper.
    const wrapper = container.querySelector('[data-role="tool-single"]');
    expect(wrapper).not.toBeNull();
    const trailingChevron = wrapper?.querySelector(
      ".group-data-\\[state\\=closed\\]\\:-rotate-90",
    );
    expect(trailingChevron).toBeNull();
  });

  it("keeps expanded low-signal steps visible when a chain starts hiding internal steps", async () => {
    const user = userEvent.setup();
    const reportStep = pair("Write report");
    const expandedInternalStep = pair("python3 create_report.py");
    const finalStep = pair("Finalize report");
    const laterInternalStep = pair("ls -lh report.pdf");
    const { container, rerender } = render(
      <ToolChainCards
        toolItems={[reportStep, expandedInternalStep, finalStep]}
      />,
    );
    const chainHeader = container.querySelector<HTMLButtonElement>(
      '[data-role="tool-chain-card"] button[aria-expanded]',
    );
    if (!chainHeader) throw new Error("expected tool-chain-card header");

    await user.click(chainHeader);
    await user.click(
      screen.getByRole("button", { name: /python3 create_report\.py/i }),
    );
    expect(screen.getByText("ok")).toBeVisible();

    rerender(
      <ToolChainCards
        toolItems={[
          reportStep,
          expandedInternalStep,
          finalStep,
          laterInternalStep,
        ]}
      />,
    );

    expect(
      screen.getByRole("button", { name: /python3 create_report\.py/i }),
    ).toBeVisible();
    expect(screen.getByText("ok")).toBeVisible();
  });

  it("counts the internal-steps disclosure as part of the rail", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ToolChainCards
        toolItems={[
          pair("Edit · src/a.ts"),
          pair("Edit · src/b.ts"),
          pair("ls"),
          pair("cat"),
        ]}
      />,
    );
    // The chain mounts as already-complete (default test pair → completed),
    // so the rail starts collapsed during replay; expand it first.
    await user.click(
      screen.getByRole("button", { name: /updating files.*4 steps/i }),
    );
    const disclosure = container.querySelector(
      '[data-role="tool-chain-internal-disclosure"]',
    );
    expect(disclosure).not.toBeNull();

    const beforeRows = container.querySelectorAll(
      '[data-role="tool-chain-step"]',
    );
    expect(beforeRows.length).toBeGreaterThanOrEqual(1);

    const showButton = screen.getByRole("button", {
      name: /show internal steps \(2\)/i,
    });
    await user.click(showButton);

    const afterRows = container.querySelectorAll(
      '[data-role="tool-chain-step"]',
    );
    expect(afterRows.length).toBe(beforeRows.length + 2);

    // Assert the accessibility state at the synchronous start of the exit.
    // Awaiting userEvent here can outlast the short animation on slower CI
    // workers, leaving no exiting node to inspect.
    fireEvent.click(
      screen.getByRole("button", { name: /hide internal steps \(2\)/i }),
    );

    const exitingSteps = container.querySelector(
      '[data-role="tool-chain-internal-steps"]',
    );
    if (!exitingSteps) {
      throw new Error("expected internal steps to remain during exit motion");
    }
    expect(exitingSteps).toHaveAttribute("aria-hidden", "true");
    expect(exitingSteps).toHaveAttribute("inert");
  });

  it("removes the heavy parent card chrome around the chain wrapper", () => {
    const { container } = render(
      <ToolChainCards
        toolItems={[pair("Edit · src/a.ts"), pair("Edit · src/b.ts")]}
      />,
    );
    const wrapper = container.querySelector('[data-role="tool-chain-card"]');
    expect(wrapper).not.toBeNull();
    const className = wrapper?.getAttribute("class") ?? "";
    expect(className).not.toMatch(/border-/);
    expect(className).not.toMatch(/bg-muted/);
  });

  it("prefers the LLM chain summary over the deterministic phrase when present", () => {
    const a = pair("Edit · src/a.ts");
    const b = pair("Edit · src/b.ts");
    if (a.request) {
      a.request.chainSummary = {
        summary: "applied dark mode polish",
        count: 2,
      };
    }
    render(<ToolChainCards toolItems={[a, b]} />);
    expect(
      screen.getByRole("button", {
        name: /applied dark mode polish.*2 steps/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /updating files/i }),
    ).not.toBeInTheDocument();
  });

  it("falls back to the deterministic phrase when no chain summary is present", () => {
    render(
      <ToolChainCards
        toolItems={[pair("Edit · src/a.ts"), pair("Edit · src/b.ts")]}
      />,
    );
    expect(
      screen.getByRole("button", { name: /updating files.*2 steps/i }),
    ).toBeInTheDocument();
  });

  it("does not surface the chain summary while the chain is still active", () => {
    const a = pair("Edit · src/a.ts");
    const b = pair("Edit · src/b.ts", {
      status: "in_progress",
      completed: false,
    });
    if (a.request) {
      a.request.chainSummary = {
        summary: "applied dark mode polish",
        count: 2,
      };
    }
    render(<ToolChainCards toolItems={[a, b]} />);
    expect(
      screen.getByRole("button", { name: /working through 2 steps/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /applied dark mode polish/i }),
    ).not.toBeInTheDocument();
  });

  it("restores chain disclosure state from virtual row state", async () => {
    const user = userEvent.setup();
    const registry = createTranscriptRowStateRegistry();
    const items = [pair("Edit · src/a.ts"), pair("Edit · src/b.ts")];
    const renderChain = () =>
      render(
        <TranscriptRowStateProvider
          registry={registry}
          sessionId="session-1"
          rowId="row-1"
        >
          <ToolChainCards toolItems={items} />
        </TranscriptRowStateProvider>,
      );

    const firstRender = renderChain();
    await user.click(
      screen.getByRole("button", { name: /updating files.*2 steps/i }),
    );
    expect(
      screen.getByRole("button", { name: /updating files.*2 steps/i }),
    ).toHaveAttribute("aria-expanded", "true");

    firstRender.unmount();
    renderChain();

    expect(
      screen.getByRole("button", { name: /updating files.*2 steps/i }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps virtual row state isolated for multiple chains in one row", async () => {
    const user = userEvent.setup();
    const registry = createTranscriptRowStateRegistry();
    const editItems = [pair("Edit · src/a.ts"), pair("Edit · src/b.ts")];
    const commandItems = [
      pair("Shell · pnpm test"),
      pair("Shell · pnpm build"),
    ];
    const renderChains = () =>
      render(
        <TranscriptRowStateProvider
          registry={registry}
          sessionId="session-1"
          rowId="row-1"
        >
          <ToolChainCards chainId="chain-edit" toolItems={editItems} />
          <ToolChainCards chainId="chain-shell" toolItems={commandItems} />
        </TranscriptRowStateProvider>,
      );

    const firstRender = renderChains();
    const editHeader = screen.getByRole("button", {
      name: /updating files.*2 steps/i,
    });
    const shellHeader = screen.getByRole("button", {
      name: /running commands.*2 steps/i,
    });

    await user.click(editHeader);

    expect(editHeader).toHaveAttribute("aria-expanded", "true");
    expect(shellHeader).toHaveAttribute("aria-expanded", "false");

    firstRender.unmount();
    renderChains();

    expect(
      screen.getByRole("button", { name: /updating files.*2 steps/i }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: /running commands.*2 steps/i }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      registry.getRowState({ sessionId: "session-1", rowId: "row-1" })
        ?.toolChains,
    ).toEqual(
      expect.objectContaining({
        "chain-edit": expect.objectContaining({ chainExpanded: true }),
        "chain-shell": expect.objectContaining({ chainExpanded: false }),
      }),
    );
  });

  it("marks tool disclosure layout pending during animation windows", () => {
    vi.useFakeTimers();
    const { container } = render(
      <ToolChainCards
        toolItems={[pair("Edit · src/a.ts"), pair("Edit · src/b.ts")]}
      />,
    );

    const wrapper = container.querySelector('[data-role="tool-chain-card"]');
    expect(wrapper).not.toHaveAttribute(VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE);

    fireEvent.click(
      screen.getByRole("button", { name: /updating files.*2 steps/i }),
    );

    expect(wrapper).toHaveAttribute(
      VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE,
      "tool-animation",
    );

    act(() => {
      vi.advanceTimersByTime(220);
    });
    expect(wrapper).not.toHaveAttribute(VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE);
  });
});
