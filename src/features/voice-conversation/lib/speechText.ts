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
  let codeMarker = "";
  let codeLength = 0;
  let fenced = false;
  let markerEnd = 0;
  for (const char of source) {
    const start = offset;
    offset += char.length;
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    const indented = /^( {4}|\t)/.test(source.slice(lineStart));
    let literalCode = indented || codeMarker !== "" || start < markerEnd;
    if (
      !indented &&
      !destination &&
      !escaped &&
      start >= markerEnd &&
      (char === "`" || char === "~")
    ) {
      const run =
        source.slice(start).match(char === "`" ? /^`+/ : /^~+/)?.[0] ?? char;
      const atFence = /^ {0,3}$/.test(source.slice(lineStart, start));
      if (
        codeMarker === char &&
        (fenced
          ? atFence && run.length >= codeLength
          : run.length === codeLength)
      ) {
        codeMarker = "";
        literalCode = true;
      } else if (
        !codeMarker &&
        (char === "`" || (atFence && run.length >= 3))
      ) {
        codeMarker = char;
        codeLength = run.length;
        fenced = atFence && run.length >= 3;
        literalCode = true;
      }
      markerEnd = start + run.length;
    }
    if (!literalCode) {
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
    if (start < from) continue;
    const last = spans.at(-1);
    if (last?.sourceEnd === start) {
      last.text += char;
      last.sourceEnd = offset;
    } else spans.push({ text: char, sourceStart: start, sourceEnd: offset });
  }
  return spans;
}
