import type { TranscriptRowDescriptor } from "@/features/chat/transcript/projection";

type FeedbackRow = Pick<
  TranscriptRowDescriptor,
  "kind" | "messageId" | "responseStartMessageId" | "rowId"
>;

export function selectResponseFeedbackRowIds(
  rows: readonly FeedbackRow[],
): ReadonlySet<string> {
  const selectedByResponse = new Map<
    string,
    { rowId: string; isAnswer: boolean }
  >();
  for (const row of rows) {
    if (
      (row.kind !== "message" && row.kind !== "assistant-content-fragment") ||
      !row.messageId
    ) {
      continue;
    }
    const responseId = row.responseStartMessageId ?? row.messageId;
    const current = selectedByResponse.get(responseId);
    const isAnswer = row.rowId.endsWith(":answer");
    if (!current || isAnswer || !current.isAnswer) {
      selectedByResponse.set(responseId, { rowId: row.rowId, isAnswer });
    }
  }
  return new Set([...selectedByResponse.values()].map(({ rowId }) => rowId));
}
