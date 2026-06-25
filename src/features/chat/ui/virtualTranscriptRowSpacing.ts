import type { TranscriptRowDescriptor } from "../transcript/projection";

const TRANSCRIPT_ROW_TOP_SPACING_PX = 16;
const TRANSCRIPT_HEADING_ROW_TOP_SPACING_PX = 24;

interface VirtualTranscriptRowSpacingInput {
  row: Pick<TranscriptRowDescriptor, "fragment" | "kind"> & {
    spacingBefore?: number;
  };
  index: number;
  previousRowKind?: TranscriptRowDescriptor["kind"];
}

export function getVirtualTranscriptRowSpacingBlockSize({
  row,
  index,
  previousRowKind,
}: VirtualTranscriptRowSpacingInput): number {
  if (typeof row.spacingBefore === "number") {
    return Math.max(0, row.spacingBefore);
  }

  if (isFragmentContinuation(row) || previousRowKind === "date-separator") {
    return 0;
  }

  if (index === 0) {
    return 0;
  }

  if (
    row.kind === "assistant-content-fragment" &&
    row.fragment?.startsWithHeading
  ) {
    return TRANSCRIPT_HEADING_ROW_TOP_SPACING_PX;
  }

  return TRANSCRIPT_ROW_TOP_SPACING_PX;
}

export function getVirtualTranscriptRowSpacingClassName({
  ...input
}: VirtualTranscriptRowSpacingInput & {
  layoutMode: "flow" | "virtual";
}): string {
  const spacingBlockSize = getVirtualTranscriptRowSpacingBlockSize(input);
  if (spacingBlockSize === 0) {
    return "pt-0";
  }
  if (spacingBlockSize === TRANSCRIPT_HEADING_ROW_TOP_SPACING_PX) {
    return "pt-6";
  }
  return "pt-4";
}

function isFragmentContinuation(
  row: Pick<TranscriptRowDescriptor, "fragment" | "kind">,
): boolean {
  return (
    row.kind === "assistant-content-fragment" &&
    row.fragment?.isCodeContinuationChunk === true
  );
}
