import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import {
  resetHomeWidgetStoreForTests,
  useHomeWidgetStore,
} from "@/features/home/stores/homeWidgetStore";
import { useSessionWindowStore } from "@/features/chat/stores/sessionWindowStore";
import { TOOLTIP_DELAY } from "@/shared/ui/tooltip-delay";
import { formatSidebarChatTimestamp, SidebarChatRow } from "../SidebarChatRow";
import {
  focusSessionWindow,
  getSessionWindowSupport,
} from "@/features/chat/lib/sessionWindowCommands";
import { setWorkingIndicatorAnimationEnabled } from "@/shared/preferences/workingIndicatorAnimationPreference";

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  writeTextToTauriClipboard: vi.fn(),
  sessionWindowSupport: {
    supported: true,
    reason: undefined as string | undefined,
  },
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (...args: unknown[]) => mocks.writeTextToTauriClipboard(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mocks.toastError(...args),
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
  },
}));

vi.mock("@/features/chat/hooks/useSessionWindowSupport", () => ({
  useSessionWindowSupport: () => mocks.sessionWindowSupport,
}));

vi.mock("@/features/chat/lib/sessionWindowCommands", () => ({
  focusSessionWindow: vi.fn().mockResolvedValue(undefined),
  getSessionWindowSupport: vi
    .fn()
    .mockResolvedValue({ supported: true, reason: undefined }),
  openSessionWindow: vi.fn().mockResolvedValue(undefined),
  releaseSession: vi.fn().mockResolvedValue(undefined),
}));

describe("SidebarChatRow", () => {
  const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "clipboard",
  );

  beforeEach(() => {
    mocks.toastError.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.writeTextToTauriClipboard.mockReset();
    mocks.writeTextToTauriClipboard.mockResolvedValue(undefined);
    mocks.sessionWindowSupport.supported = true;
    mocks.sessionWindowSupport.reason = undefined;
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    resetHomeWidgetStoreForTests();
    localStorage.clear();
    useSessionWindowStore.getState().setSnapshot([]);
    vi.mocked(getSessionWindowSupport).mockResolvedValue({
      supported: true,
      reason: undefined,
    });
  });

  afterEach(() => {
    if (originalClipboardDescriptor) {
      Object.defineProperty(
        navigator,
        "clipboard",
        originalClipboardDescriptor,
      );
      return;
    }
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("does not show the rename tooltip while a quick pin is available", async () => {
    const user = userEvent.setup();
    render(<SidebarChatRow id="session-1" title="Pin Chat" isActive={false} />);

    await user.hover(screen.getByRole("button", { name: "Pin Chat" }));
    await new Promise((resolve) =>
      setTimeout(resolve, TOOLTIP_DELAY.restedHover + 100),
    );

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it.each([
    undefined,
    "Project One",
  ])("uses a delayed dismissible tooltip instead of a native title (project: %s)", async (flatProjectName) => {
    const user = userEvent.setup();

    render(
      <SidebarChatRow
        id="session-1"
        title="Hover Chat"
        isActive={false}
        flatProjectName={flatProjectName}
        quickPinMode="never"
      />,
    );

    const titleButton = screen.getByRole("button", { name: "Hover Chat" });
    expect(titleButton).not.toHaveAttribute("title");

    await user.hover(titleButton);
    const tooltip = await screen.findByRole(
      "tooltip",
      { name: "Double-click to rename" },
      { timeout: TOOLTIP_DELAY.restedHover + 1_000 },
    );
    expect(tooltip).toBeInTheDocument();
    expect(
      tooltip.closest('[data-slot="tooltip-pointer-pass-through"]'),
    ).toHaveClass("pointer-events-none");

    await user.unhover(titleButton);
    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="tooltip-content"]'),
      ).not.toBeInTheDocument();
    });
  });

  it("starts inline rename on double-click and commits on Enter", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title="Original Title"
        isActive={false}
        onRename={onRename}
      />,
    );

    await user.dblClick(screen.getByRole("button", { name: "Original Title" }));

    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Renamed Chat{Enter}");

    expect(onRename).toHaveBeenCalledWith("session-1", "Renamed Chat");
  });

  it("opens rename from menu and cancels on Escape", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title="Original Title"
        isActive={false}
        onRename={onRename}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for original title/i }),
    );
    await user.click(screen.getByRole("menuitem", { name: /rename/i }));

    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Should Not Save{Escape}");

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("trims input and does not rename when empty or unchanged", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title="Same Title"
        isActive={false}
        onRename={onRename}
      />,
    );

    await user.dblClick(screen.getByRole("button", { name: "Same Title" }));
    const input = screen.getByRole("textbox");

    await user.clear(input);
    await user.type(input, "   {Enter}");

    expect(onRename).not.toHaveBeenCalled();

    await user.dblClick(screen.getByRole("button", { name: "Same Title" }));
    const input2 = screen.getByRole("textbox");
    await user.clear(input2);
    await user.type(input2, "  Same Title  {Enter}");

    expect(onRename).not.toHaveBeenCalled();
  });

  it("pairs the shimmer with a trailing pulsing dot when the chat is active", () => {
    const { container } = render(
      <SidebarChatRow
        id="session-1"
        title="Busy Chat"
        isActive={false}
        isRunning
      />,
    );

    expect(screen.getByLabelText(/chat active/i)).toBeInTheDocument();
    const pulseDot = container.querySelector(
      '[data-slot="active-chat-pulse-dot"]',
    );
    expect(pulseDot).toHaveClass("bg-info");
    expect(pulseDot).toHaveStyle({ animationDuration: "2.2s" });
    expect((pulseDot as HTMLElement).style.animationDelay).toBe("");
    expect(
      container.querySelector('[data-slot="berd-loader-inline"]'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("sidebar-chat-menu-icon")).toBeInTheDocument();
    expect(
      container.querySelector("[data-sidebar-chat-status]"),
    ).toBeInTheDocument();
    const shimmer = screen.getByText("Busy Chat").closest(".shimmer-text");
    expect(shimmer).toBeInTheDocument();
    expect(shimmer).toHaveStyle({
      "--shimmer-base": "var(--color-sidebar-foreground)",
      "--shimmer-highlight":
        "color-mix(in srgb, var(--color-sidebar-foreground) 25%, var(--color-background))",
      "--spread": "22.5px",
      "--shimmer-delay": "0.35s",
      backgroundPosition: "130% center, 0 0",
    });
  });

  it("shows static running status when sidebar animation is disabled", () => {
    setWorkingIndicatorAnimationEnabled(false);
    const { container } = render(
      <SidebarChatRow
        id="session-1"
        title="Busy Chat"
        isActive={false}
        isRunning
      />,
    );

    expect(screen.getByText("Busy Chat").closest(".shimmer-text")).toBeNull();
    expect(screen.getByLabelText(/chat active/i)).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="active-chat-pulse-dot"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="active-chat-pulse-dot"]'),
    ).not.toHaveClass("animate-[active-chat-dot-pulse_ease-in-out_infinite]");
  });

  it("replaces the timestamp with trailing status while running", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000);
    const { container } = render(
      <SidebarChatRow
        id="session-1"
        title="Busy Chat"
        activityAt={fiveMinutesAgo.toISOString()}
        isActive={false}
        isRunning
      />,
    );

    expect(
      container.querySelector("[data-sidebar-chat-status]"),
    ).toBeInTheDocument();
    expect(
      container.querySelector("[data-sidebar-chat-timestamp]"),
    ).not.toBeInTheDocument();
  });

  it("shows an unread dot on the right when the chat has unread output", () => {
    const { container } = render(
      <SidebarChatRow
        id="session-1"
        title="Unread Chat"
        isActive={false}
        hasUnread
      />,
    );

    expect(screen.getByLabelText(/unread messages/i)).toBeInTheDocument();
    expect(
      container.querySelector("[data-sidebar-chat-ready-status]"),
    ).toBeInTheDocument();
  });

  it("shows a chat menu icon for idle chats without an activity indicator", () => {
    const { container } = render(
      <SidebarChatRow id="session-1" title="Idle Chat" isActive={false} />,
    );

    expect(screen.getByTestId("sidebar-chat-menu-icon")).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="berd-loader-inline"]'),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/chat active/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/unread messages/i)).not.toBeInTheDocument();
  });

  it("uses the project identity icon in flat project rows", () => {
    const { container } = render(
      <SidebarChatRow
        id="session-1"
        title="Idle Chat"
        isActive={false}
        flatProjectName="Project One"
      />,
    );

    expect(screen.queryByTestId("sidebar-chat-menu-icon")).toBeNull();
    expect(screen.getByTestId("sidebar-flat-chat-project-icon")).toHaveClass(
      "text-sidebar-foreground",
    );
    expect(screen.queryByText("Project One")).not.toBeInTheDocument();
    expect(screen.getByText("Idle Chat")).toBeInTheDocument();
    const projectIcon = container.querySelector(
      "[data-sidebar-flat-project-icon]",
    );
    expect(projectIcon?.tagName).toBe("SPAN");

    if (!projectIcon) {
      throw new Error("Flat project icon was not rendered");
    }
  });

  it("uses dense flat-row spacing when requested", () => {
    const { container } = render(
      <SidebarChatRow
        id="session-1"
        title="Idle Chat"
        isActive={false}
        density="dense"
        flatProjectName="Project One"
      />,
    );

    expect(container.querySelector("[data-sidebar-chat-row]")).toHaveAttribute(
      "data-sidebar-chat-density",
      "dense",
    );
    expect(container.querySelector("[data-sidebar-chat-row]")).toHaveClass(
      "gap-2",
    );
    expect(screen.getByRole("button", { name: "Idle Chat" })).toHaveClass(
      "pl-0",
      "pr-8",
    );
    expect(
      container.querySelector("[data-sidebar-flat-project-icon]")?.parentElement
        ?.parentElement,
    ).toHaveClass("ml-3", "size-5");
    expect(
      container.querySelector("[data-sidebar-flat-project-icon]")?.parentElement
        ?.parentElement,
    ).not.toHaveClass("absolute");
    expect(
      screen.getByRole("button", { name: "Options for Idle Chat" }),
    ).toHaveClass("right-3");
  });

  it("puts flat-row project editing in the chat menu", async () => {
    const user = userEvent.setup();
    const onEditProject = vi.fn();
    const onSelect = vi.fn();
    const { container } = render(
      <SidebarChatRow
        id="session-1"
        title="Running Chat"
        isActive={false}
        isRunning
        density="dense"
        flatProjectName="Project One"
        flatProjectColor="sage"
        currentProjectId="project-1"
        onEditProject={onEditProject}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByLabelText(/chat active/i)).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="active-chat-pulse-dot"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-project-color-swatch="project-1"]'),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit project/i })).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Options for Running Chat" }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Edit Project One Project" }),
    );

    expect(onEditProject).toHaveBeenCalledWith("project-1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not use native HTML draggable affordances", () => {
    const { container } = render(
      <SidebarChatRow id="session-1" title="Idle Chat" isActive={false} />,
    );

    expect(container.querySelector("[draggable]")).not.toBeInTheDocument();
    expect(
      container.querySelector("[data-sidebar-chat-draggable]"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Idle Chat" })).toHaveClass(
      "cursor-pointer",
    );
  });

  it("toggles selection with command-click instead of selecting the row", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onSelectionChange = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title="Selectable Chat"
        isActive={false}
        onSelect={onSelect}
        onSelectionChange={onSelectionChange}
      />,
    );

    await user.keyboard("[MetaLeft>]");
    await user.click(screen.getByRole("button", { name: "Selectable Chat" }));
    await user.keyboard("[/MetaLeft]");

    expect(onSelectionChange).toHaveBeenCalledWith("session-1", true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clears selection and selects the row on plain click while selection is active", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onSelectionClear = vi.fn();
    const onSelectionChange = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title="Selectable Chat"
        isActive={false}
        selected
        selectionEnabled
        onSelect={onSelect}
        onSelectionClear={onSelectionClear}
        onSelectionChange={onSelectionChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Selectable Chat" }));

    expect(onSelectionClear).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("session-1");
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("selects normally when a session window exists but session windows are unsupported", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    mocks.sessionWindowSupport.supported = false;
    mocks.sessionWindowSupport.reason = "unsupported platform";

    useSessionWindowStore
      .getState()
      .setSnapshot([{ sessionId: "session-1", windowLabel: "session:a" }]);

    render(
      <SidebarChatRow
        id="session-1"
        title="Windowed Chat"
        isActive={false}
        onSelect={onSelect}
      />,
    );

    expect(screen.queryByLabelText(/open in window/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Windowed Chat" }));

    expect(focusSessionWindow).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("session-1");
  });

  it("focuses an existing session window instead of selecting the row when session windows are supported", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });

    useSessionWindowStore
      .getState()
      .setSnapshot([{ sessionId: "session-1", windowLabel: "session:a" }]);

    render(
      <SidebarChatRow
        id="session-1"
        title="Windowed Chat"
        isActive={false}
        onSelect={onSelect}
      />,
    );

    expect(await screen.findByLabelText(/open in window/i)).toBeInTheDocument();

    await user.click(
      screen.getAllByRole("button", { name: /windowed chat/i })[0],
    );

    expect(focusSessionWindow).toHaveBeenCalledWith("session-1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows the trailing ready dot only when the chat has unread output", () => {
    const { rerender } = render(
      <SidebarChatRow id="session-1" title="Recent Chat" isActive={false} />,
    );

    expect(screen.queryByLabelText(/unread messages/i)).not.toBeInTheDocument();

    rerender(
      <SidebarChatRow
        id="session-1"
        title="Recent Chat"
        isActive={false}
        hasUnread
      />,
    );

    expect(
      screen.getByLabelText(/unread messages/i).firstElementChild,
    ).toHaveClass("bg-success");
  });

  it("hides the unread dot while the chat is running", () => {
    render(
      <SidebarChatRow
        id="session-1"
        title="Running Chat"
        isActive={false}
        isRunning
        hasUnread
      />,
    );

    expect(screen.queryByLabelText(/unread messages/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/chat active/i)).toBeInTheDocument();
  });

  it("can mark an idle chat unread from the menu", async () => {
    const user = userEvent.setup();
    const onMarkUnread = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title="Idle Chat"
        isActive={false}
        onMarkUnread={onMarkUnread}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for idle chat/i }),
    );
    await user.click(screen.getByRole("menuitem", { name: /mark unread/i }));

    expect(onMarkUnread).toHaveBeenCalledWith("session-1");
  });

  it("can duplicate an idle chat from the menu", async () => {
    const user = userEvent.setup();
    const onFork = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title="Idle Chat"
        isActive={false}
        onFork={onFork}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for idle chat/i }),
    );
    await user.click(screen.getByRole("menuitem", { name: /duplicate/i }));

    expect(onFork).toHaveBeenCalledWith("session-1");
  });

  it("reveals a quick pin in the flat project icon slot", async () => {
    const user = userEvent.setup();
    useHomeWidgetStore.setState({
      loadStatus: "ready",
      itemRevision: 1,
      camera: { centerX: 0, centerY: 0, zoomBps: 10_000 },
    });

    const { container } = render(
      <SidebarChatRow
        id="session-1"
        title="Idle Chat"
        isActive={false}
        flatProjectName="Project One"
      />,
    );

    const row = container.querySelector("[data-sidebar-chat-row]");
    if (!row) throw new Error("Sidebar chat row was not rendered");
    await user.hover(row);

    const pin = screen.getByRole("button", { name: "Pin chat" });
    expect(pin).toHaveClass("size-full");
    expect(
      screen.getByTestId("sidebar-flat-chat-project-icon"),
    ).toBeInTheDocument();

    await user.click(pin);
    expect(
      useHomeWidgetStore
        .getState()
        .instances.some(
          (instance) =>
            instance.type === "chatPin" &&
            instance.state?.sessionId === "session-1",
        ),
    ).toBe(true);
  });

  it("keeps refreshed-primary pin controls outside the row button", () => {
    render(
      <SidebarChatRow
        id="refreshed-chat"
        title="Refreshed Chat"
        isActive={false}
        showLeadingIcon
        quickPinMode="always"
        geometry="refreshed-primary"
        leadingIconTestId="refreshed-chat-leading"
      />,
    );

    const rowButton = screen.getByRole("button", { name: "Refreshed Chat" });
    expect(rowButton).toHaveClass("pl-8");
    expect(screen.getByTestId("refreshed-chat-leading")).toHaveClass(
      "absolute",
      "left-2",
    );
    expect(screen.getByRole("button", { name: "Pin chat" })).not.toBe(
      rowButton,
    );
    expect(rowButton.querySelector("button")).toBeNull();
  });

  it("aligns grouped general chat icons and titles across pin states", () => {
    useHomeWidgetStore.setState({
      loadStatus: "ready",
      itemRevision: 1,
      camera: { centerX: 0, centerY: 0, zoomBps: 10_000 },
      instances: [
        {
          id: "chat-pin-1",
          type: "chatPin",
          x: 0,
          y: 0,
          z: 1,
          state: { sessionId: "pinned-chat" },
        },
      ],
    });

    render(
      <>
        <SidebarChatRow
          id="pinned-chat"
          title="Pinned Chat"
          isActive={false}
          showLeadingIcon
          quickPinMode="always"
          leadingIconTestId="pinned-chat-leading"
        />
        <SidebarChatRow
          id="regular-chat"
          title="Regular Chat"
          isActive={false}
          showLeadingIcon
          quickPinMode="always"
          leadingIconTestId="regular-chat-leading"
        />
      </>,
    );

    expect(screen.getByRole("button", { name: "Pinned Chat" })).toHaveClass(
      "pl-[38px]",
    );
    expect(screen.getByRole("button", { name: "Regular Chat" })).toHaveClass(
      "pl-[38px]",
    );
    expect(screen.getByTestId("pinned-chat-leading")).toHaveClass(
      "absolute",
      "left-3",
    );
    expect(screen.getByTestId("regular-chat-leading")).toHaveClass(
      "absolute",
      "left-3",
    );
    expect(screen.getByRole("button", { name: "Pin chat" })).toHaveAttribute(
      "tabindex",
      "-1",
    );
  });

  it("aligns a grouped general chat pin with titles when chat icons are hidden", () => {
    useHomeWidgetStore.setState({
      loadStatus: "ready",
      itemRevision: 1,
      camera: { centerX: 0, centerY: 0, zoomBps: 10_000 },
      instances: [
        {
          id: "chat-pin-1",
          type: "chatPin",
          x: 0,
          y: 0,
          z: 1,
          state: { sessionId: "pinned-chat" },
        },
      ],
    });

    render(
      <>
        <SidebarChatRow
          id="pinned-chat"
          title="Pinned Chat"
          isActive={false}
          showLeadingIcon={false}
          quickPinMode="pinned-only"
          leadingIconTestId="pinned-chat-leading"
        />
        <SidebarChatRow
          id="regular-chat"
          title="Regular Chat"
          isActive={false}
          showLeadingIcon={false}
          quickPinMode="pinned-only"
          leadingIconTestId="regular-chat-leading"
        />
      </>,
    );

    expect(screen.getByRole("button", { name: "Pinned Chat" })).toHaveClass(
      "pl-[38px]",
    );
    expect(screen.getByRole("button", { name: "Regular Chat" })).toHaveClass(
      "pl-3",
    );
    expect(screen.getByTestId("pinned-chat-leading")).toHaveClass(
      "absolute",
      "left-3",
    );
    expect(screen.getByRole("button", { name: "Unpin chat" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Pin chat" })).toBeNull();
    expect(screen.queryByTestId("regular-chat-leading")).toBeNull();
  });

  it("keeps an always-pin chat's pin control visible when chat icons are hidden", () => {
    useHomeWidgetStore.setState({
      loadStatus: "ready",
      itemRevision: 1,
      camera: { centerX: 0, centerY: 0, zoomBps: 10_000 },
      instances: [
        {
          id: "chat-pin-1",
          type: "chatPin",
          x: 0,
          y: 0,
          z: 1,
          state: { sessionId: "pinned-chat" },
        },
      ],
    });

    render(
      <SidebarChatRow
        id="pinned-chat"
        title="Pinned Chat"
        isActive={false}
        showLeadingIcon={false}
        quickPinMode="always"
        leadingIconTestId="pinned-chat-leading"
      />,
    );

    expect(screen.getByTestId("pinned-chat-leading")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unpin chat" })).toBeVisible();
  });

  it("keeps nested chat titles aligned when chat icons are shown", () => {
    const { rerender } = render(
      <SidebarChatRow
        id="session-1"
        title="Idle Chat"
        isActive={false}
        nested
        showLeadingIcon={false}
      />,
    );

    const titleButton = screen.getByRole("button", { name: "Idle Chat" });
    expect(titleButton).toHaveClass("pl-[38px]");
    expect(screen.queryByTestId("sidebar-chat-icon")).toBeNull();

    rerender(
      <SidebarChatRow
        id="session-1"
        title="Idle Chat"
        isActive={false}
        nested
        showLeadingIcon
        leadingIconTestId="sidebar-chat-icon"
      />,
    );

    expect(screen.getByRole("button", { name: "Idle Chat" })).toHaveClass(
      "pl-[38px]",
    );
    expect(screen.getByTestId("sidebar-chat-icon")).toHaveClass(
      "absolute",
      "left-3",
    );
  });

  it("keeps nested project chats aligned when chat icons are hidden", () => {
    render(
      <SidebarChatRow
        id="project-chat"
        title="Project Chat"
        isActive={false}
        nested
        showLeadingIcon={false}
        leadingIconTestId="project-chat-leading"
      />,
    );

    expect(screen.getByRole("button", { name: "Project Chat" })).toHaveClass(
      "pl-[38px]",
    );
    expect(screen.getByTestId("project-chat-leading")).toHaveClass(
      "absolute",
      "left-3",
    );
    expect(screen.queryByTestId("sidebar-chat-menu-icon")).toBeNull();
  });

  it("reveals a one-click pin action when chat icons are shown", async () => {
    const user = userEvent.setup();
    useHomeWidgetStore.setState({
      loadStatus: "ready",
      itemRevision: 1,
      camera: { centerX: 0, centerY: 0, zoomBps: 10_000 },
    });

    const { container } = render(
      <SidebarChatRow id="session-1" title="Idle Chat" isActive={false} />,
    );

    const row = container.querySelector("[data-sidebar-chat-row]");
    if (!row) throw new Error("Sidebar chat row was not rendered");
    await user.hover(row);
    const pinButton = screen.getByRole("button", { name: "Pin chat" });
    expect(
      screen.getByRole("button", { name: "Idle Chat" }),
    ).not.toContainElement(pinButton);
    await user.click(pinButton);

    expect(
      useHomeWidgetStore
        .getState()
        .instances.some(
          (instance) =>
            instance.type === "chatPin" &&
            instance.state?.sessionId === "session-1",
        ),
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: "Unpin chat" }));

    expect(
      useHomeWidgetStore
        .getState()
        .instances.some(
          (instance) =>
            instance.type === "chatPin" &&
            instance.state?.sessionId === "session-1",
        ),
    ).toBe(false);
  });

  it("shows a pinned compact chat as a one-click unpin control", async () => {
    const user = userEvent.setup();
    useHomeWidgetStore.setState({
      loadStatus: "ready",
      itemRevision: 1,
      camera: { centerX: 0, centerY: 0, zoomBps: 10_000 },
      instances: [
        {
          id: "chat-pin-1",
          type: "chatPin",
          x: 0,
          y: 0,
          z: 1,
          state: { sessionId: "session-1" },
        },
      ],
    });

    render(
      <SidebarChatRow
        id="session-1"
        title="Idle Chat"
        isActive={false}
        showLeadingIcon={false}
        quickPinMode="pinned-only"
      />,
    );

    const unpin = screen.getByRole("button", { name: "Unpin chat" });
    expect(unpin).toHaveClass("size-full");
    expect(screen.getByRole("button", { name: "Idle Chat" })).toHaveClass(
      "pl-[38px]",
    );

    await user.click(unpin);
    expect(
      useHomeWidgetStore
        .getState()
        .instances.some(
          (instance) =>
            instance.type === "chatPin" &&
            instance.state?.sessionId === "session-1",
        ),
    ).toBe(false);
  });

  it("keeps the hover-only quick pin action out of the tab order", () => {
    render(
      <SidebarChatRow id="session-1" title="Idle Chat" isActive={false} />,
    );

    expect(screen.getByRole("button", { name: "Pin chat" })).toHaveAttribute(
      "tabindex",
      "-1",
    );
  });

  it("shows pin chat in the chat options menu", async () => {
    const user = userEvent.setup();

    render(
      <SidebarChatRow id="session-1" title="Idle Chat" isActive={false} />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for idle chat/i }),
    );

    expect(
      screen.getByRole("menuitem", { name: /pin chat/i }),
    ).toBeInTheDocument();
  });

  it("opens the chat options as a cursor-anchored context menu on right-click", async () => {
    const { container } = render(
      <SidebarChatRow id="session-1" title="Idle Chat" isActive={false} />,
    );

    const row = container.querySelector("[data-sidebar-chat-row]");
    if (!row) {
      throw new Error("Sidebar chat row was not rendered");
    }

    fireEvent.contextMenu(row, { clientX: 128, clientY: 256 });

    expect(
      await screen.findByRole("menuitem", { name: /rename/i }),
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-slot="context-menu-content"]'),
    ).toHaveAttribute("data-variant", "raised");
    expect(
      document.querySelector('[data-slot="context-menu-content"]'),
    ).toHaveClass("w-52", "px-1", "py-1", "text-sm");
    expect(
      document.querySelector('[data-slot="dropdown-menu-content"]'),
    ).not.toBeInTheDocument();
  });

  it("uses the native clipboard for an encoded chat link in Berd", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    const { container } = render(
      <SidebarChatRow
        id="id/with spaces?#"
        title="Idle Chat"
        isActive={false}
      />,
    );

    const row = container.querySelector("[data-sidebar-chat-row]");
    if (!row) {
      throw new Error("Sidebar chat row was not rendered");
    }

    fireEvent.contextMenu(row, { clientX: 128, clientY: 256 });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /copy chat link/i }),
    );

    await waitFor(() =>
      expect(mocks.writeTextToTauriClipboard).toHaveBeenCalledWith(
        "berd://session/id%2Fwith%20spaces%3F%23",
      ),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Local chat link copied. It only works on this device.",
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("copies an encoded chat link from the right-click menu in the browser", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: undefined,
    });
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(
      <SidebarChatRow
        id="id/with spaces?#"
        title="Idle Chat"
        isActive={false}
      />,
    );

    const row = container.querySelector("[data-sidebar-chat-row]");
    if (!row) {
      throw new Error("Sidebar chat row was not rendered");
    }

    fireEvent.contextMenu(row, { clientX: 128, clientY: 256 });
    await user.click(
      await screen.findByRole("menuitem", { name: /copy chat link/i }),
    );

    expect(writeText).toHaveBeenCalledWith(
      "berd://session/id%2Fwith%20spaces%3F%23",
    );
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Local chat link copied. It only works on this device.",
      ),
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("shows an error when the native clipboard write fails", async () => {
    const user = userEvent.setup();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    mocks.writeTextToTauriClipboard.mockRejectedValue(new Error("denied"));
    const { container } = render(
      <SidebarChatRow id="session-1" title="Idle Chat" isActive={false} />,
    );

    const row = container.querySelector("[data-sidebar-chat-row]");
    if (!row) {
      throw new Error("Sidebar chat row was not rendered");
    }

    fireEvent.contextMenu(row, { clientX: 128, clientY: 256 });
    await user.click(
      await screen.findByRole("menuitem", { name: /copy chat link/i }),
    );

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Couldn't copy the local chat link.",
      ),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("shows an error when the Clipboard API is unavailable", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: undefined,
    });
    const user = userEvent.setup();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const { container } = render(
      <SidebarChatRow id="session-1" title="Idle Chat" isActive={false} />,
    );

    const row = container.querySelector("[data-sidebar-chat-row]");
    if (!row) {
      throw new Error("Sidebar chat row was not rendered");
    }

    fireEvent.contextMenu(row, { clientX: 128, clientY: 256 });
    await user.click(
      await screen.findByRole("menuitem", { name: /copy chat link/i }),
    );

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Couldn't copy the local chat link.",
      ),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("does not show selection actions in the chat options menu", async () => {
    const user = userEvent.setup();

    render(
      <SidebarChatRow
        id="session-1"
        title="Idle Chat"
        isActive={false}
        onSelectionChange={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for idle chat/i }),
    );

    expect(
      screen.queryByRole("menuitem", { name: /select idle chat/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the unpin-chat option for an already pinned chat", async () => {
    const user = userEvent.setup();
    useHomeWidgetStore.setState({
      instances: [
        {
          id: "pin-1",
          type: "chatPin",
          x: 0,
          y: 0,
          z: 1,
          state: { sessionId: "session-1" },
        },
      ],
    });

    render(
      <SidebarChatRow id="session-1" title="Idle Chat" isActive={false} />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for idle chat/i }),
    );

    expect(
      screen.getByRole("menuitem", { name: /unpin chat/i }),
    ).not.toHaveAttribute("aria-disabled", "true");
  });

  it("can mark an unread chat read from the menu", async () => {
    const user = userEvent.setup();
    const onMarkRead = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title="Unread Chat"
        isActive={false}
        hasUnread
        onMarkRead={onMarkRead}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for unread chat/i }),
    );
    await user.click(screen.getByRole("menuitem", { name: /mark read/i }));

    expect(onMarkRead).toHaveBeenCalledWith("session-1");
  });

  it("range-selects with shift-click instead of opening the chat", async () => {
    const user = userEvent.setup();
    const onRangeSelect = vi.fn();
    const onSelect = vi.fn();
    const onSelectionChange = vi.fn();

    render(
      <SidebarChatRow
        id="session-3"
        title="Range Chat"
        isActive={false}
        onRangeSelect={onRangeSelect}
        onSelect={onSelect}
        onSelectionChange={onSelectionChange}
      />,
    );

    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: "Range Chat" }));
    await user.keyboard("{/Shift}");

    expect(onRangeSelect).toHaveBeenCalledWith("session-3");
    expect(onSelect).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("hides single-chat actions and keeps bulk actions when multiple chats are selected", async () => {
    const user = userEvent.setup();

    render(
      <SidebarChatRow
        id="session-1"
        title="Bulk Chat"
        isActive={false}
        selected
        selectionEnabled
        selectedSessionIds={new Set(["session-1", "session-2"])}
        onSelectionChange={vi.fn()}
        onFork={vi.fn()}
        onArchiveSelected={vi.fn()}
        onMarkSelectedUnread={vi.fn()}
        onOpenSelectedInWindows={vi.fn()}
        onPinSelectedToHome={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for bulk chat/i }),
    );

    expect(screen.getByText("2 chats selected")).toBeInTheDocument();

    for (const name of [/rename/i, /duplicate/i, /copy chat link/i]) {
      expect(screen.queryByRole("menuitem", { name })).not.toBeInTheDocument();
    }
    for (const name of ["Pin chats", /mark unread/i, /archive/i]) {
      expect(screen.getByRole("menuitem", { name })).not.toHaveAttribute(
        "aria-disabled",
        "true",
      );
    }
  });

  it("opens every selected chat in its own window from the bulk menu", async () => {
    const user = userEvent.setup();
    const onOpenSelectedInWindows = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title="Bulk Chat"
        isActive={false}
        selected
        selectionEnabled
        selectedSessionIds={new Set(["session-1", "session-2"])}
        onSelectionChange={vi.fn()}
        onOpenSelectedInWindows={onOpenSelectedInWindows}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for bulk chat/i }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /open in new windows/i }),
    );

    expect(onOpenSelectedInWindows).toHaveBeenCalledTimes(1);
  });

  it("offers unpin for a fully pinned multi-selection", async () => {
    const user = userEvent.setup();
    const onUnpinSelectedFromHome = vi.fn();
    const onPinSelectedToHome = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title="Bulk Chat"
        isActive={false}
        selected
        selectionEnabled
        selectedSessionIds={new Set(["session-1", "session-2"])}
        onSelectionChange={vi.fn()}
        isSelectionPinnedToHome
        onPinSelectedToHome={onPinSelectedToHome}
        onUnpinSelectedFromHome={onUnpinSelectedFromHome}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /options for bulk chat/i }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Unpin chats" }),
    );

    expect(onUnpinSelectedFromHome).toHaveBeenCalledTimes(1);
    expect(onPinSelectedToHome).not.toHaveBeenCalled();
  });

  it("keeps the localized default title in rename mode without persisting it", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();

    render(
      <SidebarChatRow
        id="session-1"
        title={DEFAULT_CHAT_TITLE}
        isActive={false}
        onRename={onRename}
      />,
    );

    await user.dblClick(screen.getByRole("button", { name: "New chat" }));

    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("New chat");

    await user.tab();

    expect(onRename).not.toHaveBeenCalled();
  });

  it("formats sidebar chat activity as compact single-unit relative time", () => {
    const now = new Date("2026-07-07T12:00:00");

    expect(formatSidebarChatTimestamp("2026-07-07T11:59:40", { now })).toBe(
      "now",
    );
    expect(formatSidebarChatTimestamp("2026-07-07T11:55:00", { now })).toBe(
      "5m",
    );
    expect(formatSidebarChatTimestamp("2026-07-07T09:00:00", { now })).toBe(
      "3h",
    );
    expect(formatSidebarChatTimestamp("2026-07-05T12:00:00", { now })).toBe(
      "2d",
    );
    expect(formatSidebarChatTimestamp("2026-06-22T12:00:00", { now })).toBe(
      "2w",
    );
    expect(formatSidebarChatTimestamp("2026-05-01T12:00:00", { now })).toBe(
      "2mo",
    );
    expect(formatSidebarChatTimestamp("2024-07-07T12:00:00", { now })).toBe(
      "2y",
    );
  });

  it("returns empty for missing or invalid activity values", () => {
    expect(formatSidebarChatTimestamp(undefined)).toBe("");
    expect(formatSidebarChatTimestamp(null)).toBe("");
    expect(formatSidebarChatTimestamp("  ")).toBe("");
    expect(formatSidebarChatTimestamp("not a timestamp")).toBe("");
  });

  it("renders a Git branch when a branch name is provided", () => {
    const { container } = render(
      <SidebarChatRow
        id="session-1"
        title="Refactor session list"
        branchName="feature/sidebar-branch"
        isActive={false}
      />,
    );

    expect(screen.getByText("Refactor session list")).toBeInTheDocument();
    expect(screen.getByText("feature/sidebar-branch")).toBeInTheDocument();
    expect(container.querySelector(".flex-col")).toBeInTheDocument();
  });

  it("renders a compact activity timestamp on the right edge of the row", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000);

    const { container } = render(
      <SidebarChatRow
        id="session-1"
        title="Refactor session list"
        activityAt={fiveMinutesAgo.toISOString()}
        isActive={false}
      />,
    );

    const timestamp = container.querySelector(
      "[data-sidebar-chat-timestamp]",
    ) as HTMLElement;
    expect(timestamp).toBeInTheDocument();
    expect(timestamp).toHaveTextContent("5m");
    expect(timestamp).toHaveClass("text-muted-foreground/70");
    expect(screen.getByText("Refactor session list")).toBeInTheDocument();
  });

  it("omits the timestamp when the activity value is missing or invalid", () => {
    const { container, rerender } = render(
      <SidebarChatRow id="session-1" title="No activity" isActive={false} />,
    );
    expect(
      container.querySelector("[data-sidebar-chat-timestamp]"),
    ).not.toBeInTheDocument();

    rerender(
      <SidebarChatRow
        id="session-1"
        title="No activity"
        activityAt="not a timestamp"
        isActive={false}
      />,
    );
    expect(
      container.querySelector("[data-sidebar-chat-timestamp]"),
    ).not.toBeInTheDocument();
  });

  it("renders the timestamp on flat chat rows too", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);

    const { container } = render(
      <SidebarChatRow
        id="session-1"
        title="Refactor session list"
        activityAt={twoHoursAgo.toISOString()}
        isActive={false}
        density="dense"
        flatProjectName="Project One"
      />,
    );

    const timestamp = container.querySelector(
      "[data-sidebar-chat-timestamp]",
    ) as HTMLElement;
    expect(timestamp).toBeInTheDocument();
    expect(timestamp).toHaveTextContent("2h");
    expect(screen.getByText("Refactor session list")).toBeInTheDocument();
  });
  it("stays a single line for sessions without a usable branch", () => {
    const { container, rerender } = render(
      <SidebarChatRow id="session-1" title="No snippet" isActive={false} />,
    );

    expect(screen.getByText("No snippet")).toBeInTheDocument();
    // The two-line column wrapper only renders when a branch is shown.
    expect(container.querySelector(".flex-col")).toBeNull();

    // Whitespace-only branch names are treated as absent.
    rerender(
      <SidebarChatRow
        id="session-1"
        title="No snippet"
        branchName="   "
        isActive={false}
      />,
    );
    expect(screen.getByText("No snippet")).toBeInTheDocument();
    expect(container.querySelector(".flex-col")).toBeNull();
  });
});
