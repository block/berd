import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Tool, ToolContent, ToolHeader } from "@/shared/ui/ai-elements/tool";
import { useTranscriptRowStateAdapter } from "@/features/chat/transcript/row-state";

export function SessionNotificationDisclosure({
  enabled,
  sender,
  children,
}: {
  enabled: boolean;
  sender?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const { rowState, updateRowState, markRowInteracted, pinScrollAnchor } =
    useTranscriptRowStateAdapter();
  const durableOpen = rowState?.custom?.sessionNotificationOpen === true;
  const [open, setOpen] = useState(durableOpen);
  useEffect(() => setOpen(durableOpen), [durableOpen]);

  if (!enabled) return children;

  return (
    <Tool
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
      <ToolHeader
        className="flex-row-reverse gap-2.5"
        type="dynamic-tool"
        toolName="session-notification"
        state="output-available"
        showIcon={false}
        showStatusBadge={false}
        titleClassName="text-muted-foreground"
        title={
          <span data-role="session-notification-label">
            {sender
              ? t("message.notificationNamedLabel", { sender })
              : t("message.notificationLabel")}
          </span>
        }
      />
      <ToolContent className="relative pb-9">{children}</ToolContent>
    </Tool>
  );
}
