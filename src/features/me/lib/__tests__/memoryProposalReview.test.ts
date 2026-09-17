import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  approveMemoryProposal: vi.fn(),
  resolveMemoryProposal: vi.fn(),
}));

vi.mock("@/shared/api/system", () => ({
  approveMemoryProposal: mocks.approveMemoryProposal,
  resolveMemoryProposal: mocks.resolveMemoryProposal,
}));

import {
  approveMemoryProposal,
  CredentialMemoryError,
  declineMemoryProposal,
  UnsafeMemoryTextError,
} from "../memoryProposalReview";

const proposal = {
  id: "proposal-1",
  ts: 1,
  content: "Prefers aisle seats.",
  topic: "Travel",
  agent: "noticer",
  sessionId: "session-1",
};

describe("memory proposal review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.approveMemoryProposal.mockResolvedValue({ approved: true });
  });

  it("delegates the exact normalized reviewed approval to the backend", async () => {
    await approveMemoryProposal(
      proposal,
      "  Prefers cafe\u0301 seats.\r\n",
      " Travel\r\n ",
    );
    expect(mocks.approveMemoryProposal).toHaveBeenCalledWith(
      proposal.id,
      "Prefers café seats.",
      "Travel",
    );
  });

  it("rejects edited authentication data before backend admission", async () => {
    await expect(
      approveMemoryProposal(proposal, "API key: ghp_16CharsAtLeastHere00"),
    ).rejects.toBeInstanceOf(CredentialMemoryError);
    expect(mocks.approveMemoryProposal).not.toHaveBeenCalled();
  });

  it("rejects hidden Unicode before backend admission", async () => {
    await expect(
      approveMemoryProposal(
        proposal,
        "API key: ghp_16Chars\u200bAtLeastHere00",
      ),
    ).rejects.toBeInstanceOf(UnsafeMemoryTextError);
    await expect(
      approveMemoryProposal(proposal, "Safe content.", "Tra\u202evel"),
    ).rejects.toBeInstanceOf(UnsafeMemoryTextError);
    expect(mocks.approveMemoryProposal).not.toHaveBeenCalled();
  });

  it("declines through fingerprint-only backend suppression", async () => {
    await declineMemoryProposal(proposal);
    expect(mocks.resolveMemoryProposal).toHaveBeenCalledWith(proposal.id, {
      content: proposal.content,
      topic: proposal.topic,
    });
  });
});
