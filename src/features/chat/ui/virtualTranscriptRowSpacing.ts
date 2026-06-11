import type { TranscriptRowDescriptor } from "../transcript/projection";

const TRANSCRIPT_ROW_TOP_SPACING_PX = 16;
const TRANSCRIPT_HEADING_ROW_TOP_SPACING_PX = 24;

interface VirtualTranscriptRowSpacingInput {
  row: Pick<TranscriptRowDescriptor, "fragment" | "kind">;
  index: number;
  previousRowKind?: TranscriptRowDescriptor["kind"];
}

export function getVirtualTranscriptRowSpacingBlockSize({
  row,
  index,
  previousRowKind,
}: VirtualTranscriptRowSpacingInput): number {
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
  layoutMode,
  ...input
}: VirtualTranscriptRowSpacingInput & {
  layoutMode: "flow" | "virtual";
}): string {
  const spacingBlockSize = getVirtualTranscriptRowSpacingBlockSize(input);
  if (spacingBlockSize === 0) {
    return layoutMode === "virtual" ? "pt-0" : "mt-0";
  }
  if (spacingBlockSize === TRANSCRIPT_HEADING_ROW_TOP_SPACING_PX) {
    return layoutMode === "virtual" ? "pt-6" : "mt-6";
  }
  return layoutMode === "virtual" ? "pt-4" : "mt-4";
}

function isFragmentContinuation(
  row: Pick<TranscriptRowDescriptor, "fragment" | "kind">,
): boolean {
  return (
    row.kind === "assistant-content-fragment" &&
    row.fragment?.isCodeContinuationChunk === true
  );
}
