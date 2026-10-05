import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { useAvatarMenu } from "./useAvatarMenu";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listPersonas: vi.fn(),
  listeners: new Map<string, () => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: () => void) => {
    mocks.listeners.set(name, handler);
    return () => mocks.listeners.delete(name);
  },
}));
vi.mock("@/shared/api/agents", () => ({
  listPersonas: () => mocks.listPersonas(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.listPersonas.mockResolvedValue([
    { id: "a1", displayName: "Scout", systemPrompt: "" },
  ]);
});

function renderMenu(agentSelector: boolean, dismiss = vi.fn()) {
  return renderHook(() =>
    useAvatarMenu({
      pendingSelection: null,
      activeAgentId: null,
      select: vi.fn(),
      agentSelector,
      dismiss,
    }),
  );
}

it("shows only settings and hide while the agent selector experiment is off", async () => {
  const { result } = renderMenu(false);
  await act(() => result.current.openMenu());
  expect(mocks.listPersonas).not.toHaveBeenCalled();
  expect(mocks.invoke).toHaveBeenCalledWith(
    "desktop_agent_avatar_menu_popup",
    expect.objectContaining({ agentSelector: false, agents: [] }),
  );
});

it("lists agents when the agent selector experiment is on", async () => {
  const { result } = renderMenu(true);
  await act(() => result.current.openMenu());
  expect(mocks.invoke).toHaveBeenCalledWith(
    "desktop_agent_avatar_menu_popup",
    expect.objectContaining({
      agentSelector: true,
      agents: [{ agentId: "a1", name: "Scout" }],
      pendingFresh: true,
    }),
  );
});

it("routes the hide item to dismiss", async () => {
  const dismiss = vi.fn();
  renderMenu(false, dismiss);
  await act(async () => {});
  mocks.listeners.get("desktop-agent:menu-dismiss")?.();
  expect(dismiss).toHaveBeenCalledOnce();
});
