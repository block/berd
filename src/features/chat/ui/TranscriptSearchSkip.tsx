import type { ReactNode } from "react";
import { TRANSCRIPT_SEARCH_SKIP_ATTRIBUTE } from "@/features/chat/lib/transcriptSearch";

const skipAttribute = { [TRANSCRIPT_SEARCH_SKIP_ATTRIBUTE]: "" };

/**
 * Excludes UI chrome rendered inside the transcript search root (empty-state
 * placeholders, loading skeletons) from find-in-transcript matching without
 * affecting layout.
 */
export function TranscriptSearchSkip({ children }: { children: ReactNode }) {
  return (
    <div className="contents" {...skipAttribute}>
      {children}
    </div>
  );
}
