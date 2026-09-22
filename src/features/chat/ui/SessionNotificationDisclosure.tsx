import { useEffect, useState, type ReactNode } from "react";
import { IconBell } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Tool, ToolContent, ToolHeader } from "@/shared/ui/ai-elements/tool";
import { useTranscriptRowStateAdapter } from "@/features/chat/transcript/row-state";

export function SessionNotificationDisclosure({
  sender,
  children,
}: {
  sender?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const { rowState, updateRowState, markRowInteracted, pinScrollAnchor } =
    useTranscriptRowStateAdapter();
  const durableOpen = rowState?.custom?.sessionNotificationOpen === true;
  const [open, setOpen] = useState(durableOpen);
  useEffect(() => setOpen(durableOpen), [durableOpen]);

  return (
    <Tool
      className="flex gap-2.5"
      open={open}
      onOpenChange={(nextOpen) => {
        pinScrollAnchor();
        markRowInteracted("session-notification");
        setOpen(nextOpen);
        updateRowState((current) => ({
          ...current,
          custom: { ...current.custom, sessionNotificationOpen: nextOpen },
        }));
      }}
    >
      <div
        aria-hidden="true"
        className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground"
      >
        <IconBell className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <ToolHeader
          layout="fit"
          type="dynamic-tool"
          toolName="session-notification"
          state="output-available"
          showIcon={false}
          showStatusBadge={false}
          titleClassName="font-normal text-muted-foreground"
          title={
            <span data-role="session-notification-label">
              {sender
                ? t("message.notificationNamedLabel", { sender })
                : t("message.notificationLabel")}
            </span>
          }
        />
        <ToolContent className="relative pb-9">{children}</ToolContent>
      </div>
    </Tool>
  );
}
