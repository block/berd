import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { TRANSCRIPT_SELECTED_TEXT_CONTEXT_MENU_EVENT } from "@/features/chat/transcript/row-state";
import {
  SelectedTextContextMenu,
  getSelectionMenuPosition,
  htmlFragmentToMarkdown,
  restoreSelection,
  selectionIntersectsNode,
} from "./SelectedTextContextMenu";

function createFragment(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

async function flushFocusScopeUnmount(): Promise<void> {
  // Radix FocusScope dispatches its unmount autofocus event in setTimeout(0).
  // Keep it inside this test's jsdom realm so dispatchEvent sees a jsdom Event.
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SelectedTextContextMenu helpers", () => {
  afterEach(async () => {
    cleanup();
    await flushFocusScopeUnmount();
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  it("only treats the right-click target as selected when it intersects the current selection", () => {
    document.body.innerHTML = `
      <p id="selected">Selected text</p>
      <p id="outside">Outside text</p>
    `;

    const selected = document.getElementById("selected");
    const outside = document.getElementById("outside");
    const selection = window.getSelection();
    const range = document.createRange();

    expect(selected).not.toBeNull();
    expect(outside).not.toBeNull();
    expect(selection).not.toBeNull();

    range.selectNodeContents(selected as HTMLElement);
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(selectionIntersectsNode(selection as Selection, selected)).toBe(
      true,
    );
    expect(selectionIntersectsNode(selection as Selection, outside)).toBe(
      false,
    );
  });

  it("converts selected HTML structure into practical markdown", () => {
    const markdown = htmlFragmentToMarkdown(
      createFragment(`
        <h2>Review notes</h2>
        <p>Use the <a href="https://example.com">reference doc</a>.</p>
        <ul>
          <li>Keep <strong>Copy</strong></li>
          <li>Add <code>Copy as Markdown</code></li>
        </ul>
        <div data-language="ts">
          <pre><code>const value = 1;</code></pre>
        </div>
      `),
      "",
    );

    expect(markdown).toBe(
      [
        "## Review notes",
        "",
        "Use the [reference doc](https://example.com).",
        "",
        "- Keep **Copy**",
        "- Add `Copy as Markdown`",
        "",
        "```ts",
        "const value = 1;",
        "```",
      ].join("\n"),
    );
  });

  it("preserves inline code that already contains backticks", () => {
    const markdown = htmlFragmentToMarkdown(
      createFragment("<p>Run <code>`quoted`</code> here.</p>"),
      "",
    );

    expect(markdown).toBe("Run `` `quoted` `` here.");
  });

  it("escapes backslashes and pipes inside markdown table cells", () => {
    const markdown = htmlFragmentToMarkdown(
      createFragment(`
        <table>
          <tr><th>Value</th><th>Meaning</th></tr>
          <tr><td>C:\\tmp | folder</td><td>Path</td></tr>
        </table>
      `),
      "",
    );

    expect(markdown).toBe(
      ["Value | Meaning", "--- | ---", "C:\\\\tmp \\| folder | Path"].join(
        "\n",
      ),
    );
  });

  it("can restore the visible selection after a menu steals focus", () => {
    document.body.innerHTML = "<p>Keep this selected</p>";

    const paragraph = document.querySelector("p");
    const selection = window.getSelection();
    const range = document.createRange();

    expect(paragraph).not.toBeNull();
    expect(selection).not.toBeNull();

    range.selectNodeContents(paragraph as HTMLParagraphElement);
    selection?.removeAllRanges();
    selection?.addRange(range);

    const clonedRange = range.cloneRange();
    selection?.removeAllRanges();
    restoreSelection([clonedRange]);

    expect(selection?.toString()).toBe("Keep this selected");
  });

  it("restores selected text after opening the app-owned context menu", async () => {
    const { container } = render(
      <>
        <p>Keep this selected</p>
        <SelectedTextContextMenu />
      </>,
    );
    const paragraph = container.querySelector("p");
    const selection = window.getSelection();
    const range = document.createRange();

    expect(paragraph).not.toBeNull();
    expect(selection).not.toBeNull();

    range.selectNodeContents(paragraph as HTMLParagraphElement);
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.contextMenu(paragraph as HTMLParagraphElement, {
      clientX: 100,
      clientY: 80,
    });
    selection?.removeAllRanges();

    await waitFor(() => {
      expect(selection?.toString()).toBe("Keep this selected");
    });
  });

  it("dispatches row-state events while the selected text menu is open", async () => {
    const events: Array<{ open: boolean; ranges: readonly Range[] }> = [];
    const handleRowStateEvent = (event: Event) => {
      events.push(
        (
          event as CustomEvent<{
            open: boolean;
            ranges: readonly Range[];
          }>
        ).detail,
      );
    };
    window.addEventListener(
      TRANSCRIPT_SELECTED_TEXT_CONTEXT_MENU_EVENT,
      handleRowStateEvent,
    );
    const { container, unmount } = render(
      <>
        <p>Keep this selected</p>
        <SelectedTextContextMenu />
      </>,
    );
    const paragraph = container.querySelector("p");
    const selection = window.getSelection();
    const range = document.createRange();

    expect(paragraph).not.toBeNull();
    expect(selection).not.toBeNull();

    range.selectNodeContents(paragraph as HTMLParagraphElement);
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.contextMenu(paragraph as HTMLParagraphElement, {
      clientX: 100,
      clientY: 80,
    });

    await waitFor(() => {
      expect(events.some((event) => event.open)).toBe(true);
      expect(events.find((event) => event.open)?.ranges.length).toBe(1);
    });

    unmount();

    await waitFor(() => {
      expect(events.some((event) => !event.open)).toBe(true);
    });
    window.removeEventListener(
      TRANSCRIPT_SELECTED_TEXT_CONTEXT_MENU_EVENT,
      handleRowStateEvent,
    );
  });

  it("restores selected text when a menu item takes hover focus", async () => {
    const { container } = render(
      <>
        <p>Keep this selected</p>
        <SelectedTextContextMenu />
      </>,
    );
    const paragraph = container.querySelector("p");
    const selection = window.getSelection();
    const range = document.createRange();

    expect(paragraph).not.toBeNull();
    expect(selection).not.toBeNull();

    range.selectNodeContents(paragraph as HTMLParagraphElement);
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.contextMenu(paragraph as HTMLParagraphElement, {
      clientX: 100,
      clientY: 80,
    });

    const markdownItem = await screen.findByRole("menuitem", {
      name: /copy as markdown/i,
    });

    selection?.removeAllRanges();
    fireEvent.pointerMove(markdownItem);

    await waitFor(() => {
      expect(selection?.toString()).toBe("Keep this selected");
    });

    selection?.removeAllRanges();
    fireEvent.focus(markdownItem);

    await waitFor(() => {
      expect(selection?.toString()).toBe("Keep this selected");
    });
  });

  it("anchors keyboard-triggered menus near the selected text", () => {
    document.body.innerHTML = "<p>Keyboard selected text</p>";

    const paragraph = document.querySelector("p");
    const selection = window.getSelection();
    const range = document.createRange();

    expect(paragraph).not.toBeNull();
    expect(selection).not.toBeNull();

    range.selectNodeContents(paragraph as HTMLParagraphElement);
    selection?.removeAllRanges();
    selection?.addRange(range);

    Object.defineProperty(range, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({
          bottom: 48,
          height: 20,
          left: 24,
          right: 180,
          top: 28,
          width: 156,
          x: 24,
          y: 28,
          toJSON: () => ({}),
        }) as DOMRect,
    });

    const position = getSelectionMenuPosition(
      new MouseEvent("contextmenu", { clientX: 0, clientY: 0 }),
      selection as Selection,
      paragraph,
    );

    expect(position).toEqual({ x: 24, y: 48 });
  });
});

function createClipboardData() {
  const data = new Map<string, string>();
  return {
    getData: (type: string) => data.get(type) ?? "",
    setData: (type: string, value: string) => {
      data.set(type, value);
    },
    types: [] as string[],
  };
}

function selectNodeContents(node: Element | null): Selection {
  const selection = window.getSelection();
  const range = document.createRange();

  expect(node).not.toBeNull();
  expect(selection).not.toBeNull();

  range.selectNodeContents(node as Element);
  selection?.removeAllRanges();
  selection?.addRange(range);

  return selection as Selection;
}

describe("native copy of selected links", () => {
  afterEach(async () => {
    cleanup();
    await flushFocusScopeUnmount();
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  it("keeps the url in both clipboard flavors when copying a link", () => {
    const { container } = render(
      <>
        <p>
          Read the{" "}
          <a className="text-primary" href="https://example.com/docs">
            docs
          </a>{" "}
          first
        </p>
        <SelectedTextContextMenu />
      </>,
    );

    selectNodeContents(container.querySelector("p"));
    const clipboardData = createClipboardData();

    fireEvent.copy(container.querySelector("p") as HTMLParagraphElement, {
      clipboardData,
    });

    expect(clipboardData.getData("text/plain")).toContain(
      "docs (https://example.com/docs)",
    );
    expect(clipboardData.getData("text/html")).toContain(
      '<a href="https://example.com/docs">docs</a>',
    );
  });

  it("keeps the url when only the link label is selected", () => {
    // The way people actually copy a link: double-click / drag across just the
    // label. The selection lives inside the <a>, so the anchor is an ancestor
    // of the range rather than part of it.
    const { container } = render(
      <>
        <p>
          Read the <a href="https://example.com/docs">docs</a> first
        </p>
        <SelectedTextContextMenu />
      </>,
    );

    const label = container.querySelector("a")?.firstChild as Text;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(label, 0);
    range.setEnd(label, label.length);
    selection?.removeAllRanges();
    selection?.addRange(range);

    const clipboardData = createClipboardData();
    fireEvent.copy(container.querySelector("a") as HTMLAnchorElement, {
      clipboardData,
    });

    expect(clipboardData.getData("text/plain")).toBe(
      "docs (https://example.com/docs)",
    );
    expect(clipboardData.getData("text/html")).toBe(
      '<a href="https://example.com/docs">docs</a>',
    );
  });

  it("leaves the platform copy alone when the selection has no links", () => {
    const { container } = render(
      <>
        <p id="prose">Just prose with no links</p>
        <p id="linked">
          Read the <a href="https://example.com/docs">docs</a>
        </p>
        <SelectedTextContextMenu />
      </>,
    );

    selectNodeContents(container.querySelector("#prose"));
    const proseClipboard = createClipboardData();
    fireEvent.copy(container.querySelector("#prose") as HTMLElement, {
      clipboardData: proseClipboard,
    });

    expect(proseClipboard.getData("text/plain")).toBe("");
    expect(proseClipboard.getData("text/html")).toBe("");

    // Positive control: the same mounted listener does act on a linked
    // selection, so the assertions above hold because the handler declined
    // rather than because it never ran.
    selectNodeContents(container.querySelector("#linked"));
    const linkedClipboard = createClipboardData();
    fireEvent.copy(container.querySelector("#linked") as HTMLElement, {
      clipboardData: linkedClipboard,
    });

    expect(linkedClipboard.getData("text/plain")).toContain(
      "https://example.com/docs",
    );
  });

  it("leaves copy inside editable fields to the platform", () => {
    const { container } = render(
      <>
        <div contentEditable suppressContentEditableWarning>
          <a href="https://example.com/docs">docs</a>
        </div>
        <p id="outside">
          Read the <a href="https://example.com/docs">docs</a>
        </p>
        <SelectedTextContextMenu />
      </>,
    );

    const editable = container.querySelector("[contenteditable]");
    selectNodeContents(editable);
    const editableClipboard = createClipboardData();
    fireEvent.copy(editable as HTMLElement, {
      clipboardData: editableClipboard,
    });

    expect(editableClipboard.getData("text/plain")).toBe("");

    // Positive control: an identical link outside the editable host is enriched.
    selectNodeContents(container.querySelector("#outside"));
    const outsideClipboard = createClipboardData();
    fireEvent.copy(container.querySelector("#outside") as HTMLElement, {
      clipboardData: outsideClipboard,
    });

    expect(outsideClipboard.getData("text/plain")).toContain(
      "https://example.com/docs",
    );
  });

  it("stops rewriting the clipboard after unmount", () => {
    const { container, unmount } = render(
      <>
        <p>
          Read the <a href="https://example.com/docs">docs</a>
        </p>
        <SelectedTextContextMenu />
      </>,
    );

    const paragraph = container.querySelector("p") as HTMLParagraphElement;

    // Positive control first: prove the listener is attached and enriching,
    // so the post-unmount assertion cannot pass vacuously.
    selectNodeContents(paragraph);
    const beforeUnmount = createClipboardData();
    fireEvent.copy(paragraph, { clipboardData: beforeUnmount });

    expect(beforeUnmount.getData("text/plain")).toContain(
      "https://example.com/docs",
    );

    unmount();

    document.body.append(paragraph);
    selectNodeContents(paragraph);
    const afterUnmount = createClipboardData();
    fireEvent.copy(paragraph, { clipboardData: afterUnmount });

    expect(afterUnmount.getData("text/plain")).toBe("");
  });
});

describe("context menu Copy", () => {
  afterEach(async () => {
    cleanup();
    await flushFocusScopeUnmount();
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  function stubClipboard() {
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(public readonly items: Record<string, Blob>) {}
      },
    );
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });

    return { write, writeText };
  }

  async function openMenuOn(element: Element) {
    selectNodeContents(element);
    fireEvent.contextMenu(element, { clientX: 100, clientY: 80 });

    return screen.findByRole("menuitem", { name: /^copy$/i });
  }

  it("writes plain text only when the selection has no url to recover", async () => {
    // This item wrote Selection.toString() before rich flavors existed. A
    // selection with nothing to enrich must keep that behavior instead of
    // gaining a text/html flavor that pastes headings and bullets into rich
    // targets.
    const { write, writeText } = stubClipboard();
    const { container } = render(
      <>
        <div id="prose">
          <h1>Title</h1>
          <p>
            Some <strong>bold</strong> prose
          </p>
        </div>
        <SelectedTextContextMenu />
      </>,
    );

    const copyItem = await openMenuOn(
      container.querySelector("#prose") as HTMLElement,
    );
    fireEvent.click(copyItem);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    expect(write).not.toHaveBeenCalled();
    expect(writeText.mock.calls[0][0]).toContain("Some bold prose");
    expect(writeText.mock.calls[0][0]).not.toContain("<h1>");
  });

  it("writes both flavors when the selection holds a url", async () => {
    const { write, writeText } = stubClipboard();
    const { container } = render(
      <>
        <p id="linked">
          Read the <a href="https://example.com/docs">docs</a>
        </p>
        <SelectedTextContextMenu />
      </>,
    );

    const copyItem = await openMenuOn(
      container.querySelector("#linked") as HTMLElement,
    );
    fireEvent.click(copyItem);

    await waitFor(() => {
      expect(write).toHaveBeenCalledTimes(1);
    });
    expect(writeText).not.toHaveBeenCalled();
  });
});
