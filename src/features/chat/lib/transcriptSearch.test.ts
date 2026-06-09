import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTranscriptSearchHighlights,
  findTranscriptMatches,
  paintTranscriptSearchHighlights,
  scrollTranscriptMatchIntoView,
  supportsTranscriptSearchHighlights,
} from "./transcriptSearch";
import {
  type MockHighlight,
  stubHighlightRegistry,
} from "@/test/highlightRegistryStub";

function createRoot(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("findTranscriptMatches", () => {
  it("finds case-insensitive matches in document order", () => {
    const root = createRoot("<p>Needle one</p><p>more nEEdle</p>");

    const ranges = findTranscriptMatches(root, "needle");

    expect(ranges.map((range) => range.toString())).toEqual([
      "Needle",
      "nEEdle",
    ]);
  });

  it("returns no matches for empty or whitespace queries", () => {
    const root = createRoot("<p>needle</p>");

    expect(findTranscriptMatches(root, "")).toEqual([]);
    expect(findTranscriptMatches(root, "   ")).toEqual([]);
  });

  it("matches text spanning inline elements", () => {
    const root = createRoot("<p>foo <strong>bar</strong> baz</p>");

    const ranges = findTranscriptMatches(root, "foo bar");

    expect(ranges).toHaveLength(1);
    expect(ranges[0].toString()).toBe("foo bar");
  });

  it("matches a word split by inline formatting", () => {
    const root = createRoot("<p><strong>Drag</strong>onfruit</p>");

    const ranges = findTranscriptMatches(root, "dragonfruit");

    expect(ranges).toHaveLength(1);
    expect(ranges[0].toString()).toBe("Dragonfruit");
  });

  it("does not match across block boundaries", () => {
    const root = createRoot("<p>foo</p><p>bar</p>");

    expect(findTranscriptMatches(root, "foobar")).toEqual([]);
    expect(findTranscriptMatches(root, "foo bar")).toEqual([]);
    // Interior whitespace in the needle must not cross blocks either.
    expect(findTranscriptMatches(root, "foo\nbar")).toEqual([]);
  });

  it("does not match across empty block elements", () => {
    const root = createRoot("foo<div></div>bar");

    expect(findTranscriptMatches(root, "foobar")).toEqual([]);
    expect(findTranscriptMatches(root, "bar")).toHaveLength(1);
  });

  it("matches across markdown soft line breaks within a block", () => {
    const root = createRoot("<p>alpha\nbeta</p>");

    const ranges = findTranscriptMatches(root, "alpha beta");

    expect(ranges).toHaveLength(1);
    expect(ranges[0].toString()).toBe("alpha\nbeta");
  });

  it("treats whitespace runs in text and query as equivalent", () => {
    const root = createRoot("<p>gamma  delta</p>");

    expect(findTranscriptMatches(root, "gamma delta")).toHaveLength(1);
    expect(findTranscriptMatches(root, "gamma\tdelta")).toHaveLength(1);
  });

  it("does not match across list items", () => {
    const root = createRoot("<ul><li>alpha</li><li>beta</li></ul>");

    expect(findTranscriptMatches(root, "alphabeta")).toEqual([]);
    expect(findTranscriptMatches(root, "alpha")).toHaveLength(1);
  });

  it("treats forced line breaks as boundaries", () => {
    const root = createRoot("<p>foo<br>bar</p>");

    expect(findTranscriptMatches(root, "foobar")).toEqual([]);
    expect(findTranscriptMatches(root, "bar")).toHaveLength(1);
  });

  it("escapes regex metacharacters in the query", () => {
    const root = createRoot("<p>price is $5.00 (sale)</p>");

    const ranges = findTranscriptMatches(root, "$5.00 (sale)");

    expect(ranges).toHaveLength(1);
    expect(ranges[0].toString()).toBe("$5.00 (sale)");
  });

  it("ignores unrendered container text", () => {
    const root = createRoot(
      "<div><style>.needle{color:red}</style><script>var needle;</script><p>needle</p></div>",
    );

    expect(findTranscriptMatches(root, "needle")).toHaveLength(1);
  });

  it("ignores svg text", () => {
    const root = createRoot(
      "<div><svg><text>needle</text></svg><p>needle</p></div>",
    );

    expect(findTranscriptMatches(root, "needle")).toHaveLength(1);
  });

  it("ignores subtrees marked with the skip attribute", () => {
    const root = createRoot(
      "<div><span data-transcript-search-skip>needle</span><p>needle</p></div>",
    );

    const ranges = findTranscriptMatches(root, "needle");

    expect(ranges).toHaveLength(1);
    expect(ranges[0].startContainer.parentElement?.tagName).toBe("P");
  });

  it("ignores screen-reader-only text", () => {
    const root = createRoot(
      '<div><span class="sr-only">needle action</span><p>needle</p></div>',
    );

    expect(findTranscriptMatches(root, "needle")).toHaveLength(1);
  });

  it("prunes subtrees an engine reports as not rendered", () => {
    const root = createRoot(
      "<div><div data-collapsed><p>needle hidden</p></div><p>needle shown</p></div>",
    );
    const collapsed = root.querySelector("[data-collapsed]") as HTMLElement & {
      checkVisibility?: (options?: CheckVisibilityOptions) => boolean;
    };
    const checkVisibility = vi.fn(() => false);
    collapsed.checkVisibility = checkVisibility;

    const ranges = findTranscriptMatches(root, "needle");

    expect(ranges).toHaveLength(1);
    expect(ranges[0].toString()).toBe("needle");
    expect(ranges[0].startContainer.textContent).toBe("needle shown");
    // Steady-state hiding mechanisms beyond display:none must be checked.
    expect(checkVisibility).toHaveBeenCalledWith(
      expect.objectContaining({
        visibilityProperty: true,
        contentVisibilityAuto: true,
      }),
    );
  });

  it("descends through display:contents wrappers that report as not rendered", () => {
    const root = createRoot(
      "<div><div data-contents><p>needle</p></div></div>",
    );
    const wrapper = root.querySelector("[data-contents]") as HTMLElement & {
      checkVisibility?: () => boolean;
    };
    wrapper.style.display = "contents";
    wrapper.checkVisibility = () => false;

    expect(findTranscriptMatches(root, "needle")).toHaveLength(1);
  });

  it("caps pathological match counts", () => {
    const root = createRoot(`<p>${"x ".repeat(2500)}</p>`);

    expect(findTranscriptMatches(root, "x")).toHaveLength(2000);
  });
});

describe("highlight painting", () => {
  let registry: Map<string, MockHighlight>;

  beforeEach(() => {
    registry = stubHighlightRegistry();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports support from the stubbed registry", () => {
    expect(supportsTranscriptSearchHighlights()).toBe(true);
  });

  it("paints all matches and a prioritized active match", () => {
    const root = createRoot("<p>needle needle</p>");
    const ranges = findTranscriptMatches(root, "needle");

    paintTranscriptSearchHighlights(ranges, 1);

    const all = registry.get("chat-search-match");
    const active = registry.get("chat-search-match-active");
    expect(all?.ranges).toHaveLength(2);
    expect(active?.ranges).toEqual([ranges[1]]);
    expect(active?.priority).toBe(1);
  });

  it("empties the active highlight when no match is active", () => {
    const root = createRoot("<p>needle</p>");
    const ranges = findTranscriptMatches(root, "needle");

    paintTranscriptSearchHighlights(ranges, 1);
    paintTranscriptSearchHighlights(ranges, -1);

    expect(registry.get("chat-search-match")?.ranges).toHaveLength(1);
    expect(registry.get("chat-search-match-active")?.ranges).toHaveLength(0);
  });

  it("empties both highlights when painting no matches", () => {
    const root = createRoot("<p>needle</p>");
    const ranges = findTranscriptMatches(root, "needle");

    paintTranscriptSearchHighlights(ranges, 0);
    paintTranscriptSearchHighlights([], -1);

    expect(registry.get("chat-search-match")?.ranges).toHaveLength(0);
    expect(registry.get("chat-search-match-active")?.ranges).toHaveLength(0);
  });

  it("replaces previously painted ranges in place on re-query", () => {
    const root = createRoot("<p>several s letters s</p><p>dragonfruit</p>");
    const sRanges = findTranscriptMatches(root, "s");
    paintTranscriptSearchHighlights(sRanges, 0);
    const paintedAfterFirstQuery = registry.get("chat-search-match");

    const fruitRanges = findTranscriptMatches(root, "dragonfruit");
    paintTranscriptSearchHighlights(fruitRanges, 0);

    // Same Highlight instance, mutated in place — WKWebView fails to repaint
    // dropped ranges when the registry entry is wholesale-replaced.
    expect(registry.get("chat-search-match")).toBe(paintedAfterFirstQuery);
    expect(registry.get("chat-search-match")?.ranges).toEqual(fruitRanges);
  });

  it("clears the registry on demand", () => {
    const root = createRoot("<p>needle</p>");
    paintTranscriptSearchHighlights(findTranscriptMatches(root, "needle"), 0);

    clearTranscriptSearchHighlights();

    expect(registry.size).toBe(0);
  });
});

describe("scrollTranscriptMatchIntoView", () => {
  it("scrolls the element containing the match start", () => {
    const root = createRoot("<p>needle</p>");
    const paragraph = root.querySelector("p") as HTMLElement;
    const scrollIntoView = vi.fn();
    Object.defineProperty(paragraph, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const [range] = findTranscriptMatches(root, "needle");

    scrollTranscriptMatchIntoView(range, "smooth");

    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      behavior: "smooth",
    });
  });
});
