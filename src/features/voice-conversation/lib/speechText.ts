import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { unified } from "unified";

const parser = unified().use(remarkParse).use(remarkGfm);

export type SpeechTextSpan = {
  text: string;
  sourceStart: number;
  sourceEnd: number;
};

// Parse the full source prefix on each update, so split links and resumption
// retain Markdown context. Only literal label/prose characters are synthesized.
export function speechTextSpans(source: string, from = 0): SpeechTextSpan[] {
  const spans: SpeechTextSpan[] = [];
  let labels = 0;
  let afterLabel = false;
  let destination = 0;
  let quote: string | null = null;
  let angleDestination = false;
  let escaped = false;
  let offset = 0;
  const code: { start: number; end: number }[] = [];
  const inlineBlocks: { start: number; end: number }[] = [];
  const visit = (node: {
    type: string;
    position?: { start: { offset?: number }; end: { offset?: number } };
    children?: (typeof node)[];
  }) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (node.type === "code" || node.type === "inlineCode") {
        code.push({ start, end });
        return;
      }
      if (["paragraph", "heading", "tableCell"].includes(node.type))
        inlineBlocks.push({ start, end });
    }
    if (node.children) for (const child of node.children) visit(child);
  };
  visit(parser.parse(source));
  let codeIndex = 0;
  let blockIndex = 0;
  let incompleteCodeEnd = 0;
  for (const char of source) {
    const start = offset;
    offset += char.length;
    while (code[codeIndex] && code[codeIndex].end <= start) codeIndex++;
    while (inlineBlocks[blockIndex] && inlineBlocks[blockIndex].end <= start)
      blockIndex++;
    const range = code[codeIndex];
    let literalCode =
      (range !== undefined && range.start <= start) ||
      start < incompleteCodeEnd;
    // Streamdown can complete unfinished inline code before CommonMark has a
    // code node. Preserve only the rest of that inline block while streaming.
    if (!literalCode && !destination && !escaped && char === "`") {
      const block = inlineBlocks[blockIndex];
      if (block && block.start <= start) {
        incompleteCodeEnd = block.end;
        literalCode = true;
      }
    }
    if (destination || !literalCode) {
      if (destination) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (angleDestination) {
          if (char === ">") angleDestination = false;
        } else if (quote) {
          if (char === quote) quote = null;
        } else if (char === "<") angleDestination = true;
        else if (
          (char === '"' || char === "'") &&
          /\s/.test(source[start - 1] ?? "")
        )
          quote = char;
        else if (char === "(") destination++;
        else if (char === ")") destination--;
        continue;
      }
      if (afterLabel) {
        afterLabel = false;
        if (char === "(") {
          destination = 1;
          continue;
        }
      }
      if (escaped) escaped = false;
      else if (char === "\\") {
        escaped = true;
        if (labels) continue;
      } else if (char === "[") {
        labels++;
        continue;
      } else if (char === "]" && labels) {
        labels--;
        afterLabel = labels === 0;
        continue;
      }
    }
    if (offset <= from) continue;
    const sourceStart = Math.max(start, from);
    const text = source.slice(sourceStart, offset);
    const last = spans.at(-1);
    if (last?.sourceEnd === sourceStart) {
      last.text += text;
      last.sourceEnd = offset;
    } else spans.push({ text, sourceStart, sourceEnd: offset });
  }
  return spans;
}
