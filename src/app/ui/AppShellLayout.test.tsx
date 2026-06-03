import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppShellLayout } from "./AppShellLayout";

vi.mock("@/features/sidebar/ui/Sidebar", () => ({
  Sidebar: () => <aside>Sidebar</aside>,
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

vi.mock("./TopBar", () => ({
  TopBar: () => <header>Top bar</header>,
}));

const noop = vi.fn();
type TestLayoutProps = Omit<Parameters<typeof AppShellLayout>[0], "children">;

function layoutProps({
  isResizing = false,
  sidebarCollapsed = false,
}: {
  isResizing?: boolean;
  sidebarCollapsed?: boolean;
} = {}) {
  const sidebarPanelOuterWidth = 212;
  const sidebarOuterWidth = sidebarCollapsed ? 0 : sidebarPanelOuterWidth;

  return {
    topBar: {
      breadcrumbs: [],
      onFeedbackClick: noop,
    },
    sidebar: {
      collapsed: false,
      width: 200,
      projects: [],
    },
    sidebarCollapsed,
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
    expect(sidebarSlot.style.transition).toContain("width 320ms");
    expect(sidebarPanel.style.width).toBe(`${props.sidebarPanelOuterWidth}px`);
    expect(sidebarPanel).toHaveClass("right-0");
    expect(sidebarPanel.style.transform).toBe("");

    rerender(
      <AppShellLayout {...layoutProps({ sidebarCollapsed: true })}>
        <main>Content</main>
      </AppShellLayout>,
    );

    expect(sidebarSlot.style.width).toBe("0px");
    expect(sidebarSlot.style.transition).toContain("width 320ms");
    expect(sidebarPanel).toHaveClass("right-0");
    expect(sidebarPanel.style.transform).toBe("");
  });

  it("does not animate the reserved sidebar width while resizing", () => {
    const { sidebarSlot } = renderLayout({ isResizing: true });

    expect(sidebarSlot.style.transition).toBe("none");
  });
});
