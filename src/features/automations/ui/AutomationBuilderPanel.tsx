import {
  IconAlertTriangle,
  IconCheck,
  IconPlayerStop,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { ChatInput } from "@/features/chat/ui/ChatInput";
import { LoadingGoose } from "@/features/chat/ui/LoadingGoose";
import { MessageTimeline } from "@/features/chat/ui/MessageTimeline";
import { useAutomationBuilderSession } from "@/features/automations/hooks/useAutomationBuilderSession";
import type { AutomationDraftState } from "@/features/automations/api/automationBuilder";
import { getStableInstructionItems } from "@/features/automations/lib/stableInstructionItems";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Separator } from "@/shared/ui/separator";

interface AutomationBuilderPanelProps {
  onClose: () => void;
  onAutomationCreated?: (automationId?: string) => void;
}

function statusLabel(
  status: ReturnType<typeof useAutomationBuilderSession>["status"],
  t: (key: string) => string,
) {
  switch (status) {
    case "processing":
      return t("builder.status.processing");
    case "needClientInput":
      return t("builder.status.needClientInput");
    case "cancelling":
      return t("builder.status.cancelling");
    case "idle":
      return t("builder.status.idle");
    default:
      return t("builder.status.ready");
  }
}

function DraftValue({
  label,
  value,
}: {
  label: string;
  value: string | string[] | boolean | undefined;
}) {
  if (
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  ) {
    return null;
  }

  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm text-foreground">
        {Array.isArray(value) ? value.join(", ") : String(value)}
      </dd>
    </div>
  );
}

function AutomationDraftPreview({
  draftState,
  isSubmitting,
  onApprove,
}: {
  draftState: AutomationDraftState;
  isSubmitting: boolean;
  onApprove: () => void;
}) {
  const { t } = useTranslation("automations");
  const draft = draftState.draft;

  if (draftState.blockedToolRequest && !draft) {
    return (
      <section className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
        <div className="flex items-start gap-2">
          <IconAlertTriangle className="mt-0.5 size-4 text-destructive" />
          <div>
            <h3 className="text-sm font-medium text-foreground">
              {t("builder.blockedTitle")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("builder.blockedBody")}
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (!draft) {
    return (
      <section className="rounded-lg border border-dashed border-border p-4">
        <div className="flex items-start gap-2">
          <IconSparkles className="mt-0.5 size-4 text-brand" />
          <div>
            <h3 className="text-sm font-medium text-foreground">
              {t("builder.previewEmptyTitle")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("builder.previewEmptyBody")}
            </p>
          </div>
        </div>
      </section>
    );
  }

  const instructions = draft.humanReadableInstructions.length
    ? draft.humanReadableInstructions
    : draft.instructions;
  const instructionItems = getStableInstructionItems(instructions);

  return (
    <section className="space-y-4 rounded-lg border border-border bg-background p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            {t("builder.previewEyebrow")}
          </p>
          <h3 className="mt-1 break-words text-lg font-medium text-foreground">
            {draft.title || t("fallbacks.untitledAutomation")}
          </h3>
        </div>
        {draftState.created ? (
          <Badge variant="default">
            <IconCheck aria-hidden="true" />
            {t("builder.created")}
          </Badge>
        ) : draftState.failed ? (
          <Badge variant="destructive">{t("builder.failed")}</Badge>
        ) : draftState.createRequested ? (
          <Badge variant="secondary">{t("builder.creating")}</Badge>
        ) : (
          <Badge variant="outline">{t("builder.draft")}</Badge>
        )}
      </div>

      <dl className="grid gap-3">
        <DraftValue label={t("details.schedule")} value={draft.schedule} />
        <DraftValue label={t("details.timeZone")} value={draft.timeZone} />
        <DraftValue
          label={t("details.notifications")}
          value={
            draft.enableNotifications === undefined
              ? undefined
              : draft.enableNotifications
                ? t("details.notificationsEnabled")
                : t("details.notificationsDisabled")
          }
        />
      </dl>

      {instructions.length ? (
        <>
          <Separator />
          <div>
            <h4 className="text-xs text-muted-foreground">
              {t("details.instructions")}
            </h4>
            <ol className="mt-2 space-y-2">
              {instructionItems.map(({ instruction, key }) => (
                <li
                  key={key}
                  className="rounded-md border border-border bg-muted/20 p-2 text-sm text-foreground"
                >
                  {instruction}
                </li>
              ))}
            </ol>
          </div>
        </>
      ) : null}

      {!draftState.created && !draftState.createRequested ? (
        <Button
          type="button"
          className="w-full"
          disabled={isSubmitting}
          onClick={onApprove}
        >
          <IconCheck aria-hidden="true" />
          {isSubmitting ? t("builder.processing") : t("builder.create")}
        </Button>
      ) : null}
    </section>
  );
}

export function AutomationBuilderPanel({
  onClose,
  onAutomationCreated,
}: AutomationBuilderPanelProps) {
  const { t } = useTranslation("automations");
  const builder = useAutomationBuilderSession({ onAutomationCreated });

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex items-start justify-between gap-4 border-b border-border p-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-medium text-foreground">
              {t("builder.title")}
            </h2>
            <Badge
              variant={
                builder.status === "processing" ? "secondary" : "outline"
              }
            >
              {statusLabel(builder.status, t)}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("builder.subtitle")}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={t("builder.close")}
          title={t("builder.close")}
        >
          <IconX aria-hidden="true" />
        </Button>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section
          className="flex min-h-0 flex-col border-b border-border lg:border-r lg:border-b-0"
          aria-label={t("builder.chatAriaLabel")}
        >
          <div className="min-h-0 flex-1">
            {builder.messages.length ? (
              <MessageTimeline
                messages={builder.messages}
                streamingMessageId={builder.streamingMessageId}
                className="h-full"
              />
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-center">
                <div>
                  <IconSparkles className="mx-auto size-6 text-brand" />
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
          <ChatInput
            controls={{
              agentModelPicker: false,
              attachments: false,
              autoFocus: false,
              fileMentions: false,
              projectPicker: false,
              skills: false,
            }}
            agentModelPicker={{
              providers: [{ id: "kgoose", label: "kgoose" }],
              selectedProvider: "kgoose",
            }}
            projectPicker={{ enabled: false }}
            composerActions={{
              onSend: (text) => builder.sendMessage(text),
              onStop: builder.sessionId ? builder.cancel : undefined,
              isStreaming: builder.isStreaming,
              disabled: builder.isSubmitting,
            }}
            className="border-t border-border bg-background"
          />
        </section>

        <aside
          className="min-h-0 overflow-y-auto p-4"
          aria-label={t("builder.previewAriaLabel")}
        >
          <AutomationDraftPreview
            draftState={builder.draftState}
            isSubmitting={builder.isSubmitting}
            onApprove={builder.approveDraft}
          />
          {builder.error ? (
            <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {builder.error}
            </div>
          ) : null}
          {builder.sessionId ? (
            <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
              <IconPlayerStop className="size-3.5" aria-hidden="true" />
              <span className="shrink-0">{t("builder.sessionId")}</span>
              <span className="truncate">{builder.sessionId}</span>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
