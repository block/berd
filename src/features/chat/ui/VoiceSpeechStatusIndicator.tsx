import { Volume2 } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import type { VoiceSpeechStatus } from "@/shared/types/messages";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function formatInterruptedSpeechMarkdown(
  spokenText: string,
  unspokenText: string,
): string {
  const struckBlocks = escapeHtml(unspokenText)
    .split(/(\n\s*\n)/)
    .map((part, index) =>
      index % 2 === 0 && part ? `<del>${part}</del>` : part,
    )
    .join("");
  return `${spokenText}${struckBlocks}`;
}

export function VoiceSpeechStatusIndicator({
  status,
  label,
}: {
  status: VoiceSpeechStatus;
  label: string;
}) {
  return (
    <div
      className={cn(
        "mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground",
        status === "failed" && "text-destructive",
        status === "interrupted" && "text-warning",
      )}
    >
      <Volume2 aria-hidden="true" className="size-3.5" />
      <span>{label}</span>
    </div>
  );
}
