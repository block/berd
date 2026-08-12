import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSessionStore } from "../stores/chatSessionStore";
import {
  acquireSessionDispatchTarget,
  clearSessionTargetSelection,
  getSessionTargetSelection,
  getSessionTargetState,
  hydrateSessionTarget,
  onSessionDispatchReleased,
  observeSessionTargetMetadata,
  observeSessionTargetModelSnapshot,
  recordSessionTargetSelection,
  replaceSessionTargetAfterDispatch,
  resetSessionTargetCoordinatorsForTests,
  transitionSessionTarget,
} from "./sessionTargetCoordinator";

const mockPrepare = vi.fn();
vi.mock("@/shared/api/acp", () => ({
  acpPrepareSession: (...args: unknown[]) => mockPrepare(...args),
}));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const target = (modelId: string) =>
  ({
    harnessId: "goose",
    modelProviderId: "openai",
    modelId,
    modelName: modelId,
  }) as const;

const reasoningEffort = {
  configId: "thinking_effort",
  currentValue: "high",
  options: [{ id: "high", name: "High" }],
};

describe("session target coordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionTargetCoordinatorsForTests();
    useChatSessionStore.setState({
      sessions: [
        {
          id: "s",
          title: "s",
          executionTarget: target("a"),
          executionTargetSource: "ui",
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          messageCount: 0,
        },
      ],
    });
  });

  it("commits the concrete model acknowledged by a provider-only transition", async () => {
    mockPrepare.mockResolvedValue({
      model: { modelId: "claude-default", modelName: "Claude Default" },
      reasoningEffort: null,
    });
    const providerTarget = {
      harnessId: "goose",
      modelProviderId: "anthropic",
    } as const;

    await expect(
      transitionSessionTarget({
        sessionId: "s",
        target: providerTarget,
        workingDir: "/w",
      }),
    ).resolves.toMatchObject({
      status: "committed",
      target: {
        harnessId: "goose",
        modelProviderId: "anthropic",
        modelId: "claude-default",
        modelName: "Claude Default",
      },
      resolvedTarget: {
        modelProviderId: "anthropic",
        modelId: "claude-default",
      },
    });
    expect(getSessionTargetState("s")).toMatchObject({
      status: "settled",
      committed: {
        modelProviderId: "anthropic",
        modelId: "claude-default",
      },
    });
    expect(useChatSessionStore.getState().getSession("s")).toMatchObject({
      executionTarget: {
        modelProviderId: "anthropic",
        modelId: "claude-default",
      },
    });
  });

  it("coalesces work that has not crossed the wire", async () => {
    mockPrepare.mockResolvedValue(undefined);
    const first = transitionSessionTarget({
      sessionId: "s",
      target: target("b"),
      workingDir: "/w",
    });
    const latest = transitionSessionTarget({
      sessionId: "s",
      target: target("c"),
      workingDir: "/w",
    });

    await expect(first).resolves.toMatchObject({ status: "superseded" });
    await expect(latest).resolves.toMatchObject({
      status: "committed",
      target: target("c"),
    });
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(mockPrepare).toHaveBeenCalledWith("s", "openai", "/w", {
      modelId: "c",
    });
  });

  it("prevents an on-wire stale operation from committing over the winner", async () => {
    const wire = deferred();
    mockPrepare
      .mockReturnValueOnce(wire.promise)
      .mockResolvedValueOnce(undefined);
    const first = transitionSessionTarget({
      sessionId: "s",
      target: target("b"),
      workingDir: "/w",
    });
    await vi.waitFor(() => expect(mockPrepare).toHaveBeenCalledTimes(1));
    const latest = transitionSessionTarget({
      sessionId: "s",
      target: target("c"),
      workingDir: "/w",
    });

    wire.resolve();

    await expect(first).resolves.toMatchObject({ status: "superseded" });
    await expect(latest).resolves.toMatchObject({
      status: "committed",
      target: target("c"),
    });
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("c"));
  });

  it("keeps target commit inside the coordinator when a wire snapshot arrives before the promise", async () => {
    const wire = deferred();
    mockPrepare.mockReturnValue(wire.promise);
    recordSessionTargetSelection({
      sessionId: "s",
      operationId: "operation-b",
      target: target("b"),
      previousTarget: target("a"),
    });
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget("s", target("b"));
    const outcome = transitionSessionTarget({
      sessionId: "s",
      target: target("b"),
      workingDir: "/w",
      operationId: "operation-b",
    });
    await vi.waitFor(() => expect(mockPrepare).toHaveBeenCalledOnce());

    expect(
      observeSessionTargetModelSnapshot({
        sessionId: "s",
        snapshot: { modelId: "b", modelName: "B acknowledged" },
        context: {
          origin: "response",
          requestId: "operation-b",
          providerId: "openai",
          modelId: "b",
        },
      }),
    ).toBe(true);
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual({ ...target("b"), modelName: "B acknowledged" });

    wire.resolve();
    await expect(outcome).resolves.toMatchObject({
      status: "committed",
      target: target("b"),
    });
  });

  it.each([
    {
      name: "stale operation",
      context: {
        origin: "response" as const,
        requestId: "operation-old",
        providerId: "openai",
        modelId: "b",
      },
    },
    {
      name: "mismatched provider",
      context: {
        origin: "response" as const,
        requestId: "operation-b",
        providerId: "anthropic",
        modelId: "b",
      },
    },
    {
      name: "mismatched model",
      context: {
        origin: "response" as const,
        requestId: "operation-b",
        providerId: "openai",
        modelId: "c",
      },
    },
  ])("rejects a $name snapshot at the coordinator boundary", ({ context }) => {
    recordSessionTargetSelection({
      sessionId: "s",
      operationId: "operation-b",
      target: target("b"),
      previousTarget: target("a"),
    });
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget("s", target("b"));

    expect(
      observeSessionTargetModelSnapshot({
        sessionId: "s",
        snapshot: { modelId: context.modelId, modelName: context.modelId },
        context,
      }),
    ).toBe(false);
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("b"));
  });

  it("ignores external hydration while on-wire work owns the session", async () => {
    const wire = deferred();
    mockPrepare.mockReturnValueOnce(wire.promise);
    const first = transitionSessionTarget({
      sessionId: "s",
      target: target("b"),
      workingDir: "/w",
    });
    await vi.waitFor(() => expect(mockPrepare).toHaveBeenCalledOnce());

    expect(hydrateSessionTarget("s", target("external"), reasoningEffort)).toBe(
      false,
    );
    wire.resolve();
    await expect(first).resolves.toMatchObject({
      status: "committed",
      target: target("b"),
    });
    expect(getSessionTargetState("s")).toMatchObject({
      status: "settled",
      committed: target("b"),
    });
  });

  it("does not own or persist the working directory", async () => {
    const wire = deferred();
    mockPrepare.mockReturnValue(wire.promise);
    const outcome = transitionSessionTarget({
      sessionId: "s",
      target: target("b"),
      workingDir: "/prepare-only-workspace",
    });
    await vi.waitFor(() => expect(mockPrepare).toHaveBeenCalledOnce());

    wire.resolve();

    await expect(outcome).resolves.toMatchObject({ status: "committed" });
    expect(
      useChatSessionStore.getState().getSession("s")?.workingDir,
    ).toBeUndefined();
  });

  it("returns a failed outcome without changing the committed target", async () => {
    const error = new Error("provider rejected target");
    mockPrepare.mockRejectedValue(error);

    await expect(
      transitionSessionTarget({
        sessionId: "s",
        target: target("b"),
        workingDir: "/w",
      }),
    ).rejects.toBe(error);
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("a"));
    expect(getSessionTargetState("s")).toMatchObject({
      status: "failed",
      desired: target("b"),
      fallback: target("a"),
    });
  });

  it("accepts metadata only from the owning operation and target", async () => {
    const wire = deferred();
    mockPrepare.mockReturnValue(wire.promise);
    const outcome = transitionSessionTarget({
      sessionId: "s",
      target: target("b"),
      workingDir: "/w",
      operationId: "operation-b",
    });
    await vi.waitFor(() => expect(mockPrepare).toHaveBeenCalledOnce());

    expect(
      observeSessionTargetMetadata({
        sessionId: "s",
        operationId: "stale",
        target: target("b"),
        reasoningEffort,
      }),
    ).toBe(false);
    expect(
      observeSessionTargetMetadata({
        sessionId: "s",
        operationId: "operation-b",
        target: target("c"),
        reasoningEffort,
      }),
    ).toBe(false);
    expect(
      observeSessionTargetMetadata({
        sessionId: "s",
        operationId: "operation-b",
        target: target("b"),
        reasoningEffort,
      }),
    ).toBe(true);

    wire.resolve();
    await expect(outcome).resolves.toMatchObject({ status: "committed" });
    expect(getSessionTargetState("s")).toMatchObject({
      status: "settled",
      metadata: { target: target("b"), reasoningEffort },
    });
  });

  it("does not force a queued metadata refresh after an earlier transition restores metadata", async () => {
    const firstWire = deferred<{ reasoningEffort: typeof reasoningEffort }>();
    mockPrepare.mockReturnValueOnce(firstWire.promise);

    const selection = transitionSessionTarget({
      sessionId: "s",
      target: target("b"),
      workingDir: "/w",
      operationId: "selection",
    });
    await vi.waitFor(() => expect(mockPrepare).toHaveBeenCalledOnce());

    const refresh = transitionSessionTarget({
      sessionId: "s",
      target: target("b"),
      workingDir: "/w",
      requireReasoningEffort: true,
    });
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget("s", target("b"));
    useChatSessionStore.getState().patchSession("s", { reasoningEffort });
    firstWire.resolve({ reasoningEffort });

    await expect(selection).resolves.toMatchObject({ status: "superseded" });
    await expect(refresh).resolves.toMatchObject({ status: "committed" });
    expect(mockPrepare).toHaveBeenCalledOnce();
    expect(getSessionTargetState("s")).toMatchObject({
      status: "settled",
      committed: target("b"),
      metadata: { target: target("b"), reasoningEffort },
    });
  });

  it("forces a queued metadata refresh when metadata is still missing", async () => {
    mockPrepare.mockResolvedValue(undefined);

    await transitionSessionTarget({
      sessionId: "s",
      target: target("a"),
      workingDir: "/w",
      requireReasoningEffort: true,
    });

    expect(mockPrepare).toHaveBeenCalledWith("s", "openai", "/w", {
      modelId: "a",
      forceConfigRefresh: true,
    });
  });

  it("defers external hydration until the dispatch lease releases", () => {
    useChatSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        executionTargetSource: "acp" as const,
      })),
    }));
    const lease = acquireSessionDispatchTarget("s");

    expect(hydrateSessionTarget("s", target("b"))).toBe(false);
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("a"));

    lease.release?.();
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("b"));
  });

  it("defers a divergent model snapshot until the dispatch lease releases", () => {
    useChatSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        executionTargetSource: "acp" as const,
      })),
    }));
    const lease = acquireSessionDispatchTarget("s");

    expect(
      observeSessionTargetModelSnapshot({
        sessionId: "s",
        snapshot: { modelId: "b", modelName: "b" },
        context: {
          origin: "response",
          providerId: "openai",
          modelId: "b",
        },
      }),
    ).toBe(false);
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("a"));

    lease.release?.();
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("b"));
  });

  it.each([
    ["ACP page merge", "acp"],
    ["UI rollback", "ui"],
  ] as const)("fences a divergent direct %s store writer until dispatch releases", (_boundary, source) => {
    const lease = acquireSessionDispatchTarget("s");

    useChatSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        executionTarget: target("b"),
        executionTargetSource: source,
      })),
    }));

    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("a"));
    lease.release?.();
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("b"));
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTargetSource,
    ).toBe(source);
  });

  it("materializes a matching provider-only lease without deferring it", () => {
    const providerTarget = {
      harnessId: "goose",
      modelProviderId: "openai",
    } as const;
    useChatSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        executionTarget: providerTarget,
        executionTargetSource: "acp" as const,
      })),
    }));
    const lease = acquireSessionDispatchTarget("s");

    expect(hydrateSessionTarget("s", target("a"))).toBe(true);
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("a"));
    lease.release?.();
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("a"));
  });

  it("defers direct target replacement until the dispatch lease releases", () => {
    const lease = acquireSessionDispatchTarget("s");
    expect(lease?.target).toEqual(target("a"));

    replaceSessionTargetAfterDispatch("s", target("b"));

    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("a"));
    lease.release?.();
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("b"));
  });

  it("keeps the latest user selection ahead of a later external target mutation", () => {
    const lease = acquireSessionDispatchTarget("s");
    recordSessionTargetSelection({
      sessionId: "s",
      operationId: "pick-b",
      target: target("b"),
    });
    replaceSessionTargetAfterDispatch("s", undefined);

    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("a"));
    lease.release?.();
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("a"));
    expect(getSessionTargetSelection("s")).toMatchObject({
      operationId: "pick-b",
      target: target("b"),
    });
  });

  it("keeps a deferred picker intent visible while publishing only after backend apply", async () => {
    const wire = deferred();
    mockPrepare.mockReturnValueOnce(wire.promise);
    const lease = acquireSessionDispatchTarget("s");
    recordSessionTargetSelection({
      sessionId: "s",
      operationId: "pick-b",
      target: target("b"),
      previousTarget: target("a"),
    });

    expect(getSessionTargetSelection("s")).toMatchObject({
      operationId: "pick-b",
      target: target("b"),
    });

    const apply = transitionSessionTarget({
      sessionId: "s",
      target: target("b"),
      workingDir: "/w",
      requestId: "pick-b",
    });
    await Promise.resolve();
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("a"));

    lease.release?.();
    await vi.waitFor(() => expect(mockPrepare).toHaveBeenCalledOnce());
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("a"));
    wire.resolve();
    await expect(apply).resolves.toMatchObject({ status: "committed" });
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("b"));
    expect(clearSessionTargetSelection("s", "pick-b")).toBe(true);
  });

  it("provides a cancellable one-shot contention waiter across release races", async () => {
    const lease = acquireSessionDispatchTarget("s");
    const contention = acquireSessionDispatchTarget("s");
    expect(contention.status).toBe("contended");
    if (contention.status !== "contended") return;

    lease.release?.();
    const released = vi.fn();
    const cancel = contention.waiter.wait(released);
    cancel();
    await Promise.resolve();
    expect(released).not.toHaveBeenCalled();

    const nextLease = acquireSessionDispatchTarget("s");
    const nextContention = acquireSessionDispatchTarget("s");
    expect(nextContention.status).toBe("contended");
    if (nextContention.status !== "contended") return;
    const nextReleased = vi.fn();
    nextContention.waiter.wait(nextReleased);
    nextContention.waiter.wait(nextReleased);
    nextLease.release?.();
    await vi.waitFor(() => expect(nextReleased).toHaveBeenCalledOnce());
  });

  it("notifies release waiters only after a deferred picker transition settles", async () => {
    const wire = deferred();
    mockPrepare.mockReturnValueOnce(wire.promise);
    const lease = acquireSessionDispatchTarget("s");
    recordSessionTargetSelection({
      sessionId: "s",
      operationId: "pick-b",
      target: target("b"),
      previousTarget: target("a"),
    });
    const apply = transitionSessionTarget({
      sessionId: "s",
      target: target("b"),
      workingDir: "/w",
      requestId: "pick-b",
    });
    const released = vi.fn();
    expect(onSessionDispatchReleased("s", released)).not.toBeNull();

    lease.release?.();
    await vi.waitFor(() => expect(mockPrepare).toHaveBeenCalledOnce());
    expect(released).not.toHaveBeenCalled();

    wire.resolve();
    await expect(apply).resolves.toMatchObject({ status: "committed" });
    await vi.waitFor(() => expect(released).toHaveBeenCalledOnce());
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("b"));
  });

  it("keeps local A when deferred picker backend apply fails", async () => {
    const failure = new Error("prepare failed");
    mockPrepare.mockRejectedValueOnce(failure);
    const lease = acquireSessionDispatchTarget("s");
    recordSessionTargetSelection({
      sessionId: "s",
      operationId: "pick-b",
      target: target("b"),
      previousTarget: target("a"),
    });
    const apply = transitionSessionTarget({
      sessionId: "s",
      target: target("b"),
      workingDir: "/w",
      requestId: "pick-b",
    });

    lease.release?.();
    await expect(apply).rejects.toBe(failure);
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("a"));
  });

  it("gives deferred user intent precedence over external observations", async () => {
    mockPrepare.mockResolvedValue(undefined);
    const lease = acquireSessionDispatchTarget("s");
    recordSessionTargetSelection({
      sessionId: "s",
      operationId: "pick-b",
      target: target("b"),
    });
    expect(hydrateSessionTarget("s", target("c"))).toBe(false);

    const apply = transitionSessionTarget({
      sessionId: "s",
      target: target("b"),
      workingDir: "/w",
      requestId: "pick-b",
    });
    lease.release?.();
    await expect(apply).resolves.toMatchObject({ status: "committed" });
    expect(
      useChatSessionStore.getState().getSession("s")?.executionTarget,
    ).toEqual(target("b"));
  });

  it("starts tracking bootstrap actors once their session becomes live", async () => {
    useChatSessionStore.setState({ sessions: [] });
    const bootstrapWire = deferred();
    const liveWire = deferred();
    mockPrepare
      .mockReturnValueOnce(bootstrapWire.promise)
      .mockReturnValueOnce(liveWire.promise);

    const bootstrap = transitionSessionTarget({
      sessionId: "bootstrap",
      target: target("a"),
      workingDir: "/w",
    });
    await vi.waitFor(() => expect(mockPrepare).toHaveBeenCalledOnce());
    bootstrapWire.resolve();
    await expect(bootstrap).resolves.toMatchObject({ status: "committed" });

    useChatSessionStore.setState({
      sessions: [
        {
          id: "bootstrap",
          title: "bootstrap",
          executionTarget: target("a"),
          executionTargetSource: "ui",
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          messageCount: 0,
        },
      ],
    });
    const live = transitionSessionTarget({
      sessionId: "bootstrap",
      target: target("b"),
      workingDir: "/w",
    });
    await vi.waitFor(() => expect(mockPrepare).toHaveBeenCalledTimes(2));

    useChatSessionStore.getState().removeSession("bootstrap");
    liveWire.resolve();

    await expect(live).resolves.toMatchObject({ status: "session-missing" });
  });

  it("settles on-wire and queued operations when the session is removed", async () => {
    const wire = deferred();
    mockPrepare.mockReturnValue(wire.promise);
    const current = transitionSessionTarget({
      sessionId: "s",
      target: target("b"),
      workingDir: "/w",
    });
    await vi.waitFor(() => expect(mockPrepare).toHaveBeenCalledOnce());
    const queued = transitionSessionTarget({
      sessionId: "s",
      target: target("c"),
      workingDir: "/w",
    });

    useChatSessionStore.getState().removeSession("s");

    await expect(current).resolves.toMatchObject({ status: "session-missing" });
    await expect(queued).resolves.toMatchObject({ status: "session-missing" });
    expect(useChatSessionStore.getState().getSession("s")).toBeUndefined();
  });

  it("invalidates an on-wire operation when the session is removed", async () => {
    const wire = deferred();
    mockPrepare.mockReturnValue(wire.promise);
    const outcome = transitionSessionTarget({
      sessionId: "s",
      target: target("b"),
      workingDir: "/w",
    });
    await vi.waitFor(() => expect(mockPrepare).toHaveBeenCalledOnce());

    useChatSessionStore.getState().removeSession("s");
    wire.resolve();

    await expect(outcome).resolves.toMatchObject({ status: "session-missing" });
    expect(useChatSessionStore.getState().getSession("s")).toBeUndefined();
  });

  it("owns pending selection metadata outside the chat session store", async () => {
    const {
      recordSessionTargetSelection,
      getSessionTargetSelection,
      clearSessionTargetSelection,
    } = await import("./sessionTargetCoordinator");
    recordSessionTargetSelection({
      sessionId: "selection",
      operationId: "op-1",
      target: target("b"),
      previousTarget: target("a"),
      preferenceAgentId: "goose",
    });

    expect(getSessionTargetSelection("selection")).toMatchObject({
      operationId: "op-1",
      target: target("b"),
      previousTarget: target("a"),
      preferenceAgentId: "goose",
    });
    expect(clearSessionTargetSelection("selection", "stale")).toBe(false);
    expect(clearSessionTargetSelection("selection", "op-1")).toBe(true);
    expect(getSessionTargetSelection("selection")).toBeUndefined();
  });

  it("settles pending draft work when ownership transfers to an existing backend actor", async () => {
    const { transferSessionTargetOwnership, hydrateSessionTarget } =
      await import("./sessionTargetCoordinator");
    const wire = deferred();
    mockPrepare.mockReturnValueOnce(wire.promise);
    useChatSessionStore.setState((state) => ({
      sessions: [
        ...state.sessions,
        {
          ...state.sessions[0],
          id: "draft",
          title: "draft",
        },
        {
          ...state.sessions[0],
          id: "backend",
          title: "backend",
        },
      ],
    }));
    const pending = transitionSessionTarget({
      sessionId: "draft",
      target: target("b"),
      workingDir: "/w",
    });
    await vi.waitFor(() => expect(mockPrepare).toHaveBeenCalledOnce());
    hydrateSessionTarget("backend", target("a"));

    transferSessionTargetOwnership("draft", "backend");

    await expect(pending).resolves.toMatchObject({
      status: "superseded",
      applied: false,
    });
    expect(getSessionTargetState("backend")).toMatchObject({
      status: "settled",
      committed: target("a"),
    });
    wire.resolve();
  });

  it("preserves an existing backend actor while transferring draft selection", async () => {
    const {
      recordSessionTargetSelection,
      getSessionTargetSelection,
      transferSessionTargetOwnership,
    } = await import("./sessionTargetCoordinator");
    recordSessionTargetSelection({
      sessionId: "backend",
      operationId: "op-backend",
      target: target("a"),
    });
    recordSessionTargetSelection({
      sessionId: "draft",
      operationId: "op-draft",
      target: target("b"),
    });

    transferSessionTargetOwnership("draft", "backend");

    expect(getSessionTargetSelection("draft")).toBeUndefined();
    expect(getSessionTargetSelection("backend")).toMatchObject({
      operationId: "op-backend",
      target: target("a"),
    });
  });

  it("transfers pending selection ownership from a draft id", async () => {
    const {
      recordSessionTargetSelection,
      getSessionTargetSelection,
      transferSessionTargetOwnership,
    } = await import("./sessionTargetCoordinator");
    recordSessionTargetSelection({
      sessionId: "draft",
      operationId: "op-draft",
      target: target("b"),
    });

    transferSessionTargetOwnership("draft", "backend");

    expect(getSessionTargetSelection("draft")).toBeUndefined();
    expect(getSessionTargetSelection("backend")).toMatchObject({
      operationId: "op-draft",
      target: target("b"),
    });
  });
});
