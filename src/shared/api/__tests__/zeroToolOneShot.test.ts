import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  interceptSessionNotifications: vi.fn(() => vi.fn()),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: mocks.getClient,
  getBackendClient: mocks.getClient,
  interceptSessionNotifications: mocks.interceptSessionNotifications,
}));

vi.mock("@/shared/api/acpSessionBackends", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acpSessionBackends")>();
  return {
    ...actual,
    getClientForSession: mocks.getClient,
  };
});

import { runZeroToolOneShot } from "../zeroToolOneShot";

function mockClient(extensions: string[] = []) {
  const remove = vi.fn(async () => undefined);
  const client = {
    newSession: vi.fn(async () => ({ sessionId: "hidden-session" })),
    prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    cancel: vi.fn(async () => undefined),
    extMethod: vi.fn(async (_method?: string, _params?: unknown) => undefined),
    setSessionConfigOption: vi.fn(async () => ({})),
    goose: {
      GooseUnstableSessionExtensionsList: vi.fn(async () => ({
        extensions: extensions.map((extensionKey) => ({ extensionKey })),
      })),
      GooseUnstableSessionExtensionsRemove: remove,
    },
  };
  mocks.getClient.mockResolvedValue(client);
  return { client, remove };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mockClient();
});

describe("runZeroToolOneShot", () => {
  it("creates a hidden zero-tool session, prompts, cancels, and deletes it", async () => {
    const { client, remove } = mockClient(["developer", "scheduler"]);

    await expect(
      runZeroToolOneShot({
        userPrompt: "extract",
        systemPrompt: "rules",
        target: { providerId: "test-provider", modelId: "model-1" },
        timeoutMs: 1000,
      }),
    ).resolves.toBeNull();

    expect(client.newSession).toHaveBeenCalledWith({
      cwd: "/tmp",
      mcpServers: [],
      _meta: { hidden: true, provider: "test-provider" },
    });
    expect(client.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "hidden-session",
      configId: "model",
      value: "model-1",
    });
    expect(remove).toHaveBeenCalledTimes(2);
    expect(client.extMethod).toHaveBeenCalledWith(
      "_goose/unstable/session/system-prompt/set",
      {
        sessionId: "hidden-session",
        mode: "set",
        text: "rules",
      },
    );
    expect(client.prompt).toHaveBeenCalledWith({
      sessionId: "hidden-session",
      prompt: [{ type: "text", text: "extract" }],
      _meta: undefined,
    });
    expect(client.cancel).toHaveBeenCalledWith({ sessionId: "hidden-session" });
    expect(client.extMethod).toHaveBeenCalledWith("session/delete", {
      sessionId: "hidden-session",
    });
  });

  it("fails best-effort when setup fails without prompting", async () => {
    const { client } = mockClient();
    client.extMethod.mockImplementation(async (method?: string) => {
      if (method === "_goose/unstable/session/system-prompt/set") {
        throw new Error("boom");
      }
    });

    await expect(
      runZeroToolOneShot({
        userPrompt: "extract",
        systemPrompt: "rules",
        target: { providerId: "test-provider", modelId: "model-1" },
        timeoutMs: 1000,
      }),
    ).resolves.toBeNull();

    expect(client.prompt).not.toHaveBeenCalled();
    expect(client.cancel).toHaveBeenCalledWith({ sessionId: "hidden-session" });
    expect(client.extMethod).toHaveBeenCalledWith("session/delete", {
      sessionId: "hidden-session",
    });
  });

  it("bounds session creation so foreground chat cannot be held by a hung setup", async () => {
    vi.useFakeTimers();
    const { client } = mockClient();
    client.newSession.mockReturnValue(new Promise(() => {}));

    const result = runZeroToolOneShot({
      userPrompt: "extract",
      systemPrompt: "rules",
      target: { providerId: "test-provider" },
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(120);

    await expect(result).resolves.toBeNull();
    expect(client.prompt).not.toHaveBeenCalled();
    expect(client.extMethod).not.toHaveBeenCalled();
  });

  it("cleans up a hidden session if creation resolves after timeout", async () => {
    vi.useFakeTimers();
    const { client } = mockClient();
    let resolveSession: ((value: { sessionId: string }) => void) | undefined;
    client.newSession.mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );

    const result = runZeroToolOneShot({
      userPrompt: "extract",
      systemPrompt: "rules",
      target: { providerId: "test-provider" },
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(120);
    await expect(result).resolves.toBeNull();

    resolveSession?.({ sessionId: "late-session" });
    await vi.runOnlyPendingTimersAsync();

    expect(client.cancel).toHaveBeenCalledWith({ sessionId: "late-session" });
    expect(client.extMethod).toHaveBeenCalledWith("session/delete", {
      sessionId: "late-session",
    });
    expect(client.prompt).not.toHaveBeenCalled();
  });

  it("observes setup after timeout so late rejection cannot leak", async () => {
    vi.useFakeTimers();
    const { client } = mockClient();
    let rejectSetup: ((reason?: unknown) => void) | undefined;
    client.extMethod.mockImplementation(async (method?: string) => {
      if (method === "_goose/unstable/session/system-prompt/set") {
        return new Promise((_, reject) => {
          rejectSetup = reject;
        });
      }
    });

    const result = runZeroToolOneShot({
      userPrompt: "extract",
      systemPrompt: "rules",
      target: { providerId: "test-provider" },
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(120);
    await expect(result).resolves.toBeNull();

    rejectSetup?.(new Error("late setup failure"));
    await Promise.resolve();

    expect(client.prompt).not.toHaveBeenCalled();
    expect(client.extMethod).toHaveBeenCalledWith("session/delete", {
      sessionId: "hidden-session",
    });
  });

  it("bounds cleanup after prompt timeout", async () => {
    vi.useFakeTimers();
    const { client } = mockClient();
    client.prompt.mockReturnValue(new Promise(() => {}));
    client.cancel.mockReturnValue(new Promise(() => {}));

    const result = runZeroToolOneShot({
      userPrompt: "extract",
      systemPrompt: "rules",
      target: { providerId: "test-provider" },
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(3_100);

    await expect(result).resolves.toBeNull();
    expect(client.cancel).toHaveBeenCalledWith({ sessionId: "hidden-session" });
    expect(client.extMethod).toHaveBeenCalledWith("session/delete", {
      sessionId: "hidden-session",
    });
  });
});
