import { describe, expect, it } from "vitest";
import { linkifyText } from "@/shared/lib/linkify";

describe("linkifyText", () => {
  it("returns a single text segment when there is no URL", () => {
    expect(linkifyText("just some text")).toEqual([
      { type: "text", value: "just some text" },
    ]);
  });

  it("splits a bare https URL into a link segment", () => {
    expect(linkifyText("see https://github.com/squareup/buzz-website")).toEqual(
      [
        { type: "text", value: "see " },
        {
          type: "link",
          value: "https://github.com/squareup/buzz-website",
          href: "https://github.com/squareup/buzz-website",
        },
      ],
    );
  });

  it("handles multiple URLs in one string", () => {
    const segments = linkifyText("a https://a.com b https://b.com/x?y=1 done");
    expect(segments.filter((s) => s.type === "link")).toEqual([
      { type: "link", value: "https://a.com", href: "https://a.com" },
      {
        type: "link",
        value: "https://b.com/x?y=1",
        href: "https://b.com/x?y=1",
      },
    ]);
  });

  it("trims trailing sentence punctuation out of the link", () => {
    const segments = linkifyText("visit https://example.com/sites/buzz/.");
    expect(segments).toEqual([
      { type: "text", value: "visit " },
      {
        type: "link",
        value: "https://example.com/sites/buzz/",
        href: "https://example.com/sites/buzz/",
      },
      { type: "text", value: "." },
    ]);
  });

  it("keeps balanced parentheses inside the URL", () => {
    const segments = linkifyText(
      "wiki https://en.wikipedia.org/wiki/Foo_(bar)",
    );
    expect(segments).toEqual([
      { type: "text", value: "wiki " },
      {
        type: "link",
        value: "https://en.wikipedia.org/wiki/Foo_(bar)",
        href: "https://en.wikipedia.org/wiki/Foo_(bar)",
      },
    ]);
  });

  it("preserves query strings with encoded characters", () => {
    const url =
      "https://www.figma.com/design/abc/Builderlab-%E2%80%94-Branding?node-id=1118-13176&t=ZpNTTxOHojXJL3ol-4";
    const segments = linkifyText(`figma ${url}`);
    expect(segments).toEqual([
      { type: "text", value: "figma " },
      { type: "link", value: url, href: url },
    ]);
  });

  it("does not linkify non-http schemes", () => {
    expect(linkifyText("run localhost:3000 now")).toEqual([
      { type: "text", value: "run localhost:3000 now" },
    ]);
  });
});
