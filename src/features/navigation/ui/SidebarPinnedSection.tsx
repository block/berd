import { cn } from "@/shared/lib/cn";
import {
  SIDEBAR_NAV_MICRO_LABEL_TEXT_CLASS,
  SIDEBAR_SECTION_DIVIDER_CLASS,
} from "@/shared/ui/sidebar-tokens";

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
    <div className={className}>
      <div className={SIDEBAR_SECTION_DIVIDER_CLASS} aria-hidden />
      <div className="space-y-0 pt-3">
        <div
          className={cn(
            "px-3 pb-1 text-foreground/25",
            SIDEBAR_NAV_MICRO_LABEL_TEXT_CLASS,
          )}
        >
          {/* i18n-check-ignore — shell only; pinning v2 wires the localized header */}
          Pinned
        </div>
        <ul className="space-y-0">
          {items.map((item) => (
            <li key={item.id} className="px-3 py-1 text-sm text-foreground/80">
              {item.label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
