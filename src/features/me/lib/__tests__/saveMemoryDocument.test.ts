import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readTextFile: vi.fn(),
  resolveMemoryProposal: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock("@/shared/api/system", () => ({
  readTextFile: mocks.readTextFile,
  resolveMemoryProposal: mocks.resolveMemoryProposal,
  writeTextFile: mocks.writeTextFile,
}));

import { CredentialMemoryError } from "../memoryCredentialGuard";
import { saveMemoryDocument } from "../saveMemoryDocument";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("crypto", { randomUUID: () => "delete-id" });
  mocks.writeTextFile.mockResolvedValue(undefined);
  mocks.resolveMemoryProposal.mockResolvedValue(undefined);
  mocks.readTextFile.mockResolvedValue({
    contents: "# Travel\n\n- Prefers aisle seats.\n- Packs light.\n",
  });
});

describe("saveMemoryDocument", () => {
  it("writes before suppressing an unambiguous deletion", async () => {
    await saveMemoryDocument({
      path: "/home/u/.me/topics/travel.md",
      contents: "# Travel\n\n- Packs light.\n",
      topic: "Travel",
    });

    expect(mocks.writeTextFile).toHaveBeenCalledOnce();
    expect(mocks.resolveMemoryProposal).toHaveBeenCalledWith(
      "manual-delete-delete-id",
      { content: "Prefers aisle seats.", topic: "Travel" },
    );
    expect(mocks.writeTextFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.resolveMemoryProposal.mock.invocationCallOrder[0],
    );
  });

  it("does not suppress anything when the write fails", async () => {
    mocks.writeTextFile.mockRejectedValue(new Error("read only"));
    await expect(
      saveMemoryDocument({
        path: "/home/u/.me/topics/travel.md",
        contents: "# Travel\n\n- Packs light.\n",
        topic: "Travel",
      }),
    ).rejects.toThrow("read only");
    expect(mocks.resolveMemoryProposal).not.toHaveBeenCalled();
  });

  it("blocks credential-shaped edits before writing", async () => {
    await expect(
      saveMemoryDocument({
        path: "/home/u/.me/me.md",
        contents: "# Me\n\n- API key: ghp_16CharsAtLeastHere00\n",
        topic: null,
      }),
    ).rejects.toBeInstanceOf(CredentialMemoryError);
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });
});
