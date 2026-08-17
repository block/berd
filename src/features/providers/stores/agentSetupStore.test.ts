import { describe, expect, it, vi } from "vitest";

import type { AgentSetupOperation } from "@/features/providers/api/agentSetup";

const mocks = vi.hoisted(() => ({
  clearAgentSetupStatus: vi.fn(),
  listAgentSetupStatus: vi.fn(),
  onAgentSetupState: vi.fn(),
  startAgentSetup: vi.fn(),
}));

vi.mock("@/features/providers/api/agentSetup", () => ({
  clearAgentSetupStatus: (...args: unknown[]) =>
    mocks.clearAgentSetupStatus(...args),
  listAgentSetupStatus: (...args: unknown[]) =>
    mocks.listAgentSetupStatus(...args),
  onAgentSetupState: (...args: unknown[]) => mocks.onAgentSetupState(...args),
  startAgentSetup: (...args: unknown[]) => mocks.startAgentSetup(...args),
}));

function makeOperation(
  overrides: Partial<AgentSetupOperation> = {},
): AgentSetupOperation {
  return {
    action: "install",
    phase: "installing",
    status: "running",
    output: [],
    error: null,
    ...overrides,
  };
}

describe("useAgentSetupStore", () => {
  it("does not let rehydration overwrite a listener update that arrives during the list request", async () => {
    vi.resetModules();
    vi.clearAllMocks();

    const { useAgentSetupStore } = await import("./agentSetupStore");
    let emitState:
      | ((providerId: string, operation: AgentSetupOperation) => void)
      | undefined;

    const olderRunningSnapshot = makeOperation({
      status: "running",
      output: ["installing"],
    });
    const newerTerminalSnapshot = makeOperation({
      phase: "checking",
      status: "succeeded",
      output: ["installed"],
    });

    mocks.onAgentSetupState.mockImplementation(async (callback) => {
      emitState = callback as typeof emitState;
      return vi.fn();
    });
    mocks.listAgentSetupStatus.mockImplementation(async () => {
      emitState?.("claude-acp", newerTerminalSnapshot);
      return [["claude-acp", olderRunningSnapshot]];
    });

    await useAgentSetupStore.getState().init();

    expect(useAgentSetupStore.getState().getStatus("claude-acp")).toEqual(
      newerTerminalSnapshot,
    );
  });

  it("does not let a start response overwrite a listener update that arrives first", async () => {
    vi.resetModules();
    vi.clearAllMocks();

    const { useAgentSetupStore } = await import("./agentSetupStore");
    let emitState:
      | ((providerId: string, operation: AgentSetupOperation) => void)
      | undefined;

    const seededRunningSnapshot = makeOperation({
      status: "running",
      output: ["installing"],
    });
    const newerTerminalSnapshot = makeOperation({
      phase: "checking",
      status: "succeeded",
      output: ["installed"],
    });

    mocks.onAgentSetupState.mockImplementation(async (callback) => {
      emitState = callback as typeof emitState;
      return vi.fn();
    });
    mocks.listAgentSetupStatus.mockResolvedValue([]);
    mocks.startAgentSetup.mockImplementation(async () => {
      emitState?.("claude-acp", newerTerminalSnapshot);
      return seededRunningSnapshot;
    });

    await useAgentSetupStore.getState().init();
    await useAgentSetupStore.getState().startSetup("claude-acp", "install", {
      installFixType: "command",
      updateFixTypes: [],
      verifyInstall: true,
    });

    expect(useAgentSetupStore.getState().getStatus("claude-acp")).toEqual(
      newerTerminalSnapshot,
    );
  });
});
