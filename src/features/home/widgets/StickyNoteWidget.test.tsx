import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StickyNoteWidget } from "./StickyNoteWidget";
import type { WidgetRenderProps } from "./types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        "widgets.stickyNote.label": "Sticky note",
        "widgets.stickyNote.dismiss": "Dismiss sticky note",
        "widgets.stickyNote.toolbar": "Sticky note tools",
        "widgets.stickyNote.bold": "Bold",
        "widgets.stickyNote.italic": "Italic",
        "widgets.stickyNote.strikethrough": "Strikethrough",
        "widgets.stickyNote.editAria": "Edit sticky note",
        "widgets.stickyNote.placeholder": "Write a note...",
        "widgets.stickyNote.fontSizes.small": "Small text",
        "widgets.stickyNote.fontSizes.medium": "Medium text",
        "widgets.stickyNote.fontSizes.large": "Large text",
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

describe("StickyNoteWidget", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders a user-editable note when no onboarding note id is present", () => {
    render(
      <StickyNoteWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { text: "Remember launch notes" },
        }}
      />,
    );

    expect(
      screen.getByRole("textbox", { name: "Edit sticky note" }),
    ).toHaveTextContent("Remember launch notes");
  });

  it("debounces editable note content into widget state", async () => {
    vi.useFakeTimers();
    const onUpdateState = vi.fn();
    render(
      <StickyNoteWidget
        {...baseProps}
        onUpdateState={onUpdateState}
        instance={{
          ...baseProps.instance,
          state: { text: "Old note" },
        }}
      />,
    );

    const note = screen.getByRole("textbox", { name: "Edit sticky note" });
    note.textContent = "New note";
    fireEvent.input(note);
    expect(onUpdateState).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(onUpdateState).toHaveBeenCalledWith(
      expect.objectContaining({ text: "New note" }),
    );
  });

  it("flushes editable note content on blur", () => {
    vi.useFakeTimers();
    const onUpdateState = vi.fn();
    render(
      <StickyNoteWidget
        {...baseProps}
        onUpdateState={onUpdateState}
        instance={{
          ...baseProps.instance,
          state: { text: "Old note" },
        }}
      />,
    );

    const note = screen.getByRole("textbox", { name: "Edit sticky note" });
    note.textContent = "Blurred note";
    fireEvent.input(note);
    fireEvent.blur(note);

    expect(onUpdateState).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Blurred note" }),
    );
  });

  it("sanitizes persisted editable note html before rendering", () => {
    render(
      <StickyNoteWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: {
            html: [
              '<img src="x" onerror="alert(1)">',
              '<strong onclick="alert(1)">safe</strong>',
              '<font size="5" style="color:red">big</font>',
              '<font size="99">plain</font>',
              "<script>alert(1)</script>",
            ].join(""),
          },
        }}
      />,
    );

    const note = screen.getByRole("textbox", { name: "Edit sticky note" });
    expect(note.innerHTML).not.toContain("img");
    expect(note.innerHTML).not.toContain("script");
    expect(note.innerHTML).not.toContain("onclick");
    expect(note.innerHTML).not.toContain("style");
    expect(note.innerHTML).toContain("<strong>safe</strong>");
    expect(note.innerHTML).toContain('<font size="5">big</font>');
    expect(note.innerHTML).toContain("<font>plain</font>");
  });

  it("pastes clipboard html as plain text", () => {
    const execCommand = vi.fn();
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    render(<StickyNoteWidget {...baseProps} />);

    fireEvent.paste(screen.getByRole("textbox", { name: "Edit sticky note" }), {
      clipboardData: {
        getData: vi.fn((type: string) =>
          type === "text/plain" ? "<b>plain text</b>" : "<b>html</b>",
        ),
      },
    });

    expect(execCommand).toHaveBeenCalledWith(
      "insertText",
      false,
      "<b>plain text</b>",
    );
  });

  it("does not bubble pointer down from the editable text surface", () => {
    const onPointerDown = vi.fn();
    render(
      <div onPointerDown={onPointerDown}>
        <StickyNoteWidget {...baseProps} />
      </div>,
    );

    fireEvent.pointerDown(
      screen.getByRole("textbox", { name: "Edit sticky note" }),
    );

    expect(onPointerDown).not.toHaveBeenCalled();
  });

  it("does not bubble wheel events from the editable text surface", () => {
    const onWheel = vi.fn();
    render(
      <div onWheel={onWheel}>
        <StickyNoteWidget {...baseProps} />
      </div>,
    );

    fireEvent.wheel(screen.getByRole("textbox", { name: "Edit sticky note" }));

    expect(onWheel).not.toHaveBeenCalled();
  });

  it("updates the note tone from the floating toolbar", () => {
    const onUpdateState = vi.fn();
    render(
      <StickyNoteWidget
        {...baseProps}
        onUpdateState={onUpdateState}
        instance={{
          ...baseProps.instance,
          state: { text: "Old note", tone: "warm" },
        }}
      />,
    );

    expect(
      screen.getByRole("toolbar", { name: "Sticky note tools" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Blue" }));

    expect(onUpdateState).toHaveBeenCalledWith({ tone: "blue" });
  });

  it("updates note formatting from the floating toolbar", () => {
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

    fireEvent.mouseDown(screen.getByRole("button", { name: "Large text" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Bold" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Italic" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Strikethrough" }));

    expect(execCommand).toHaveBeenCalledWith("fontSize", false, "5");
    expect(execCommand).toHaveBeenCalledWith("bold", false, undefined);
    expect(execCommand).toHaveBeenCalledWith("italic", false, undefined);
    expect(execCommand).toHaveBeenCalledWith("strikeThrough", false, undefined);
    expect(
      screen.queryByRole("button", { name: "Bullet list" }),
    ).not.toBeInTheDocument();
  });

  it("reflects active formatting states in the floating toolbar", () => {
    Object.defineProperty(document, "queryCommandValue", {
      configurable: true,
      value: vi.fn((command: string) => (command === "fontSize" ? "5" : "")),
    });
    Object.defineProperty(document, "queryCommandState", {
      configurable: true,
      value: vi.fn((command: string) => command === "strikeThrough"),
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

    fireEvent.focus(screen.getByRole("textbox", { name: "Edit sticky note" }));

    expect(screen.getByRole("button", { name: "Large text" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Strikethrough" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Bold" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("preserves selected text across consecutive toolbar formatting commands", () => {
    const selectionCollapsedAtCommand: boolean[] = [];
    const execCommand = vi.fn((command: string) => {
      const selection = window.getSelection();
      selectionCollapsedAtCommand.push(
        selection?.rangeCount ? selection.getRangeAt(0).collapsed : true,
      );

      if (command === "bold" && selection?.rangeCount) {
        const range = selection.getRangeAt(0).cloneRange();
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }

      return true;
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    render(
      <StickyNoteWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { text: "Selected text" },
        }}
      />,
    );

    const note = screen.getByRole("textbox", { name: "Edit sticky note" });
    const textNode = note.firstChild;
    expect(textNode).not.toBeNull();
    const range = document.createRange();
    range.setStart(textNode as ChildNode, 0);
    range.setEnd(textNode as ChildNode, "Selected".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(note);

    fireEvent.mouseDown(screen.getByRole("button", { name: "Bold" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Italic" }));

    expect(execCommand).toHaveBeenCalledWith("bold", false, undefined);
    expect(execCommand).toHaveBeenCalledWith("italic", false, undefined);
    expect(selectionCollapsedAtCommand).toEqual([false, false]);
  });

  it("turns a leading dash and space into a bullet list", () => {
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

    const note = screen.getByRole("textbox", { name: "Edit sticky note" });
    note.textContent = "-";
    const marker = note.firstChild;
    expect(marker).not.toBeNull();
    const range = document.createRange();
    range.setStart(marker as ChildNode, 1);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(fireEvent.keyDown(note, { key: " " })).toBe(false);
    expect(execCommand).toHaveBeenCalledWith("delete", false, undefined);
    expect(execCommand).toHaveBeenCalledWith(
      "insertUnorderedList",
      false,
      undefined,
    );
  });

  it("turns a leading dash and space into a bullet list after existing content", () => {
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

    const note = screen.getByRole("textbox", { name: "Edit sticky note" });
    note.innerHTML = "<div>Existing content</div><div>-</div>";
    const marker = note.querySelector("div:last-child")?.firstChild;
    expect(marker).not.toBeNull();
    const range = document.createRange();
    range.setStart(marker as ChildNode, 1);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(fireEvent.keyDown(note, { key: " " })).toBe(false);
    expect(execCommand).toHaveBeenCalledWith("delete", false, undefined);
    expect(execCommand).toHaveBeenCalledWith(
      "insertUnorderedList",
      false,
      undefined,
    );
  });

  it("does not convert a dash at the end of regular text into a bullet list", () => {
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

    const note = screen.getByRole("textbox", { name: "Edit sticky note" });
    note.textContent = "Existing-";
    const marker = note.firstChild;
    expect(marker).not.toBeNull();
    const range = document.createRange();
    range.setStart(marker as ChildNode, "Existing-".length);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(fireEvent.keyDown(note, { key: " " })).toBe(true);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("keeps enter from moving the caret below the empty-note placeholder", () => {
    render(<StickyNoteWidget {...baseProps} />);

    expect(
      fireEvent.keyDown(
        screen.getByRole("textbox", { name: "Edit sticky note" }),
        { key: "Enter" },
      ),
    ).toBe(false);
  });

  it("uses a text cursor over the editable note surface", () => {
    render(<StickyNoteWidget {...baseProps} />);

    expect(
      screen.getByRole("textbox", { name: "Edit sticky note" }),
    ).toHaveClass("cursor-text");
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
