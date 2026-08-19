import { Volume2 } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import type { VoiceSpeechStatus } from "@/shared/types/messages";

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
