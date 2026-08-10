import type { StagedItem } from "@/shared/types/messages";

const CALLBACK_PREFIX =
  "The user is referring specifically to this earlier passage:";

export function buildStagedQuoteAssistantPrompt(
  stagedItems: readonly StagedItem[],
): string | undefined {
  const quotes = stagedItems.filter((item) => item.kind === "quote");
  if (quotes.length === 0) return undefined;

  return [
    CALLBACK_PREFIX,
    ...quotes.map(
      (quote) => `\n<quoted-passage>\n${quote.excerpt}\n</quoted-passage>`,
    ),
    "\nAnswer the user's message in relation to that passage, not the entire earlier response unless they explicitly ask for it.",
  ].join("\n");
}

export function stagedItemSnapshotsMatch(
  current: readonly StagedItem[],
  submitted: readonly StagedItem[],
): boolean {
  return (
    current.length === submitted.length &&
    current.every((item, index) => item.id === submitted[index]?.id)
  );
}
