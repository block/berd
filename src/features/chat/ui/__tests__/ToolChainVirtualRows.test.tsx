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

    render(
      <>
        <ToolChainSummaryMessageBubble payload={payload} />
        <div data-testid="following-content">Following content</div>
      </>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /updating files.*2 steps/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /edit.*src\/old\.ts/i }),
    );

    const oldResult = screen.getByText("old result");
    const oldTool = screen
      .getByRole("button", { name: /edit.*src\/old\.ts/i })
      .closest('[data-role="tool-chain-step"]');
    const followingContent = screen.getByTestId("following-content");

    expect(oldTool).toContainElement(oldResult);
    expect(
      oldResult.compareDocumentPosition(followingContent) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });
});
