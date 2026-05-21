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

  return (
    <div className="page-transition flex h-full min-w-0 gap-3 px-3 pb-3 pt-[var(--spacing-app-panel-gutter-top)]">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <section
          className="relative mb-20 flex min-h-0 flex-1 flex-col overflow-hidden rounded-card bg-card"
          aria-label={t("builder.chatAriaLabel")}
        >
          <div className="min-h-0 flex-1">
            {builder.messages.length ? (
              <MessageTimeline
                messages={builder.messages}
                streamingMessageId={builder.streamingMessageId}
                className="h-full pb-24"
              />
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-center">
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
            )}
          </div>

          {builder.isStreaming ? (
            <div className="px-4 pb-2">
              <LoadingGoose chatState="thinking" />
            </div>
          ) : null}
        </section>

        <div className="pointer-events-none absolute inset-x-0 bottom-20 flex translate-y-1/2 justify-center px-4">
          <div
            className="pointer-events-auto w-full max-w-3xl rounded-composer bg-surface-composer-glass ring-1 ring-inset ring-[var(--ring-composer-glass-inner)] outline outline-1 outline-[var(--outline-composer-glass-outer)]"
            style={{
              backdropFilter: "var(--backdrop-composer-glass)",
              WebkitBackdropFilter: "var(--backdrop-composer-glass)",
            }}
          >
            <ChatInput
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
      </div>

      <AutomationDraftRail
        className="mb-20"
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
