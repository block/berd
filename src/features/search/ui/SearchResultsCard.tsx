import type { ReactNode } from "react";
import { BottomFade } from "@/shared/ui/BottomFade";
import { cn } from "@/shared/lib/cn";

export type SearchResultsCardTone = "file" | "agent" | "skill" | "automation";

interface SearchResultsCardProps {
  label: string;
  tone: SearchResultsCardTone;
  children: ReactNode;
}

// Explicit class literals per tone so Tailwind's JIT preserves them at build time.
const TONE_CHIP_CLASSES: Record<SearchResultsCardTone, string> = {
  file: "bg-chip-file-bg text-chip-file-fg",
  agent: "bg-chip-agent-bg text-chip-agent-fg",
  skill: "bg-chip-skill-bg text-chip-skill-fg",
  automation: "bg-chip-automation-bg text-chip-automation-fg",
};

export function SearchResultsCard({
  label,
  tone,
  children,
}: SearchResultsCardProps) {
  return (
    <section className="relative h-full min-h-[220px] w-[259px] flex-none animate-fade-in overflow-hidden rounded-md bg-card motion-reduce:animate-none">
      <h2
        className={cn(
          "absolute left-5 top-[21px] inline-flex h-5 items-center rounded-xs px-[6px] pb-[3px] text-[14px]",
          TONE_CHIP_CLASSES[tone],
        )}
      >
        {label}
      </h2>

      <div className="absolute bottom-0 left-6 top-[59px] flex w-[222px] flex-col gap-6 overflow-y-auto pb-12 scrollbar-none">
        {children}
      </div>

      <BottomFade
        className="absolute bottom-0 left-0 h-20"
        surface="var(--card)"
      />
    </section>
  );
}
