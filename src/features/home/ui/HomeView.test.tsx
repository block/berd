import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TopBarActionsProvider,
  useTopBarActions,
} from "@/app/contexts/TopBarActionsContext";
import type { Layout } from "@/features/layout/api/layout";
import {
  getLayout,
  HOME_LAYOUT_ID,
  saveLayoutCamera,
  saveLayoutItems,
} from "@/features/layout/api/layout";
import {
  resetHomeWidgetStoreForTests,
  useHomeWidgetStore,
} from "../stores/homeWidgetStore";
import { HomeView } from "./HomeView";

const ONBOARDING_STICKIES_SEEDED_STORAGE_KEY =
  "goose:home:onboarding-stickies-seeded";

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

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
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

function TopBarActionsHost() {
  const actions = useTopBarActions();
  return <div data-testid="topbar-actions">{actions}</div>;
}

function renderHomeView() {
  return render(<HomeView />);
}

function renderHomeViewWithTopBarActions() {
  return render(
    <TopBarActionsProvider>
      <TopBarActionsHost />
      <HomeView />
    </TopBarActionsProvider>,
  );
}

beforeEach(() => {
  resetHomeWidgetStoreForTests();
  vi.mocked(getLayout).mockReset();
  vi.mocked(saveLayoutItems).mockReset();
  vi.mocked(saveLayoutItems).mockImplementation(async (request) => ({
    ok: true,
    layout: layout({ items: request.items, itemRevision: 2 }),
  }));
  vi.mocked(saveLayoutCamera).mockReset();
  vi.mocked(saveLayoutCamera).mockImplementation(async (request) => ({
    ok: true,
    layout: layout({ camera: request.camera, cameraRevision: 2 }),
  }));
  localStorage.clear();
  localStorage.setItem(ONBOARDING_STICKIES_SEEDED_STORAGE_KEY, "5");
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

  it("shows loading state without inline composer", () => {
    vi.mocked(getLayout).mockReturnValue(new Promise(() => {}));

    renderHomeView();

    expect(screen.getByText("Loading widgets...")).toBeInTheDocument();
    expect(screen.queryByText("home composer")).not.toBeInTheDocument();
  });

  it("shows error actions without inline composer", async () => {
    vi.mocked(getLayout).mockRejectedValue("raw backend error");

    renderHomeView();

    expect(
      await screen.findByText("Widgets could not be loaded."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy details" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("home composer")).not.toBeInTheDocument();
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

  it("exposes a top-bar recenter action for the home camera", async () => {
    const user = userEvent.setup();
    vi.mocked(getLayout).mockResolvedValue(
      layout({
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
          {
            id: "00000000-0000-0000-0000-000000000002",
            kind: "clock",
            targetId: "widget:00000000-0000-0000-0000-000000000002",
            centerX: 640,
            centerY: 360,
            width: 240,
            height: 240,
            zIndex: 2,
            titleOverride: null,
          },
        ],
      }),
    );

    renderHomeViewWithTopBarActions();
    await screen.findByText("widget canvas");

    expect(screen.queryByText("Recenter")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Recenter pinned objects" }),
    );

    expect(useHomeWidgetStore.getState().camera).toEqual({
      centerX: 440,
      centerY: 300,
      zoomBps: 10_000,
    });
  });

  it("exposes a top-bar cleanup action that toggles between organized and restored layouts", async () => {
    const user = userEvent.setup();
    vi.mocked(getLayout).mockResolvedValue(
      layout({
        items: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            kind: "persona",
            targetId: "agent-1",
            centerX: 600,
            centerY: 610,
            width: 200,
            height: 220,
            zIndex: 7,
            titleOverride: null,
          },
          {
            id: "00000000-0000-0000-0000-000000000002",
            kind: "clock",
            targetId: "widget:00000000-0000-0000-0000-000000000002",
            centerX: 120,
            centerY: 120,
            width: 240,
            height: 240,
            zIndex: 1,
            titleOverride: null,
          },
          {
            id: "00000000-0000-0000-0000-000000000003",
            kind: "session",
            targetId: "session-1",
            centerX: 1094,
            centerY: 540,
            width: 188,
            height: 80,
            zIndex: 2,
            titleOverride: null,
          },
          {
            id: "00000000-0000-0000-0000-000000000004",
            kind: "skill",
            targetId: "skill-1",
            centerX: 1120,
            centerY: 28,
            width: 240,
            height: 56,
            zIndex: 3,
            titleOverride: null,
          },
        ],
      }),
    );

    renderHomeViewWithTopBarActions();
    await screen.findByText("widget canvas");

    expect(screen.queryByText("Clean up")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clean up pins" }));

    expect(useHomeWidgetStore.getState().instances).toMatchObject([
      { id: "00000000-0000-0000-0000-000000000001", x: 384, y: 0, z: 2 },
      { id: "00000000-0000-0000-0000-000000000002", x: 0, y: 0, z: 1 },
      { id: "00000000-0000-0000-0000-000000000003", x: 744, y: 0, z: 3 },
      { id: "00000000-0000-0000-0000-000000000004", x: 1080, y: 0, z: 4 },
    ]);
    await waitFor(() => expect(saveLayoutItems).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "Revert layout" }));

    expect(useHomeWidgetStore.getState().instances).toMatchObject([
      { id: "00000000-0000-0000-0000-000000000001", x: 500, y: 500, z: 7 },
      { id: "00000000-0000-0000-0000-000000000002", x: 0, y: 0, z: 1 },
      { id: "00000000-0000-0000-0000-000000000003", x: 1000, y: 500, z: 2 },
      { id: "00000000-0000-0000-0000-000000000004", x: 1000, y: 0, z: 3 },
    ]);
    await waitFor(() => expect(saveLayoutItems).toHaveBeenCalledTimes(2));
  });
});
