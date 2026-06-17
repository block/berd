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
