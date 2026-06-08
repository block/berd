import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSetModel = vi.fn();
const mockSetProvider = vi.fn();
const mockUpdateWorkingDir = vi.fn();
const mockLoadSession = vi.fn();

vi.mock("../acpApi", () => ({
  setModel: (...args: unknown[]) => mockSetModel(...args),
  setProvider: (...args: unknown[]) => mockSetProvider(...args),
  updateWorkingDir: (...args: unknown[]) => mockUpdateWorkingDir(...args),
  loadSession: (...args: unknown[]) => mockLoadSession(...args),
}));

async function importRegistry() {
  return import("../acpSessionRegistry");
}

describe("applySessionModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockSetModel.mockResolvedValue(undefined);
    mockSetProvider.mockResolvedValue(undefined);
    mockUpdateWorkingDir.mockResolvedValue(undefined);
    mockLoadSession.mockResolvedValue(undefined);
  });

  it("sends setModel over the wire and records it for the session", async () => {
    const registry = await importRegistry();
    registry.registerPreparedSession("session-1", "codex-acp", "/project");

    await registry.applySessionModel("session-1", "gpt-5.5");

    expect(mockSetModel).toHaveBeenCalledTimes(1);
    expect(mockSetModel).toHaveBeenCalledWith("session-1", "gpt-5.5");
  });

  it("skips the wire call when the same model is re-applied", async () => {
    const registry = await importRegistry();
    registry.registerPreparedSession("session-1", "codex-acp", "/project");

    await registry.applySessionModel("session-1", "gpt-5.5");
    await registry.applySessionModel("session-1", "gpt-5.5");
    await registry.applySessionModel("session-1", "gpt-5.5");

    expect(mockSetModel).toHaveBeenCalledTimes(1);
  });

  it("sends setModel again when the model actually changes", async () => {
    const registry = await importRegistry();
    registry.registerPreparedSession("session-1", "codex-acp", "/project");

    await registry.applySessionModel("session-1", "gpt-5.5");
    await registry.applySessionModel("session-1", "gpt-5.4");

    expect(mockSetModel).toHaveBeenCalledTimes(2);
    expect(mockSetModel).toHaveBeenLastCalledWith("session-1", "gpt-5.4");
  });

  it("retries over the wire after a failed setModel", async () => {
    const registry = await importRegistry();
    registry.registerPreparedSession("session-1", "codex-acp", "/project");

    await registry.applySessionModel("session-1", "gpt-5.5");

    mockSetModel.mockRejectedValueOnce(new Error("backend rejected model"));
    await expect(
      registry.applySessionModel("session-1", "gpt-5.4"),
    ).rejects.toThrow("backend rejected model");

    // The failure cleared the cached model, so re-applying the previously
    // successful model must go back over the wire instead of being skipped.
    await registry.applySessionModel("session-1", "gpt-5.5");
    expect(mockSetModel).toHaveBeenCalledTimes(3);
    expect(mockSetModel).toHaveBeenLastCalledWith("session-1", "gpt-5.5");
  });

  it("clears the cached model when the provider changes", async () => {
    const registry = await importRegistry();
    registry.registerPreparedSession("session-1", "codex-acp", "/project");

    await registry.applySessionModel("session-1", "gpt-5.5");
    expect(mockSetModel).toHaveBeenCalledTimes(1);

    // Provider change rebuilds the backend provider with its default model,
    // so the cached model id no longer reflects backend state.
    await registry.prepareSession("session-1", "claude-acp", "/project");
    expect(mockSetProvider).toHaveBeenCalledWith("session-1", "claude-acp");

    await registry.applySessionModel("session-1", "gpt-5.5");
    expect(mockSetModel).toHaveBeenCalledTimes(2);
  });

  it("keeps the cached model across a no-op prepareSession reuse", async () => {
    const registry = await importRegistry();
    registry.registerPreparedSession("session-1", "codex-acp", "/project");

    await registry.applySessionModel("session-1", "gpt-5.5");
    await registry.prepareSession("session-1", "codex-acp", "/project");
    await registry.applySessionModel("session-1", "gpt-5.5");

    expect(mockSetModel).toHaveBeenCalledTimes(1);
    expect(mockSetProvider).not.toHaveBeenCalled();
  });

  it("does not cache when the session was never prepared", async () => {
    const registry = await importRegistry();

    await registry.applySessionModel("session-unprepared", "gpt-5.5");
    await registry.applySessionModel("session-unprepared", "gpt-5.5");

    // Without a registry entry there is nowhere safe to record the applied
    // model, so each apply goes over the wire.
    expect(mockSetModel).toHaveBeenCalledTimes(2);
  });
});
