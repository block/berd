import { math } from "@streamdown/math";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { unified } from "unified";

// Use the renderer's math configuration and CommonMark's code boundaries.
const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use([math.remarkPlugin]);
// Bound the extra CommonMark pass on pathological model output. Larger
// messages retain native rendering and source offsets without partial edits.
const maxNormalizationLength = 128_000;
const protectedTypes = new Set([
  "code",
  "inlineCode",
  "html",
  "math",
  "inlineMath",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "definition",
]);

const symbols: Readonly<Record<string, string>> = {
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  leftrightarrow: "↔",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  Leftrightarrow: "⇔",
  mapsto: "↦",
  uparrow: "↑",
  downarrow: "↓",
  Uparrow: "⇑",
  Downarrow: "⇓",
  updownarrow: "↕",
  Updownarrow: "⇕",
  implies: "⇒",
  iff: "⇔",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  ne: "≠",
  neq: "≠",
  approx: "≈",
  sim: "∼",
  simeq: "≃",
  cong: "≅",
  equiv: "≡",
  propto: "∝",
  pm: "±",
  mp: "∓",
  times: "×",
  div: "÷",
  cdot: "·",
  infty: "∞",
  degree: "°",
  checkmark: "✓",
  in: "∈",
  notin: "∉",
  ni: "∋",
  subset: "⊂",
  subseteq: "⊆",
  supset: "⊃",
  supseteq: "⊇",
  cup: "∪",
  cap: "∩",
  emptyset: "∅",
  forall: "∀",
  exists: "∃",
  neg: "¬",
  land: "∧",
  lor: "∨",
  therefore: "∴",
  because: "∵",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  theta: "θ",
  lambda: "λ",
  mu: "μ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  phi: "φ",
  omega: "ω",
  Delta: "Δ",
  Gamma: "Γ",
  Lambda: "Λ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Omega: "Ω",
};

type SourceNode = {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: SourceNode[];
  checked?: boolean | null;
};
type Edit = { start: number; end: number; replacement: string };
type Range = { start: number; end: number };
type Paragraph = Range & {
  index: number;
  prefix: string;
  container: number;
  containerEnd: number;
};

function paragraphAt(paragraphs: Paragraph[], offset: number) {
  let low = 0;
  let high = paragraphs.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const paragraph = paragraphs[middle];
    if (offset < paragraph.start) high = middle - 1;
    else if (offset >= paragraph.end) low = middle + 1;
    else return paragraph;
  }
  return undefined;
}

function overlapsRange(ranges: Range[], start: number, end: number) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const range = ranges[middle];
    if (range.end <= start) low = middle + 1;
    else if (range.start >= end) high = middle - 1;
    else return true;
  }
  return false;
}

function mergeRanges(ranges: Range[]): Range[] {
  ranges.sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end)
      previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  while (index > 0 && source[--index] === "\\") backslashes += 1;
  return backslashes % 2 === 1;
}

function continuationPrefix(source: string): string {
  // CommonMark indentation uses four-column tab stops, not character counts.
  // Expand before replacing markers so nested list/quote columns stay aligned.
  let column = 0;
  let expanded = "";
  for (const character of source) {
    const width = character === "\t" ? 4 - (column % 4) : 1;
    expanded += character === "\t" ? " ".repeat(width) : character;
    column += width;
  }
  return expanded.replace(/(?:[-+*]|\d+[.)]) +/g, (marker) =>
    " ".repeat(marker.length),
  );
}

function displayReplacement(
  body: string,
  prefix: string,
  atContainerParagraphStart: boolean,
): string {
  const lines = body.split(/\r?\n/);
  const continuation = new RegExp(
    "^" + prefix.replace(/[ \t]+/g, (spaces) => `[ \\t]{0,${spaces.length}}`),
  );
  // The first line starts after \\[. Subsequent lines still carry their
  // Markdown quote/list continuation prefix, which is not part of TeX.
  for (let index = 1; index < lines.length; index += 1) {
    if (prefix) lines[index] = lines[index].replace(continuation, "");
  }
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const blank = prefix.trimEnd();
  // A list marker with no preceding prose cannot survive a blank line before
  // its first block. Start the display on that retained marker/quote line.
  const opening = atContainerParagraphStart ? "$$" : `\n${blank}\n${prefix}$$`;
  return `${opening}\n${lines.map((line) => prefix + line).join("\n")}\n${prefix}$$\n${blank}\n${prefix}`;
}

function isOperatorContinuation(body: string, prefix: string): boolean {
  // CommonMark can mistake a simple algebra continuation for a child bullet.
  // Admit only an operator followed by one explicit math atom. Ambiguous prose
  // and more complex cross-item source retain their original Markdown instead.
  const continuation = new RegExp(
    "^" + prefix.replace(/[ \t]+/g, (spaces) => `[ \\t]{0,${spaces.length}}`),
  );
  return body
    .split(/\r?\n/)
    .slice(1)
    .every((line) => {
      const source = (prefix ? line.replace(continuation, "") : line).trim();
      return /^[+-][ \t]+(?:[A-Za-z]|\d+(?:\.\d+)?|\\[A-Za-z]+)(?:[_^](?:[A-Za-z0-9]|\{[A-Za-z0-9]+\}))?$/.test(
        source,
      );
    });
}

function segmentEdits(
  source: string,
  offset: number,
  paragraphs: Paragraph[],
  nonDisplayRanges: Range[],
): Edit[] {
  const edits: Edit[] = [];
  let opening: number | undefined;
  for (const match of source.matchAll(/\\[[\]]/g)) {
    const index = match.index;
    if (isEscaped(source, index)) continue;
    if (match[0] === "\\[") {
      opening ??= index;
    } else if (opening !== undefined) {
      const start = offset + opening;
      const end = offset + index + 2;
      const paragraph = paragraphAt(paragraphs, start);
      const closingParagraph = paragraphAt(paragraphs, end - 1);
      const body = source.slice(opening + 2, index);
      // Block displays cannot be inserted into inline formatting, table cells,
      // or across unrelated list/quote containers without changing their markup.
      // A math continuation such as "+ b" can parse as a nested list. Only
      // admit that narrow algebra case across containers; a parent's source
      // span also contains real child items and cannot alone protect them.
      // Preserve unrelated source rather than manufacture an invalid block.
      if (
        !paragraph ||
        !closingParagraph ||
        end > paragraph.containerEnd ||
        (paragraph.prefix.match(/>/g)?.length ?? 0) !==
          (closingParagraph.prefix.match(/>/g)?.length ?? 0) ||
        (paragraphs
          .slice(paragraph.index, closingParagraph.index + 1)
          .some(
            (candidate) =>
              candidate.start < end &&
              candidate.end > start &&
              candidate.container !== paragraph.container,
          ) &&
          !isOperatorContinuation(body, paragraph.prefix)) ||
        overlapsRange(nonDisplayRanges, start, end)
      ) {
        opening = undefined;
        continue;
      }
      edits.push({
        start,
        end,
        replacement: displayReplacement(
          body,
          paragraph.prefix,
          start === paragraph.start && paragraph.prefix.length > 0,
        ),
      });
      opening = undefined;
    }
  }
  // Symbols inside bracket equations belong to KaTeX, not this prose pass.
  const equations = [...edits];
  let equationIndex = 0;
  for (const match of source.matchAll(/\$\\([A-Za-z]+)\$/g)) {
    const start = offset + match.index;
    while (equations[equationIndex] && equations[equationIndex].end <= start)
      equationIndex += 1;
    const equation = equations[equationIndex];
    const symbol = symbols[match[1]];
    if (
      !symbol ||
      isEscaped(source, match.index) ||
      (equation && start >= equation.start)
    )
      continue;
    edits.push({ start, end: start + match[0].length, replacement: symbol });
  }
  return edits.sort((a, b) => a.start - b.start);
}

export type PreparedMessageMath = {
  content: string;
  remapCutoff: (cutoff?: number) => number | undefined;
};

/** Prepare supported math once per source change, independent of voice updates. */
export function prepareMessageMath(content: string): PreparedMessageMath {
  if (
    content.length > maxNormalizationLength ||
    (!content.includes("\\[") && !/\$\\[A-Za-z]+\$/.test(content))
  ) {
    return { content, remapCutoff: (cutoff) => cutoff };
  }
  const protectedRanges: Range[] = [];
  const paragraphs: Paragraph[] = [];
  const htmlRanges: Range[] = [];
  const nonDisplayRanges: Range[] = [];
  // Leaf blocks and empty containers are barriers even when the equation's
  // opening and closing paragraphs share the same parent.
  const nonDisplayTypes = new Set([
    "emphasis",
    "strong",
    "delete",
    "heading",
    "thematicBreak",
    "table",
  ]);
  let nextContainer = 0;
  const visit = (
    node: SourceNode,
    container = 0,
    containerEnd = content.length,
  ) => {
    if (node.type === "blockquote" || node.type === "listItem")
      container = ++nextContainer;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      (node.type === "blockquote" || node.type === "listItem") &&
      end !== undefined
    )
      containerEnd = end;
    if (node.type === "paragraph" && start !== undefined && end !== undefined) {
      const lineStart = content.lastIndexOf("\n", start - 1) + 1;
      // A paragraph's source position begins after its container markers.
      // Keep quote markers and turn list markers into continuation indentation.
      const prefix = continuationPrefix(content.slice(lineStart, start));
      paragraphs.push({
        index: paragraphs.length,
        start,
        end,
        prefix,
        container,
        containerEnd,
      });
    }
    if (
      (nonDisplayTypes.has(node.type) ||
        ((node.type === "blockquote" || node.type === "listItem") &&
          !node.children?.length)) &&
      start !== undefined &&
      end !== undefined
    )
      nonDisplayRanges.push({ start, end });
    // GFM task markers belong to their first paragraph. Replacing that
    // paragraph with a display block loses checkbox semantics, so preserve
    // bracket source there just as in other non-display Markdown contexts.
    if (node.type === "listItem" && typeof node.checked === "boolean") {
      const first = node.children?.[0];
      const taskStart = first?.position?.start.offset;
      const taskEnd = first?.position?.end.offset;
      if (
        first?.type === "paragraph" &&
        taskStart !== undefined &&
        taskEnd !== undefined
      )
        nonDisplayRanges.push({ start: taskStart, end: taskEnd });
    }
    if (node.type === "html" && start !== undefined && end !== undefined)
      htmlRanges.push({ start, end });
    if (protectedTypes.has(node.type)) {
      if (start !== undefined && end !== undefined)
        protectedRanges.push({ start, end });
      return;
    }
    for (const child of node.children ?? [])
      visit(child, container, containerEnd);
  };
  visit(parser.parse(content));
  // Inline HTML tags are separate AST nodes from their bodies. Preserve code
  // and pre contents through the matching close, or the end of a partial stream.
  const rawCode: { tag: string; start: number }[] = [];
  const rawHtml: { tag: string; start: number }[] = [];
  const voidTags = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);
  for (const range of htmlRanges) {
    const html = content.slice(range.start, range.end);
    for (const match of html.matchAll(
      /<\s*(\/?)\s*([A-Za-z][\w-]*)\b[^>]*>/g,
    )) {
      const tag = match[2].toLowerCase();
      if (voidTags.has(tag) || /\/\s*>$/.test(match[0])) continue;
      if (!match[1]) {
        rawHtml.push({ tag, start: range.start + match.index });
      } else {
        let opening = rawHtml.length - 1;
        while (opening >= 0 && rawHtml[opening].tag !== tag) opening -= 1;
        if (opening !== -1) {
          nonDisplayRanges.push({
            start: rawHtml[opening].start,
            end: range.start + match.index + match[0].length,
          });
          rawHtml.splice(opening);
        }
      }
    }
    for (const match of html.matchAll(/<\s*(\/?)\s*(code|pre)\b[^>]*>/gi)) {
      const tag = match[2].toLowerCase();
      if (!match[1]) {
        rawCode.push({ tag, start: range.start + match.index });
      } else {
        let opening = rawCode.length - 1;
        while (opening >= 0 && rawCode[opening].tag !== tag) opening -= 1;
        if (opening !== -1) {
          protectedRanges.push({
            start: rawCode[opening].start,
            end: range.start + match.index + match[0].length,
          });
          rawCode.splice(opening);
        }
      }
    }
  }
  for (const opening of rawCode)
    protectedRanges.push({ start: opening.start, end: content.length });
  for (const opening of rawHtml)
    nonDisplayRanges.push({ start: opening.start, end: content.length });
  const existingProtection = mergeRanges(protectedRanges);
  // Streamdown can complete an unfinished inline code span while streaming.
  // CommonMark has no code node yet, so conservatively preserve its remainder.
  for (const paragraph of paragraphs) {
    const source = content.slice(paragraph.start, paragraph.end);
    for (const match of source.matchAll(/`+/g)) {
      const start = paragraph.start + match.index;
      const lineEnd = source.indexOf("\n", match.index);
      if (
        match.index === 0 &&
        match[0].length >= 3 &&
        source
          .slice(match[0].length, lineEnd === -1 ? undefined : lineEnd)
          .includes("`")
      )
        continue;
      if (
        !isEscaped(content, start) &&
        !overlapsRange(existingProtection, start, start + match[0].length)
      ) {
        protectedRanges.push({ start, end: paragraph.end });
        break;
      }
    }
  }
  const mergedRanges = mergeRanges(protectedRanges);
  const mergedNonDisplayRanges = mergeRanges(nonDisplayRanges);
  const edits: Edit[] = [];
  let position = 0;
  for (const range of mergedRanges) {
    edits.push(
      ...segmentEdits(
        content.slice(position, range.start),
        position,
        paragraphs,
        mergedNonDisplayRanges,
      ),
    );
    position = range.end;
  }
  edits.push(
    ...segmentEdits(
      content.slice(position),
      position,
      paragraphs,
      mergedNonDisplayRanges,
    ),
  );
  const parts: string[] = [];
  position = 0;
  for (const edit of edits) {
    parts.push(content.slice(position, edit.start), edit.replacement);
    position = edit.end;
  }
  parts.push(content.slice(position));
  return {
    content: parts.join(""),
    remapCutoff: (cutoff) => {
      if (cutoff === undefined) return undefined;
      let delta = 0;
      for (const edit of edits) {
        if (cutoff < edit.start) break;
        // A partially spoken symbol or formula stays wholly unspoken.
        if (cutoff < edit.end) return edit.start + delta;
        delta += edit.replacement.length - (edit.end - edit.start);
      }
      return cutoff + delta;
    },
  };
}

/** Compatibility wrapper for callers that already supply a voice boundary. */
export function normalizeMessageMath(content: string, cutoff?: number) {
  const prepared = prepareMessageMath(content);
  return { content: prepared.content, cutoff: prepared.remapCutoff(cutoff) };
}
