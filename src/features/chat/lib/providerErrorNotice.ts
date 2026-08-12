/**
 * Recognizes known, actionable provider errors that the Goose backend surfaces
 * as plain assistant text (e.g. the generic "Ran into this error: ..." arm in
 * the agent reply loop). When matched, the UI can replace the raw provider 400
 * with a friendly explanation instead of dumping the JSON at the user.
 *
 * This is detection only. It does not change what is sent to the provider; the
 * underlying fix for these cases lives in the Goose backend session history.
 */
export type ProviderErrorNoticeKind = "anthropicThinkingHistory";

/**
 * Anthropic rejects a request when a prior assistant message's `thinking` /
 * `redacted_thinking` blocks were changed from what it originally returned
 * (duplicated, merged, reordered, or trimmed). Once a session's persisted
 * history reaches this shape, every later Claude turn on that session 400s.
 *
 * Example backend text:
 *   Ran into this error: Request failed: Bad request (400):
 *   {"message":"messages.5.content.1: `thinking` or `redacted_thinking`
 *   blocks in the latest assistant message cannot be modified. These blocks
 *   must remain as they were in the original response."}
 */
const ANTHROPIC_THINKING_HISTORY_PATTERN =
  /(?:thinking|redacted_thinking)[\s\S]*blocks in the latest assistant message cannot be modified/i;

export function detectProviderErrorNotice(
  text: string,
): ProviderErrorNoticeKind | null {
  if (!text) {
    return null;
  }

  if (ANTHROPIC_THINKING_HISTORY_PATTERN.test(text)) {
    return "anthropicThinkingHistory";
  }

  return null;
}
