import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { SHORTCUT_PREFERENCES_STORAGE_KEY } from "@/features/shortcuts/lib/shortcutRegistry";
import { isEditableTarget } from "@/shared/keyboard/isEditableTarget";
import {
  FocusRegionProvider,
  getNearestFocusRegion,
  getVisibleFocusRegions,
  hasOpenKeyboardOwningLayer,
  normalizePaneJumpShortcut,
  useFocusRegion,
  type FocusRegionRegistration,
} from "./FocusRegionProvider";
import { getPaneJumpBadgePosition } from "./PaneJumpOverlay";

function rect(left: number, top: number, width = 100, height = 80): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function Region({ registration }: { registration: FocusRegionRegistration }) {
  useFocusRegion(registration);
  return null;
}

function TestRegion({
  id,
  shortcutKey,
  label,
}: Pick<FocusRegionRegistration, "id" | "label"> & { shortcutKey: string }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useFocusRegion({
    id,
    key: shortcutKey,
    label,
    enabled: true,
    element,
  });
  return (
    <div ref={setElement} tabIndex={-1}>
      {label}
    </div>
  );
}

describe("isEditableTarget", () => {
  it("matches editable form fields and contenteditable nodes", () => {
    render(
      <>
        <input aria-label="input" />
        <textarea aria-label="textarea" />
        <select aria-label="select" />
        <div contentEditable data-testid="editable" />
        <div className="xterm">
          <textarea aria-label="terminal input" />
        </div>
        <button type="button">button</button>
      </>,
    );

    expect(isEditableTarget(screen.getByLabelText("input"))).toBe(true);
    expect(isEditableTarget(screen.getByLabelText("textarea"))).toBe(true);
    expect(isEditableTarget(screen.getByLabelText("select"))).toBe(true);
    expect(isEditableTarget(screen.getByTestId("editable"))).toBe(true);
    expect(isEditableTarget(screen.getByLabelText("terminal input"))).toBe(
      false,
    );
    expect(isEditableTarget(screen.getByRole("button"))).toBe(false);
  });
});

describe("focus region helpers", () => {
  it("normalizes pane jump shortcut config", () => {
    expect(normalizePaneJumpShortcut(" Control + K ")).toBe("ctrl+k");
    expect(normalizePaneJumpShortcut("Ctrl+.")).toBe("ctrl+.");
    expect(normalizePaneJumpShortcut("shift+k")).toBe("shift+k");
    // A doubled separator means the "+" key; a single dangling one is
    // invalid and falls back.
    expect(normalizePaneJumpShortcut("ctrl++")).toBe("ctrl+plus");
    expect(normalizePaneJumpShortcut("ctrl+")).toBe("ctrl+;");
    expect(normalizePaneJumpShortcut("bogus+k")).toBe("ctrl+;");
    expect(normalizePaneJumpShortcut(undefined)).toBe("ctrl+;");
  });

  it("filters disabled, hidden, inert, and zero-size regions", () => {
    const visible = document.createElement("div");
    const hidden = document.createElement("div");
    const inert = document.createElement("div");
    const zero = document.createElement("div");
    hidden.setAttribute("aria-hidden", "true");
    inert.setAttribute("inert", "");
    vi.spyOn(visible, "getBoundingClientRect").mockReturnValue(rect(0, 0));
    vi.spyOn(hidden, "getBoundingClientRect").mockReturnValue(rect(0, 0));
    vi.spyOn(inert, "getBoundingClientRect").mockReturnValue(rect(0, 0));
    vi.spyOn(zero, "getBoundingClientRect").mockReturnValue(rect(0, 0, 0, 0));

    const regions = getVisibleFocusRegions([
      {
        id: "terminal",
        label: "terminal",
        key: "t",
        enabled: true,
        element: visible,
      },
      {
        id: "sidebar",
        label: "side",
        key: "s",
        enabled: true,
        element: hidden,
      },
      { id: "main", label: "main", key: "m", enabled: true, element: inert },
      {
        id: "context",
        label: "context",
        key: "x",
        enabled: true,
        element: zero,
      },
      {
        id: "composer",
        label: "composer",
        key: "c",
        enabled: false,
        element: visible,
      },
    ]);

    expect(regions.map((region) => region.id)).toEqual(["terminal"]);
  });

  it("selects the nearest region in a vim direction", () => {
    const current = {
      id: "main" as const,
      label: "main",
      key: "m",
      enabled: true,
      element: document.createElement("div"),
      rect: rect(200, 100),
    };
    const left = { ...current, id: "sidebar" as const, rect: rect(0, 100) };
    const down = { ...current, id: "terminal" as const, rect: rect(200, 260) };
    const farRight = {
      ...current,
      id: "context" as const,
      rect: rect(500, 260),
    };

    expect(
      getNearestFocusRegion(current, [current, left, down, farRight], "left")
        ?.id,
    ).toBe("sidebar");
    expect(
      getNearestFocusRegion(current, [current, left, down, farRight], "down")
        ?.id,
    ).toBe("terminal");
  });

  it("places top-edge badges below their region", () => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });

    expect(getPaneJumpBadgePosition(rect(0, 0, 1000, 48))).toEqual({
      top: 56,
      left: 8,
    });
  });
});

describe("FocusRegionProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("opens, cancels with Escape, and times out", () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      rect(0, 0),
    );

    render(
      <FocusRegionProvider>
        <TestRegion id="main" shortcutKey="m" label="main content" />
      </FocusRegionProvider>,
    );

    fireEvent.keyDown(window, { key: ";", ctrlKey: true });
    expect(screen.getByTestId("pane-jump-overlay")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("pane-jump-overlay")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: ";", ctrlKey: true });
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(screen.queryByTestId("pane-jump-overlay")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("does not open when disabled", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      rect(0, 0),
    );

    render(
      <FocusRegionProvider enabled={false}>
        <TestRegion id="main" shortcutKey="m" label="main content" />
      </FocusRegionProvider>,
    );

    fireEvent.keyDown(window, { key: ";", ctrlKey: true });
    expect(screen.queryByTestId("pane-jump-overlay")).not.toBeInTheDocument();
  });

  it("opens with a user-overridden shortcut from the registry", () => {
    window.localStorage.setItem(
      SHORTCUT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        overrides: { "navigation.paneJump": "ctrl+." },
      }),
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      rect(0, 0),
    );

    render(
      <FocusRegionProvider>
        <TestRegion id="main" shortcutKey="m" label="main content" />
      </FocusRegionProvider>,
    );

    fireEvent.keyDown(window, { key: ";", ctrlKey: true });
    expect(screen.queryByTestId("pane-jump-overlay")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: ".", ctrlKey: true });
    expect(screen.getByTestId("pane-jump-overlay")).toBeInTheDocument();
  });

  it("closes after a successful directional move", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return this.textContent === "sidebar" ? rect(0, 0) : rect(200, 0);
      },
    );

    render(
      <FocusRegionProvider>
        <TestRegion id="sidebar" shortcutKey="s" label="sidebar" />
        <TestRegion id="main" shortcutKey="m" label="main" />
      </FocusRegionProvider>,
    );

    screen.getByText("sidebar").focus();
    fireEvent.keyDown(window, { key: ";", ctrlKey: true });
    fireEvent.keyDown(window, { key: "l" });

    expect(screen.getByText("main")).toHaveFocus();
    expect(screen.queryByTestId("pane-jump-overlay")).not.toBeInTheDocument();
  });

  it("keeps pane jump mode open when a directional move has no target", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      rect(0, 0),
    );

    render(
      <FocusRegionProvider>
        <TestRegion id="main" shortcutKey="m" label="main" />
      </FocusRegionProvider>,
    );

    fireEvent.keyDown(window, { key: ";", ctrlKey: true });
    fireEvent.keyDown(window, { key: "l" });

    expect(screen.getByTestId("pane-jump-overlay")).toBeInTheDocument();
  });

  it("opens from an editable field when the prefix is pressed", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      rect(0, 0),
    );
    const textareaKeyDown = vi.fn();

    render(
      <FocusRegionProvider>
        <TestRegion id="main" shortcutKey="m" label="main content" />
        <textarea aria-label="chat message" onKeyDown={textareaKeyDown} />
      </FocusRegionProvider>,
    );

    const chatMessage = screen.getByLabelText("chat message");
    fireEvent.keyDown(chatMessage, {
      key: ";",
      ctrlKey: true,
    });

    expect(screen.getByTestId("pane-jump-overlay")).toBeInTheDocument();

    fireEvent.keyDown(chatMessage, { key: "m" });
    expect(textareaKeyDown).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: "m" }),
    );
    expect(screen.queryByTestId("pane-jump-overlay")).not.toBeInTheDocument();
  });

  it("unregisters regions", () => {
    const element = document.createElement("div");
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect(0, 0));
    const { unmount } = render(
      <FocusRegionProvider>
        <Region
          registration={{
            id: "main",
            label: "main content",
            key: "m",
            enabled: true,
            element,
          }}
        />
      </FocusRegionProvider>,
    );

    unmount();
    expect(getVisibleFocusRegions([])).toEqual([]);
  });

  it("does not treat tooltip poppers as keyboard-owning layers", () => {
    const tooltipWrapper = document.createElement("div");
    tooltipWrapper.dataset.radixPopperContentWrapper = "";
    const tooltip = document.createElement("div");
    tooltip.dataset.slot = "tooltip-content";
    tooltipWrapper.appendChild(tooltip);
    document.body.appendChild(tooltipWrapper);

    expect(hasOpenKeyboardOwningLayer()).toBe(false);

    const menuWrapper = document.createElement("div");
    menuWrapper.dataset.radixPopperContentWrapper = "";
    document.body.appendChild(menuWrapper);

    expect(hasOpenKeyboardOwningLayer()).toBe(true);

    tooltipWrapper.remove();
    menuWrapper.remove();
  });

  it("captures pane jump keys before xterm can type them", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      rect(0, 0),
    );
    const terminalKeyDown = vi.fn();

    render(
      <FocusRegionProvider>
        <TestRegion id="main" shortcutKey="m" label="main content" />
        <div className="xterm">
          <textarea aria-label="terminal input" onKeyDown={terminalKeyDown} />
        </div>
      </FocusRegionProvider>,
    );

    const terminalInput = screen.getByLabelText("terminal input");
    fireEvent.keyDown(terminalInput, { key: ";", ctrlKey: true });
    expect(screen.getByTestId("pane-jump-overlay")).toBeInTheDocument();

    fireEvent.keyDown(terminalInput, { key: "m" });
    expect(terminalKeyDown).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: "m" }),
    );
    expect(screen.queryByTestId("pane-jump-overlay")).not.toBeInTheDocument();
  });
});
