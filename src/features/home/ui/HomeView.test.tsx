import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Layout } from "@/features/layout/api/layout";
import { getLayout, HOME_LAYOUT_ID } from "@/features/layout/api/layout";
import {
  resetHomeWidgetStoreForTests,
  useHomeWidgetStore,
} from "../stores/homeWidgetStore";
import { HomeView } from "./HomeView";

vi.mock("@/features/layout/api/layout", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/layout/api/layout")>();
  return {
    ...actual,
    getLayout: vi.fn(),
    saveLayoutItems: vi.fn(),
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("./HomeComposer", () => ({
  HomeComposer: () => <div>home composer</div>,
}));

vi.mock("./WidgetCanvas", () => ({
  WidgetCanvas: () => <div>widget canvas</div>,
}));

function layout(overrides: Partial<Layout> = {}): Layout {
  return {
    layoutId: HOME_LAYOUT_ID,
    itemRevision: 1,
    cameraRevision: 1,
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

function renderHomeView() {
  return render(
    <HomeView sessionId="home-session" onActivateSession={vi.fn()} />,
  );
}

beforeEach(() => {
  resetHomeWidgetStoreForTests();
  vi.mocked(getLayout).mockReset();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
});

describe("HomeView", () => {
  it("calls initialize on mount", async () => {
    vi.mocked(getLayout).mockResolvedValue(layout());

    renderHomeView();

    await screen.findByText("widget canvas");
    expect(getLayout).toHaveBeenCalledWith(HOME_LAYOUT_ID);
  });

  it("shows loading state without hiding composer", () => {
    vi.mocked(getLayout).mockReturnValue(new Promise(() => {}));

    renderHomeView();

    expect(screen.getByText("Loading widgets...")).toBeInTheDocument();
    expect(screen.getByText("home composer")).toBeInTheDocument();
  });

  it("shows error actions without hiding composer", async () => {
    vi.mocked(getLayout).mockRejectedValue("raw backend error");

    renderHomeView();

    expect(
      await screen.findByText("Widgets could not be loaded."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy details" }),
    ).toBeInTheDocument();
    expect(screen.getByText("home composer")).toBeInTheDocument();
  });

  it("copy details writes the raw error string and shows a toast", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.mocked(getLayout).mockRejectedValue("raw backend error");

    renderHomeView();
    await user.click(
      await screen.findByRole("button", { name: "Copy details" }),
    );

    expect(writeText).toHaveBeenCalledWith("raw backend error");
    expect(toast.success).toHaveBeenCalledWith("Copied error details.");
  });

  it("retry moves from error state to ready", async () => {
    const user = userEvent.setup();
    vi.mocked(getLayout)
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue(layout());

    renderHomeView();

    act(() => {
      useHomeWidgetStore.setState({
        loadStatus: "error",
        error: "first failure",
      });
    });
    await user.click(await screen.findByRole("button", { name: "Retry" }));

    await screen.findByText("widget canvas");
    expect(getLayout).toHaveBeenCalledTimes(2);
  });
});
