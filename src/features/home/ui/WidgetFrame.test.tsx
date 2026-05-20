import type React from "react";
import { createRef, type ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WidgetInstance,
  WidgetMutationHandlers,
  WidgetNavigationHandlers,
} from "../widgets/types";
import { WidgetFrame } from "./WidgetFrame";

type MotionDivProps = React.HTMLAttributes<HTMLDivElement> & {
  onDragEnd?: (
    event: MouseEvent | PointerEvent | TouchEvent,
    info: { offset: { x: number; y: number } },
  ) => void;
};

const mocks = vi.hoisted(() => ({
  motionDivProps: undefined as MotionDivProps | undefined,
}));

vi.mock("motion/react", async () => {
  const { forwardRef } = await import("react");

  return {
    motion: {
      div: forwardRef<HTMLDivElement, Record<string, unknown>>(
        (
          {
            children,
            drag: _drag,
            dragConstraints: _dragConstraints,
            dragElastic: _dragElastic,
            dragMomentum: _dragMomentum,
            initial: _initial,
            exit: _exit,
            transition: _transition,
            ...props
          },
          ref,
        ) => {
          mocks.motionDivProps = props as typeof mocks.motionDivProps;
          return (
            <div ref={ref} data-testid="widget-frame" {...props}>
              {children as ReactNode}
            </div>
          );
        },
      ),
    },
  };
});

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: (selector: (state: unknown) => unknown) =>
    selector({
      personas: [
        {
          id: "agent-1",
          displayName: "Agent One",
          isBuiltin: false,
        },
      ],
    }),
}));

function mutationHandlers(
  overrides: Partial<WidgetMutationHandlers> = {},
): WidgetMutationHandlers {
  return {
    addWidget: vi.fn(),
    moveWidget: vi.fn(),
    bumpZ: vi.fn(),
    removeWidget: vi.fn(),
    updateWidgetState: vi.fn(),
    ...overrides,
  };
}

function renderWidgetFrame({
  currentMaxZ = 1,
  getCanvasBounds = () => ({ width: 800, height: 600 }),
  instance = { id: "clock-1", type: "clock", x: 20, y: 30, z: 1 },
  mutations = mutationHandlers(),
  navigation,
}: {
  currentMaxZ?: number;
  getCanvasBounds?: () => { width: number; height: number };
  instance?: WidgetInstance;
  mutations?: WidgetMutationHandlers;
  navigation?: WidgetNavigationHandlers;
} = {}) {
  return render(
    <WidgetFrame
      instance={instance}
      canvasRef={createRef<HTMLDivElement>()}
      currentMaxZ={currentMaxZ}
      getCanvasBounds={getCanvasBounds}
      mutations={mutations}
      {...navigation}
    />,
  );
}

describe("WidgetFrame", () => {
  beforeEach(() => {
    mocks.motionDivProps = undefined;
  });

  it("moves the widget when a drag ends", () => {
    const moveWidget = vi.fn();
    const getCanvasBounds = vi.fn(() => ({ width: 800, height: 600 }));

    renderWidgetFrame({
      getCanvasBounds,
      mutations: mutationHandlers({ moveWidget }),
    });

    act(() => {
      mocks.motionDivProps?.onDragEnd?.(new MouseEvent("pointerup"), {
        offset: { x: 12, y: 8 },
      });
    });

    expect(moveWidget).toHaveBeenCalledWith("clock-1", 32, 38, {
      width: 800,
      height: 600,
    });
  });

  it("does not commit z-index changes on pointer down", () => {
    const bumpZ = vi.fn();

    renderWidgetFrame({
      currentMaxZ: 2,
      mutations: mutationHandlers({ bumpZ }),
    });

    const frame = screen.getByTestId("widget-frame");
    fireEvent.pointerDown(frame, { clientX: 20, clientY: 30 });

    expect(frame).toHaveStyle({ zIndex: "3" });
    expect(bumpZ).not.toHaveBeenCalled();
  });

  it("commits z-index changes on click after pointer down", () => {
    const bumpZ = vi.fn();

    renderWidgetFrame({
      currentMaxZ: 2,
      mutations: mutationHandlers({ bumpZ }),
    });

    const frame = screen.getByTestId("widget-frame");
    fireEvent.pointerDown(frame, { clientX: 20, clientY: 30 });
    fireEvent.click(frame);

    expect(bumpZ).toHaveBeenCalledWith("clock-1");
  });

  it("commits z-index changes when opening the context menu", () => {
    const bumpZ = vi.fn();

    renderWidgetFrame({
      currentMaxZ: 2,
      mutations: mutationHandlers({ bumpZ }),
    });

    const frame = screen.getByTestId("widget-frame");
    fireEvent.pointerDown(frame, { clientX: 20, clientY: 30 });
    fireEvent.contextMenu(frame);

    expect(bumpZ).toHaveBeenCalledWith("clock-1");
  });

  it("renders the context menu above widget frames", () => {
    renderWidgetFrame();

    fireEvent.contextMenu(screen.getByTestId("widget-frame"));

    expect(
      document.querySelector('[data-slot="context-menu-content"]'),
    ).toHaveClass("z-[1000]");
  });

  it("resets visual z-index lift when the pointer is canceled", () => {
    renderWidgetFrame({
      currentMaxZ: 2,
    });

    const frame = screen.getByTestId("widget-frame");
    fireEvent.pointerDown(frame, { clientX: 20, clientY: 30 });
    expect(frame).toHaveStyle({ zIndex: "3" });

    fireEvent.pointerCancel(frame);

    expect(frame).toHaveStyle({ zIndex: "1" });
  });

  it("preserves widget click activation before committing z-index changes", () => {
    const bumpZ = vi.fn();
    const onOpenAgent = vi.fn();

    renderWidgetFrame({
      currentMaxZ: 2,
      instance: {
        id: "agent-pin-1",
        type: "agentPin",
        x: 20,
        y: 30,
        z: 1,
        state: { agentId: "agent-1" },
      },
      mutations: mutationHandlers({ bumpZ }),
      navigation: { onOpenAgent },
    });

    fireEvent.click(screen.getByRole("button", { name: /agent one/i }));

    expect(onOpenAgent).toHaveBeenCalledWith("agent-1");
    expect(bumpZ).toHaveBeenCalledWith("agent-pin-1");
    expect(onOpenAgent.mock.invocationCallOrder[0]).toBeLessThan(
      bumpZ.mock.invocationCallOrder[0],
    );
  });

  it("suppresses child widget activation after drag-sized pointer movement", () => {
    const onOpenAgent = vi.fn();

    renderWidgetFrame({
      instance: {
        id: "agent-pin-1",
        type: "agentPin",
        x: 20,
        y: 30,
        z: 1,
        state: { agentId: "agent-1" },
      },
      navigation: { onOpenAgent },
    });

    act(() => {
      mocks.motionDivProps?.onDragEnd?.(new MouseEvent("pointerup"), {
        offset: { x: 4, y: 0 },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: /agent one/i }));

    expect(onOpenAgent).not.toHaveBeenCalled();
  });

  it("commits z-index changes on drag end", () => {
    const bumpZ = vi.fn();
    const moveWidget = vi.fn();

    renderWidgetFrame({
      currentMaxZ: 2,
      mutations: mutationHandlers({ bumpZ, moveWidget }),
    });

    act(() => {
      mocks.motionDivProps?.onDragEnd?.(new MouseEvent("pointerup"), {
        offset: { x: 12, y: 8 },
      });
    });

    expect(bumpZ).toHaveBeenCalledWith("clock-1");
    expect(moveWidget).toHaveBeenCalledWith("clock-1", 32, 38, {
      width: 800,
      height: 600,
    });
  });
});
