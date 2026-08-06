import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  canUseNative: vi.fn(() => true),
  generateOptions: vi.fn(),
  animateOption: vi.fn(),
  deleteUserAvatar: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/shared/api/gloopies", async (importOriginal) => {
  // Only the transport is mocked. Error normalization stays real so error-code
  // assertions below cannot pass vacuously.
  const actual = await importOriginal<typeof import("@/shared/api/gloopies")>();
  return {
    ...actual,
    canUseNativeGloopieGeneration: apiMocks.canUseNative,
    generateGloopieOptions: apiMocks.generateOptions,
    animateGloopieOption: apiMocks.animateOption,
  };
});

vi.mock("@/shared/api/avatars", () => ({
  deleteUserAvatar: apiMocks.deleteUserAvatar,
}));

import {
  animateChosenGloopie,
  chooseGloopieOption,
  clearGloopieGenerationSession,
  getGloopieGenerationJob,
  isGloopieGenerationUnresolved,
  resetGloopieGeneration,
  resetGloopieGenerationStoreForTests,
  setGloopieObject,
  startGloopieGeneration,
  useGloopieGenerationStore,
} from "../gloopieGenerationStore";
import type { AvatarLibraryState } from "@/features/agents/hooks/useAvatarLibrary";
import { GloopieGenerationError } from "@/shared/api/gloopies";

const library = {
  catalog: null,
  cachedAvatarMediaById: {},
  loading: false,
  cacheChecking: false,
  error: false,
  errorCode: null,
  downloadingCollectionIds: new Set(),
  failedCollectionIds: new Set(),
  retryCatalog: vi.fn(),
  openCollection: vi.fn(),
  isCollectionCached: () => false,
} as AvatarLibraryState;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("gloopieGenerationStore", () => {
  beforeEach(() => {
    resetGloopieGenerationStoreForTests();
    apiMocks.generateOptions.mockReset();
    apiMocks.animateOption.mockReset();
    apiMocks.deleteUserAvatar.mockClear();
  });

  async function generateTwoOptions(sessionId = "session") {
    apiMocks.generateOptions.mockResolvedValue([
      { id: "one", avatarRef: "user-avatar:one" },
      { id: "two", avatarRef: "user-avatar:two" },
    ]);
    setGloopieObject(sessionId, "teapot");
    startGloopieGeneration(sessionId, library);
    await flushPromises();
  }

  it("surfaces a blocked prompt as contentBlocked, not a generic failure", async () => {
    apiMocks.generateOptions.mockRejectedValue(
      new GloopieGenerationError("blocked", "contentBlocked"),
    );

    setGloopieObject("session", "teapot");
    startGloopieGeneration("session", library);
    await flushPromises();

    const job = getGloopieGenerationJob("session");
    expect(job.phase).toBe("error");
    expect(job.errorCode).toBe("contentBlocked");
  });

  it("surfaces a lost connection as networkAccess", async () => {
    apiMocks.generateOptions.mockResolvedValue([
      { id: "one", avatarRef: "user-avatar:one" },
    ]);
    apiMocks.animateOption.mockRejectedValue(
      new GloopieGenerationError("offline", "networkAccess"),
    );

    setGloopieObject("session", "teapot");
    startGloopieGeneration("session", library);
    await flushPromises();
    chooseGloopieOption("session", "one");
    animateChosenGloopie("session");
    await flushPromises();

    expect(getGloopieGenerationJob("session").errorCode).toBe("networkAccess");
  });

  it("deletes the losing options once one is animated", async () => {
    await generateTwoOptions();
    apiMocks.animateOption.mockResolvedValue("user-avatar:finished");

    chooseGloopieOption("session", "one");
    animateChosenGloopie("session");
    await flushPromises();

    // The chosen option was uploaded and superseded by the animation, so both
    // stills are now garbage; only the animation survives.
    expect(apiMocks.deleteUserAvatar.mock.calls.flat()).toEqual(
      expect.arrayContaining(["user-avatar:one", "user-avatar:two"]),
    );
    expect(apiMocks.deleteUserAvatar).not.toHaveBeenCalledWith(
      "user-avatar:finished",
    );
  });

  it("deletes abandoned media when the attempt is discarded", async () => {
    await generateTwoOptions();

    resetGloopieGeneration("session");

    expect(apiMocks.deleteUserAvatar.mock.calls.flat()).toEqual(
      expect.arrayContaining(["user-avatar:one", "user-avatar:two"]),
    );
  });

  it("can preserve the prompt when the user starts over", async () => {
    await generateTwoOptions();

    resetGloopieGeneration("session", { keepObject: true });

    const job = getGloopieGenerationJob("session");
    expect(job.phase).toBe("prompt");
    expect(job.object).toBe("teapot");
    expect(job.options).toHaveLength(0);
  });

  it("keeps a ref the caller has just committed to the agent", async () => {
    await generateTwoOptions();
    apiMocks.animateOption.mockResolvedValue("user-avatar:finished");
    chooseGloopieOption("session", "one");
    animateChosenGloopie("session");
    await flushPromises();
    apiMocks.deleteUserAvatar.mockClear();

    resetGloopieGeneration("session", { keepRefs: ["user-avatar:finished"] });

    expect(apiMocks.deleteUserAvatar).not.toHaveBeenCalledWith(
      "user-avatar:finished",
    );
  });

  it("deletes options that land after the attempt was abandoned", async () => {
    const request = deferred<Array<{ id: string; avatarRef: string }>>();
    apiMocks.generateOptions.mockReturnValue(request.promise);
    setGloopieObject("session", "teapot");
    startGloopieGeneration("session", library);

    // Abandon while in flight; the backend still produces and writes files.
    resetGloopieGeneration("session");
    apiMocks.deleteUserAvatar.mockClear();
    request.resolve([{ id: "late", avatarRef: "user-avatar:late" }]);
    await flushPromises();

    expect(getGloopieGenerationJob("session").phase).toBe("prompt");
    expect(apiMocks.deleteUserAvatar).toHaveBeenCalledWith("user-avatar:late");
  });

  it("evicts the job and its media when the session goes away", async () => {
    await generateTwoOptions("session");

    clearGloopieGenerationSession("session");

    expect(useGloopieGenerationStore.getState().jobs).not.toHaveProperty(
      "session",
    );
    expect(apiMocks.deleteUserAvatar.mock.calls.flat()).toEqual(
      expect.arrayContaining(["user-avatar:one", "user-avatar:two"]),
    );
  });

  it("keeps a native generation alive without a mounted React subscriber", async () => {
    const request = deferred<Array<{ id: string; avatarRef: string }>>();
    apiMocks.generateOptions.mockReturnValue(request.promise);

    setGloopieObject("session", "teapot");
    startGloopieGeneration("session", library);
    expect(getGloopieGenerationJob("session").phase).toBe("generating");

    request.resolve([{ id: "one", avatarRef: "user-avatar:one" }]);
    await flushPromises();

    expect(getGloopieGenerationJob("session").phase).toBe("choosing");
  });

  it("blocks saving until the generated avatar is resolved", async () => {
    // The save gate exists so a draft can never be promoted with a
    // half-finished avatar. Walk the whole flow and assert the gate tracks it.
    expect(isGloopieGenerationUnresolved("session")).toBe(false);

    const request = deferred<Array<{ id: string; avatarRef: string }>>();
    apiMocks.generateOptions.mockReturnValue(request.promise);
    setGloopieObject("session", "teapot");
    startGloopieGeneration("session", library);
    expect(isGloopieGenerationUnresolved("session")).toBe(true);

    request.resolve([{ id: "one", avatarRef: "user-avatar:one" }]);
    await flushPromises();
    expect(getGloopieGenerationJob("session").phase).toBe("choosing");
    expect(isGloopieGenerationUnresolved("session")).toBe(true);

    const animation = deferred<string>();
    apiMocks.animateOption.mockReturnValue(animation.promise);
    chooseGloopieOption("session", "one");
    animateChosenGloopie("session");
    expect(isGloopieGenerationUnresolved("session")).toBe(true);

    animation.resolve("user-avatar:finished");
    await flushPromises();
    // Finished is still unresolved: the user has not committed it to the agent.
    expect(getGloopieGenerationJob("session").phase).toBe("done");
    expect(isGloopieGenerationUnresolved("session")).toBe(true);

    // Committing the result (Use this avatar) clears the block.
    resetGloopieGeneration("session", { keepRefs: ["user-avatar:finished"] });
    expect(isGloopieGenerationUnresolved("session")).toBe(false);
  });

  it("does not block saving after a failure, so the user is not trapped", async () => {
    apiMocks.generateOptions.mockRejectedValue(
      new GloopieGenerationError("boom", "unavailable"),
    );

    setGloopieObject("session", "teapot");
    startGloopieGeneration("session", library);
    await flushPromises();

    // There is no pending avatar to wait for, so saving must stay available.
    expect(getGloopieGenerationJob("session").phase).toBe("error");
    expect(isGloopieGenerationUnresolved("session")).toBe(false);
  });
});
