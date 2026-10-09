// Markdown renderer for agent replies: typed AST -> React elements. No
// dangerouslySetInnerHTML anywhere — XSS-safe by construction (the parser
// only admits http/https links; everything else is text nodes).

import { openUrl } from "@tauri-apps/plugin-opener";

import type { InlineSpan, MarkdownBlock } from "../lib/markdown";
import { parseMarkdown } from "../lib/markdown";

function Spans({ spans }: { spans: InlineSpan[] }) {
  return (
    <>
      {spans.map((span, i) => {
        switch (span.kind) {
          case "bold":
            // biome-ignore lint/suspicious/noArrayIndexKey: parse/content arrays are regenerated wholesale per render and only ever append — the index IS the stable identity
            return <strong key={i}>{span.text}</strong>;
          case "italic":
            // biome-ignore lint/suspicious/noArrayIndexKey: parse/content arrays are regenerated wholesale per render and only ever append — the index IS the stable identity
            return <em key={i}>{span.text}</em>;
          case "code":
            // biome-ignore lint/suspicious/noArrayIndexKey: parse/content arrays are regenerated wholesale per render and only ever append — the index IS the stable identity
            return <code key={i}>{span.text}</code>;
          case "link":
            // This WKWebView has no new-window handler, so target=_blank
            // navigations are cancelled outright — links would do nothing.
            // Route through Berd's opener plugin instead (href is already
            // http(s)-only by parser construction).
            return (
              <a
                // biome-ignore lint/suspicious/noArrayIndexKey: parse/content arrays are regenerated wholesale per render and only ever append — the index IS the stable identity
                key={i}
                href={span.href}
                onClick={(e) => {
                  e.preventDefault();
                  void openUrl(span.href).catch(() => {});
                }}
              >
                {span.text}
              </a>
            );
          case "text":
            // biome-ignore lint/suspicious/noArrayIndexKey: parse/content arrays are regenerated wholesale per render and only ever append — the index IS the stable identity
            return <span key={i}>{span.text}</span>;
          default:
            // Exhaustive over InlineSpan['kind']; unreachable.
            return null;
        }
      })}
    </>
  );
}

function Block({ block }: { block: MarkdownBlock }) {
  switch (block.kind) {
    case "paragraph":
      return (
        <p>
          <Spans spans={block.spans} />
        </p>
      );
    case "heading": {
      // Headings render as bold paragraph-ish lines scaled by level —
      // real h1/h2 elements are absurd inside a 380pt chat bubble.
      const size =
        block.level === 1 ? "1.05em" : block.level === 2 ? "1.0em" : "0.95em";
      return (
        <p style={{ fontWeight: 700, fontSize: size, margin: "0.5em 0 0.2em" }}>
          <Spans spans={block.spans} />
        </p>
      );
    }
    case "code":
      return (
        <pre>
          <code>{block.text}</code>
        </pre>
      );
    case "list":
      return block.ordered ? (
        <ol>
          {block.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: parse/content arrays are regenerated wholesale per render and only ever append — the index IS the stable identity
            <li key={i}>
              <Spans spans={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul>
          {block.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: parse/content arrays are regenerated wholesale per render and only ever append — the index IS the stable identity
            <li key={i}>
              <Spans spans={item} />
            </li>
          ))}
        </ul>
      );
    case "quote":
      return (
        <blockquote>
          <Spans spans={block.spans} />
        </blockquote>
      );
  }
}

export function MarkdownBody({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="markdown-body">
      {blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parse/content arrays are regenerated wholesale per render and only ever append — the index IS the stable identity
        <Block key={i} block={block} />
      ))}
    </div>
  );
}
