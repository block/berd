import {
  IconArrowLeft,
  IconArrowRight,
  IconLayoutSidebar,
  IconLayoutSidebarFilled,
  IconLayoutSidebarRight,
  IconLayoutSidebarRightFilled,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

interface TopBarProps {
  canGoBack?: boolean;
  canGoForward?: boolean;
  className?: string;
  contextPanelLabel?: string;
  contextPanelOpen?: boolean;
  showContextPanelToggle?: boolean;
  sidebarCollapsed?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onToggleContextPanel?: () => void;
  onToggleSidebar?: () => void;
}

export function TopBar({
  canGoBack = false,
  canGoForward = false,
  className,
  contextPanelLabel,
  contextPanelOpen = false,
  showContextPanelToggle = false,
  sidebarCollapsed = false,
  onGoBack,
  onGoForward,
  onToggleContextPanel,
  onToggleSidebar,
}: TopBarProps) {
  const { t } = useTranslation("sidebar");
  const sidebarLabel = sidebarCollapsed
    ? t("actions.expand")
    : t("actions.collapse");
  const SidebarIcon = sidebarCollapsed
    ? IconLayoutSidebar
    : IconLayoutSidebarFilled;
  const ContextPanelIcon = contextPanelOpen
    ? IconLayoutSidebarRightFilled
    : IconLayoutSidebarRight;

  return (
    <header
      className={cn(
        "flex h-10 items-center bg-background/80 pr-5 backdrop-blur-sm",
        className,
      )}
    >
      <div className="h-full w-24 shrink-0" data-tauri-drag-region />
      <div className="flex translate-y-0.5 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onToggleSidebar}
          aria-label={sidebarLabel}
          title={sidebarLabel}
        >
          <SidebarIcon aria-hidden="true" className="size-[18px]" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onGoBack}
          disabled={!canGoBack}
          aria-label={t("actions.back")}
          title={t("actions.back")}
        >
          <IconArrowLeft aria-hidden="true" className="size-[18px]" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onGoForward}
          disabled={!canGoForward}
          aria-label={t("actions.forward")}
          title={t("actions.forward")}
        >
          <IconArrowRight aria-hidden="true" className="size-[18px]" />
        </Button>
      </div>
      <div
        className="ml-2 min-w-0 flex-1 self-stretch"
        data-tauri-drag-region
      />
      {showContextPanelToggle && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="translate-y-0.5"
          onClick={onToggleContextPanel}
          aria-label={contextPanelLabel}
          title={contextPanelLabel}
        >
          <ContextPanelIcon aria-hidden="true" className="size-[18px]" />
        </Button>
      )}
    </header>
  );
}
