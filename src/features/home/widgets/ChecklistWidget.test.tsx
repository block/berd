import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChecklistWidget } from "./ChecklistWidget";
import type { WidgetRenderProps } from "./types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        "widgets.checklist.label": "Checklist",
        "widgets.checklist.dismiss": "Dismiss checklist",
        "widgets.checklist.toolbar": "Checklist tools",
        "widgets.checklist.titlePlaceholder": "Checklist",
        "widgets.checklist.itemPlaceholder": "List item",
        "widgets.checklist.addItem": "Add item",
        "widgets.checklist.removeItem": "Remove item",
        "widgets.checklist.toggleItem": "Toggle item",
        "widgets.checklist.fontSizes.small": "Small text",
        "widgets.checklist.fontSizes.medium": "Medium text",
        "widgets.checklist.fontSizes.large": "Large text",
        "widgets.checklist.tones.warm": "Warm",
        "widgets.checklist.tones.cool": "Cool",
        "widgets.checklist.tones.rose": "Rose",
        "widgets.checklist.tones.blue": "Blue",
        "widgets.checklist.tones.lavender": "Lavender",
        "widgets.checklist.tones.peach": "Peach",
      };
      return values[key] ?? key;
    },
  }),
}));

const baseProps: WidgetRenderProps = {
  instance: { id: "checklist-test", type: "checklist", x: 0, y: 0, z: 1 },
  onUpdateState: vi.fn(),
};

function withItems(items: Array<{ id: string; text: string; done: boolean }>) {
  return {
    ...baseProps.instance,
    state: { items },
  };
}

describe("ChecklistWidget", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders an empty checklist with an add-item row", () => {
    render(<ChecklistWidget {...baseProps} />);

    expect(
      screen.getByRole("textbox", { name: "Add item" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "List item" }),
    ).not.toBeInTheDocument();
  });

  it("renders existing items with their checked state", () => {
    render(
      <ChecklistWidget
        {...baseProps}
        instance={withItems([
          { id: "a", text: "Ship it", done: false },
          { id: "b", text: "Celebrate", done: true },
        ])}
      />,
    );

    const checkboxes = screen.getAllByRole("checkbox", { name: "Toggle item" });
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toHaveAttribute("aria-checked", "false");
    expect(checkboxes[1]).toHaveAttribute("aria-checked", "true");
  });

  it("adds an item from the add-item row on Enter", () => {
    const onUpdateState = vi.fn();
    render(<ChecklistWidget {...baseProps} onUpdateState={onUpdateState} />);

    const addRow = screen.getByRole("textbox", { name: "Add item" });
    fireEvent.change(addRow, { target: { value: "Buy milk" } });
    fireEvent.keyDown(addRow, { key: "Enter" });

    expect(onUpdateState).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ text: "Buy milk", done: false })],
      }),
    );
  });

  it("toggles an item's done state immediately", () => {
    const onUpdateState = vi.fn();
    render(
      <ChecklistWidget
        {...baseProps}
        onUpdateState={onUpdateState}
        instance={withItems([{ id: "a", text: "Ship it", done: false }])}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Toggle item" }));

    expect(onUpdateState).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ id: "a", done: true })],
      }),
    );
  });

  it("debounces item text edits into widget state", async () => {
    vi.useFakeTimers();
    const onUpdateState = vi.fn();
    render(
      <ChecklistWidget
        {...baseProps}
        onUpdateState={onUpdateState}
        instance={withItems([{ id: "a", text: "Ship", done: false }])}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "List item" }), {
      target: { value: "Ship it" },
    });
    expect(onUpdateState).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(onUpdateState).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ id: "a", text: "Ship it" })],
      }),
    );
  });

  it("adds a new item after the current one on Enter", () => {
    const onUpdateState = vi.fn();
    render(
      <ChecklistWidget
        {...baseProps}
        onUpdateState={onUpdateState}
        instance={withItems([{ id: "a", text: "First", done: false }])}
      />,
    );

    fireEvent.keyDown(screen.getByRole("textbox", { name: "List item" }), {
      key: "Enter",
    });

    expect(onUpdateState).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({ id: "a", text: "First" }),
          expect.objectContaining({ text: "" }),
        ],
      }),
    );
  });

  it("removes an item via the remove button", () => {
    const onUpdateState = vi.fn();
    render(
      <ChecklistWidget
        {...baseProps}
        onUpdateState={onUpdateState}
        instance={withItems([{ id: "a", text: "Ship it", done: false }])}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove item" }));

    expect(onUpdateState).toHaveBeenCalledWith(
      expect.objectContaining({ items: [] }),
    );
  });

  it("debounces title edits into widget state", async () => {
    vi.useFakeTimers();
    const onUpdateState = vi.fn();
    render(<ChecklistWidget {...baseProps} onUpdateState={onUpdateState} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Checklist" }), {
      target: { value: "Groceries" },
    });

    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(onUpdateState).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Groceries" }),
    );
  });

  it("updates tone and font size from the floating toolbar", () => {
    const onUpdateState = vi.fn();
    render(<ChecklistWidget {...baseProps} onUpdateState={onUpdateState} />);

    fireEvent.click(screen.getByRole("button", { name: "Blue" }));
    fireEvent.click(screen.getByRole("button", { name: "Large text" }));

    expect(onUpdateState).toHaveBeenCalledWith({ tone: "blue" });
    expect(onUpdateState).toHaveBeenCalledWith({ fontSize: "large" });
  });

  it("removes the widget from the dismiss control", () => {
    const onRemoveWidget = vi.fn();
    render(<ChecklistWidget {...baseProps} onRemoveWidget={onRemoveWidget} />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss checklist" }));

    expect(onRemoveWidget).toHaveBeenCalled();
  });

  it("does not bubble pointer down from item inputs", () => {
    const onPointerDown = vi.fn();
    render(
      <div onPointerDown={onPointerDown}>
        <ChecklistWidget {...baseProps} />
      </div>,
    );

    fireEvent.pointerDown(screen.getByRole("textbox", { name: "Add item" }));

    expect(onPointerDown).not.toHaveBeenCalled();
  });
});
