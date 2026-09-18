import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTextFile: vi.fn(),
  initializeMemoryStore: vi.fn(),
  saveReviewedMemoryDocument: vi.fn(),
}));

vi.mock("@/shared/api/system", () => ({
  createTextFile: mocks.createTextFile,
  initializeMemoryStore: mocks.initializeMemoryStore,
  saveReviewedMemoryDocument: mocks.saveReviewedMemoryDocument,
}));

import { CredentialMemoryError } from "../memoryCredentialGuard";
import { saveMemoryDocument } from "../saveMemoryDocument";
import { UnsafeMemoryTextError } from "../memoryTextContract";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.saveReviewedMemoryDocument.mockResolvedValue(undefined);
});

describe("saveMemoryDocument", () => {
  it("uses one backend transaction for the document, approval, and suppression", async () => {
    await saveMemoryDocument({
      path: "/home/u/.me/topics/travel.md",
      contents: "# Travel\n\n- Packs light.\n",
      topic: "Travel",
    });
    expect(mocks.saveReviewedMemoryDocument).toHaveBeenCalledExactlyOnceWith(
      "/home/u/.me/topics/travel.md",
      "# Travel\n\n- Packs light.\n",
      "Travel",
    );
    expect(mocks.initializeMemoryStore).not.toHaveBeenCalled();
    expect(mocks.createTextFile).not.toHaveBeenCalled();
  });

  it("normalizes direct Settings document saves before the atomic save", async () => {
    await saveMemoryDocument({
      path: "/home/u/.me/topics/travel.md",
      contents: "# Cafe\u0301\r\n\r\n- Packs light.\r\n",
      topic: " Travel\r\n ",
    });

    expect(mocks.saveReviewedMemoryDocument).toHaveBeenCalledWith(
      "/home/u/.me/topics/travel.md",
      "# Café\n\n- Packs light.\n",
      "Travel",
    );
  });

  it("blocks credential-shaped edits before writing", async () => {
    await expect(
      saveMemoryDocument({
        path: "/home/u/.me/me.md",
        contents: "# Me\n\n- PIN: 1234\n",
        topic: null,
      }),
    ).rejects.toBeInstanceOf(CredentialMemoryError);
    expect(mocks.saveReviewedMemoryDocument).not.toHaveBeenCalled();
  });

  it("blocks hidden Unicode before writing", async () => {
    await expect(
      saveMemoryDocument({
        path: "/home/u/.me/me.md",
        contents: "# Me\n\n- token ghp_16Chars\u200bAtLeastHere00\n",
        topic: null,
      }),
    ).rejects.toBeInstanceOf(UnsafeMemoryTextError);
    await expect(
      saveMemoryDocument({
        path: "/home/u/.me/topics/travel.md",
        contents: "# Travel\n\n- Packs light.\n",
        topic: "Tra\u202evel",
      }),
    ).rejects.toBeInstanceOf(UnsafeMemoryTextError);
    expect(mocks.saveReviewedMemoryDocument).not.toHaveBeenCalled();
  });
});

it.each([
  "locked",
  "corrupt ciphertext",
  "missing",
  "legacy store",
])("propagates transaction failures without retrying or reinitializing: %s", async (message) => {
  mocks.saveReviewedMemoryDocument.mockRejectedValue(new Error(message));
  await expect(
    saveMemoryDocument({
      path: "/home/u/.me/me.md",
      contents: "# Me",
      topic: null,
    }),
  ).rejects.toThrow(message);
  expect(mocks.saveReviewedMemoryDocument).toHaveBeenCalledOnce();
  expect(mocks.createTextFile).not.toHaveBeenCalled();
  expect(mocks.initializeMemoryStore).not.toHaveBeenCalled();
});
it("initializes only an explicit create, then uses create-only IPC", async () => {
  await saveMemoryDocument({
    path: "/home/u/.me/me.md",
    contents: "# Me",
    topic: null,
    create: true,
  });
  expect(mocks.initializeMemoryStore).toHaveBeenCalledOnce();
  expect(mocks.createTextFile).toHaveBeenCalledExactlyOnceWith(
    "/home/u/.me/me.md",
    "# Me",
  );
  expect(mocks.initializeMemoryStore.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.createTextFile.mock.invocationCallOrder[0],
  );
  expect(mocks.saveReviewedMemoryDocument).not.toHaveBeenCalled();
});
it("refuses creation if initialization rejects a legacy or locked store", async () => {
  mocks.initializeMemoryStore.mockRejectedValue(new Error("legacy store"));
  await expect(
    saveMemoryDocument({
      path: "/home/u/.me/me.md",
      contents: "# Me",
      topic: null,
      create: true,
    }),
  ).rejects.toThrow("legacy store");
  expect(mocks.createTextFile).not.toHaveBeenCalled();
});
