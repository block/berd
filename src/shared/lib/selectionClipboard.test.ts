import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendLinkUrlsToText,
  buildEnrichedSelectionPayload,
  buildSelectionClipboardPayload,
  cloneSelectionContents,
  collectSelectionLinks,
  collectSelectionTextSegments,
  isEditableSelectionTarget,
  selectionFragmentToHtml,
  writeSelectionToClipboard,
} from "./selectionClipboard";

function createFragment(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

afterEach(() => {
  vi.unstubAllGlobals();
  // Ranges outlive the nodes they point at, so a selection left behind by one
  // test shows up as a stale detached range in the next one.
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("collectSelectionLinks", () => {
  it("collects external links in document order", () => {
    const fragment = createFragment(
      `<p><a href="https://one.example">first</a> and <a href="https://two.example">second</a></p>`,
    );

    expect(collectSelectionLinks(fragment)).toEqual([
      { href: "https://one.example", label: "first" },
      { href: "https://two.example", label: "second" },
    ]);
  });

  it("keeps mailto and tel destinations", () => {
    const fragment = createFragment(
      `<a href="mailto:team@example.com">email us</a><a href="tel:+15551234567">call us</a>`,
    );

    expect(collectSelectionLinks(fragment).map((link) => link.href)).toEqual([
      "mailto:team@example.com",
      "tel:+15551234567",
    ]);
  });

  it("spells out mailto and tel addresses in both flavors", () => {
    // Rich targets such as Google Docs accept pasted http(s) anchors but strip
    // mailto:/tel: ones, which left these labels as bare words. The address has
    // to survive the strip, so it is written out beside the anchor.
    const fragment = createFragment(
      `<p>Contact: <a href="mailto:team@example.com">email us</a> or <a href="tel:+15551234567">call us</a></p>`,
    );

    const payload = buildSelectionClipboardPayload(
      fragment,
      "Contact: email us or call us",
    );

    expect(payload.text).toBe(
      "Contact: email us (team@example.com) or call us (+15551234567)",
    );
    expect(payload.html).toBe(
      `<p>Contact: <a href="mailto:team@example.com">email us</a> (team@example.com) or <a href="tel:+15551234567">call us</a> (+15551234567)</p>`,
    );
  });

  it("drops the scheme rather than showing mailto: to the reader", () => {
    // "email us (mailto:team@example.com)" carries no more information than
    // "email us (team@example.com)" and reads worse.
    const fragment = createFragment(
      `<a href="mailto:team@example.com">email us</a>`,
    );

    expect(buildSelectionClipboardPayload(fragment, "email us").text).toBe(
      "email us (team@example.com)",
    );
  });

  it("does not repeat an address the label already shows", () => {
    const fragment = createFragment(
      `<a href="mailto:team@example.com">team@example.com</a>`,
    );
    const payload = buildSelectionClipboardPayload(
      fragment,
      "team@example.com",
    );

    expect(payload.text).toBe("team@example.com");
    expect(payload.html).toBe(
      `<a href="mailto:team@example.com">team@example.com</a>`,
    );
  });

  it("keeps http(s) anchors free of a trailing address", () => {
    // Only the stripped schemes need the belt-and-braces treatment; adding it
    // to every link would clutter ordinary web links.
    const fragment = createFragment(
      `<a href="https://example.com/docs">docs</a>`,
    );

    expect(buildSelectionClipboardPayload(fragment, "docs").html).toBe(
      `<a href="https://example.com/docs">docs</a>`,
    );
  });

  it("ignores local artifact paths and session deep links", () => {
    const fragment = createFragment(
      `<a href="/workspace/report.md">report</a><a href="berd://session/abc">chat</a>`,
    );

    expect(collectSelectionLinks(fragment)).toEqual([]);
  });

  it("ignores links inside code so copied code stays runnable", () => {
    const fragment = createFragment(
      `<pre><code><a href="https://example.com">curl example.com</a></code></pre>`,
    );

    expect(collectSelectionLinks(fragment)).toEqual([]);
  });

  it("skips links whose label already shows the destination", () => {
    const fragment = createFragment(
      `<a href="https://example.com">https://example.com</a>`,
    );

    expect(collectSelectionLinks(fragment)).toEqual([]);
  });

  it("skips a label that contains the destination as a whole token", () => {
    // "Note: example.com (example.com)" only repeats what the reader can see.
    const fragment = createFragment(
      `<a href="https://example.com">Note: example.com</a>`,
    );

    expect(collectSelectionLinks(fragment)).toEqual([]);
  });

  it("skips a label that spells out the full url mid-sentence", () => {
    const fragment = createFragment(
      `<a href="https://example.com/docs">see https://example.com/docs here</a>`,
    );

    expect(collectSelectionLinks(fragment)).toEqual([]);
  });

  it("still appends when the label is only a fragment of the destination", () => {
    // The token-boundary check must not become a substring check: "example" and
    // "docs" carry none of the destination's information, and treating them as
    // redundant is exactly how the URL went missing in the first place.
    for (const [label, href] of [
      ["example", "https://example.com"],
      ["docs", "https://example.com/docs"],
      ["release notes", "https://example.com/blog/release-notes"],
    ]) {
      const fragment = createFragment(`<a href="${href}">${label}</a>`);

      expect(collectSelectionLinks(fragment)).toEqual([{ href, label }]);
    }
  });
});

describe("collectSelectionTextSegments", () => {
  it("tags each text run with the link it belongs to", () => {
    const fragment = createFragment(
      `<p>Read the <a href="https://example.com/docs">docs</a> first</p>`,
    );

    expect(collectSelectionTextSegments(fragment)).toEqual([
      { href: null, text: "Read the " },
      { href: "https://example.com/docs", text: "docs" },
      { href: null, text: " first" },
    ]);
  });

  it("merges runs inside one anchor so the label stays a single segment", () => {
    // Otherwise the URL lands after the first text node ("bold"), splitting the
    // label instead of following it.
    const fragment = createFragment(
      `<p>See <a href="https://x.example"><strong>bold</strong> link</a> now</p>`,
    );

    expect(collectSelectionTextSegments(fragment)).toEqual([
      { href: null, text: "See " },
      { href: "https://x.example", text: "bold link" },
      { href: null, text: " now" },
    ]);
  });

  it("leaves code and non-external links untagged", () => {
    const fragment = createFragment(
      `<p><code><a href="https://x.example">fetch</a></code> and <a href="/local.md">report</a></p>`,
    );

    expect(
      collectSelectionTextSegments(fragment).every(
        (segment) => segment.href === null,
      ),
    ).toBe(true);
  });
});

describe("appendLinkUrlsToText", () => {
  it("appends the url after the link label", () => {
    const result = appendLinkUrlsToText("See the docs for details", [
      { href: null, text: "See the " },
      { href: "https://example.com/docs", text: "docs" },
      { href: null, text: " for details" },
    ]);

    expect(result).toBe("See the docs (https://example.com/docs) for details");
  });

  it("annotates the linked occurrence, not an identical earlier word", () => {
    // The label "docs" appears as plain prose before the link. Locating the
    // label by searching the text annotates that first match and leaves the
    // real link bare — the bug this module exists to prevent.
    const result = appendLinkUrlsToText("docs and docs", [
      { href: null, text: "docs and " },
      { href: "https://example.com/docs", text: "docs" },
    ]);

    expect(result).toBe("docs and docs (https://example.com/docs)");
  });

  it("maps repeated linked labels to their own occurrence in order", () => {
    const result = appendLinkUrlsToText("read docs then read docs again", [
      { href: null, text: "read " },
      { href: "https://one.example", text: "docs" },
      { href: null, text: " then read " },
      { href: "https://two.example", text: "docs" },
      { href: null, text: " again" },
    ]);

    expect(result).toBe(
      "read docs (https://one.example) then read docs (https://two.example) again",
    );
  });

  it("matches a label that wrapped across lines in the selection text", () => {
    const result = appendLinkUrlsToText("open the release\nnotes now", [
      { href: null, text: "open the " },
      { href: "https://example.com", text: "release notes" },
      { href: null, text: " now" },
    ]);

    expect(result).toBe("open the release\nnotes (https://example.com) now");
  });

  it("does not duplicate a url the author already wrote out", () => {
    const result = appendLinkUrlsToText(
      "docs (https://example.com) explain it",
      [
        { href: "https://example.com", text: "docs" },
        { href: null, text: " (https://example.com) explain it" },
      ],
    );

    expect(result).toBe("docs (https://example.com) explain it");
  });

  it("returns the text unchanged when no segment carries a link", () => {
    expect(appendLinkUrlsToText("plain text", [])).toBe("plain text");
    expect(
      appendLinkUrlsToText("plain text", [{ href: null, text: "plain text" }]),
    ).toBe("plain text");
  });

  it("skips a segment that is not present in the selection text", () => {
    const result = appendLinkUrlsToText("clipped selection", [
      { href: "https://example.com", text: "missing label" },
    ]);

    expect(result).toBe("clipped selection");
  });
});

describe("selectionFragmentToHtml", () => {
  it("keeps anchors so rich targets paste a clickable link", () => {
    const fragment = createFragment(
      `<p>See <a class="text-primary" data-streamdown="link" href="https://example.com">docs</a></p>`,
    );

    expect(selectionFragmentToHtml(fragment)).toBe(
      `<p>See <a href="https://example.com">docs</a></p>`,
    );
  });

  it("unwraps non-external anchors to their label", () => {
    const fragment = createFragment(
      `<p><a href="/local/report.md">report</a></p>`,
    );

    expect(selectionFragmentToHtml(fragment)).toBe("<p>report</p>");
  });

  it("unwraps app chrome wrappers but keeps their text", () => {
    const fragment = createFragment(
      `<div class="rounded-lg bg-muted"><span class="sr-only">kept</span></div>`,
    );

    expect(selectionFragmentToHtml(fragment)).toBe("kept");
  });

  it("keeps classes and data attributes off preserved elements", () => {
    const fragment = createFragment(
      `<p class="mb-2" data-streamdown="paragraph">text</p>`,
    );

    expect(selectionFragmentToHtml(fragment)).toBe("<p>text</p>");
  });

  it("drops script and style content", () => {
    const fragment = createFragment(
      `<p>safe</p><script>alert(1)</script><style>p{color:red}</style>`,
    );

    expect(selectionFragmentToHtml(fragment)).toBe("<p>safe</p>");
  });

  it("escapes html special characters in text", () => {
    const fragment = createFragment("<p>a &lt; b &amp;&amp; c &gt; d</p>");

    expect(selectionFragmentToHtml(fragment)).toBe(
      "<p>a &lt; b &amp;&amp; c &gt; d</p>",
    );
  });

  it("escapes quotes in hrefs so the attribute cannot be broken out of", () => {
    const anchor = document.createElement("a");
    anchor.setAttribute("href", 'https://example.com/?q="onmouseover=x');
    anchor.textContent = "link";
    const fragment = document.createDocumentFragment();
    fragment.append(anchor);

    expect(selectionFragmentToHtml(fragment)).toBe(
      `<a href="https://example.com/?q=&quot;onmouseover=x">link</a>`,
    );
  });

  it("keeps list, table, and emphasis structure", () => {
    const fragment = createFragment(
      `<ul><li><strong>bold</strong> and <em>italic</em></li></ul>`,
    );

    expect(selectionFragmentToHtml(fragment)).toBe(
      "<ul><li><strong>bold</strong> and <em>italic</em></li></ul>",
    );
  });

  it("degrades non-remote images to their alt text", () => {
    const fragment = createFragment(
      `<img alt="diagram" src="asset://localhost/tmp/a.png" />`,
    );

    expect(selectionFragmentToHtml(fragment)).toBe("diagram");
  });
});

describe("recoverable link detection", () => {
  it("treats an external link as worth taking over the clipboard for", () => {
    expect(
      buildEnrichedSelectionPayload(
        createFragment(`<a href="https://example.com">docs</a>`),
        "docs",
      ),
    ).not.toBeNull();
  });

  it("leaves a selection with no external links alone", () => {
    expect(
      buildEnrichedSelectionPayload(
        createFragment("<p>just prose</p>"),
        "just prose",
      ),
    ).toBeNull();
  });
});

describe("buildSelectionClipboardPayload", () => {
  it("returns url-bearing plain text alongside anchored html", () => {
    const fragment = createFragment(
      `<p>Read the <a href="https://example.com/docs">docs</a></p>`,
    );

    expect(buildSelectionClipboardPayload(fragment, "Read the docs")).toEqual({
      html: `<p>Read the <a href="https://example.com/docs">docs</a></p>`,
      text: "Read the docs (https://example.com/docs)",
    });
  });

  it("annotates the link when the same words appear unlinked earlier", () => {
    // End-to-end guard for the whole path: the URL has to follow the anchor's
    // own text, not the first place those words happen to appear.
    const fragment = createFragment(
      `<p>docs and <a href="https://example.com/docs">docs</a></p>`,
    );

    expect(buildSelectionClipboardPayload(fragment, "docs and docs").text).toBe(
      "docs and docs (https://example.com/docs)",
    );
  });

  it("annotates the link when the label also appears in earlier prose", () => {
    const fragment = createFragment(
      `<p>Read the release notes. Now see <a href="https://x.example/rn">release notes</a>.</p>`,
    );

    expect(
      buildSelectionClipboardPayload(
        fragment,
        "Read the release notes. Now see release notes.",
      ).text,
    ).toBe(
      "Read the release notes. Now see release notes (https://x.example/rn).",
    );
  });
});

describe("buildEnrichedSelectionPayload", () => {
  it("returns null for a selection with no recoverable url", () => {
    // Without this gate the caller attaches a text/html flavor to ordinary
    // prose, turning a plain-text copy into a formatted one.
    const fragment = createFragment(
      `<h1>Title</h1><p>Some <strong>bold</strong> prose</p><ul><li>item</li></ul>`,
    );

    expect(
      buildEnrichedSelectionPayload(fragment, "Title Some bold prose item"),
    ).toBeNull();
  });

  it("returns the payload when a url is at risk", () => {
    const fragment = createFragment(
      `<p>Read the <a href="https://example.com/docs">docs</a></p>`,
    );

    expect(buildEnrichedSelectionPayload(fragment, "Read the docs")).toEqual({
      html: `<p>Read the <a href="https://example.com/docs">docs</a></p>`,
      text: "Read the docs (https://example.com/docs)",
    });
  });

  it("returns null when the only link is inside code", () => {
    const fragment = createFragment(
      `<pre><code><a href="https://example.com">curl example.com</a></code></pre>`,
    );

    expect(
      buildEnrichedSelectionPayload(fragment, "curl example.com"),
    ).toBeNull();
  });
});

describe("code selections", () => {
  it("keeps pre so newlines and indentation survive in the html flavor", () => {
    // Serializing a code selection without its <pre> leaves a bare <code> whose
    // whitespace the paste target collapses, flattening the snippet onto one
    // line. Selecting inside the <pre> is what a user does when copying code.
    document.body.innerHTML = `<div data-language="bash"><pre><code>line one\n  indented two\nline three</code></pre></div>`;
    const pre = document.querySelector("pre") as HTMLElement;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(pre);
    selection?.removeAllRanges();
    selection?.addRange(range);

    const html = selectionFragmentToHtml(
      cloneSelectionContents(selection as Selection),
    );

    expect(html).toBe(
      "<pre><code>line one\n  indented two\nline three</code></pre>",
    );
  });

  it("leaves a link inside code alone in both flavors", () => {
    // The two flavors have to agree about what counts as code, otherwise the
    // html keeps an anchor the plain text deliberately dropped.
    const fragment = createFragment(
      `<p>run <code><a href="https://x.example">fetch x</a></code> now</p>`,
    );
    const payload = buildSelectionClipboardPayload(fragment, "run fetch x now");

    expect(payload.html).toBe("<p>run <code>fetch x</code> now</p>");
    expect(payload.text).toBe("run fetch x now");
  });
});

describe("cloneSelectionContents inside a link", () => {
  function selectRange(configure: (range: Range) => void): Selection {
    const selection = window.getSelection();
    const range = document.createRange();
    configure(range);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return selection as Selection;
  }

  it("keeps the anchor when the whole label is selected from inside it", () => {
    // Double-clicking a link label selects its text node, not the <a>. The
    // anchor is then an ancestor of the range, so a plain cloneContents()
    // returns bare text and the href is lost.
    document.body.innerHTML = `<p>Check the <a href="https://example.com/docs">docs</a> now</p>`;
    const textNode = document.querySelector("a")?.firstChild as Text;

    const selection = selectRange((range) => {
      range.setStart(textNode, 0);
      range.setEnd(textNode, textNode.length);
    });

    const fragment = cloneSelectionContents(selection);

    expect(collectSelectionLinks(fragment)).toEqual([
      { href: "https://example.com/docs", label: "docs" },
    ]);
    expect(selectionFragmentToHtml(fragment)).toBe(
      `<a href="https://example.com/docs">docs</a>`,
    );
  });

  it("keeps the anchor when only part of the label is selected", () => {
    document.body.innerHTML = `<p><a href="https://example.com/docs">release notes</a></p>`;
    const textNode = document.querySelector("a")?.firstChild as Text;

    const selection = selectRange((range) => {
      range.setStart(textNode, 0);
      range.setEnd(textNode, "release".length);
    });

    const fragment = cloneSelectionContents(selection);

    expect(collectSelectionLinks(fragment)).toEqual([
      { href: "https://example.com/docs", label: "release" },
    ]);
  });

  it("keeps the anchor when the label is selected via selectNodeContents", () => {
    document.body.innerHTML = `<p><a href="https://example.com/docs">docs</a></p>`;
    const anchor = document.querySelector("a") as HTMLAnchorElement;

    const selection = selectRange((range) => {
      range.selectNodeContents(anchor);
    });

    expect(collectSelectionLinks(cloneSelectionContents(selection))).toEqual([
      { href: "https://example.com/docs", label: "docs" },
    ]);
  });

  it("restores nested inline ancestors around the selection", () => {
    document.body.innerHTML = `<p><a href="https://example.com"><strong>bold link</strong></a></p>`;
    const textNode = document.querySelector("strong")?.firstChild as Text;

    const selection = selectRange((range) => {
      range.setStart(textNode, 0);
      range.setEnd(textNode, textNode.length);
    });

    expect(selectionFragmentToHtml(cloneSelectionContents(selection))).toBe(
      `<a href="https://example.com"><strong>bold link</strong></a>`,
    );
  });

  it("does not double-wrap when the range already spans the link", () => {
    document.body.innerHTML = `<p>Check the <a href="https://example.com/docs">docs</a> now</p>`;
    const paragraph = document.querySelector("p") as HTMLParagraphElement;

    const selection = selectRange((range) => {
      range.selectNodeContents(paragraph);
    });

    const fragment = cloneSelectionContents(selection);

    expect(fragment.querySelectorAll("a")).toHaveLength(1);
    expect(collectSelectionLinks(fragment)).toEqual([
      { href: "https://example.com/docs", label: "docs" },
    ]);
  });

  it("still ignores a code link when the selection starts inside it", () => {
    document.body.innerHTML = `<pre><code><a href="https://example.com">curl example.com</a></code></pre>`;
    const textNode = document.querySelector("a")?.firstChild as Text;

    const selection = selectRange((range) => {
      range.setStart(textNode, 0);
      range.setEnd(textNode, textNode.length);
    });

    expect(collectSelectionLinks(cloneSelectionContents(selection))).toEqual(
      [],
    );
  });
});

describe("cloneSelectionContents", () => {
  it("flattens every range of a multi-range selection", () => {
    document.body.innerHTML = `<p id="a">alpha</p><p id="b">beta <a href="https://example.com">docs</a></p>`;

    const ranges = ["a", "b"].map((id) => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById(id) as HTMLElement);
      return range;
    });

    // jsdom's addRange() ignores every range after the first, so rangeCount
    // stays 1 and a real multi-range selection cannot be built here. Drive the
    // function with a stub instead: the alternative is a test that silently
    // only ever exercises one range.
    const selection = {
      getRangeAt: (index: number) => ranges[index],
      rangeCount: ranges.length,
    } as unknown as Selection;

    const fragment = cloneSelectionContents(selection);

    expect(fragment.textContent).toBe("alphabeta docs");
    expect(collectSelectionLinks(fragment)).toEqual([
      { href: "https://example.com", label: "docs" },
    ]);
  });
});

describe("isEditableSelectionTarget", () => {
  it("detects inputs, textareas, and contenteditable hosts", () => {
    document.body.innerHTML = `
      <input id="input" />
      <textarea id="textarea"></textarea>
      <div id="editable" contenteditable="true"><span id="inner">x</span></div>
      <p id="prose">prose</p>
    `;

    for (const id of ["input", "textarea", "editable", "inner"]) {
      expect(isEditableSelectionTarget(document.getElementById(id))).toBe(true);
    }
    expect(isEditableSelectionTarget(document.getElementById("prose"))).toBe(
      false,
    );
    expect(isEditableSelectionTarget(null)).toBe(false);
  });
});

describe("writeSelectionToClipboard", () => {
  it("writes both flavors when rich clipboard writes are available", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    class FakeClipboardItem {
      constructor(public readonly items: Record<string, Blob>) {}
    }

    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });

    await writeSelectionToClipboard({
      html: `<a href="https://example.com">docs</a>`,
      text: "docs (https://example.com)",
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();

    const item = write.mock.calls[0][0][0] as FakeClipboardItem;
    expect(Object.keys(item.items).sort()).toEqual(["text/html", "text/plain"]);
  });

  it("falls back to url-bearing plain text when the rich write is denied", async () => {
    const write = vi.fn().mockRejectedValue(new Error("denied"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    vi.stubGlobal("ClipboardItem", class {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });

    await writeSelectionToClipboard({
      html: `<a href="https://example.com">docs</a>`,
      text: "docs (https://example.com)",
    });

    expect(writeText).toHaveBeenCalledWith("docs (https://example.com)");
    consoleError.mockRestore();
  });

  it("falls back to plain text when ClipboardItem is unavailable", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal("ClipboardItem", undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await writeSelectionToClipboard({
      html: "<p>x</p>",
      text: "docs (https://example.com)",
    });

    expect(writeText).toHaveBeenCalledWith("docs (https://example.com)");
  });

  it("does nothing when there is no content to write", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await writeSelectionToClipboard({ html: "", text: "" });

    expect(writeText).not.toHaveBeenCalled();
  });
});
