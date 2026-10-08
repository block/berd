import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DesktopAgentApp } from "@/features/desktop-agent/ui/DesktopAgentApp";

const mocks = vi.hoisted(() => ({
  avatar: {
    isBerdy: true,
    choice: {
      src: "default",
      id: "default",
      kind: "video",
      shape: "circle",
      label: "Default",
    },
  },
  perch: {
    phase: "unperched",
    dismount: vi.fn(),
    beginTargeting: vi.fn(),
    endTargetingAndMaybePerch: vi.fn(),
    cancelTargeting: vi.fn(async () => {}),
  },
  port: {
    restore: vi.fn(async () => {}),
    onDragStarted: vi.fn(),
    onDragEnded: vi.fn(),
    onDragEndedPerched: vi.fn(),
    mode: "avatar",
    computeExpanded: vi.fn(),
    applyExpanded: vi.fn(),
    computeMenu: vi.fn(),
    applyMenu: vi.fn(),
    collapse: vi.fn(),
  },
  agentId: null as string | null,
  openMenu: vi.fn(),
  invoke: vi.fn(async () => undefined),
  avatarProps: {} as Record<string, unknown>,
}));
vi.mock("@/features/desktop-agent/lib/panelState", () => ({
  PanelStateMachine: class {
    constructor() {
      Object.assign(this, mocks.port);
    }
    get mode() {
      return mocks.port.mode;
    }
    set mode(value: string) {
      mocks.port.mode = value;
    }
  },
}));
vi.mock("@/features/desktop-agent/lib/tauriWindowPort", () => ({
  LocalStoragePositionStore: class {},
  TauriWindowPort: class {},
}));
vi.mock("@/features/desktop-agent/hooks/useAgentAvatar", () => ({
  useAgentAvatar: () => mocks.avatar,
}));
vi.mock("@/features/desktop-agent/hooks/usePerch", () => ({
  usePerch: () => mocks.perch,
}));
vi.mock("@/features/desktop-agent/hooks/useSession", () => ({
  useSession: () => ({
    messages: [],
    pendingSelection: null,
    activeAgentId: mocks.agentId,
    attached: true,
    activity: "idle",
  }),
}));
vi.mock("@/features/desktop-agent/hooks/useAvatarMenu", () => ({
  useAvatarMenu: () => ({
    prepareMenu: mocks.openMenu,
    selectAgent: vi.fn(),
    selectFresh: vi.fn(),
  }),
}));
vi.mock("@/features/desktop-agent/ui/AgentAvatar", () => ({
  AgentAvatar: (props: Record<string, unknown>) => {
    mocks.avatarProps = props;
    return <span data-testid="avatar" />;
  },
}));
vi.mock("@/features/desktop-agent/ui/ChatPopover", () => ({
  ChatPopover: () => null,
}));
vi.mock("@/features/experiments/experimentPreferences", () => ({
  useExperiment: () => ({ enabled: true, config: {} }),
}));
vi.mock("@/features/desktop-agent/lib/desktopAgentPreferences", () => ({
  setDesktopAgentEnabled: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("PointerEvent", MouseEvent);
  mocks.agentId = null;
  mocks.port.mode = "avatar";
  mocks.port.computeExpanded.mockResolvedValue({
    avatarRect: { x: 0, y: 0, width: 94, height: 94 },
    popoverRect: { x: 94, y: 0, width: 300, height: 400 },
  });
  mocks.port.applyExpanded.mockImplementation(async () => {
    mocks.port.mode = "expanded";
  });
  mocks.port.collapse.mockImplementation(async () => {
    mocks.port.mode = "avatar";
  });
  mocks.avatar.isBerdy = true;
  mocks.openMenu.mockResolvedValue({
    agents: [],
    checkedAgentId: null,
    checkedFresh: true,
  });
  mocks.port.computeMenu.mockResolvedValue({
    avatarRect: { x: 42, y: 17, width: 94, height: 94 },
    popoverRect: { x: 136, y: 17, width: 438, height: 96 },
    windowFrame: { x: 0, y: 0, width: 574, height: 130 },
    popoverAbove: false,
  });
  mocks.port.applyMenu.mockImplementation(async () => {
    mocks.port.mode = "menu";
  });
  mocks.perch.phase = "unperched";
  mocks.perch.endTargetingAndMaybePerch.mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("animates only a positively identified Berdy, and forwards hide and perch state", async () => {
  const { rerender, findByTestId } = render(<DesktopAgentApp />);
  await findByTestId("avatar");
  expect(mocks.avatarProps.character).toBe(true);
  mocks.avatar.isBerdy = false;
  rerender(<DesktopAgentApp />);
  expect(mocks.avatarProps.character).toBe(false);
  mocks.avatar.isBerdy = true;
  mocks.perch.phase = "targeting";
  rerender(<DesktopAgentApp />);
  expect(mocks.avatarProps.target).toBe("dangle");
  mocks.perch.phase = "perched";
  rerender(<DesktopAgentApp />);
  expect(mocks.avatarProps.target).toBe("sit");
  // Hidden only flips via the menu's "Hide agent" dismiss path now (the
  // separate visible preference is gone).
  expect(mocks.avatarProps.hidden).toBe(false);
  mocks.perch.phase = "unperched";
  rerender(<DesktopAgentApp />);
  expect(mocks.avatarProps.target).toBe("idle");
});

it("positions the avatar from menu layout while the menu is open", async () => {
  const { findByTestId } = render(<DesktopAgentApp />);
  const hit = (await findByTestId("avatar")).parentElement;
  if (!hit) throw new Error("missing hit target");

  await act(async () => fireEvent.contextMenu(hit));

  expect(mocks.port.applyMenu).toHaveBeenCalledOnce();
  expect(hit.style.left).toBe("42px");
  expect(hit.style.top).toBe("17px");
});

it("ignores a second right-click while menu preparation is in flight", async () => {
  let resolve!: (value: {
    agents: [];
    checkedAgentId: null;
    checkedFresh: true;
  }) => void;
  mocks.openMenu.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const { findByTestId } = render(<DesktopAgentApp />);
  const hit = (await findByTestId("avatar")).parentElement;
  if (!hit) throw new Error("missing hit target");

  fireEvent.contextMenu(hit);
  fireEvent.contextMenu(hit);
  expect(mocks.openMenu).toHaveBeenCalledOnce();

  await act(async () =>
    resolve({ agents: [], checkedAgentId: null, checkedFresh: true }),
  );
  expect(mocks.port.applyMenu).toHaveBeenCalledOnce();
});

it("cancels an in-flight menu open when Escape changes generation", async () => {
  let resolve!: (value: {
    agents: [];
    checkedAgentId: null;
    checkedFresh: true;
  }) => void;
  mocks.openMenu.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const { findByTestId } = render(<DesktopAgentApp />);
  const hit = (await findByTestId("avatar")).parentElement;
  if (!hit) throw new Error("missing hit target");

  fireEvent.contextMenu(hit);
  fireEvent.keyDown(window, { key: "Escape" });
  await act(async () =>
    resolve({ agents: [], checkedAgentId: null, checkedFresh: true }),
  );

  expect(mocks.port.computeMenu).not.toHaveBeenCalled();
  expect(mocks.port.applyMenu).not.toHaveBeenCalled();
});

it("native drag slop changes target, not DOM position, and drop returns to idle", async () => {
  // jsdom has no PointerEvent; MouseEvent supplies the coordinates React reads.
  vi.stubGlobal("PointerEvent", MouseEvent);
  const { findByTestId } = render(<DesktopAgentApp />);
  const hit = (await findByTestId("avatar")).parentElement;
  if (!hit) throw new Error("missing hit target");
  fireEvent.pointerDown(hit, { button: 0, screenX: 10, screenY: 10 });
  fireEvent.pointerMove(hit, { screenX: 12, screenY: 10 });
  expect(mocks.avatarProps.target).toBe("idle");
  fireEvent.pointerMove(hit, { screenX: 15, screenY: 10 });
  expect(mocks.avatarProps.target).toBe("dangle");
  expect(mocks.port.onDragStarted).toHaveBeenCalled();
  expect(hit.style.left).toBe("0px");
  await act(async () => fireEvent.pointerUp(hit));
  await waitFor(() => expect(mocks.port.onDragEndedPerched).toHaveBeenCalled());
  expect(mocks.avatarProps.target).toBe("idle");
  vi.unstubAllGlobals();
});

it("a clean pointer-up expands once without the subsequent click collapsing the persistent renderer", async () => {
  vi.clearAllMocks();
  mocks.port.computeExpanded.mockResolvedValue({
    avatarRect: { x: 0, y: 0, width: 94, height: 94 },
    popoverRect: { x: 94, y: 0, width: 300, height: 400 },
  });
  vi.stubGlobal("PointerEvent", MouseEvent);
  const { findByTestId } = render(<DesktopAgentApp />);
  const hit = (await findByTestId("avatar")).parentElement;
  if (!hit) throw new Error("missing hit target");
  fireEvent.pointerDown(hit, { button: 0, screenX: 10, screenY: 10 });
  await act(async () => fireEvent.pointerUp(hit));
  fireEvent.click(hit);
  expect(mocks.port.applyExpanded).toHaveBeenCalledOnce();
  expect(mocks.port.collapse).not.toHaveBeenCalled();
  expect(mocks.port.onDragStarted).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it("expanded avatar collapses only on a primary click, not pointer-up or context/auxiliary clicks", async () => {
  const { findByTestId } = render(<DesktopAgentApp />);
  const hit = (await findByTestId("avatar")).parentElement;
  if (!hit) throw new Error("missing hit target");
  fireEvent.pointerDown(hit, { button: 0 });
  await act(async () => fireEvent.pointerUp(hit));
  fireEvent.click(hit); // trailing click from the expansion gesture
  expect(mocks.port.mode).toBe("expanded");
  expect(mocks.port.collapse).not.toHaveBeenCalled();

  for (const button of [1, 2]) {
    fireEvent.pointerDown(hit, { button });
    fireEvent.pointerUp(hit, { button });
    fireEvent.click(hit, { button });
  }
  fireEvent.pointerDown(document.body, { button: 0 });
  fireEvent.pointerUp(hit, { button: 0 });
  expect(mocks.port.collapse).not.toHaveBeenCalled();

  fireEvent.pointerDown(hit, { button: 0 });
  fireEvent.pointerUp(hit, { button: 0 });
  expect(mocks.port.collapse).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(hit, { button: 0 }));
  expect(mocks.port.collapse).toHaveBeenCalledOnce();
});

it.each([
  true,
  false,
])("keeps dangle until async drop resolves (perched=%s)", async (perched) => {
  let resolveDrop!: (value: boolean) => void;
  mocks.perch.endTargetingAndMaybePerch.mockReturnValue(
    new Promise<boolean>((resolve) => {
      resolveDrop = resolve;
    }),
  );
  const { findByTestId, rerender } = render(<DesktopAgentApp />);
  const hit = (await findByTestId("avatar")).parentElement;
  if (!hit) throw new Error("missing hit target");
  fireEvent.pointerDown(hit, { button: 0, screenX: 10, screenY: 10 });
  fireEvent.pointerMove(hit, { screenX: 15, screenY: 10 });
  fireEvent.pointerUp(hit);
  expect(mocks.avatarProps.target).toBe("dangle");
  // Native targeting itself also keeps the route dangling, even after up.
  mocks.perch.phase = "targeting";
  rerender(<DesktopAgentApp />);
  expect(mocks.avatarProps.target).toBe("dangle");
  expect(mocks.port.onDragEnded).not.toHaveBeenCalled();
  expect(mocks.port.onDragEndedPerched).not.toHaveBeenCalled();
  await act(async () => {
    mocks.perch.phase = perched ? "perched" : "unperched";
    resolveDrop(perched);
  });
  expect(mocks.avatarProps.target).toBe(perched ? "sit" : "idle");
  expect(
    perched ? mocks.port.onDragEndedPerched : mocks.port.onDragEnded,
  ).toHaveBeenCalledOnce();
});

async function pressFixture() {
  const view = render(<DesktopAgentApp />);
  const hit = (await view.findByTestId("avatar")).parentElement;
  if (!hit) throw new Error("missing hit target");
  vi.useFakeTimers();
  hit.setPointerCapture = vi.fn();
  hit.hasPointerCapture = vi.fn(() => true);
  hit.releasePointerCapture = vi.fn();
  return { ...view, hit };
}

it.each([
  "unperched",
  "perched",
])("stationary hold at 180ms is visual only (%s) and release never opens chat", async (phase) => {
  mocks.perch.phase = phase;
  const { hit, unmount } = await pressFixture();
  fireEvent.pointerDown(hit, { button: 0 });
  act(() => vi.advanceTimersByTime(179));
  expect(mocks.avatarProps.target).toBe(phase === "perched" ? "sit" : "idle");
  act(() => vi.advanceTimersByTime(1));
  expect(mocks.avatarProps.target).toBe("dangle");
  expect(hit.setPointerCapture).toHaveBeenCalledOnce();
  expect(mocks.port.onDragStarted).not.toHaveBeenCalled();
  expect(mocks.perch.beginTargeting).not.toHaveBeenCalled();
  expect(mocks.perch.dismount).not.toHaveBeenCalled();
  await act(async () => fireEvent.pointerUp(hit, { button: 0 }));
  fireEvent.click(hit);
  expect(hit.releasePointerCapture).toHaveBeenCalledOnce();
  expect(mocks.avatarProps.target).toBe(phase === "perched" ? "sit" : "idle");
  expect(mocks.port.computeExpanded).not.toHaveBeenCalled();
  expect(mocks.perch.endTargetingAndMaybePerch).not.toHaveBeenCalled();
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("quick clicks clear their hold timer, and expanded presses never hold", async () => {
  const { hit, unmount } = await pressFixture();
  fireEvent.pointerDown(hit, { button: 0 });
  act(() => vi.advanceTimersByTime(179));
  await act(async () => fireEvent.pointerUp(hit, { button: 0 }));
  fireEvent.click(hit);
  act(() => vi.advanceTimersByTime(500));
  expect(mocks.avatarProps.target).toBe("idle");
  expect(mocks.port.applyExpanded).toHaveBeenCalledOnce();
  fireEvent.pointerDown(hit, { button: 0 });
  act(() => vi.advanceTimersByTime(500));
  expect(mocks.avatarProps.target).toBe("idle");
  fireEvent.pointerUp(hit, { button: 0 });
  await act(async () => fireEvent.click(hit));
  expect(mocks.port.collapse).toHaveBeenCalledOnce();
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  "cancel",
  "lostcapture",
  "identity",
  "unmount",
  "visibility",
])("clears holds on %s without stale timer or native attach", async (reason) => {
  const { hit, rerender, unmount } = await pressFixture();
  fireEvent.pointerDown(hit, { button: 0 });
  act(() => vi.advanceTimersByTime(90));
  if (reason === "cancel") fireEvent.pointerCancel(hit);
  if (reason === "lostcapture") fireEvent.lostPointerCapture(hit);
  if (reason === "identity") {
    mocks.agentId = "other";
    rerender(<DesktopAgentApp />);
  }
  if (reason === "visibility") {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    visibility.mockRestore();
  }
  if (reason === "unmount") unmount();
  act(() => vi.advanceTimersByTime(500));
  expect(mocks.avatarProps.target).toBe("idle");
  fireEvent.pointerUp(hit, { button: 0 });
  expect(mocks.port.computeExpanded).not.toHaveBeenCalled();
  expect(mocks.perch.endTargetingAndMaybePerch).not.toHaveBeenCalled();
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("ignores auxiliary holds and preserves the context menu", async () => {
  const { hit, unmount } = await pressFixture();
  for (const button of [1, 2]) {
    fireEvent.pointerDown(hit, { button });
    act(() => vi.advanceTimersByTime(500));
    fireEvent.pointerUp(hit, { button });
  }
  await act(async () => {
    fireEvent.contextMenu(hit);
  });
  expect(mocks.openMenu).toHaveBeenCalledOnce();
  expect(mocks.avatarProps.target).toBe("idle");
  expect(mocks.port.computeExpanded).not.toHaveBeenCalled();
  expect(mocks.port.onDragStarted).not.toHaveBeenCalled();
  unmount();
});

it("native drag starts before hold threshold; cancellation stops targeting without a drop", async () => {
  const { hit, unmount } = await pressFixture();
  fireEvent.pointerDown(hit, { button: 0, screenX: 0, screenY: 0 });
  fireEvent.pointerMove(hit, { screenX: 4, screenY: 0 });
  expect(mocks.avatarProps.target).toBe("dangle");
  expect(mocks.port.onDragStarted).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => fireEvent.pointerCancel(hit));
  expect(mocks.perch.cancelTargeting).toHaveBeenCalledOnce();
  expect(mocks.perch.endTargetingAndMaybePerch).not.toHaveBeenCalled();
  expect(mocks.avatarProps.target).toBe("idle");
  unmount();
});

it("an old async drop cannot clear a regrab hold or start overlapping native drags", async () => {
  let finish!: (value: boolean) => void;
  mocks.perch.endTargetingAndMaybePerch.mockReturnValue(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  );
  const { hit, unmount } = await pressFixture();
  fireEvent.pointerDown(hit, { button: 0, screenX: 0, screenY: 0 });
  fireEvent.pointerMove(hit, { screenX: 4, screenY: 0 });
  fireEvent.pointerUp(hit, { button: 0 });
  fireEvent.pointerDown(hit, { button: 0, screenX: 0, screenY: 0 });
  fireEvent.pointerMove(hit, { screenX: 4, screenY: 0 });
  expect(mocks.port.onDragStarted).toHaveBeenCalledOnce();
  act(() => vi.advanceTimersByTime(180));
  await act(async () => finish(false));
  expect(mocks.avatarProps.target).toBe("dangle");
  await act(async () => fireEvent.pointerUp(hit, { button: 0 }));
  expect(mocks.avatarProps.target).toBe("idle");
  expect(mocks.port.computeExpanded).not.toHaveBeenCalled();
  unmount();
});

it("native handoff capture loss preserves drag until pointer-up", async () => {
  const { hit, unmount } = await pressFixture();
  fireEvent.pointerDown(hit, { button: 0, screenX: 0, screenY: 0 });
  fireEvent.pointerMove(hit, { screenX: 4, screenY: 0 });
  fireEvent.lostPointerCapture(hit);
  expect(mocks.perch.cancelTargeting).not.toHaveBeenCalled();
  expect(mocks.avatarProps.target).toBe("dangle");
  await act(async () => fireEvent.pointerUp(hit, { button: 0 }));
  expect(mocks.perch.endTargetingAndMaybePerch).toHaveBeenCalledOnce();
  expect(mocks.port.onDragEndedPerched).toHaveBeenCalledOnce();
  expect(mocks.port.computeExpanded).not.toHaveBeenCalled();
  unmount();
});

it("cancelling a pending drop prevents stale placement and keeps a new hold intact", async () => {
  let finish!: (value: boolean) => void;
  mocks.perch.endTargetingAndMaybePerch.mockReturnValue(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  );
  const { hit, rerender, unmount } = await pressFixture();
  fireEvent.pointerDown(hit, { button: 0, screenX: 0, screenY: 0 });
  fireEvent.pointerMove(hit, { screenX: 4, screenY: 0 });
  fireEvent.pointerUp(hit, { button: 0 });
  mocks.agentId = "other";
  rerender(<DesktopAgentApp />);
  expect(mocks.perch.cancelTargeting).toHaveBeenCalledOnce();
  fireEvent.pointerDown(hit, { button: 0 });
  act(() => vi.advanceTimersByTime(180));
  await act(async () => finish(true));
  expect(mocks.port.onDragEndedPerched).not.toHaveBeenCalled();
  expect(mocks.port.onDragEnded).not.toHaveBeenCalled();
  expect(mocks.avatarProps.target).toBe("dangle");
  await act(async () => fireEvent.pointerUp(hit, { button: 0 }));
  expect(mocks.avatarProps.target).toBe("idle");
  expect(mocks.port.computeExpanded).not.toHaveBeenCalled();
  unmount();
});
