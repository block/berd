import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  computeAvatarMenuPlacement,
  MENU_WIDTH,
  SUBMENU_GAP,
  SUBMENU_WIDTH,
  AvatarMenu,
} from "./AvatarMenu";
import type { ExpandedLayout } from "../lib/anchorGeometry";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "menu.newChat": "New chat",
        "menu.switchAgent": "Switch agent",
        "menu.settings": "Settings",
        "menu.dismiss": "Hide",
        "menu.fresh": "Berd",
        "menu.empty": "No agents yet",
      })[key] ?? key,
  }),
}));
vi.mock("../hooks/useAgentAvatar", () => ({
  useAgentAvatar: () => ({
    choice: { kind: "image", src: "agent.png", label: "Agent" },
  }),
}));
vi.mock("./AvatarView", () => ({
  AvatarView: () => <span data-testid="preview" />,
}));
vi.mock("../lib/berdyClips", () => ({
  BERDY_CLIPS: { idle1: { file: "idle.mp4" } },
}));

const layout: ExpandedLayout = {
  windowFrame: { x: 100, y: 100, width: 600, height: 300 },
  avatarRect: { x: 0, y: 100, width: 94, height: 94 },
  popoverRect: { x: 94, y: 0, width: 438, height: 124 },
  popoverAbove: false,
  popoverSide: null,
};

function renderMenu(overrides?: Partial<Parameters<typeof AvatarMenu>[0]>) {
  const props = {
    layout,
    agentSelector: true,
    model: {
      agents: [
        {
          agentId: "a1",
          name: "Scout",
          systemPrompt: "",
          provider: null,
          model: null,
        },
      ],
      checkedAgentId: null,
      checkedFresh: true,
    },
    onNewChat: vi.fn(),
    onSelectAgent: vi.fn(),
    onSelectFresh: vi.fn(),
    onSettings: vi.fn(),
    onHide: vi.fn(),
    ...overrides,
  };
  render(<AvatarMenu {...props} />);
  return props;
}

describe("AvatarMenu keyboard and activation", () => {
  it("navigates root rows and activates with Enter/Escape untouched", () => {
    const props = renderMenu();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(props.onSettings).toHaveBeenCalledOnce();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(props.onHide).toHaveBeenCalledOnce();
  });

  it("opens, navigates, activates, and closes the submenu with arrows", () => {
    const props = renderMenu();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("Berd")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(props.onSelectAgent).toHaveBeenCalledWith(props.model.agents[0]);

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.queryByText("Scout")).not.toBeInTheDocument();
  });

  it("renders New chat first and activates it by keyboard", () => {
    const props = renderMenu();
    const rows = screen.getAllByRole("button");
    expect(rows[0]).toHaveTextContent("New chat");
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(props.onNewChat).toHaveBeenCalledOnce();
  });

  it("supports hover + click submenu activation", () => {
    const props = renderMenu();
    fireEvent.pointerEnter(screen.getByText("Switch agent"));
    fireEvent.click(screen.getByText("Scout"));
    expect(props.onSelectAgent).toHaveBeenCalledWith(props.model.agents[0]);
  });

  it("renders checkmark fallback, zero-agents row, and selector-off rows", () => {
    const { rerender } = render(
      <AvatarMenu
        layout={layout}
        agentSelector={true}
        model={{ agents: [], checkedAgentId: null, checkedFresh: true }}
        onNewChat={vi.fn()}
        onSelectAgent={vi.fn()}
        onSelectFresh={vi.fn()}
        onSettings={vi.fn()}
        onHide={vi.fn()}
      />,
    );
    fireEvent.pointerEnter(screen.getByText("Switch agent"));
    expect(screen.getByText("No agents yet")).toBeInTheDocument();
    expect(screen.getByText("✓")).toBeInTheDocument();

    rerender(
      <AvatarMenu
        layout={layout}
        agentSelector={false}
        model={{ agents: [], checkedAgentId: null, checkedFresh: false }}
        onNewChat={vi.fn()}
        onSelectAgent={vi.fn()}
        onSelectFresh={vi.fn()}
        onSettings={vi.fn()}
        onHide={vi.fn()}
      />,
    );
    expect(screen.queryByText("Switch agent")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")[0]).toHaveTextContent("New chat");
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Hide")).toBeInTheDocument();
  });
});

describe("AvatarMenu placement", () => {
  it.each([
    ["centre", "right"],
    ["left screen edge", "right"],
    ["right screen edge", "left"],
  ] as const)("keeps root/submenu non-overlapping and on-screen at %s", (_name, side) => {
    const placement = computeAvatarMenuPlacement({
      agentSelector: true,
      agentCount: 3,
      preferSubmenuSide: side,
    });
    const root = placement.root;
    const sub = placement.submenu;
    expect(root.x).toBeGreaterThanOrEqual(0);
    expect(sub.x).toBeGreaterThanOrEqual(0);
    expect(root.x + root.width).toBeLessThanOrEqual(placement.regionSize.width);
    expect(sub.x + sub.width).toBeLessThanOrEqual(placement.regionSize.width);
    expect(root.x + root.width <= sub.x || sub.x + sub.width <= root.x).toBe(
      true,
    );
    expect(sub.width).toBe(SUBMENU_WIDTH);
    expect(placement.regionSize.width).toBe(
      MENU_WIDTH + SUBMENU_GAP + SUBMENU_WIDTH,
    );
  });
});
