import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppShellLayout } from "./AppShellLayout";

vi.mock("@/app/views/NavigationPanesView", () => ({
  NavigationPanesView: () => <aside>Sidebar</aside>,
}));

vi.mock("@/features/projects/ui/CreateProjectDialog", () => ({
  CreateProjectDialog: () => null,
}));

vi.mock("@/features/design-system/inspector/DesignSystemInspector", () => ({
  DesignSystemInspector: () => null,
}));

vi.mock("@/features/design-system/lib/designSystemEnabled", () => ({
  isDesignSystemExplorerEnabled: () => false,
}));

vi.mock("@/features/updates/ui/UpdateButton", () => ({
  UpdateButton: () => null,
}));

vi.mock("@/features/updates/ui/ChannelSwitchDialog", () => ({
  ChannelSwitchDialog: () => null,
}));

vi.mock("./TopBar", () => ({
  TopBar: () => <header>Top bar</header>,
}));

const noop = vi.fn();
type TestLayoutProps = Omit<Parameters<typeof AppShellLayout>[0], "children">;

function layoutProps({
  isResizing = false,
  sidebarCollapsed = false,
  sidebarDisableWidthTransition = false,
  sidebarHeightResizeDisabled = false,
  sidebarResizeDisabled = false,
  sidebarWidthResizeDisabled = false,
  sidebarContentAnchor = "right",
}: {
  isResizing?: boolean;
  sidebarCollapsed?: boolean;
  sidebarDisableWidthTransition?: boolean;
  sidebarHeightResizeDisabled?: boolean;
  sidebarResizeDisabled?: boolean;
  sidebarWidthResizeDisabled?: boolean;
  sidebarContentAnchor?: "left" | "right";
} = {}) {
  const sidebarPanelOuterWidth = 212;
  const sidebarOuterWidth = sidebarCollapsed ? 0 : sidebarPanelOuterWidth;

  return {
    topBar: {
      breadcrumbs: [],
      onFeedbackClick: noop,
    },
    navigationPanes: {
      collapsed: false,
      width: 200,
      projects: [],
    },
    sidebarCollapsed,
    sidebarContentAnchor,
    sidebarDisableWidthTransition,
    sidebarHeightResizeDisabled,
    sidebarResizeDisabled,
    sidebarWidthResizeDisabled,
    sidebarOuterWidth,
    sidebarPanelOuterWidth,
    isResizing,
    resizeHandleHeight: 12,
    resizeHandleWidth: 12,
    sidebarOuterHeight: 480,
    onResizeStart: noop,
    onResizeDoubleClick: noop,
    onHeightResizeStart: noop,
    onHeightResizeDoubleClick: noop,
    onCornerResizeStart: noop,
    onCornerResizeDoubleClick: noop,
    designSystemInspectorModeToggleRequest: 0,
    showDesignSystemInspector: false,
    createProjectDialog: {
      isOpen: false,
      onClose: noop,
      onCreated: noop,
    },
  } satisfies TestLayoutProps;
}

function renderLayout(options?: Parameters<typeof layoutProps>[0]) {
  const props = layoutProps(options);
  const result = render(
    <AppShellLayout {...props}>
      <main>Content</main>
    </AppShellLayout>,
  );

  const sidebarSlot = result.container.querySelector(
    ".goose-zoom-scope > div:first-child",
  ) as HTMLElement | null;
  const sidebarPanel = result.container.querySelector(
    ".goose-zoom-scope > div:first-child > div",
  ) as HTMLElement | null;

  if (!sidebarSlot || !sidebarPanel) {
    throw new Error("Expected sidebar slot and panel to render");
  }

  return { ...result, props, sidebarPanel, sidebarSlot };
}

describe("AppShellLayout", () => {
  it("animates the sidebar slot while keeping the panel aligned to its content edge", () => {
    const { rerender, props, sidebarPanel, sidebarSlot } = renderLayout();

    expect(sidebarSlot.style.width).toBe(`${props.sidebarPanelOuterWidth}px`);
    expect(sidebarSlot.style.height).toBe("480px");
    expect(sidebarSlot.style.transition).toContain("width 320ms");
    expect(sidebarPanel.style.width).toBe(`${props.sidebarPanelOuterWidth}px`);
    expect(sidebarPanel.style.opacity).toBe("");
    expect(sidebarPanel).toHaveClass("right-0");
    expect(sidebarPanel.style.transform).toBe("");

    rerender(
      <AppShellLayout {...layoutProps({ sidebarCollapsed: true })}>
        <main>Content</main>
      </AppShellLayout>,
    );

    expect(sidebarSlot.style.width).toBe("0px");
    expect(sidebarSlot.style.height).toBe("480px");
    expect(sidebarSlot.style.clipPath).toBe("inset(-100vh 0 -100vh 0)");
    expect(sidebarSlot.style.transition).toContain("width 320ms");
    expect(sidebarPanel.style.opacity).toBe("");
    expect(sidebarPanel.style.pointerEvents).toBe("none");
    expect(sidebarPanel).toHaveClass("right-0");
    expect(sidebarPanel.style.transform).toBe("");
  });

  it("keeps a left-anchored sidebar right-aligned while animating back in", () => {
    const { rerender, sidebarPanel } = renderLayout({
      sidebarCollapsed: true,
      sidebarContentAnchor: "left",
    });

    expect(sidebarPanel).toHaveClass("right-0");
    expect(sidebarPanel).not.toHaveClass("left-0");

    rerender(
      <AppShellLayout
        {...layoutProps({
          sidebarCollapsed: false,
          sidebarContentAnchor: "left",
        })}
      >
        <main>Content</main>
      </AppShellLayout>,
    );

    expect(sidebarPanel).toHaveClass("right-0");
    expect(sidebarPanel).not.toHaveClass("left-0");
  });

  it("does not animate the reserved sidebar width while resizing", () => {
    const { container, sidebarSlot } = renderLayout({ isResizing: true });

    expect(container.firstElementChild).toHaveAttribute(
      "data-app-shell-root",
      "true",
    );
    expect(sidebarSlot.style.transition).toBe("none");
  });

  it("does not animate the reserved sidebar width when transition suppression is requested", () => {
    const { sidebarSlot } = renderLayout({
      sidebarDisableWidthTransition: true,
    });

    expect(sidebarSlot.style.transition).toBe("none");
  });

  it("hides shell resize rails when sidebar resize is disabled", () => {
    const { container } = renderLayout({
      sidebarResizeDisabled: true,
    });

    expect(container.querySelector(".sidebar-resize-rail")).toBeNull();
    expect(container.querySelector(".cursor-ns-resize")).toBeNull();
  });

  it("can disable sidebar width resize while keeping height resize available", () => {
    const { container } = renderLayout({
      sidebarWidthResizeDisabled: true,
    });

    expect(container.querySelector(".sidebar-resize-rail")).toBeNull();
    expect(container.querySelector(".cursor-ns-resize")).toBeInTheDocument();
    expect(container.querySelector(".cursor-nwse-resize")).toBeNull();
  });
});
