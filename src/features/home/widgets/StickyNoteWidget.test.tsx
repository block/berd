import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StickyNoteWidget } from "./StickyNoteWidget";
import type { WidgetRenderProps } from "./types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        "widgets.stickyNote.label": "Sticky note",
        "widgets.label.label": "Label",
        "widgets.label.placeholder": "Add a heading…",
        "widgets.label.fontFamily.label": "Font family",
        "widgets.label.fontFamily.options.sans": "Inter",
        "widgets.label.fontFamily.options.serif": "Fraunces",
        "widgets.label.fontFamily.options.mono": "Geist Mono",
        "widgets.label.fontFamily.options.comic": "Comic Relief",
        "widgets.label.fontFamily.options.marker": "Permanent Marker",
        "widgets.label.fontSize.label": "Font size in pixels",
        "widgets.label.fontSize.decrease": "Decrease font size",
        "widgets.label.fontSize.increase": "Increase font size",
        "widgets.label.fontSize.unit": "pixels",
        "widgets.stickyNote.dismiss": "Dismiss sticky note",
        "widgets.stickyNote.toolbar": "Sticky note tools",
        "widgets.stickyNote.bold": "Bold",
        "widgets.stickyNote.italic": "Italic",
        "widgets.stickyNote.strikethrough": "Strikethrough",
        "widgets.stickyNote.editAria": "Edit sticky note",
        "widgets.stickyNote.placeholder": "Write a note...",
        "widgets.stickyNote.preview": "Preview",
        "widgets.stickyNote.edit": "Edit",
        "widgets.stickyNote.fontSizes.small": "Small text",
        "widgets.stickyNote.fontSizes.medium": "Medium text",
        "widgets.stickyNote.fontSizes.large": "Large text",
        "widgets.stickyNote.tones.neutral": "Neutral",
        "widgets.stickyNote.tones.warm": "Warm",
        "widgets.stickyNote.tones.cool": "Cool",
        "widgets.stickyNote.tones.rose": "Rose",
        "widgets.stickyNote.tones.blue": "Blue",
        "widgets.stickyNote.tones.lavender": "Lavender",
        "widgets.stickyNote.tones.peach": "Peach",
        "widgets.stickyNote.notes.buildAgent.title": "Build an agent",
        "widgets.stickyNote.notes.buildAgent.body":
          "Give Goose a role, model, and instructions for work you repeat.",
        "widgets.stickyNote.notes.buildAgent.action": "Build agent",
      };
      return values[key] ?? key;
    },
  }),
}));

const baseProps: WidgetRenderProps = {
  instance: { id: "note-test", type: "stickyNote", x: 0, y: 0, z: 1 },
  onUpdateState: vi.fn(),
};

function getEditor() {
  return screen.getByRole("textbox", {
    name: "Edit sticky note",
  }) as HTMLDivElement;
}

describe("StickyNoteWidget", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens an empty note in the editor with a placeholder", () => {
    render(<StickyNoteWidget {...baseProps} />);

    const editor = getEditor();
    expect(editor).toHaveTextContent("");
    expect(editor).toHaveAttribute("data-placeholder", "Write a note...");
  });

  it("keeps existing content directly editable without a preview toggle", () => {
    render(
      <StickyNoteWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { text: "Remember launch notes" },
        }}
      />,
    );

    expect(getEditor()).toHaveTextContent("Remember launch notes");
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("debounces editable note content into widget state", async () => {
    vi.useFakeTimers();
    const onUpdateState = vi.fn();
    render(<StickyNoteWidget {...baseProps} onUpdateState={onUpdateState} />);

    getEditor().textContent = "New note";
    fireEvent.input(getEditor());
    expect(onUpdateState).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(onUpdateState).toHaveBeenCalledWith(
      expect.objectContaining({ text: "New note" }),
    );
  });

  it("flushes editable note content on blur", () => {
    const onUpdateState = vi.fn();
    render(<StickyNoteWidget {...baseProps} onUpdateState={onUpdateState} />);

    const editor = getEditor();
    editor.textContent = "Blurred note";
    fireEvent.input(editor);
    fireEvent.blur(editor);

    expect(onUpdateState).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Blurred note" }),
    );
  });

  it("updates the note tone from the floating toolbar", () => {
    const onUpdateState = vi.fn();
    render(
      <StickyNoteWidget
        {...baseProps}
        onUpdateState={onUpdateState}
        instance={{
          ...baseProps.instance,
          state: { tone: "warm" },
        }}
      />,
    );

    expect(
      screen.getByRole("toolbar", { name: "Sticky note tools" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Blue" }));

    expect(onUpdateState).toHaveBeenCalledWith({ tone: "blue" });
  });

  it("renders label tone as transparent canvas text with large default text", () => {
    render(
      <StickyNoteWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          type: "label",
          state: { text: "ANZ" },
        }}
      />,
    );

    const note = screen.getByLabelText("Label");
    expect(note).toHaveClass("text-foreground");
    expect(note.firstElementChild).toHaveClass(
      "bg-transparent",
      "overflow-visible",
    );
    expect(note.firstElementChild).not.toHaveClass("shadow-sticky-note");
    expect(getEditor()).toHaveClass("whitespace-nowrap", "overflow-visible");
    expect(getEditor()).toHaveStyle({ fontSize: "18px" });
    expect(getEditor()).toHaveAttribute("contenteditable", "false");
    expect(getEditor()).toHaveAttribute("data-placeholder", "Add a heading…");
    expect(
      screen.queryByRole("spinbutton", { name: "Font size in pixels" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Warm" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Dismiss sticky note" }),
    ).toBeNull();
  });

  it("enters label edit mode on double-click and exits on outside click", () => {
    const onUpdateState = vi.fn();
    render(
      <div data-testid="outside">
        <StickyNoteWidget
          {...baseProps}
          onUpdateState={onUpdateState}
          instance={{
            ...baseProps.instance,
            type: "label",
            state: { text: "Roadmap label" },
          }}
        />
      </div>,
    );

    const editor = getEditor();
    const selection = window.getSelection();
    const selectedRange = document.createRange();
    const text = editor.firstChild;
    if (!text) throw new Error("Expected label text");
    selectedRange.setStart(text, 0);
    selectedRange.setEnd(text, 0);
    selection?.removeAllRanges();
    selection?.addRange(selectedRange);
    fireEvent.doubleClick(editor);

    expect(editor).toHaveAttribute("contenteditable", "true");
    expect(editor).toHaveFocus();
    expect(selection?.rangeCount).toBe(1);
    expect(selection?.getRangeAt(0).startOffset).toBe(0);
    expect(selection?.getRangeAt(0).endOffset).toBe(0);
    const input = screen.getByRole("spinbutton", {
      name: "Font size in pixels",
    });
    expect(input).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Increase font size" }));
    expect(onUpdateState).toHaveBeenCalledWith({ fontSizePx: 19 });

    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(editor).toHaveAttribute("contenteditable", "false");
    expect(input).not.toBeVisible();
  });

  it("prevents line breaks in labels", () => {
    render(
      <StickyNoteWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          type: "label",
          state: { text: "Roadmap label" },
        }}
      />,
    );

    fireEvent.doubleClick(getEditor());
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    expect(getEditor().dispatchEvent(enter)).toBe(false);
    expect(getEditor()).toHaveAttribute("aria-multiline", "false");
  });

  it("applies and persists the selected label font family", () => {
    const onUpdateState = vi.fn();
    render(
      <StickyNoteWidget
        {...baseProps}
        onUpdateState={onUpdateState}
        instance={{
          ...baseProps.instance,
          type: "label",
          state: { text: "Roadmap label", fontFamily: "serif" },
        }}
      />,
    );

    expect(getEditor()).toHaveStyle({
      fontFamily: "var(--font-label-serif)",
    });
    fireEvent.doubleClick(getEditor());
    fireEvent.click(screen.getByRole("combobox", { name: "Font family" }));
    fireEvent.click(screen.getByRole("option", { name: "Geist Mono" }));
    expect(onUpdateState).toHaveBeenCalledWith({ fontFamily: "mono" });
  });

  it("previews the nostalgic and handwritten fonts in the family menu", () => {
    render(
      <StickyNoteWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          type: "label",
          state: { text: "Roadmap label" },
        }}
      />,
    );

    fireEvent.doubleClick(getEditor());
    fireEvent.click(screen.getByRole("combobox", { name: "Font family" }));
    expect(
      screen
        .getByRole("option", { name: "Comic Relief" })
        .querySelector("[style]"),
    ).toHaveAttribute("style", "font-family: var(--font-label-comic);");
    expect(
      screen
        .getByRole("option", { name: "Permanent Marker" })
        .querySelector("[style]"),
    ).toHaveAttribute("style", "font-family: var(--font-label-marker);");
  });

  it("lets pointer-down bubble across a label until edit mode", () => {
    const onPointerDown = vi.fn();
    render(
      <div onPointerDown={onPointerDown}>
        <StickyNoteWidget
          {...baseProps}
          instance={{ ...baseProps.instance, type: "label" }}
        />
      </div>,
    );

    const editor = getEditor();
    fireEvent.pointerDown(editor);
    expect(onPointerDown).toHaveBeenCalledOnce();

    fireEvent.doubleClick(editor);
    onPointerDown.mockClear();
    fireEvent.pointerDown(editor);
    expect(onPointerDown).not.toHaveBeenCalled();
  });

  it("updates the note font size from the floating toolbar", () => {
    const onUpdateState = vi.fn();
    render(<StickyNoteWidget {...baseProps} onUpdateState={onUpdateState} />);

    fireEvent.click(screen.getByRole("button", { name: "Large text" }));

    expect(onUpdateState).toHaveBeenCalledWith({ fontSize: "large" });
  });

  it("uses native direct formatting without exposing markdown markers", () => {
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    render(
      <StickyNoteWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { text: "Old note" },
        }}
      />,
    );

    const editor = getEditor();
    const text = editor.firstChild;
    if (!text) throw new Error("Expected editable note text");
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 3);
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(editor);

    fireEvent.mouseDown(screen.getByRole("button", { name: "Bold" }));

    expect(execCommand).toHaveBeenCalledWith("bold", false, undefined);
    expect(editor).toHaveTextContent("Old note");
    expect(editor).not.toHaveTextContent("**");
  });

  it("renders edit decorations without parsing note text as HTML", () => {
    const { container } = render(<StickyNoteWidget {...baseProps} />);
    const payload =
      '**<img src=x onerror="alert(1)">**\n# <script>alert(1)</script>';

    getEditor().textContent = payload;
    fireEvent.input(getEditor());

    expect(container.querySelector("img,script")).toBeNull();
    expect(container).toHaveTextContent('<img src=x onerror="alert(1)">');
    expect(container).toHaveTextContent("<script>alert(1)</script>");
  });

  it("does not bubble pointer down from the editor surface", () => {
    const onPointerDown = vi.fn();
    render(
      <div onPointerDown={onPointerDown}>
        <StickyNoteWidget {...baseProps} />
      </div>,
    );

    fireEvent.pointerDown(getEditor());

    expect(onPointerDown).not.toHaveBeenCalled();
  });

  it("does not bubble wheel events from the editor surface", () => {
    const onWheel = vi.fn();
    render(
      <div onWheel={onWheel}>
        <StickyNoteWidget {...baseProps} />
      </div>,
    );

    fireEvent.wheel(getEditor());

    expect(onWheel).not.toHaveBeenCalled();
  });

  it("uses a text cursor over the editor surface", () => {
    render(<StickyNoteWidget {...baseProps} />);

    expect(getEditor()).toHaveClass("cursor-text");
  });

  it("keeps onboarding notes in the starter-card presentation", () => {
    render(
      <StickyNoteWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { noteId: "onboarding:build-agent" },
        }}
      />,
    );

    expect(screen.getByText("Build an agent")).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Edit sticky note" }),
    ).not.toBeInTheDocument();
  });
});
