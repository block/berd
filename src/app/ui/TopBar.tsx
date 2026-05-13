import {
  IconArrowLeft,
  IconArrowRight,
  IconLayoutSidebar,
  IconLayoutSidebarFilled,
  IconLayoutSidebarRight,
  IconLayoutSidebarRightFilled,
  IconMessageReport,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { UpdateIndicator } from "@/features/updates/ui/UpdateIndicator";
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
  onFeedbackClick: () => void;
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
  onFeedbackClick,
}: TopBarProps) {
  const { t } = useTranslation(["sidebar", "feedback"]);
  const sidebarLabel = sidebarCollapsed
    ? t("actions.expand")
    : t("actions.collapse");
  const SidebarIcon = sidebarCollapsed
    ? IconLayoutSidebar
    : IconLayoutSidebarFilled;
  const ContextPanelIcon = contextPanelOpen
    ? IconLayoutSidebarRightFilled
    : IconLayoutSidebarRight;
  const toolbarButtonClassName = "size-[24px]";
  const toolbarButtonOffsetClassName = "translate-y-px";
  const toolbarIconClassName = "size-[18px]";

  return (
    <header
      className={cn(
        "flex h-[30px] items-center bg-background/80 pr-[15px] backdrop-blur-sm",
        className,
      )}
    >
      <div className="h-full w-[84px] shrink-0" data-tauri-drag-region />
      <div
        className={cn(
          "flex items-center gap-[1.5px]",
          toolbarButtonOffsetClassName,
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={toolbarButtonClassName}
          onClick={onToggleSidebar}
          aria-label={sidebarLabel}
          title={sidebarLabel}
        >
          <SidebarIcon aria-hidden="true" className={toolbarIconClassName} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={toolbarButtonClassName}
          onClick={onGoBack}
          disabled={!canGoBack}
          aria-label={t("actions.back")}
          title={t("actions.back")}
        >
          <IconArrowLeft aria-hidden="true" className={toolbarIconClassName} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={toolbarButtonClassName}
          onClick={onGoForward}
          disabled={!canGoForward}
          aria-label={t("actions.forward")}
          title={t("actions.forward")}
        >
          <IconArrowRight aria-hidden="true" className={toolbarIconClassName} />
        </Button>
      </div>
      <div
        className="ml-[6px] min-w-0 flex-1 self-stretch"
        data-tauri-drag-region
      />
      <UpdateIndicator />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn(toolbarButtonClassName, toolbarButtonOffsetClassName)}
        onClick={onFeedbackClick}
        aria-label={t("feedback:title")}
        title={t("feedback:title")}
      >
        <IconMessageReport
          aria-hidden="true"
          className={toolbarIconClassName}
        />
      </Button>
      {showContextPanelToggle && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn(toolbarButtonClassName, toolbarButtonOffsetClassName)}
          onClick={onToggleContextPanel}
          aria-label={contextPanelLabel}
          title={contextPanelLabel}
        >
          <ContextPanelIcon
            aria-hidden="true"
            className={toolbarIconClassName}
          />
        </Button>
      )}
    </header>
  );
}
