import {
  IconLayoutSidebarRight,
  IconLayoutSidebarRightFilled,
} from "@tabler/icons-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

interface SessionWindowTopBarProps {
  title: string;
  className?: string;
  contextPanelLabel?: string;
  contextPanelOpen?: boolean;
  showContextPanelToggle?: boolean;
  onToggleContextPanel?: () => void;
}

export function SessionWindowTopBar({
  title,
  className,
  contextPanelLabel,
  contextPanelOpen = false,
  showContextPanelToggle = false,
  onToggleContextPanel,
}: SessionWindowTopBarProps) {
  const ContextPanelIcon = contextPanelOpen
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
        {showContextPanelToggle ? (
          <Button
            type="button"
            variant="top-bar-icon"
            size="icon-top-bar"
            onClick={onToggleContextPanel}
            aria-label={contextPanelLabel}
            title={contextPanelLabel}
          >
            <ContextPanelIcon aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </header>
  );
}
