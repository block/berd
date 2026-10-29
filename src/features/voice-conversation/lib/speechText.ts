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
  for (const char of source) {
    const start = offset;
    offset += char.length;
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
    else if (char === "\\" && labels) {
      escaped = true;
      continue;
    } else if (char === "[") {
      labels++;
      continue;
    } else if (char === "]" && labels) {
      labels--;
      afterLabel = labels === 0;
      continue;
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
