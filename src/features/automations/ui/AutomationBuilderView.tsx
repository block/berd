import { IconSparkles } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { ChatInput } from "@/features/chat/ui/ChatInput";
import { LoadingGoose } from "@/features/chat/ui/LoadingGoose";
import { MessageTimeline } from "@/features/chat/ui/MessageTimeline";
import { useAutomationBuilderSession } from "@/features/automations/hooks/useAutomationBuilderSession";
import { AutomationDraftRail } from "@/features/automations/ui/AutomationDraftRail";

interface AutomationBuilderViewProps {
  onAutomationCreated?: (automationId?: string) => void;
}

export function AutomationBuilderView({
  onAutomationCreated,
}: AutomationBuilderViewProps) {
  const { t } = useTranslation("automations");
  const builder = useAutomationBuilderSession({ onAutomationCreated });
  const composerFooter = (
    <>
      {builder.isStreaming ? <LoadingGoose chatState="thinking" /> : null}
      <div className="px-4">
        <div className="pointer-events-auto mx-auto w-full max-w-xl rounded-card-chat bg-surface-composer shadow-[var(--shadow-chat)] backdrop-blur-md">
          <ChatInput
            surface="bare"
            controls={{
              agentModelPicker: false,
              projectPicker: false,
            }}
            composerActions={{
              onSend: (text) => builder.sendMessage(text),
              onStop: builder.sessionId ? builder.cancel : undefined,
              isStreaming: builder.isStreaming,
              disabled: builder.isSubmitting,
            }}
          />
        </div>
      </div>
    </>
  );
  const conversationPlaceholder = (
    <div className="flex w-full flex-1 items-center justify-center px-6 text-center">
      <div>
        <IconSparkles className="mx-auto size-4 text-foreground" />
        <h3 className="mt-3 text-sm font-medium text-foreground">
          {t("builder.emptyTitle")}
        </h3>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          {t("builder.emptyBody")}
        </p>
      </div>
    </div>
  );

  return (
    <div className="page-transition flex h-full min-w-0 gap-3 px-3 pb-3 pt-[var(--spacing-app-panel-gutter-top)]">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <section
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-card-chat bg-card"
          aria-label={t("builder.chatAriaLabel")}
        >
          <MessageTimeline
            messages={builder.messages}
            streamingMessageId={builder.streamingMessageId}
            placeholder={conversationPlaceholder}
            footer={composerFooter}
          />
        </section>
      </div>

      <AutomationDraftRail
        draftState={builder.draftState}
        error={builder.error}
        isSubmitting={builder.isSubmitting}
        sessionId={builder.sessionId}
        status={builder.status}
        onApprove={builder.approveDraft}
        onDraftOverride={builder.setDraftOverride}
      />
    </div>
  );
}
