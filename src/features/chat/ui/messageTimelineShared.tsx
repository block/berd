import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconArrowDown } from "@tabler/icons-react";
import type { RunCommandOptions } from "@/shared/ui/ai-elements/runnable-code-block";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";
import { SIDEBAR_GROUP_LABEL_TEXT_CLASS } from "@/shared/ui/sidebar-tokens";
import type { McpAppMessageHandler } from "./mcpAppTypes";

export interface MessageBubbleCallbacks {
  onRetryMessage?: (messageId: string) => void;
  onEditMessage?: (messageId: string) => void;
  onSendMcpAppMessage?: McpAppMessageHandler;
  onMcpAppAutoScroll?: (element: HTMLElement | null) => void;
  onRunShellCommand?: (command: string, options?: RunCommandOptions) => void;
  onEditProject?: (projectId: string) => void;
  onOpenContextPanel?: () => void;
}

export type MessageTimelineBubbleCallbacks = Omit<
  MessageBubbleCallbacks,
  "onMcpAppAutoScroll"
>;

export function MessageDateSeparator({ label }: { label?: string }) {
  return (
    <div className="my-4 px-4 text-center">
      <span
        className={cn(SIDEBAR_GROUP_LABEL_TEXT_CLASS, "text-muted-foreground")}
      >
        {label}
      </span>
    </div>
  );
}

export function MessageTimelineEmptyState() {
  const { t } = useTranslation("chat");

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="text-center">
        <p className="text-lg font-medium font-display tracking-tight text-muted-foreground">
          {t("timeline.emptyTitle")}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("timeline.emptyDescription")}
        </p>
      </div>
    </div>
  );
}

export function MessageTimelineJumpToLatestButton({
  compact,
  label,
  onClick,
}: {
  compact: boolean;
  label: string;
  onClick: () => void;
}) {
  if (compact) {
    return (
      <Button
        type="button"
        variant="jump-to-latest"
        size="icon-sm"
        onClick={onClick}
        aria-label={label}
        title={label}
      >
        <IconArrowDown aria-hidden="true" />
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="jump-to-latest"
      size="sm"
      onClick={onClick}
      leftIcon={<IconArrowDown />}
    >
      {label}
    </Button>
  );
}

export function MessageTimelineFooterControlRow({
  footerStatus,
  jumpToLatestButton,
}: {
  footerStatus?: ReactNode;
  jumpToLatestButton?: ReactNode;
}) {
  if (!footerStatus && !jumpToLatestButton) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 flex justify-center gap-2 px-4 pb-2">
      {footerStatus ? (
        <div className="pointer-events-auto">{footerStatus}</div>
      ) : null}
      {jumpToLatestButton ? (
        <div className="pointer-events-auto">{jumpToLatestButton}</div>
      ) : null}
    </div>
  );
}

/** Duration of the jump-to-latest eased scroll glide, shared by both
 * timeline renderers so their scroll feel stays in sync. */
export const JUMP_TO_LATEST_SCROLL_MS = 180;

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function easeOutCubic(progress: number): number {
  return 1 - (1 - progress) ** 3;
}
