import { describe, expect, it, vi } from "vitest";

import type { ModelSetupOperation } from "@/features/providers/api/modelSetup";

const mocks = vi.hoisted(() => ({
  clearModelSetupStatus: vi.fn(),
  listModelSetupStatus: vi.fn(),
  onModelSetupState: vi.fn(),
  startModelSetup: vi.fn(),
}));

vi.mock("@/features/providers/api/modelSetup", () => ({
  clearModelSetupStatus: (...args: unknown[]) =>
    mocks.clearModelSetupStatus(...args),
  listModelSetupStatus: (...args: unknown[]) =>
    mocks.listModelSetupStatus(...args),
  onModelSetupState: (...args: unknown[]) => mocks.onModelSetupState(...args),
  startModelSetup: (...args: unknown[]) => mocks.startModelSetup(...args),
}));

function makeOperation(
  overrides: Partial<ModelSetupOperation> = {},
): ModelSetupOperation {
  return {
    phase: "authenticating",
    status: "running",
    output: [],
    error: null,
    ...overrides,
  };
}

describe("useModelSetupStore", () => {
  it("does not let rehydration overwrite a listener update that arrives during the list request", async () => {
    vi.resetModules();
    vi.clearAllMocks();

    const { useModelSetupStore } = await import("./modelSetupStore");
    let emitState:
      | ((providerId: string, operation: ModelSetupOperation) => void)
      | undefined;

    const olderRunningSnapshot = makeOperation({
      status: "running",
      output: ["authenticating"],
    });
    const newerTerminalSnapshot = makeOperation({
      phase: "idle",
      status: "succeeded",
      output: ["connected"],
    });

    mocks.onModelSetupState.mockImplementation(async (callback) => {
      emitState = callback as typeof emitState;
      return vi.fn();
    });
    mocks.listModelSetupStatus.mockImplementation(async () => {
      emitState?.("databricks", newerTerminalSnapshot);
      return [["databricks", olderRunningSnapshot]];
    });

    await useModelSetupStore.getState().init();

    expect(useModelSetupStore.getState().getStatus("databricks")).toEqual(
      newerTerminalSnapshot,
    );
  });

  it("does not let a start response overwrite a listener update that arrives first", async () => {
    vi.resetModules();
    vi.clearAllMocks();

    const { useModelSetupStore } = await import("./modelSetupStore");
    let emitState:
      | ((providerId: string, operation: ModelSetupOperation) => void)
      | undefined;

    const seededRunningSnapshot = makeOperation({
      status: "running",
      output: ["authenticating"],
    });
    const newerTerminalSnapshot = makeOperation({
      phase: "idle",
      status: "succeeded",
      output: ["connected"],
    });

    mocks.onModelSetupState.mockImplementation(async (callback) => {
      emitState = callback as typeof emitState;
      return vi.fn();
    });
    mocks.listModelSetupStatus.mockResolvedValue([]);
    mocks.startModelSetup.mockImplementation(async () => {
      emitState?.("databricks", newerTerminalSnapshot);
      return seededRunningSnapshot;
    });

    await useModelSetupStore.getState().init();
    await useModelSetupStore.getState().startSetup("databricks", {
      providerLabel: "databricks",
    });

    expect(useModelSetupStore.getState().getStatus("databricks")).toEqual(
      newerTerminalSnapshot,
    );
  });
});
