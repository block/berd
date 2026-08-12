/**
 * Builds the bounded, single-line snippet shown as a session's sidebar
 * subtitle, from the session's latest real text message.
 *
 * The whitespace-collapse + 128-code-point cap + ellipsis pipeline is a
 * verbatim mirror of the goose backend's `message_snippet`
 * (aaif-goose/goose @ session-subtitle —
 * `crates/goose/src/session/session_manager.rs`), which still computes and
 * ships exactly that over `SessionInfo._meta.lastMessageSnippet`. Mirroring it
 * lets the sidebar subtitle update live, in place, as messages stream in —
 * without an extra `session/list` round-trip — and lets the next full
 * `loadSessions()` overwrite the live value with the backend's canonical one
 * without the text visibly changing. (See the explicit White_Space class below
 * for why we keep that piece byte-for-byte.)
 *
 * Markdown stripping is the one piece that is NOT shared with the backend: the
 * backend reverted its copy, so the canonical ACP snippet now contains RAW
 * markdown. {@link stripMarkdown} therefore runs entirely in this frontend, in
 * two contexts but from ONE implementation: (a) the live accumulated
 * assistant/user text, and (b) the backend-provided snippet on ingest (see
 * `mapLastMessageSnippet` in `src/shared/api/acpApi.ts`). Because both paths
 * funnel through {@link messageSnippet}, the subtitle reads as prose ("bold",
 * "Title", "item") rather than raw syntax ("**bold**", "# Title", "- item")
 * whether it arrives live or from a reload. See {@link stripMarkdown} for the
 * narrow live-vs-reload edges this single-implementation design accepts.
 */

/**
 * Maximum number of Unicode code points retained in a snippet. Mirrors the
 * backend's `LAST_MESSAGE_SNIPPET_MAX_CHARS`. Counts code points (Rust
 * `chars()`), NOT bytes, UTF-16 units, or graphemes.
 */
export const MESSAGE_SNIPPET_MAX_CHARS = 128;

/**
 * Upper bound, in UTF-16 code units (the unit of `String.prototype.slice` and
 * `.length`), on how much leading input {@link messageSnippet} scans. The output
 * is at most `maxChars` code points, so we never need more input than is required
 * to fill the cap and detect a `(maxChars + 1)`th code point. Bounding the scanned
 * input keeps each call O(SNIPPET_SCAN_LIMIT) instead of O(input length), which
 * matters on the live per-chunk streaming path: without it, recomputing the
 * snippet on every chunk is O(n) in the accumulated reply and O(n²) across the
 * turn.
 *
 * The worst case for "few code points per UTF-16 unit" is an unbroken run of
 * surrogate-pair code points (e.g. emoji): `maxChars + 1` code points occupy
 * `2·(128 + 1) = 258` units. 4096 sits comfortably above that and absorbs
 * realistic inter-word whitespace, so any realistic message is scanned in full.
 * Only pathological input (multiple KB of leading/internal whitespace) could
 * produce a slightly different live value, and that self-corrects on the next
 * `loadSessions()` reconcile. A slice may cut mid-surrogate at the boundary,
 * leaving a lone surrogate as the last scanned unit, but it sits far past the
 * cap and is dropped during truncation, so it never reaches the output.
 *
 * Markdown stripping (see {@link stripMarkdown}) runs on this bounded prefix,
 * after the slice. Stripping is purely subtractive (it only removes characters),
 * so the bound stays a safe over-estimate of the input needed to fill the cap.
 * It does slightly widen the live-vs-reload window described in the
 * {@link stripMarkdown} LIMITATION note: a Markdown construct whose closing
 * delimiter sits past this limit (e.g. a multi-KB link URL inside the leading
 * prefix) could be truncated mid-construct on the live path, yielding a slightly
 * different live value than the reconciled one — an accepted tradeoff of the
 * single-implementation design, same family as the live-vs-ingest cap
 * difference.
 */
export const SNIPPET_SCAN_LIMIT = 4096;

// Mirror Rust's `char::is_whitespace` (the Unicode White_Space property), which
// the backend relies on via `str::split_whitespace` and `str::trim_end`. We
// deliberately do NOT use JS `\s`: `\s` INCLUDES U+FEFF (ZWNBSP) and EXCLUDES
// U+0085 (NEL) — exactly the opposite of Rust's White_Space set. Using `\s`
// would make the live snippet disagree with the backend's canonical value (a
// NEL would survive instead of collapsing; a stray BOM would be dropped),
// producing a visible flip on the next reload. This explicit class matches
// White_Space: it includes U+0085 and excludes U+FEFF.
const WHITESPACE_CLASS =
  "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WHITESPACE_RUN_RE = new RegExp(`[${WHITESPACE_CLASS}]+`);
const TRAILING_WHITESPACE_RE = new RegExp(`[${WHITESPACE_CLASS}]+$`);

// ---------------------------------------------------------------------------
// Markdown stripping — a FRONTEND-ONLY transform. The backend used to strip
// Markdown out of the snippet, but that was reverted (aaif-goose/goose @
// session-subtitle), so the canonical value shipped over ACP
// `_meta.lastMessageSnippet` is now raw, collapsed-and-capped Markdown. To keep
// the sidebar showing readable prose ("bold", "Title", "item") rather than raw
// syntax ("**bold**", "# Title", "- item"), this frontend is now the sole place
// that strips. It runs in two contexts but from ONE implementation: the live
// accumulated assistant/user text, and the backend-provided snippet on ingest
// (`mapLastMessageSnippet` in `src/shared/api/acpApi.ts`). Both funnel through
// `messageSnippet`, so the displayed text reads the same whether it arrives live
// or from a `loadSessions()` reload.
//
// `stripMarkdown` is a line-for-line port of the backend's now-reverted
// `strip_markdown`. It is deliberately a hand-written single-pass code-point
// scanner, NOT a regex or a Markdown library, because the two call contexts run
// it on DIFFERENT inputs — the full live text vs. the backend's pre-capped
// snippet — and only a single, well-defined algorithm keeps the two agreeing at
// the edges (delimiter-run flanking, unmatched/escaped delimiters, nested links,
// code-span fence lengths, list/heading/blockquote line-start markers). This is
// the same single-implementation rationale as the explicit White_Space class
// above (kept byte-for-byte for parity with the still-shared collapse/cap
// pipeline, which avoids JS `\s` disagreeing with Rust's White_Space set).
//
// LIMITATION — because the backend caps to 128 RAW code points BEFORE this
// frontend can strip, the ingest path strips a pre-capped value while the live
// path strips the full text and then caps. So a long message whose first ~128
// chars contain Markdown can show a slightly shorter or different tail after a
// full `loadSessions()` reload than it did live. The common no-Markdown message
// is byte-identical either way (zero flip). Two further edges apply to the
// ingested value, which the backend has already newline-collapsed to a single
// line: a marker can survive at the 128-char truncation boundary (an unclosed
// `**`/`[` reverts to literal), and block markers (`#`, `>`, list markers) that
// were NOT on the message's first line are no longer at a line start once
// collapsed, so they are not stripped. These are accepted tradeoffs of the
// single-implementation design; inline bold/italic/code/strike/links — the
// primary concern — are handled regardless of position.
//
// Porting notes: Rust `chars()` -> `Array.from(input)` (so emoji / surrogate
// pairs are single elements); `out.drain(a..b)` -> `out.splice(a, b - a)`; the
// link-label recursion `strip_markdown(&label)` -> `stripMarkdown(label.join(""))`.

// `is_ws` (Rust `char::is_whitespace`): a char is whitespace iff it matches the
// White_Space class above for a single char. Reuses WHITESPACE_CLASS so
// emphasis flanking agrees with the backend; never JS `\s` (see divergence note).
const WHITESPACE_CHAR_RE = new RegExp(`^[${WHITESPACE_CLASS}]$`);
function isWs(c: string): boolean {
  return WHITESPACE_CHAR_RE.test(c);
}

// `is_word` (Rust `char::is_ascii_alphanumeric`): ASCII alphanumeric ONLY, not
// Unicode — drives the "`_` cannot break inside a word" rule (e.g. `run_fast`).
function isWord(c: string): boolean {
  return /^[0-9A-Za-z]$/.test(c);
}

// `is_ascii_punct`: the CommonMark ASCII punctuation set (the chars `\` escapes).
const ASCII_PUNCT = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~");
function isAsciiPunct(c: string): boolean {
  return ASCII_PUNCT.has(c);
}

// Rust `char::is_ascii_digit`.
function isAsciiDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

interface EmphasisDelim {
  ch: string;
  len: number;
  pos: number;
}

// Port of the backend's `consume_line_start_markers`: from `start`, consume any
// leading block markers on the current line (thematic break, ATX heading,
// blockquote, bullet/ordered list marker) and return the index of the first
// content character. Blockquotes recurse (a marker can nest, e.g. `> # H`).
function consumeLineStartMarkers(chars: string[], start: number): number {
  const n = chars.length;
  let i = start;
  for (;;) {
    let p = i;
    while (p < n && (chars[p] === " " || chars[p] === "\t")) p += 1;
    let lineEnd = p;
    while (lineEnd < n && chars[lineEnd] !== "\n") lineEnd += 1;

    // Thematic break: a line of >= 3 of the same marker (`-`, `*`, `_`), with
    // only spaces/tabs between — drop the whole line.
    let marker: string | null = null;
    let count = 0;
    let allBreak = true;
    let k = p;
    while (k < lineEnd) {
      const cc = chars[k];
      if (cc === "-" || cc === "*" || cc === "_") {
        if (marker === null) {
          marker = cc;
          count += 1;
        } else if (marker === cc) {
          count += 1;
        } else {
          allBreak = false;
          break;
        }
      } else if (cc !== " " && cc !== "\t") {
        allBreak = false;
        break;
      }
      k += 1;
    }
    if (allBreak && marker !== null && count >= 3) return lineEnd;

    // ATX heading: 1-6 `#` followed by a space/tab or end of line.
    let hashes = 0;
    k = p;
    while (k < lineEnd && chars[k] === "#") {
      hashes += 1;
      k += 1;
    }
    if (
      hashes >= 1 &&
      hashes <= 6 &&
      (k === lineEnd || chars[k] === " " || chars[k] === "\t")
    ) {
      let after = k;
      if (after < lineEnd && (chars[after] === " " || chars[after] === "\t")) {
        after += 1;
      }
      return after;
    }

    // Blockquote: `>` then optional space — recurse for nested markers.
    if (p < n && chars[p] === ">") {
      let after = p + 1;
      if (after < n && (chars[after] === " " || chars[after] === "\t")) {
        after += 1;
      }
      i = after;
      continue;
    }

    // Bullet list: `-`/`*`/`+` followed by a space/tab.
    if (p < n && (chars[p] === "-" || chars[p] === "*" || chars[p] === "+")) {
      if (p + 1 < n && (chars[p + 1] === " " || chars[p + 1] === "\t")) {
        return p + 2;
      }
    }

    // Ordered list: 1-9 digits then `.`/`)` then a space/tab.
    if (p < n && isAsciiDigit(chars[p])) {
      let kd = p;
      while (kd < n && isAsciiDigit(chars[kd]) && kd - p < 9) kd += 1;
      if (kd < n && (chars[kd] === "." || chars[kd] === ")")) {
        const delim = kd;
        if (
          delim + 1 < n &&
          (chars[delim + 1] === " " || chars[delim + 1] === "\t")
        ) {
          return delim + 2;
        }
      }
    }

    return i;
  }
}

/**
 * Strip Markdown styling from `input`, returning plain text — a line-for-line
 * port of the backend's now-reverted `strip_markdown` (see the section comment
 * above). Removes emphasis/strong (`*`/`_`),
 * strikethrough (`~~`), inline code fences (keeping the literal contents),
 * link/image syntax (keeping the recursively-stripped label), backslash escapes
 * of ASCII punctuation, and line-start block markers (headings, blockquotes,
 * list bullets, thematic breaks). Unmatched or non-flanking delimiters are left
 * verbatim, exactly as the backend does. Newlines are preserved.
 */
export function stripMarkdown(input: string): string {
  const chars = Array.from(input);
  const n = chars.length;
  const out: string[] = [];
  const stack: EmphasisDelim[] = [];
  let i = 0;
  let atLineStart = true;

  while (i < n) {
    if (atLineStart) {
      i = consumeLineStartMarkers(chars, i);
      atLineStart = false;
      if (i >= n) break;
    }
    const c = chars[i];

    // Backslash escape: a `\` before ASCII punctuation emits that punctuation
    // literally; otherwise the `\` itself is kept.
    if (c === "\\") {
      if (i + 1 < n && isAsciiPunct(chars[i + 1])) {
        out.push(chars[i + 1]);
        i += 2;
      } else {
        out.push("\\");
        i += 1;
      }
      continue;
    }

    // Inline code span: a run of N backticks closed by another run of exactly N
    // backticks. Contents are kept verbatim (no styling stripped, no spaces
    // trimmed). An unclosed run is emitted literally.
    if (c === "`") {
      let run = 0;
      while (i + run < n && chars[i + run] === "`") run += 1;
      let j = i + run;
      let close: number | null = null;
      while (j < n) {
        if (chars[j] === "`") {
          let k = 0;
          while (j + k < n && chars[j + k] === "`") k += 1;
          if (k === run) {
            close = j;
            break;
          }
          j += k;
        } else {
          j += 1;
        }
      }
      if (close !== null) {
        for (let idx = i + run; idx < close; idx += 1) out.push(chars[idx]);
        i = close + run;
      } else {
        for (let r = 0; r < run; r += 1) out.push("`");
        i += run;
      }
      continue;
    }

    // Link `[label](dest)` / `[label][ref]` and image `![alt](dest)`: keep the
    // recursively-stripped label, drop the brackets and destination. A bare
    // `[label]` with no following `(` or `[` is left as literal text.
    if (c === "[" || (c === "!" && i + 1 < n && chars[i + 1] === "[")) {
      const openBracket = c === "!" ? i + 1 : i;
      let depth = 1;
      let closeBracket: number | null = null;
      let q = openBracket + 1;
      while (q < n) {
        if (chars[q] === "[") {
          depth += 1;
        } else if (chars[q] === "]") {
          depth -= 1;
          if (depth === 0) {
            closeBracket = q;
            break;
          }
        }
        q += 1;
      }
      if (closeBracket !== null) {
        const mpos = closeBracket;
        const after = mpos + 1;
        const label = chars.slice(openBracket + 1, mpos);
        if (after < n && chars[after] === "(") {
          let pdepth = 1;
          let r = after + 1;
          let endParen: number | null = null;
          while (r < n) {
            if (chars[r] === "(") {
              pdepth += 1;
            } else if (chars[r] === ")") {
              pdepth -= 1;
              if (pdepth === 0) {
                endParen = r;
                break;
              }
            }
            r += 1;
          }
          if (endParen !== null) {
            for (const ch of stripMarkdown(label.join(""))) out.push(ch);
            i = endParen + 1;
            continue;
          }
        } else if (after < n && chars[after] === "[") {
          let rdepth = 1;
          let r = after + 1;
          let refEnd: number | null = null;
          while (r < n) {
            if (chars[r] === "[") {
              rdepth += 1;
            } else if (chars[r] === "]") {
              rdepth -= 1;
              if (rdepth === 0) {
                refEnd = r;
                break;
              }
            }
            r += 1;
          }
          if (refEnd !== null) {
            for (const ch of stripMarkdown(label.join(""))) out.push(ch);
            i = refEnd + 1;
            continue;
          }
        }
      }
      out.push("[");
      i = openBracket + 1;
      continue;
    }

    // Emphasis / strong / strikethrough delimiters. `~` only forms a delimiter
    // as an exact run of 2 (strikethrough); otherwise it is literal text.
    if (c === "*" || c === "_" || c === "~") {
      let run = 0;
      while (i + run < n && chars[i + run] === c) run += 1;
      if (c === "~" && run !== 2) {
        for (let r = 0; r < run; r += 1) out.push("~");
        i += run;
        continue;
      }
      const prev = i > 0 && chars[i - 1] !== "\n" ? chars[i - 1] : null;
      const next =
        i + run < n && chars[i + run] !== "\n" ? chars[i + run] : null;
      let canOpen = next !== null && !isWs(next);
      let canClose = prev !== null && !isWs(prev);
      if (c === "_") {
        // `_` may not open/close against a word char (intra-word `_` is literal).
        const prevOk = prev === null ? true : !isWord(prev);
        const nextOk = next === null ? true : !isWord(next);
        canOpen = canOpen && prevOk;
        canClose = canClose && nextOk;
      }
      if (canClose) {
        let openerIdx: number | null = null;
        for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
          if (stack[idx].ch === c) {
            openerIdx = idx;
            break;
          }
        }
        if (openerIdx !== null) {
          const opener = stack[openerIdx];
          out.splice(opener.pos, opener.len);
          stack.length = openerIdx;
          i += run;
          continue;
        }
      }
      if (canOpen) {
        const pos = out.length;
        for (let r = 0; r < run; r += 1) out.push(c);
        stack.push({ ch: c, len: run, pos });
        i += run;
        continue;
      }
      for (let r = 0; r < run; r += 1) out.push(c);
      i += run;
      continue;
    }

    out.push(c);
    atLineStart = c === "\n";
    i += 1;
  }
  return out.join("");
}

/**
 * Build a bounded, single-line snippet from a message's real text content, or
 * `null` when there is no text (tool-only, thinking-only, image-only,
 * notification-only, or whitespace-only input).
 *
 * Callers must pass ONLY concatenated text content; non-text blocks (thinking,
 * tool calls/results, images, notifications) must be excluded upstream, exactly
 * as the backend's `Message::as_concat_text` yields only `Text` parts.
 *
 * @param text concatenated text content of the message
 * @param maxChars code-point cap (defaults to {@link MESSAGE_SNIPPET_MAX_CHARS};
 *   parameterized so tests can mirror the backend's smaller-cap vectors)
 */
export function messageSnippet(
  text: string,
  maxChars: number = MESSAGE_SNIPPET_MAX_CHARS,
): string | null {
  // Bound the scanned input before the (otherwise full-length) split/join/
  // Array.from passes so each call is O(SNIPPET_SCAN_LIMIT), not O(text length).
  // The snippet is determined by the leading prefix, so slicing here is exact for
  // realistic input; see SNIPPET_SCAN_LIMIT for the surrogate-pair math and the
  // pathological-whitespace caveat.
  const scanned =
    text.length > SNIPPET_SCAN_LIMIT ? text.slice(0, SNIPPET_SCAN_LIMIT) : text;

  // Strip Markdown styling before whitespace normalization. The backend no
  // longer strips (its copy was reverted), so this is a frontend-only step; see
  // the stripMarkdown section comment. Order is exactly:
  // slice -> stripMarkdown -> collapse whitespace -> cap. Stripping only removes
  // characters, so it can never push more text into view than the
  // SNIPPET_SCAN_LIMIT bound already covers. On the live path this runs on the
  // full (bounded) text; on ingest (acpApi.ts) it runs on the backend's
  // already-collapsed-and-capped value — the live-vs-reload difference
  // documented on stripMarkdown.
  const stripped = stripMarkdown(scanned);

  // Collapse every White_Space run to a single ASCII space and trim the ends,
  // exactly like the backend's `text.split_whitespace().collect().join(" ")`.
  const normalized = stripped
    .split(WHITESPACE_RUN_RE)
    .filter((token) => token.length > 0)
    .join(" ");
  if (normalized.length === 0) {
    return null;
  }

  // Count by code point (Rust `chars()`) so surrogate pairs / emoji are never
  // split mid-character and the cap matches the backend's exactly.
  const codePoints = Array.from(normalized);
  if (codePoints.length <= maxChars) {
    // Exact fit (== cap) gets NO ellipsis, mirroring the backend.
    return normalized;
  }

  // Truncate to the cap, then drop a trailing space so we never produce
  // "word …". After normalization only a single U+0020 can remain, but we trim
  // with the White_Space-aware regex rather than `String.prototype.trimEnd`,
  // which would also strip a trailing U+FEFF that the backend's `trim_end`
  // keeps.
  const truncated = codePoints
    .slice(0, maxChars)
    .join("")
    .replace(TRAILING_WHITESPACE_RE, "");
  return `${truncated}…`;
}
