import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  approveMemoryProposal: vi.fn(),
  resolveMemoryProposal: vi.fn(),
  loadMeFile: vi.fn(),
  publishMeFile: vi.fn(),
}));

vi.mock("@/shared/api/system", () => ({
  approveMemoryProposal: mocks.approveMemoryProposal,
  resolveMemoryProposal: mocks.resolveMemoryProposal,
}));
vi.mock("../meFile", () => ({ loadMeFile: mocks.loadMeFile }));
vi.mock("../mePublish", () => ({ publishMeFile: mocks.publishMeFile }));

import {
  approveMemoryProposal,
  CredentialMemoryError,
  declineMemoryProposal,
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
    mocks.approveMemoryProposal.mockResolvedValue({
      approved: true,
      refreshProjection: true,
    });
    mocks.loadMeFile.mockResolvedValue({ status: "missing" });
  });

  it("delegates edited approval to the backend", async () => {
    await approveMemoryProposal(proposal, "Prefers window seats.");
    expect(mocks.approveMemoryProposal).toHaveBeenCalledWith(
      proposal.id,
      "Prefers window seats.",
      "Travel",
    );
  });

  it("rejects edited authentication data before backend admission", async () => {
    await expect(
      approveMemoryProposal(proposal, "API key: ghp_16CharsAtLeastHere00"),
    ).rejects.toBeInstanceOf(CredentialMemoryError);
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
