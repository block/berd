import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startPrivateVoiceDraft } from "./privateVoiceDraft";
const mocks = vi.hoisted(() => ({
  forkSession: vi.fn(),
  newSession: vi.fn(),
  getSessionInfo: vi.fn(),
  setModel: vi.fn(),
  setSessionMode: vi.fn(),
  prompt: vi.fn(),
  cancelSession: vi.fn(),
  deleteSession: vi.fn(),
  hide: vi.fn(),
  intercept: vi.fn(),
}));
vi.mock("@/shared/api/acpApi", () => mocks);
vi.mock("@/shared/api/acpConnection", () => ({
  hidePrivateSessionNotifications: mocks.hide,
  interceptSessionNotifications: mocks.intercept,
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.getSessionInfo.mockResolvedValue({
    providerId: "openai",
    modelId: "configured-model",
  });
  mocks.newSession.mockResolvedValue({ sessionId: "private" });
  mocks.setModel.mockResolvedValue(undefined);
  mocks.setSessionMode.mockResolvedValue(undefined);
  mocks.prompt.mockResolvedValue(undefined);
  mocks.cancelSession.mockResolvedValue(undefined);
  mocks.deleteSession.mockResolvedValue(undefined);
  mocks.intercept.mockReturnValue(vi.fn());
});
afterEach(() => vi.useRealTimers());
it("awaits chat mode before first prompt and captures only private text", async () => {
  const mode = deferred<void>();
  mocks.setSessionMode.mockReturnValue(mode.promise);
  mocks.prompt.mockImplementation(async () => {
    mocks.intercept.mock.calls[0][0]({
      sessionId: "private",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Draft" },
      },
    });
  });
  const draft = startPrivateVoiceDraft("main", "/work", "interim");
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.setSessionMode).toHaveBeenCalledWith("private", "chat");
  expect(mocks.prompt).not.toHaveBeenCalled();
  mode.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(await draft.take()).toBe("Draft");
  expect(mocks.forkSession).not.toHaveBeenCalled();
  expect(mocks.getSessionInfo).toHaveBeenCalledWith("main");
  expect(mocks.newSession).toHaveBeenCalledWith("/work", {
    hidden: true,
    providerId: "openai",
    backendId: "local",
  });
  expect(mocks.setModel).toHaveBeenCalledWith("private", "configured-model");
  expect(mocks.prompt).toHaveBeenCalledWith("private", [
    { type: "text", text: "interim" },
  ]);
  expect(mocks.cancelSession).toHaveBeenCalledWith("private");
});
it("fails closed when chat mode is rejected", async () => {
  mocks.setSessionMode.mockRejectedValue(new Error("unsupported"));
  const draft = startPrivateVoiceDraft("main", "/work", "interim");
  await expect(draft.take()).resolves.toBeNull();
  expect(mocks.prompt).not.toHaveBeenCalled();
});
it.each([
  "creation",
  "mode",
  "prompt",
])("bounds stalled %s and cancellation without touching main", async (stage) => {
  const stalled = deferred<never>();
  mocks[
    stage === "creation"
      ? "newSession"
      : stage === "mode"
        ? "setSessionMode"
        : "prompt"
  ].mockReturnValue(stalled.promise);
  mocks.cancelSession.mockReturnValue(stalled.promise);
  mocks.deleteSession.mockReturnValue(stalled.promise);
  const draft = startPrivateVoiceDraft("main", "/work", "interim");
  const taken = draft.take();
  await vi.advanceTimersByTimeAsync(750);
  expect(await taken).toBeNull();
  expect(mocks.cancelSession.mock.calls.every(([id]) => id === "private")).toBe(
    true,
  );
  if (stage !== "prompt") expect(mocks.prompt).not.toHaveBeenCalled();
});
it("bounds best effort setup and cleans a private session created after disposal", async () => {
  const creation = deferred<{ sessionId: string }>();
  mocks.newSession.mockReturnValue(creation.promise);
  startPrivateVoiceDraft("main", "/work", "interim");
  await vi.advanceTimersByTimeAsync(2000);
  creation.resolve({ sessionId: "late-private" });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.cancelSession).toHaveBeenCalledWith("late-private");
  expect(mocks.hide).toHaveBeenCalledWith("late-private");
  expect(mocks.setSessionMode).not.toHaveBeenCalled();
  expect(mocks.prompt).not.toHaveBeenCalled();
});
it("never prompts after a timed out mode ack", async () => {
  const mode = deferred<void>();
  mocks.setSessionMode.mockReturnValue(mode.promise);
  startPrivateVoiceDraft("main", "/work", "interim");
  await vi.advanceTimersByTimeAsync(2000);
  mode.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.prompt).not.toHaveBeenCalled();
});

it.each([
  { providerId: null, modelId: "model" },
  { providerId: "openai", modelId: null },
])("fails closed without configured provider/model: %o", async (config) => {
  mocks.getSessionInfo.mockResolvedValue(config);
  const draft = startPrivateVoiceDraft("main", "/work", "interim");
  await expect(draft.take()).resolves.toBeNull();
  expect(mocks.newSession).not.toHaveBeenCalled();
  expect(mocks.forkSession).not.toHaveBeenCalled();
  expect(mocks.prompt).not.toHaveBeenCalled();
});
it("fails closed on model configuration failure", async () => {
  mocks.setModel.mockRejectedValue(new Error("unavailable"));
  await expect(
    startPrivateVoiceDraft("main", "/work", "interim").take(),
  ).resolves.toBeNull();
  expect(mocks.prompt).not.toHaveBeenCalled();
});
