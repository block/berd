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
        "widgets.stickyNote.preview": "Preview",
        "widgets.stickyNote.edit": "Edit",
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

function getEditor() {
  return screen.getByRole("textbox", {
    name: "Edit sticky note",
  }) as HTMLTextAreaElement;
}

describe("StickyNoteWidget", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens an empty note in the editor with a placeholder", () => {
    render(<StickyNoteWidget {...baseProps} />);

    const editor = getEditor();
    expect(editor).toHaveValue("");
    expect(editor).toHaveAttribute("placeholder", "Write a note...");
  });

  it("opens a note that already has content in rendered preview", () => {
    render(
      <StickyNoteWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { text: "Remember launch notes" },
        }}
      />,
    );

    expect(screen.getByText("Remember launch notes")).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Edit sticky note" }),
    ).not.toBeInTheDocument();
  });

  it("toggles from preview into the editor", () => {
    render(
      <StickyNoteWidget
        {...baseProps}
        instance={{
          ...baseProps.instance,
          state: { text: "Remember launch notes" },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(getEditor()).toHaveValue("Remember launch notes");
  });

  it("toggles from the editor into rendered preview", () => {
    render(<StickyNoteWidget {...baseProps} />);

    fireEvent.change(getEditor(), { target: { value: "Drafted note" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(screen.getByText("Drafted note")).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Edit sticky note" }),
    ).not.toBeInTheDocument();
  });

  it("debounces editable note content into widget state", async () => {
    vi.useFakeTimers();
    const onUpdateState = vi.fn();
    render(<StickyNoteWidget {...baseProps} onUpdateState={onUpdateState} />);

    fireEvent.change(getEditor(), { target: { value: "New note" } });
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
    fireEvent.change(editor, { target: { value: "Blurred note" } });
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

  it("updates the note font size from the floating toolbar", () => {
    const onUpdateState = vi.fn();
    render(<StickyNoteWidget {...baseProps} onUpdateState={onUpdateState} />);

    fireEvent.click(screen.getByRole("button", { name: "Large text" }));

    expect(onUpdateState).toHaveBeenCalledWith({ fontSize: "large" });
  });

  it("wraps the selection in markdown syntax from the toolbar", () => {
    render(<StickyNoteWidget {...baseProps} />);

    const editor = getEditor();
    fireEvent.change(editor, { target: { value: "Old note" } });

    editor.setSelectionRange(0, 3);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Bold" }));
    expect(editor).toHaveValue("**Old** note");

    editor.setSelectionRange(2, 5);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Italic" }));
    expect(editor).toHaveValue("***Old*** note");
  });

  it("renders edit decorations without parsing note text as HTML", () => {
    const { container } = render(<StickyNoteWidget {...baseProps} />);
    const payload =
      '**<img src=x onerror="alert(1)">**\n# <script>alert(1)</script>';

    fireEvent.change(getEditor(), { target: { value: payload } });

    expect(container.querySelector("img,script")).toBeNull();
    expect(container).toHaveTextContent('**<img src=x onerror="alert(1)">**');
    expect(container).toHaveTextContent("# <script>alert(1)</script>");
  });

  it("hides inline formatting buttons in preview mode", () => {
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
      screen.queryByRole("button", { name: "Bold" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Italic" }),
    ).not.toBeInTheDocument();
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
