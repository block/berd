// Scoped markdown for agent replies: agents answer in heavy markdown,
// and raw asterisk soup in the bubbles reads terribly.
//
// Deliberately a SUBSET, parsed to a typed block AST that MessageRow
// renders as React elements — no dangerouslySetInnerHTML, so the output is
// XSS-safe by construction and no parser/sanitizer dependency lands in the
// bundle. Unknown constructs degrade to plain text — a rendering miss must
// never eat content.
//
// Supported: # headings, ``` fences, - / * / 1. lists, > quotes, **bold**,
// *italic* / _italic_, `code`, [text](http/https link). Everything else is
// literal text.

export type InlineSpan =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

export type MarkdownBlock =
  | { kind: "paragraph"; spans: InlineSpan[] }
  | { kind: "heading"; level: number; spans: InlineSpan[] }
  | { kind: "code"; language: string; text: string }
  | { kind: "list"; ordered: boolean; items: InlineSpan[][] }
  | { kind: "quote"; spans: InlineSpan[] };

// --- inline ----------------------------------------------------------------

const INLINE_PATTERN =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)|(\[[^\]]+\]\(https?:\/\/[^\s)]+\))/;

export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let rest = text;
  while (rest.length > 0) {
    const match = INLINE_PATTERN.exec(rest);
    if (!match || match.index === undefined) {
      spans.push({ kind: "text", text: rest });
      break;
    }
    if (match.index > 0) {
      spans.push({ kind: "text", text: rest.slice(0, match.index) });
    }
    const token = match[0];
    if (token.startsWith("`")) {
      spans.push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("**")) {
      spans.push({ kind: "bold", text: token.slice(2, -2) });
    } else if (token.startsWith("*") || token.startsWith("_")) {
      spans.push({ kind: "italic", text: token.slice(1, -1) });
    } else {
      // [text](href) — pattern guarantees the shape and http(s) scheme.
      const close = token.indexOf("](");
      spans.push({
        kind: "link",
        text: token.slice(1, close),
        href: token.slice(close + 2, -1),
      });
    }
    rest = rest.slice(match.index + token.length);
  }
  return spans;
}

// --- blocks ------------------------------------------------------------------

const HEADING = /^(#{1,4})\s+(.*)$/;
const UNORDERED_ITEM = /^\s*[-*]\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+(.*)$/;

export function parseMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = text.split("\n");
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({
      kind: "paragraph",
      spans: parseInline(paragraph.join("\n")),
    });
    paragraph = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code: consumed to the closing fence (or end — an unclosed
    // fence still renders as code rather than leaking asterisk parsing).
    if (line.trimStart().startsWith("```")) {
      flushParagraph();
      const language = line.trim().slice(3).trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // skip the closing fence (no-op at end of input)
      blocks.push({ kind: "code", language, text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        spans: parseInline(heading[2]),
      });
      i += 1;
      continue;
    }

    if (line.startsWith(">")) {
      flushParagraph();
      const quoted: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        quoted.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", spans: parseInline(quoted.join("\n")) });
      continue;
    }

    const unordered = UNORDERED_ITEM.exec(line);
    const ordered = unordered ? null : ORDERED_ITEM.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = ordered !== null;
      const items: InlineSpan[][] = [];
      while (i < lines.length) {
        const item = isOrdered
          ? ORDERED_ITEM.exec(lines[i])
          : UNORDERED_ITEM.exec(lines[i]);
        if (!item) break;
        items.push(parseInline(item[1]));
        i += 1;
      }
      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      i += 1;
      continue;
    }

    paragraph.push(line);
    i += 1;
  }
  flushParagraph();
  return blocks;
}
