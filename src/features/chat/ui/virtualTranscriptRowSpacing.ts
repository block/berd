import type { TranscriptRowDescriptor } from "../transcript/projection";

const TRANSCRIPT_ROW_TOP_SPACING_PX = 16;

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

  return index === 0 ? 0 : TRANSCRIPT_ROW_TOP_SPACING_PX;
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

  return layoutMode === "virtual" ? "pt-4" : "mt-4";
}

function isFragmentContinuation(
  row: Pick<TranscriptRowDescriptor, "fragment" | "kind">,
): boolean {
  return (
    row.kind === "assistant-content-fragment" &&
    row.fragment?.role !== "start" &&
    row.fragment?.role !== "single"
  );
}
