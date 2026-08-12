import { describe, expect, it } from "vitest";
import {
  MESSAGE_SNIPPET_MAX_CHARS,
  messageSnippet,
  SNIPPET_SCAN_LIMIT,
  stripMarkdown,
} from "./messageSnippet";

describe("messageSnippet", () => {
  // Mirrors the backend's own test vectors at cap=20
  // (aaif-goose/goose @ session-subtitle —
  // crates/goose/src/session/session_manager.rs::test_message_snippet_*).
  describe("backend parity at cap=20", () => {
    it("collapses internal whitespace to single spaces and trims the ends", () => {
      expect(messageSnippet("  hello\n\nworld\t  again  ", 20)).toBe(
        "hello world again",
      );
    });

    it("returns an exact-fit string with NO ellipsis", () => {
      expect(messageSnippet("one two three four x", 20)).toBe(
        "one two three four x",
      );
    });

    it("truncates just-over-cap prose and trims the trailing space before '…'", () => {
      expect(messageSnippet("abcde fghij klmno p qrstuv", 20)).toBe(
        "abcde fghij klmno p…",
      );
    });

    it("truncates a whitespace-free blob longer than the cap", () => {
      const snippet = messageSnippet("x".repeat(5000), 20);
      expect(snippet).not.toBeNull();
      expect([...(snippet ?? "")].length).toBe(21);
      expect(snippet?.endsWith("…")).toBe(true);
    });

    it("returns null for tool-only / thinking-only input (empty text)", () => {
      expect(messageSnippet("", 20)).toBeNull();
    });
  });

  describe("empty and whitespace-only input", () => {
    it("returns null for an empty string", () => {
      expect(messageSnippet("")).toBeNull();
    });

    it("returns null for whitespace-only input", () => {
      expect(messageSnippet("   \n\t  ")).toBeNull();
    });
  });

  describe("cap at MESSAGE_SNIPPET_MAX_CHARS (128)", () => {
    it("returns an exact-fit string with no ellipsis", () => {
      const exact = "a".repeat(MESSAGE_SNIPPET_MAX_CHARS);
      const snippet = messageSnippet(exact);
      expect(snippet).toBe(exact);
      expect(snippet?.endsWith("…")).toBe(false);
    });

    it("truncates just-over-cap prose, trimming the trailing space before '…'", () => {
      // 64 two-char words separated by single spaces => 191 code points; the
      // 128th code point is the space after the 64th word, so it gets trimmed.
      const prose = Array.from({ length: 64 }, () => "ab").join(" ");
      const snippet = messageSnippet(prose);
      expect(snippet).not.toBeNull();
      expect(snippet?.endsWith(" …")).toBe(false);
      expect(snippet?.endsWith("…")).toBe(true);
      expect(snippet?.endsWith("ab…")).toBe(true);
    });

    it("truncates a whitespace-free blob longer than the cap", () => {
      const snippet = messageSnippet("x".repeat(5000));
      expect(snippet).not.toBeNull();
      expect([...(snippet ?? "")].length).toBe(MESSAGE_SNIPPET_MAX_CHARS + 1);
      expect(snippet?.endsWith("…")).toBe(true);
    });

    it("counts emoji by code point, never splitting a surrogate pair", () => {
      const snippet = messageSnippet("\u{1f600}".repeat(200));
      expect(snippet).not.toBeNull();
      const codePoints = [...(snippet ?? "")];
      expect(codePoints.length).toBe(MESSAGE_SNIPPET_MAX_CHARS + 1);
      expect(codePoints[codePoints.length - 1]).toBe("…");
      // Every retained code point is a whole emoji (no lone surrogate).
      for (const cp of codePoints.slice(0, MESSAGE_SNIPPET_MAX_CHARS)) {
        expect(cp).toBe("\u{1f600}");
      }
    });
  });

  describe("bounded input scan (SNIPPET_SCAN_LIMIT)", () => {
    it("yields the same snippet whether the input far exceeds the scan limit or barely fills the cap", () => {
      // "word " repeated: the first 128 code points are identical no matter how
      // many copies follow, so slicing the scanned input must not change output.
      // 10000 copies = 50000 units (>> SNIPPET_SCAN_LIMIT); 40 copies = 200 units
      // (already well past the cap, < the limit, so scanned in full).
      const huge = messageSnippet("word ".repeat(10000));
      const small = messageSnippet("word ".repeat(40));
      expect(huge).not.toBeNull();
      expect(huge).toBe(small);
      expect(huge?.endsWith("…")).toBe(true);
    });

    it("truncates an emoji run longer than the scan limit to exactly the cap + '…' with no lone surrogate", () => {
      // 4000 emoji = 8000 UTF-16 units, well past SNIPPET_SCAN_LIMIT (4096). A
      // leading ASCII char makes the slice boundary odd so it cuts mid-surrogate,
      // proving the lone surrogate left at the end of the scan is dropped during
      // truncation and never reaches the output.
      expect("x".length + "\u{1f600}".repeat(4000).length).toBeGreaterThan(
        SNIPPET_SCAN_LIMIT,
      );
      const snippet = messageSnippet(`x${"\u{1f600}".repeat(4000)}`);
      expect(snippet).not.toBeNull();
      const codePoints = [...(snippet ?? "")];
      expect(codePoints.length).toBe(MESSAGE_SNIPPET_MAX_CHARS + 1);
      expect(codePoints[0]).toBe("x");
      expect(codePoints[codePoints.length - 1]).toBe("…");
      // Every retained code point past the leading "x" is a whole emoji — no lone
      // surrogate leaked through from the slice boundary.
      for (const cp of codePoints.slice(1, MESSAGE_SNIPPET_MAX_CHARS)) {
        expect(cp).toBe("\u{1f600}");
      }
    });
  });

  describe("White_Space handling diverges from JS \\s", () => {
    it("treats U+0085 (NEL) as whitespace (Rust does, JS \\s does not)", () => {
      // NEL must collapse like any other whitespace run.
      expect(messageSnippet("hello\u0085world")).toBe("hello world");
    });

    it("does NOT treat U+FEFF (BOM/ZWNBSP) as whitespace (JS \\s does, Rust does not)", () => {
      // The BOM must survive as a real character, not collapse to a space.
      expect(messageSnippet("hello\uFEFFworld")).toBe("hello\uFEFFworld");
    });
  });

  describe("strips markdown", () => {
    // Each row is the backend's ACTUAL verified output for that input
    // (aaif-goose/goose @ session-subtitle \u2014
    // crates/goose/src/session/session_manager.rs::test_strip_markdown_* /
    // ::test_message_snippet_*). Every vector here has a byte-identical twin in
    // the Rust suite; a divergence would flip the subtitle on the next reload.
    describe("stripMarkdown in isolation", () => {
      const stripCases: Array<[string, string, string]> = [
        ["1 strong **", "**bold**", "bold"],
        ["2 emphasis *", "*italic*", "italic"],
        ["3 emphasis _", "_italic_", "italic"],
        ["4 strong __", "__bold__", "bold"],
        ["5 strikethrough ~~", "~~strike~~", "strike"],
        ["6 triple ***", "***wow***", "wow"],
        ["7 code span", "`code`", "code"],
        ["8 code span keeps * literal", "`a*b*c`", "a*b*c"],
        ["9 atx heading #", "# Title", "Title"],
        ["10 atx heading ###", "### Three", "Three"],
        ["11 # without a space is literal", "#nospace", "#nospace"],
        ["12 blockquote", "> quoted", "quoted"],
        ["13 nested blockquote + bullet", "> - item", "item"],
        ["14 bullet -", "- item", "item"],
        ["15 bullet *", "* item", "item"],
        ["16 bullet +", "+ item", "item"],
        ["17 ordered 1.", "1. item", "item"],
        ["18 ordered 2)", "2) item", "item"],
        ["19 -N is not a bullet", "-1 degree", "-1 degree"],
        ["20 link keeps the label", "[text](https://x.com)", "text"],
        ["21 link label is re-stripped", "[**bold**](u)", "bold"],
        ["22 image keeps the alt text", "![alt](img.png)", "alt"],
        ["23 bare [label] stays literal", "[just text]", "[just text]"],
        ["24 reference link keeps the label", "[text][ref]", "text"],
        [
          "25 intra-word _ is literal",
          "call run_fast_now()",
          "call run_fast_now()",
        ],
        ["26 __init__ keeps the inner word", "__init__", "init"],
        ["27 unmatched ** stays literal", "**bold", "**bold"],
        [
          "28 lone * stays literal",
          "text *with one star",
          "text *with one star",
        ],
        ["29 backslash-escaped *", "\\*literal\\*", "*literal*"],
        ["30 strong inside parens", "(**bold**)", "(bold)"],
        ["31 strong mid-sentence", "say **bold**.", "say bold."],
        ["32 thematic break *** -> empty", "***", ""],
        ["33 thematic break --- (trailing space) -> empty", "--- ", ""],
        ["34 real newline is preserved", "a\nb", "a\nb"],
        ["35 blockquote + heading", "> # H", "H"],
        [
          "36 plain prose unchanged",
          "plain text, no markdown",
          "plain text, no markdown",
        ],
        ["37 C#/F# hashes are literal", "C# and F#", "C# and F#"],
        // 38: a double-backtick code span wrapping a single backtick. The space
        // padding is kept VERBATIM \u2014 code-span space-trimming is deliberately
        // disabled \u2014 so the output is " ` " WITH a leading AND trailing space,
        // never just "`". Input chars: ` ` (space) ` (space) ` `.
        ["38 double-fence span keeps padding", `\`\` \` \`\``, " ` "],
      ];

      it.each(stripCases)("strips %s", (_label, input, expected) => {
        expect(stripMarkdown(input)).toBe(expected);
      });
    });

    describe("end-to-end messageSnippet with markdown", () => {
      // E1-E4: markdown-free inputs pass through stripMarkdown unchanged, so the
      // existing backend-parity behavior survives with the new step in the path.
      it("E1 collapses whitespace on plain text", () => {
        expect(messageSnippet("  hello\n\nworld\t  again  ", 20)).toBe(
          "hello world again",
        );
      });

      it("E2 returns a plain exact-fit string with no ellipsis", () => {
        expect(messageSnippet("one two three four x", 20)).toBe(
          "one two three four x",
        );
      });

      it("E3 truncates plain just-over-cap prose", () => {
        expect(messageSnippet("abcde fghij klmno p qrstuv", 20)).toBe(
          "abcde fghij klmno p\u2026",
        );
      });

      it("E4 truncates a plain blob to cap + '\u2026'", () => {
        const snippet = messageSnippet("x".repeat(5000), 20);
        expect([...(snippet ?? "")].length).toBe(21);
        expect(snippet?.endsWith("\u2026")).toBe(true);
      });

      // E5: stripping order matters \u2014 a leading heading marker vs. a literal '#'
      // that happens to sit inside emphasis.
      it("E5a strips a heading marker, then the inner emphasis", () => {
        expect(messageSnippet("# **Hello** _world_", 20)).toBe("Hello world");
      });

      it("E5b keeps a '#' that was emphasized text, not a heading marker", () => {
        expect(messageSnippet("**# Hello** _world_", 20)).toBe("# Hello world");
      });

      it("E6 strips a multi-'#' heading and strong together", () => {
        expect(messageSnippet("## **Big Title**", 20)).toBe("Big Title");
      });

      // E7/E8: markdown stripping must not disturb the White_Space parity at the
      // full 128 cap \u2014 NEL still collapses, BOM is still preserved.
      it("E7 still collapses U+0085 (NEL) after stripping", () => {
        expect(messageSnippet("hello\u0085world", 128)).toBe("hello world");
      });

      it("E8 still preserves U+FEFF (BOM) after stripping", () => {
        expect(messageSnippet("hello\uFEFFworld", 128)).toBe(
          "hello\uFEFFworld",
        );
      });

      // Markdown-only messages strip to empty and yield null, so the live path
      // leaves the prior subtitle intact rather than clearing it.
      it("returns null for markdown-only input", () => {
        expect(messageSnippet("***")).toBeNull();
        expect(messageSnippet("> ")).toBeNull();
        expect(messageSnippet("[]()")).toBeNull();
      });
    });
  });
});
