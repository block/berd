const NUMERIC = /^\d+$/;

const KNOWN_CASINGS: Record<string, string> = {
  gpt: "GPT",
  chatgpt: "ChatGPT",
  aws: "AWS",
  openai: "OpenAI",
};

export function humanizeRawModelId(id: string): string {
  const stripped = id.startsWith("goose-") ? id.slice("goose-".length) : id;
  const tokens = stripped.split("-").filter(Boolean);
  if (tokens.length === 0) return id;

  const segments: string[] = [];
  let numericRun: string[] = [];
  const flushNumeric = () => {
    if (numericRun.length > 0) {
      segments.push(numericRun.join("."));
      numericRun = [];
    }
  };

  for (const token of tokens) {
    if (NUMERIC.test(token)) {
      numericRun.push(token);
    } else {
      flushNumeric();
      const known = KNOWN_CASINGS[token.toLowerCase()];
      segments.push(
        known ?? token.charAt(0).toUpperCase() + token.slice(1).toLowerCase(),
      );
    }
  }
  flushNumeric();

  const result = segments.join(" ");
  return result.length === 0 ? id : result;
}
