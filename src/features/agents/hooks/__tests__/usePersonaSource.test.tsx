import { StrictMode, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listMock = vi.fn();
const readSourceMock = vi.fn();
const updateMock = vi.fn();
const createMock = vi.fn();

vi.mock("@/shared/api/agents", () => ({
  createPersonaSource: (request: unknown) => createMock(request),
  listPersonaSources: () => listMock(),
  readAgentSourceFile: (path: string, fallback: unknown) =>
    readSourceMock(path, fallback),
  updatePersonaSource: (path: string, patch: unknown) =>
    updateMock(path, patch),
}));

import {
  createDraftAgentSource,
  resetAgentBuilderSourceLifecycleForTests,
} from "@/features/agents/lib/agentBuilderSourceLifecycle";
import { usePersonaSource } from "../usePersonaSource";

const path = "/Users/x/.agents/agents/draft-1.md";

const sourceV1 = {
  type: "agent",
  path,
  name: "Untitled agent",
  description: "Draft",
  content: "Draft in progress.",
  properties: { draft: true },
  writable: true,
};

const sourceV2 = { ...sourceV1, name: "Snark" };
const movedSource = {
  ...sourceV1,
  path: "/Users/x/.agents/agents/moved-draft.md",
  properties: { draft: true, builderSessionId: "sess-1" },
};
const sessionPlaceholderSource = {
  ...sourceV1,
  name: "Untitled agent sess-1",
  properties: { draft: true, builderSessionId: "sess-1" },
};
const renamedSessionSource = {
  ...sourceV1,
  path: "/Users/x/.agents/agents/constructive-critic.md",
  name: "Constructive Critic",
  content: "Give useful critique.",
  properties: { draft: true, builderSessionId: "sess-1" },
};

let documentHasFocus = true;
let hasFocusSpy: ReturnType<typeof vi.spyOn> | null = null;

function setDocumentVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("usePersonaSource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    documentHasFocus = true;
    hasFocusSpy = vi.spyOn(document, "hasFocus").mockImplementation(() => {
      return documentHasFocus;
    });
    setDocumentVisibility("visible");
    listMock.mockReset();
    readSourceMock.mockReset();
    readSourceMock.mockImplementation(
      async (_path: string, fallback: unknown) => fallback,
    );
    updateMock.mockReset();
    createMock.mockReset();
    resetAgentBuilderSourceLifecycleForTests();
  });

  afterEach(() => {
    hasFocusSpy?.mockRestore();
    hasFocusSpy = null;
    vi.useRealTimers();
  });

  it("reads the source by path on mount", async () => {
    listMock.mockResolvedValue([sourceV1]);

    const { result } = renderHook(() => usePersonaSource(path));
    await flushPromises();

    expect(result.current.data?.name).toBe("Untitled agent");
  });

  it("polls and picks up external changes", async () => {
    listMock.mockResolvedValueOnce([sourceV1]);
    const { result } = renderHook(() => usePersonaSource(path));
    await flushPromises();
    expect(result.current.data?.name).toBe("Untitled agent");

    listMock.mockResolvedValue([sourceV2]);
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });

    expect(result.current.data?.name).toBe("Snark");
  });

  it("pauses polling while the window is hidden", async () => {
    listMock.mockResolvedValue([sourceV1]);
    renderHook(() => usePersonaSource(path));
    await flushPromises();
    expect(listMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      setDocumentVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });

    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("pauses polling while the window is unfocused", async () => {
    listMock.mockResolvedValue([sourceV1]);
    renderHook(() => usePersonaSource(path));
    await flushPromises();
    expect(listMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      documentHasFocus = false;
      window.dispatchEvent(new Event("blur"));
    });

    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });

    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("resumes polling with a fresh reload when the window becomes visible", async () => {
    listMock.mockResolvedValueOnce([sourceV1]).mockResolvedValue([sourceV2]);
    const { result } = renderHook(() => usePersonaSource(path));
    await flushPromises();
    expect(result.current.data?.name).toBe("Untitled agent");

    await act(async () => {
      setDocumentVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });
    expect(result.current.data?.name).toBe("Untitled agent");

    await act(async () => {
      setDocumentVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushPromises();

    expect(result.current.data?.name).toBe("Snark");
  });

  it("update() is optimistic and debounced", async () => {
    listMock.mockResolvedValue([sourceV1]);
    updateMock.mockResolvedValue({ ...sourceV1, name: "Snark" });
    const { result } = renderHook(() => usePersonaSource(path));
    await flushPromises();
    expect(result.current.data?.name).toBe("Untitled agent");

    act(() => result.current.update({ name: "Sna" }));
    act(() => result.current.update({ name: "Snar" }));
    act(() => result.current.update({ name: "Snark" }));

    expect(result.current.data?.name).toBe("Snark");
    expect(updateMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(path, { name: "Snark" });
  });

  it("does not auto-save existing agent builder edits before saveNow", async () => {
    const existingSource = {
      ...sourceV1,
      name: "Code Reviewer",
      content: "Review code carefully.",
      properties: {},
    };
    listMock.mockResolvedValue([existingSource]);
    updateMock.mockResolvedValue({
      ...existingSource,
      name: "Code Reviewer Deluxe",
    });
    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1" }),
    );
    await flushPromises();

    act(() => result.current.update({ name: "Code Reviewer Deluxe" }));
    expect(result.current.data?.name).toBe("Code Reviewer Deluxe");

    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    expect(updateMock).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.saveNow();
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(path, {
      name: "Code Reviewer Deluxe",
    });
  });

  it("drops a pending debounced save when the source path changes", async () => {
    const secondPath = "/Users/x/.agents/agents/draft-2.md";
    const sourceB = { ...sourceV1, path: secondPath, name: "Second" };
    listMock.mockResolvedValue([sourceV1, sourceB]);

    const { result, rerender } = renderHook(
      ({ sourcePath }) => usePersonaSource(sourcePath),
      { initialProps: { sourcePath: path } },
    );
    await flushPromises();

    act(() => result.current.update({ name: "Unsaved" }));
    rerender({ sourcePath: secondPath });

    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(updateMock).not.toHaveBeenCalled();
    expect(result.current.data?.path).toBe(secondPath);
  });

  it("does not flush a debounced save after unmount", async () => {
    listMock.mockResolvedValue([sourceV1]);
    const { result, unmount } = renderHook(() => usePersonaSource(path));
    await flushPromises();

    act(() => result.current.update({ name: "Unsaved" }));
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    expect(updateMock).not.toHaveBeenCalled();
  });

  it("keeps newer local edits when an older save completes", async () => {
    const firstSave = deferred<typeof sourceV1>();
    listMock.mockResolvedValue([sourceV1]);
    updateMock.mockReturnValueOnce(firstSave.promise);
    const { result } = renderHook(() => usePersonaSource(path));
    await flushPromises();

    act(() => result.current.update({ name: "Sna" }));
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    act(() => result.current.update({ name: "Snark" }));
    expect(result.current.data?.name).toBe("Snark");

    await act(async () => {
      firstSave.resolve({ ...sourceV1, name: "Sna" });
      await firstSave.promise;
    });

    expect(result.current.data?.name).toBe("Snark");
    expect(result.current.saveStatus).toBe("unsaved");
  });

  it("keeps local trailing spaces when a save response trims markdown body whitespace", async () => {
    listMock.mockResolvedValue([sourceV1]);
    updateMock.mockResolvedValue({ ...sourceV1, content: "-" });
    const { result } = renderHook(() => usePersonaSource(path));
    await flushPromises();

    act(() => result.current.update({ content: "- " }));
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    expect(updateMock).toHaveBeenCalledWith(path, { content: "- " });
    expect(result.current.data?.content).toBe("- ");
    expect(result.current.saveStatus).toBe("saved");
  });

  it("gives a new source a short grace period before showing missing", async () => {
    listMock.mockResolvedValue([]);

    const { result } = renderHook(() => usePersonaSource(path));
    await flushPromises();

    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(800 * 4);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.error).toBe("missing");
  });

  it("uses a just-created draft while source listing and file reads catch up", async () => {
    createMock.mockResolvedValue(sessionPlaceholderSource);

    await createDraftAgentSource("sess-1");

    listMock.mockResolvedValue([]);
    readSourceMock.mockRejectedValue(new Error("not flushed"));

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1" }),
    );
    await flushPromises();

    expect(result.current.data).toMatchObject({
      path,
      name: "Untitled agent sess-1",
    });
    expect(result.current.error).toBeNull();
  });

  it("loads a builder draft under StrictMode effect remount checks", async () => {
    listMock.mockResolvedValue([sessionPlaceholderSource]);

    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );
    const { result } = renderHook(
      () => usePersonaSource(path, { builderSessionId: "sess-1" }),
      { wrapper },
    );
    await flushPromises();

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.data).toMatchObject({
      path,
      name: "Untitled agent sess-1",
    });
  });

  it("keeps a just-created draft if source listing flickers after first seeing it", async () => {
    createMock.mockResolvedValue(sessionPlaceholderSource);

    await createDraftAgentSource("sess-1");

    listMock
      .mockResolvedValueOnce([sessionPlaceholderSource])
      .mockResolvedValue([]);
    readSourceMock.mockRejectedValue(new Error("not flushed"));

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1" }),
    );
    await flushPromises();

    expect(result.current.data?.path).toBe(path);

    await act(async () => {
      vi.advanceTimersByTime(800 * 5);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.data).toMatchObject({
      path,
      name: "Untitled agent sess-1",
    });
  });

  it("shows missing after a loaded source is deleted", async () => {
    listMock.mockResolvedValue([sourceV1]);
    const { result } = renderHook(() => usePersonaSource(path));
    await flushPromises();
    expect(result.current.data?.path).toBe(path);

    listMock.mockResolvedValue([]);
    await act(async () => {
      vi.advanceTimersByTime(800 * 5);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.data).toBeNull();
    expect(result.current.error).toBe("missing");
  });

  it("resolves a moved draft by builder session id", async () => {
    listMock.mockResolvedValue([movedSource]);
    const onResolvedPathChange = vi.fn();

    const { result } = renderHook(() =>
      usePersonaSource(path, {
        builderSessionId: "sess-1",
        onResolvedPathChange,
      }),
    );
    await flushPromises();

    expect(result.current.data?.path).toBe(movedSource.path);
    expect(onResolvedPathChange).toHaveBeenCalledWith(movedSource);
    expect(result.current.error).toBeNull();
  });

  it("follows a content-named draft when the original placeholder still exists", async () => {
    listMock.mockResolvedValue([
      sessionPlaceholderSource,
      renamedSessionSource,
    ]);
    const onResolvedPathChange = vi.fn();

    const { result } = renderHook(() =>
      usePersonaSource(path, {
        builderSessionId: "sess-1",
        onResolvedPathChange,
      }),
    );
    await flushPromises();

    expect(result.current.data?.path).toBe(renamedSessionSource.path);
    expect(result.current.data?.name).toBe("Constructive Critic");
    expect(onResolvedPathChange).toHaveBeenCalledWith(renamedSessionSource);
  });

  it("does not reset loading when only the resolved path callback changes", async () => {
    listMock.mockResolvedValue([movedSource]);
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();

    const { result, rerender } = renderHook(
      ({ onResolvedPathChange }) =>
        usePersonaSource(path, {
          builderSessionId: "sess-1",
          onResolvedPathChange,
        }),
      { initialProps: { onResolvedPathChange: firstCallback } },
    );
    await flushPromises();
    expect(result.current.isLoading).toBe(false);
    expect(listMock).toHaveBeenCalledTimes(1);

    rerender({ onResolvedPathChange: secondCallback });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data?.path).toBe(movedSource.path);
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("uses the on-disk draft contents when source listing is stale", async () => {
    const diskSource = {
      ...sourceV1,
      name: "Constructive Critic",
      description: "Challenges assumptions.",
      content: "Push back constructively.",
      properties: { draft: true, builderSessionId: "sess-1" },
    };
    listMock.mockResolvedValue([sessionPlaceholderSource]);
    readSourceMock.mockResolvedValue(diskSource);

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1" }),
    );
    await flushPromises();

    expect(readSourceMock).toHaveBeenCalledWith(
      path,
      expect.objectContaining({ name: "Untitled agent sess-1" }),
    );
    expect(result.current.data?.name).toBe("Constructive Critic");
    expect(result.current.data?.content).toBe("Push back constructively.");
  });

  it("drops stale local edits when an agent updates the draft file", async () => {
    const userSave = deferred<typeof sourceV1>();
    const externalSource = {
      ...sourceV1,
      name: "Project Manager",
      content: "Keep projects clear and moving.",
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        avatar: "app-avatar:gloopies-15",
        provider: "goose",
        model: "databricks-gpt-5-2-codex",
      },
    };
    listMock.mockResolvedValue([sessionPlaceholderSource]);
    readSourceMock.mockResolvedValue(sessionPlaceholderSource);
    updateMock.mockReturnValue(userSave.promise);

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1" }),
    );
    await flushPromises();

    act(() => {
      result.current.update({
        name: "Cheesy",
        content: "Draft in progre",
      });
    });
    expect(result.current.data?.name).toBe("Cheesy");

    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });
    expect(updateMock).toHaveBeenCalledWith(
      path,
      expect.objectContaining({
        name: "Cheesy",
        content: "Draft in progre",
      }),
    );

    listMock.mockResolvedValue([externalSource]);
    readSourceMock.mockResolvedValue(externalSource);
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.data?.name).toBe("Cheesy");

    await act(async () => {
      userSave.resolve({
        ...sessionPlaceholderSource,
        name: "Cheesy",
        content: "Draft in progre",
      });
      await userSave.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.data?.name).toBe("Project Manager");
    expect(result.current.data?.content).toBe(
      "Keep projects clear and moving.",
    );
  });

  it("keeps a newer avatar choice when an older avatar save reaches disk", async () => {
    const firstSave = deferred<typeof sourceV1>();
    const defaultAvatarSource = {
      ...sessionPlaceholderSource,
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        avatar: "app-avatar:gloopies-1",
      },
    };
    const selectedAvatarSource = {
      ...sessionPlaceholderSource,
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        avatar: "app-avatar:gloopies-2",
      },
    };
    listMock.mockResolvedValue([sessionPlaceholderSource]);
    readSourceMock.mockResolvedValue(sessionPlaceholderSource);
    updateMock
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce(selectedAvatarSource);

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1" }),
    );
    await flushPromises();

    act(() => {
      result.current.update({
        properties: { avatar: "app-avatar:gloopies-1" },
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });
    expect(updateMock).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.update({
        properties: { avatar: "app-avatar:gloopies-2" },
      });
    });
    expect(result.current.data?.properties?.avatar).toBe(
      "app-avatar:gloopies-2",
    );

    listMock.mockResolvedValue([defaultAvatarSource]);
    readSourceMock.mockResolvedValue(defaultAvatarSource);
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(result.current.data?.properties?.avatar).toBe(
      "app-avatar:gloopies-2",
    );

    await act(async () => {
      firstSave.resolve(defaultAvatarSource);
      await firstSave.promise;
    });
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    expect(updateMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(updateMock).toHaveBeenLastCalledWith(
      path,
      expect.objectContaining({
        properties: expect.objectContaining({
          avatar: "app-avatar:gloopies-2",
        }),
      }),
    );
  });

  it("saveNow waits for queued avatar changes before returning", async () => {
    const firstSave = deferred<typeof sourceV1>();
    const defaultAvatarSource = {
      ...sessionPlaceholderSource,
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        avatar: "app-avatar:gloopies-1",
      },
    };
    const selectedAvatarSource = {
      ...sessionPlaceholderSource,
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        avatar: "app-avatar:gloopies-2",
      },
    };
    listMock.mockResolvedValue([sessionPlaceholderSource]);
    readSourceMock.mockResolvedValue(sessionPlaceholderSource);
    updateMock
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce(selectedAvatarSource);

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1" }),
    );
    await flushPromises();

    act(() => {
      result.current.update({
        properties: { avatar: "app-avatar:gloopies-1" },
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    act(() => {
      result.current.update({
        properties: { avatar: "app-avatar:gloopies-2" },
      });
    });

    let saveResolved = false;
    let savePromise!: Promise<void>;
    await act(async () => {
      savePromise = result.current.saveNow().then(() => {
        saveResolved = true;
      });
      await Promise.resolve();
    });

    expect(saveResolved).toBe(false);
    expect(updateMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstSave.resolve(defaultAvatarSource);
      await firstSave.promise;
      await savePromise;
    });

    expect(saveResolved).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock).toHaveBeenLastCalledWith(
      path,
      expect.objectContaining({
        properties: expect.objectContaining({
          avatar: "app-avatar:gloopies-2",
        }),
      }),
    );
    expect(result.current.data?.properties?.avatar).toBe(
      "app-avatar:gloopies-2",
    );
  });

  it("saveNow returns false and keeps edits queued when the flush fails", async () => {
    listMock.mockResolvedValue([sourceV1]);
    updateMock.mockRejectedValue(new Error("write failed"));
    const { result } = renderHook(() => usePersonaSource(path));
    await flushPromises();

    act(() => {
      result.current.update({ name: "Snark" });
    });

    let saved = true;
    await act(async () => {
      saved = await result.current.saveNow();
    });

    expect(saved).toBe(false);
    expect(result.current.saveStatus).toBe("error");
    expect(result.current.data?.name).toBe("Snark");
  });

  it("notifies onWritePersisted with the persisted source when saveNow flushes edits", async () => {
    const existingSource = {
      ...sourceV1,
      name: "Code Reviewer",
      content: "Review code carefully.",
      properties: { provider: "openai", model: "gpt-5" },
    };
    const persistedSource = { ...existingSource, name: "Code Reviewer Deluxe" };
    listMock.mockResolvedValue([existingSource]);
    updateMock.mockResolvedValue(persistedSource);
    const onWritePersisted = vi.fn();

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1", onWritePersisted }),
    );
    await flushPromises();

    act(() => result.current.update({ name: "Code Reviewer Deluxe" }));
    expect(onWritePersisted).not.toHaveBeenCalled();

    let saved = false;
    await act(async () => {
      saved = await result.current.saveNow();
    });

    expect(saved).toBe(true);
    expect(onWritePersisted).toHaveBeenCalledTimes(1);
    expect(onWritePersisted).toHaveBeenCalledWith(persistedSource);
  });

  it("does not notify onWritePersisted when saveNow has nothing to flush", async () => {
    const existingSource = {
      ...sourceV1,
      name: "Code Reviewer",
      content: "Review code carefully.",
      properties: {},
    };
    listMock.mockResolvedValue([existingSource]);
    const onWritePersisted = vi.fn();

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1", onWritePersisted }),
    );
    await flushPromises();

    let saved = false;
    await act(async () => {
      saved = await result.current.saveNow();
    });

    expect(saved).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
    expect(onWritePersisted).not.toHaveBeenCalled();
  });

  it("does not notify onWritePersisted when the flush fails", async () => {
    listMock.mockResolvedValue([sourceV1]);
    updateMock.mockRejectedValue(new Error("write failed"));
    const onWritePersisted = vi.fn();

    const { result } = renderHook(() =>
      usePersonaSource(path, { onWritePersisted }),
    );
    await flushPromises();

    act(() => result.current.update({ name: "Snark" }));
    await act(async () => {
      await result.current.saveNow();
    });

    expect(onWritePersisted).not.toHaveBeenCalled();
  });

  it("contains a throwing onWritePersisted observer without re-queuing the persisted write", async () => {
    const persistedSource = { ...sourceV1, name: "Snark" };
    listMock.mockResolvedValue([sourceV1]);
    updateMock.mockResolvedValue(persistedSource);
    const onWritePersisted = vi.fn(() => {
      throw new Error("observer exploded");
    });

    const { result } = renderHook(() =>
      usePersonaSource(path, { onWritePersisted }),
    );
    await flushPromises();

    act(() => result.current.update({ name: "Snark" }));

    let saved = false;
    await act(async () => {
      saved = await result.current.saveNow();
    });

    expect(saved).toBe(true);
    expect(onWritePersisted).toHaveBeenCalledTimes(1);
    expect(result.current.saveStatus).toBe("saved");
    expect(updateMock).toHaveBeenCalledTimes(1);

    // Nothing was merged back into the pending patch: a follow-up flush
    // finds no work, so the durable write is not repeated (and the observer
    // does not hear a second persisted edit).
    await act(async () => {
      saved = await result.current.saveNow();
    });
    expect(saved).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(onWritePersisted).toHaveBeenCalledTimes(1);
  });

  it("notifies onWritePersisted for debounced draft auto-saves", async () => {
    const persistedDraft = { ...sessionPlaceholderSource, name: "Snark" };
    listMock.mockResolvedValue([sessionPlaceholderSource]);
    readSourceMock.mockResolvedValue(sessionPlaceholderSource);
    updateMock.mockResolvedValue(persistedDraft);
    const onWritePersisted = vi.fn();

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1", onWritePersisted }),
    );
    await flushPromises();

    act(() => result.current.update({ name: "Snark" }));
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(onWritePersisted).toHaveBeenCalledTimes(1);
    expect(onWritePersisted).toHaveBeenCalledWith(persistedDraft);
  });

  it("preserves local model and avatar choices when the agent updates text fields", async () => {
    const firstSave = deferred<unknown>();
    const localChoices = {
      provider: "goose",
      model: "databricks-gpt-5-2-codex",
      avatar: "app-avatar:gloopies-15",
    };
    const externalSource = {
      ...sourceV1,
      name: "Project Manager",
      content: "Keep projects clear and moving.",
      properties: { draft: true, builderSessionId: "sess-1" },
    };
    const savedChoicesSource = {
      ...externalSource,
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        ...localChoices,
      },
    };
    listMock.mockResolvedValue([sessionPlaceholderSource]);
    readSourceMock.mockResolvedValue(sessionPlaceholderSource);
    updateMock
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce(savedChoicesSource);

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1" }),
    );
    await flushPromises();

    act(() => {
      result.current.update({ properties: localChoices });
    });
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });
    expect(updateMock).toHaveBeenCalledTimes(1);

    listMock.mockResolvedValue([externalSource]);
    readSourceMock.mockResolvedValue(externalSource);
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.data?.name).toBe("Untitled agent sess-1");
    expect(result.current.data?.properties).toEqual(
      expect.objectContaining(localChoices),
    );

    await act(async () => {
      firstSave.resolve({
        ...sessionPlaceholderSource,
        properties: {
          draft: true,
          builderSessionId: "sess-1",
          ...localChoices,
        },
      });
      await firstSave.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.data?.name).toBe("Project Manager");
    expect(result.current.data?.content).toBe(
      "Keep projects clear and moving.",
    );
    expect(result.current.data?.properties).toEqual(
      expect.objectContaining(localChoices),
    );

    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock).toHaveBeenLastCalledWith(
      path,
      expect.objectContaining({
        properties: expect.objectContaining(localChoices),
      }),
    );
    expect(result.current.data?.name).toBe("Project Manager");
    expect(result.current.data?.properties).toEqual(
      expect.objectContaining(localChoices),
    );
  });

  it("keeps local avatar choices when an agent writes stale avatar frontmatter", async () => {
    const firstSave = deferred<unknown>();
    const selectedAvatar = "app-avatar:gloopies-15";
    const staleAgentSource = {
      ...sourceV1,
      name: "Project Manager",
      content: "Keep projects clear and moving.",
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        avatar: "app-avatar:gloopies-1",
      },
    };
    const savedAvatarSource = {
      ...staleAgentSource,
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        avatar: selectedAvatar,
      },
    };
    listMock.mockResolvedValue([sessionPlaceholderSource]);
    readSourceMock.mockResolvedValue(sessionPlaceholderSource);
    updateMock
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce(savedAvatarSource);

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1" }),
    );
    await flushPromises();

    act(() => {
      result.current.update({ properties: { avatar: selectedAvatar } });
    });
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    listMock.mockResolvedValue([staleAgentSource]);
    readSourceMock.mockResolvedValue(staleAgentSource);
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.data?.name).toBe("Untitled agent sess-1");
    expect(result.current.data?.properties?.avatar).toBe(selectedAvatar);

    await act(async () => {
      firstSave.resolve({
        ...sessionPlaceholderSource,
        properties: {
          draft: true,
          builderSessionId: "sess-1",
          avatar: selectedAvatar,
        },
      });
      await firstSave.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.data?.name).toBe("Project Manager");
    expect(result.current.data?.properties?.avatar).toBe(selectedAvatar);

    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock).toHaveBeenLastCalledWith(
      path,
      expect.objectContaining({
        properties: expect.objectContaining({ avatar: selectedAvatar }),
      }),
    );
  });

  it("re-saves local avatar choices after a later stale agent write", async () => {
    const selectedAvatar = "app-avatar:gloopies-15";
    const selectedAvatarSource = {
      ...sessionPlaceholderSource,
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        avatar: selectedAvatar,
      },
    };
    const staleAgentSource = {
      ...sourceV1,
      name: "Project Manager",
      content: "Keep projects clear and moving.",
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        avatar: "app-avatar:gloopies-1",
      },
    };
    const restoredSource = {
      ...staleAgentSource,
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        avatar: selectedAvatar,
      },
    };
    listMock.mockResolvedValue([sessionPlaceholderSource]);
    readSourceMock.mockResolvedValue(sessionPlaceholderSource);
    updateMock
      .mockResolvedValueOnce(selectedAvatarSource)
      .mockResolvedValueOnce(restoredSource);

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1" }),
    );
    await flushPromises();

    act(() => {
      result.current.update({ properties: { avatar: selectedAvatar } });
    });
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(result.current.data?.properties?.avatar).toBe(selectedAvatar);

    listMock.mockResolvedValue([staleAgentSource]);
    readSourceMock.mockResolvedValue(staleAgentSource);
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.data?.name).toBe("Project Manager");
    expect(result.current.data?.properties?.avatar).toBe(selectedAvatar);

    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock).toHaveBeenLastCalledWith(
      path,
      expect.objectContaining({
        properties: expect.objectContaining({ avatar: selectedAvatar }),
      }),
    );
  });

  it("uses the exact draft file when source listing omits a duplicate-name draft", async () => {
    const diskSource = {
      ...sourceV1,
      name: "Constructive Critic",
      description: "Challenges assumptions.",
      content: "Push back constructively.",
      properties: { draft: true, builderSessionId: "sess-1" },
    };
    listMock.mockResolvedValue([]);
    readSourceMock.mockResolvedValue(diskSource);

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1" }),
    );
    await flushPromises();

    expect(readSourceMock).toHaveBeenCalledWith(path, undefined);
    expect(result.current.data?.name).toBe("Constructive Critic");
    expect(result.current.data?.description).toBe("Challenges assumptions.");
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("keeps the listed draft when the fresh draft file read fails", async () => {
    listMock.mockResolvedValue([sessionPlaceholderSource]);
    readSourceMock.mockRejectedValue(new Error("command unavailable"));

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1" }),
    );
    await flushPromises();

    expect(readSourceMock).toHaveBeenCalledWith(
      path,
      expect.objectContaining({ name: "Untitled agent sess-1" }),
    );
    expect(result.current.error).toBeNull();
    expect(result.current.data).toMatchObject({
      path,
      name: "Untitled agent sess-1",
    });
  });
});
