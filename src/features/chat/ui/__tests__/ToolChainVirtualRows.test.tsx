import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "@/shared/types/messages";
import { ToolChainSummaryMessageBubble } from "../ToolChainVirtualRows";

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
  }),
}));

function getToolStep(name: RegExp): HTMLElement {
  const step = screen
    .getByRole("button", { name })
    .closest<HTMLElement>('[data-role="tool-chain-step"]');
  if (!step) throw new Error(`Expected tool-chain step matching ${name}`);
  return step;
}

function toolChainMessage(): Message {
  return {
    id: "assistant-tools",
    role: "assistant",
    created: Date.UTC(2026, 6, 10, 12, 0, 0),
    metadata: { userVisible: true },
    content: [
      {
        type: "toolRequest",
        id: "tool-old",
        name: "Edit · src/old.ts",
        arguments: {},
        status: "completed",
      },
      {
        type: "toolResponse",
        id: "tool-old",
        name: "Edit · src/old.ts",
        result: "old result",
        isError: false,
      },
      {
        type: "toolRequest",
        id: "tool-new",
        name: "Edit · src/new.ts",
        arguments: {},
        status: "completed",
      },
      {
        type: "toolResponse",
        id: "tool-new",
        name: "Edit · src/new.ts",
        result: "new result",
        isError: false,
      },
    ],
  };
}

describe("ToolChainVirtualRows", () => {
  it("renders expanded tool details immediately after their parent", () => {
    const message = toolChainMessage();
    const payload = {
      chainId: message.id,
      message,
      detailRowId: "message:assistant-tools:tool-chain-detail",
      isActiveChain: false,
    };

    render(<ToolChainSummaryMessageBubble payload={payload} />);

    fireEvent.click(
      screen.getByRole("button", { name: /updating files.*2 steps/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /edit.*src\/old\.ts/i }),
    );

    const oldResult = screen.getByText("old result");
    const oldTool = getToolStep(/edit.*src\/old\.ts/i);
    const newTool = getToolStep(/edit.*src\/new\.ts/i);

    expect(oldTool).toContainElement(oldResult);
    expect(
      oldResult.compareDocumentPosition(newTool) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("keeps request-only step details before the next tool step", () => {
    const message = toolChainMessage();
    message.content = [
      {
        type: "toolRequest",
        id: "tool-pending",
        name: "Shell · npm test",
        arguments: { command: "npm test" },
        status: "in_progress",
      },
      {
        type: "toolRequest",
        id: "tool-next",
        name: "Read · src/next.ts",
        arguments: {},
        status: "pending",
      },
    ];
    const payload = {
      chainId: message.id,
      message,
      detailRowId: "message:assistant-tools:tool-chain-detail",
      isActiveChain: true,
    };

    render(<ToolChainSummaryMessageBubble payload={payload} />);

    fireEvent.click(
      screen.getByRole("button", { name: /running command.*npm test/i }),
    );

    const pendingDetails = screen.getByText("npm test");
    const pendingTool = getToolStep(/running command.*npm test/i);
    const nextTool = getToolStep(/read.*src\/next\.ts/i);

    expect(pendingTool).toContainElement(pendingDetails);
    expect(
      pendingDetails.compareDocumentPosition(nextTool) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });
});
