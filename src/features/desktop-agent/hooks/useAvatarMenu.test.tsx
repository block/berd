import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import type { PendingSelection } from "./useSession";
import { useAvatarMenu } from "./useAvatarMenu";

const mocks = vi.hoisted(() => ({
  listPersonas: vi.fn(),
}));

vi.mock("@/shared/api/agents", () => ({
  listPersonas: () => mocks.listPersonas(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPersonas.mockResolvedValue([
    { id: "a1", displayName: "Scout", systemPrompt: "" },
  ]);
});

function renderMenu(args?: {
  agentSelector?: boolean;
  pendingSelection?: PendingSelection | null;
  activeAgentId?: string | null;
  select?: (selection: PendingSelection | null) => void;
}) {
  return renderHook(() =>
    useAvatarMenu({
      pendingSelection: args?.pendingSelection ?? null,
      activeAgentId: args?.activeAgentId ?? null,
      select: args?.select ?? vi.fn(),
      agentSelector: args?.agentSelector ?? true,
    }),
  );
}

it("skips the persona fetch while the agent selector experiment is off", async () => {
  const { result } = renderMenu({ agentSelector: false });
  const model = await act(() => result.current.prepareMenu());
  expect(mocks.listPersonas).not.toHaveBeenCalled();
  expect(model.agents).toEqual([]);
});

it("lists agents and checks the fresh entry when nothing is armed or committed", async () => {
  const { result } = renderMenu();
  const model = await act(() => result.current.prepareMenu());
  expect(model.agents).toEqual([
    {
      agentId: "a1",
      name: "Scout",
      systemPrompt: "",
      provider: null,
      model: null,
    },
  ]);
  expect(model.checkedFresh).toBe(true);
  expect(model.checkedAgentId).toBeNull();
});

it("falls back to the committed agent for the checkmark when nothing is armed", async () => {
  const { result } = renderMenu({ activeAgentId: "a1" });
  const model = await act(() => result.current.prepareMenu());
  expect(model.checkedAgentId).toBe("a1");
  expect(model.checkedFresh).toBe(false);
});

it("survives a failed persona fetch with an empty list", async () => {
  mocks.listPersonas.mockRejectedValue(new Error("boom"));
  const { result } = renderMenu();
  const model = await act(() => result.current.prepareMenu());
  expect(model.agents).toEqual([]);
  expect(model.checkedFresh).toBe(true);
});

it("arms an agent on select and no-ops when it is already armed", async () => {
  const select = vi.fn();
  const armed: PendingSelection = {
    kind: "agent",
    agent: {
      agentId: "a1",
      name: "Scout",
      systemPrompt: "",
      provider: null,
      model: null,
    },
  };
  const { result, rerender } = renderHook(
    ({ pending }: { pending: PendingSelection | null }) =>
      useAvatarMenu({
        pendingSelection: pending,
        activeAgentId: null,
        select,
        agentSelector: true,
      }),
    { initialProps: { pending: null as PendingSelection | null } },
  );
  await act(() => result.current.prepareMenu());
  act(() => result.current.selectAgent("a1"));
  expect(select).toHaveBeenCalledWith({ kind: "agent", agent: armed.agent });

  select.mockClear();
  rerender({ pending: armed });
  act(() => result.current.selectAgent("a1"));
  expect(select).not.toHaveBeenCalled();
});

it("arms fresh on select and no-ops when fresh is already armed", async () => {
  const select = vi.fn();
  const { result, rerender } = renderHook(
    ({ pending }: { pending: PendingSelection | null }) =>
      useAvatarMenu({
        pendingSelection: pending,
        activeAgentId: "a1",
        select,
        agentSelector: true,
      }),
    { initialProps: { pending: null as PendingSelection | null } },
  );
  act(() => result.current.selectFresh());
  expect(select).toHaveBeenCalledWith({ kind: "fresh" });

  select.mockClear();
  rerender({ pending: { kind: "fresh" } });
  act(() => result.current.selectFresh());
  expect(select).not.toHaveBeenCalled();
});
