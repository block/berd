import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageResponse } from "./message";
import { serializeMessageResponseSelection } from "./message-response-selection";

function text(root: Node, value: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.data.includes(value)) return node;
  }
  throw new Error(`missing ${value}`);
}

function range(
  root: HTMLElement,
  from: string,
  to: string,
  fromOffset = 0,
  toOffset = to.length,
) {
  const start = text(root, from);
  const end = text(root, to);
  const selection = document.createRange();
  selection.setStart(start, start.data.indexOf(from) + fromOffset);
  selection.setEnd(end, end.data.indexOf(to) + toOffset);
  return selection;
}

describe("serializeMessageResponseSelection", () => {
  it("serializes an actual Streamdown table", () => {
    const markdown = [
      "| Density | Spacing |",
      "| --- | --- |",
      "| Compact | 0px |",
      "| Comfy | 2px |",
    ].join("\n");
    const view = render(
      <MessageResponse mode="static">{markdown}</MessageResponse>,
    );
    const surface = view.container.firstElementChild as HTMLElement;
    expect(
      serializeMessageResponseSelection(
        surface,
        range(surface, "Density", "2px"),
      ),
    ).toBe("Density\tSpacing\nCompact\t0px\nComfy\t2px");
  });

  it("includes a destination only when the complete link label is selected", () => {
    const surface = document.createElement("div");
    surface.innerHTML = `<p>See <a href="https://example.com/policy">Block policy</a> today</p>`;
    expect(
      serializeMessageResponseSelection(
        surface,
        range(surface, "Block policy", "Block policy"),
      ),
    ).toBe("Block policy (https://example.com/policy)");
    expect(
      serializeMessageResponseSelection(
        surface,
        range(surface, "Block policy", "Block policy", 6, 12),
      ),
    ).toBe("policy");
    expect(
      serializeMessageResponseSelection(
        surface,
        range(surface, "See ", "Block policy", 0, 5),
      ),
    ).toBe("See Block");
  });

  it("preserves table columns, including empty and untaken cells", () => {
    const surface = document.createElement("div");
    surface.innerHTML = `<table><tbody>
      <tr><td>A1</td><td></td><td>C1</td></tr>
      <tr><td>A2</td><td>B2</td><td>C2</td></tr>
    </tbody></table>`;
    expect(
      serializeMessageResponseSelection(surface, range(surface, "C1", "A2")),
    ).toBe("\t\tC1\nA2\t\t");
  });

  it("preserves selected code whitespace verbatim", () => {
    const surface = document.createElement("div");
    surface.innerHTML = `<pre><code>  if (ready) {\n    run();\n  }\n</code></pre>`;
    expect(
      serializeMessageResponseSelection(
        surface,
        range(surface, "  if", "  }\n", 0, 4),
      ),
    ).toBe("  if (ready) {\n    run();\n  }\n");
  });

  it("preserves hard breaks and nested list hierarchy", () => {
    const surface = document.createElement("div");
    surface.innerHTML = `<p>first<br>second</p><ol><li>Parent<ul><li>Child</li></ul></li><li>Next</li></ol>`;
    expect(
      serializeMessageResponseSelection(
        surface,
        range(surface, "first", "Next"),
      ),
    ).toBe("first\nsecond\n1. Parent\n  • Child\n2. Next");
  });

  it("removes selected controls on fallback surfaces", () => {
    const surface = document.createElement("div");
    surface.innerHTML = `visible <button>Show more</button> ending`;
    expect(
      serializeMessageResponseSelection(
        surface,
        range(surface, "visible ", " ending"),
      ),
    ).toBe("visible  ending");
  });
});
