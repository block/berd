import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

interface ConnectionCardProps {
  icon: ReactNode;
  name: string;
  // Inline status chip rendered right after the name (expiry badge,
  // always-on warning, ...).
  badge?: ReactNode;
  // Primary affordance on the card's right edge (Connect / Reconnect button,
  // active check, configure gear, ...). Interactive action elements must call
  // `stopPropagation` on click/keydown so they don't also open the details
  // dialog (same pattern as SkillCard's overflow menu).
  action?: ReactNode;
  // Opens the connection's details dialog. The card body is the click target.
  onSelect: () => void;
  selectLabel: string;
  className?: string;
}

/**
 * Shared card shell for the Connections grid. Every MCP — an OAuth service
 * from the org catalog or a user-added custom server — renders through this
 * one card so the page reads as a single list of connections.
 *
 * Descriptions intentionally don't render on the card; users recognize tools
 * by name. Clicking the card opens a details dialog for the full story.
 */
export function ConnectionCard({
  icon,
  name,
  badge,
  action,
  onSelect,
  selectLabel,
  className,
}: ConnectionCardProps) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: card contains nested action buttons, so a native button is not valid here
    <div
      role="button"
      tabIndex={0}
      aria-label={selectLabel}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      className={cn(
        "group relative flex w-full cursor-pointer items-center gap-3 rounded-md bg-card p-3",
        "transition-shadow duration-200 hover:shadow-card",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    >
      <div className="flex h-6 w-6 shrink-0 items-center justify-center">
        {icon}
      </div>
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <p className="truncate text-sm">{name}</p>
        {badge ? <span className="shrink-0">{badge}</span> : null}
      </div>
      {action ? (
        <div className="flex shrink-0 items-center gap-1.5">{action}</div>
      ) : null}
    </div>
  );
}
