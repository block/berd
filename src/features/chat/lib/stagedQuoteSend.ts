import type {
  Message,
  StagedItem,
  StagedQuoteItem,
  StagedQuoteSourceRange,
} from "@/shared/types/messages";

/**
 * Quote serialization happens at the authoritative send attempt, not in the
 * composer: only dispatch knows whether compaction ran for this attempt and
 * whether each quote's source turn still exists in the live transcript.
 *
 * - Anchor framing (source survives): the passage appears verbatim earlier
 *   in the conversation, so long excerpts are elided to head…tail anchors
 *   that uniquely locate it without re-sending the whole passage.
 * - Full-excerpt framing (source lost): compaction summarized the source
 *   turn away, so the excerpt is repeated in full — the callback must not
 *   silently degrade just because history was compacted.
 *
 * The decision is per quote source, not session-wide: a quote taken after
 * an old compaction can still anchor, while one whose source was just
 * compacted needs its excerpt.
 */

const CALLBACK_PREFIX =
  "The user is referring specifically to this earlier passage:";

const CALLBACK_SUFFIX =
  "Answer the user's message in relation to that passage, not the entire earlier response unless they explicitly ask for it.";

/** Excerpts at or under this length are sent whole even when anchored. */
const ANCHOR_ELISION_THRESHOLD = 400;
/** Head/tail lengths for elided anchors. */
const ANCHOR_EDGE_LENGTH = 160;

function anchorBody(excerpt: string): string {
  if (excerpt.length <= ANCHOR_ELISION_THRESHOLD) return excerpt;
  const head = excerpt.slice(0, ANCHOR_EDGE_LENGTH).trimEnd();
  const tail = excerpt.slice(-ANCHOR_EDGE_LENGTH).trimStart();
  return `${head}\n[…]\n${tail}`;
}

function serializeQuote(quote: StagedQuoteItem, anchored: boolean): string {
  if (anchored) {
    return [
      "\n<quoted-passage-anchor>",
      anchorBody(quote.excerpt),
      "</quoted-passage-anchor>",
      "(The full passage appears verbatim earlier in this conversation.)",
    ].join("\n");
  }
  return `\n<quoted-passage>\n${quote.excerpt}\n</quoted-passage>`;
}

/** Builds the assistant-audience quote framing for one send attempt.
 * `isSourceLive` reports whether a source's message still exists in the
 * transcript at this attempt; a quote anchors only when every one of its
 * sources survives. */
export function buildStagedQuoteDispatchPrompt(
  stagedItems: readonly StagedItem[],
  isSourceLive: (source: StagedQuoteSourceRange) => boolean,
): string | undefined {
  const quotes = stagedItems.filter((item) => item.kind === "quote");
  if (quotes.length === 0) return undefined;

  return [
    CALLBACK_PREFIX,
    ...quotes.map((quote) =>
      serializeQuote(
        quote,
        quote.sources.length > 0 && quote.sources.every(isSourceLive),
      ),
    ),
    `\n${CALLBACK_SUFFIX}`,
  ].join("\n");
}

/** Whether a quote source's turn is still live in the transcript at this
 * send attempt: its message exists and the referenced text block still
 * contains the quoted range. Compaction that summarizes the turn away (or
 * rewrites it shorter than the quote) fails this check, switching that
 * quote to full-excerpt framing. */
export function stagedQuoteSourceIsLive(
  messages: readonly Pick<Message, "id" | "content">[],
  source: StagedQuoteSourceRange,
): boolean {
  const message = messages.find(
    (candidate) => candidate.id === source.messageId,
  );
  const block = message?.content[source.contentBlockIndex];
  return (
    !!block &&
    block.type === "text" &&
    typeof block.text === "string" &&
    source.end <= block.text.length
  );
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
