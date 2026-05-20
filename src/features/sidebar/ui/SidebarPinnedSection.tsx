import { cn } from "@/shared/lib/cn";

export interface SidebarPinnedItem {
  id: string;
  label: string;
}

interface SidebarPinnedSectionProps {
  items?: readonly SidebarPinnedItem[];
  className?: string;
}

// Visual shell only — the data layer (pinning v2) wires items in via a future
// PR. Renders nothing until items exist so the sidebar reads clean today.
export function SidebarPinnedSection({
  items = [],
  className,
}: SidebarPinnedSectionProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div
      className={cn("mt-4 space-y-0.5 border-t border-border pt-3", className)}
    >
      <div className="px-3 pb-1 text-[10px] font-light text-foreground/25">
        {/* i18n-check-ignore — shell only; pinning v2 wires the localized header */}
        Pinned
      </div>
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li key={item.id} className="px-3 py-1 text-xs text-foreground/80">
            {item.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
