import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Layout } from "@/features/layout/api/layout";
import {
  getLayout,
  HOME_LAYOUT_ID,
  saveLayoutCamera,
  saveLayoutItems,
} from "@/features/layout/api/layout";
import { resetHomeWidgetStoreForTests } from "../stores/homeWidgetStore";
import { HomeView } from "./HomeView";

vi.mock("@/features/layout/api/layout", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/layout/api/layout")>();
  return {
    ...actual,
    getLayout: vi.fn(),
    saveLayoutCamera: vi.fn(),
    saveLayoutItems: vi.fn(),
  };
});

function layout(overrides: Partial<Layout> = {}): Layout {
  return {
    layoutId: HOME_LAYOUT_ID,
    itemRevision: 1,
    cameraRevision: 2,
    camera: { centerX: 0, centerY: 0, zoomBps: 10_000 },
    constraints: {
      minCenter: -100_000,
      maxCenter: 100_000,
      minSize: 1,
      maxSize: 10_000,
      minZoomBps: 1_000,
      maxZoomBps: 20_000,
      maxTitleOverrideLength: 120,
      maxItems: 100,
    },
    items: [
      {
        id: "00000000-0000-0000-0000-000000000001",
        kind: "clock",
        targetId: "widget:00000000-0000-0000-0000-000000000001",
        centerX: 240,
        centerY: 240,
        width: 240,
        height: 240,
        zIndex: 1,
        titleOverride: null,
      },
    ],
    ...overrides,
  };
}

function mockCanvasRect(canvas: Element): void {
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    width: 800,
    height: 600,
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetHomeWidgetStoreForTests();
  vi.mocked(getLayout).mockResolvedValue(layout());
  vi.mocked(saveLayoutCamera).mockResolvedValue({
    ok: true,
    layout: layout({ cameraRevision: 3 }),
  });
  vi.mocked(saveLayoutItems).mockResolvedValue({
    ok: true,
    layout: layout({ itemRevision: 2 }),
  });
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HomeView layout camera persistence", () => {
  it("saves camera changes after background pan", async () => {
    const user = userEvent.setup();
    const { container } = render(<HomeView />);

    await screen.findByText(/wed|sun|mon|tue|thu|fri|sat/i);
    const canvas = container.querySelector(".bg-dot-grid");
    expect(canvas).toBeInstanceOf(HTMLElement);
    mockCanvasRect(canvas as HTMLElement);

    await user.pointer([
      {
        keys: "[MouseLeft>]",
        target: canvas as HTMLElement,
        coords: { clientX: 100, clientY: 120 },
      },
      {
        target: canvas as HTMLElement,
        coords: { clientX: 124, clientY: 96 },
      },
      {
        keys: "[/MouseLeft]",
        target: canvas as HTMLElement,
        coords: { clientX: 124, clientY: 96 },
      },
    ]);

    expect(saveLayoutCamera).toHaveBeenCalledWith({
      layoutId: HOME_LAYOUT_ID,
      expectedRevision: 2,
      camera: {
        centerX: expect.any(Number),
        centerY: expect.any(Number),
        zoomBps: 10_000,
      },
    });
  });

  it("saves camera changes after wheel zoom", async () => {
    const { container } = render(<HomeView />);

    await screen.findByText(/wed|sun|mon|tue|thu|fri|sat/i);
    vi.useFakeTimers();
    const canvas = container.querySelector(".bg-dot-grid");
    expect(canvas).toBeInstanceOf(HTMLElement);
    mockCanvasRect(canvas as HTMLElement);

    await act(async () => {
      fireEvent.wheel(canvas as HTMLElement, {
        clientX: 400,
        clientY: 300,
        deltaY: -120,
      });
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(saveLayoutCamera).toHaveBeenCalledWith({
      layoutId: HOME_LAYOUT_ID,
      expectedRevision: 2,
      camera: {
        centerX: expect.any(Number),
        centerY: expect.any(Number),
        zoomBps: expect.any(Number),
      },
    });
    expect(
      vi.mocked(saveLayoutCamera).mock.calls[0][0].camera.zoomBps,
    ).toBeGreaterThan(10_000);
  });
});
