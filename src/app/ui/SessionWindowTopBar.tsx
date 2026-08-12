import {
  IconLayoutSidebarRight,
  IconLayoutSidebarRightFilled,
} from "@tabler/icons-react";

import { cn } from "@/shared/lib/cn";
import { TopBarIconButton } from "@/shared/ui/top-bar-icon-button";

interface SessionWindowTopBarProps {
  title: string;
  className?: string;
  rightRailLabel?: string;
  rightRailOpen?: boolean;
  showRightRailToggle?: boolean;
  onToggleRightRail?: () => void;
}

export function SessionWindowTopBar({
  title,
  className,
  rightRailLabel,
  rightRailOpen = false,
  showRightRailToggle = false,
  onToggleRightRail,
}: SessionWindowTopBarProps) {
  const RightRailIcon = rightRailOpen
    ? IconLayoutSidebarRightFilled
    : IconLayoutSidebarRight;

  return (
    <header
      className={cn(
        "flex h-[var(--spacing-app-top-bar)] min-w-0 shrink-0 items-center bg-background pr-4",
        className,
      )}
      data-tauri-drag-region
    >
      <div
        className="h-full w-[var(--spacing-app-top-bar-leading)] shrink-0"
        data-tauri-drag-region
      />
      <div
        className="flex min-w-0 flex-1 items-center justify-center"
        data-tauri-drag-region
      >
        <div
          className="truncate text-sm font-medium text-foreground"
          data-tauri-drag-region
        >
          {title}
        </div>
      </div>
      <div
        className="flex w-[var(--spacing-app-top-bar-leading)] shrink-0 justify-end"
        data-tauri-drag-region
      >
        {showRightRailToggle ? (
          <TopBarIconButton
            type="button"
            size="icon-top-bar"
            onClick={onToggleRightRail}
            aria-pressed={rightRailOpen}
            aria-label={rightRailLabel}
            tooltip={rightRailLabel}
            data-right-rail-toggle="true"
          >
            <RightRailIcon aria-hidden="true" />
          </TopBarIconButton>
        ) : null}
      </div>
    </header>
  );
}
