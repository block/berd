import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  type AutomationTileResult,
  getAutomationSessionMessages,
} from "@/features/automations/api/kgooseAutomations";
import { getOutputBody } from "@/features/automations/lib/automationFormatting";
import { MessageTimeline } from "@/features/chat/ui/MessageTimeline";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import { Spinner } from "@/shared/ui/spinner";

export function JsonPreview({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-sm border border-border/80 bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-sm border border-dashed border-border/80 px-6 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

export function RunOutput({ result }: { result: AutomationTileResult }) {
  const { t } = useTranslation("automations");
  const summary = getOutputBody(result.tileData);
  const hasTileOutput = Boolean(summary || result.tileData);
  const shouldLoadSessionFallback = !hasTileOutput && Boolean(result.sessionId);
  const {
    data: sessionData,
    error: sessionError,
    isLoading: isSessionLoading,
  } = useQuery({
    queryKey: ["automationSessionMessages", result.sessionId],
    queryFn: () => getAutomationSessionMessages(result.sessionId ?? ""),
    enabled: shouldLoadSessionFallback,
  });
  const messages = sessionData?.messages ?? [];

  return (
    <section className="min-w-0 space-y-3">
      {hasTileOutput ? (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <h4 className="text-sm font-medium text-foreground">
              {t("history.runOutput")}
            </h4>
            {result.sessionId ? (
              <span className="truncate text-xs text-muted-foreground">
                {result.sessionId}
              </span>
            ) : null}
          </div>
          {summary ? (
            <MessageResponse className="min-w-0 text-sm leading-relaxed">
              {summary}
            </MessageResponse>
          ) : (
            <JsonPreview value={result.tileData} />
          )}
        </>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <h4 className="text-sm font-medium text-foreground">
              {t("history.sessionHistory")}
            </h4>
            {result.sessionId ? (
              <span className="truncate text-xs text-muted-foreground">
                {result.sessionId}
              </span>
            ) : null}
          </div>

          {!result.sessionId ? (
            <p className="text-sm text-muted-foreground">
              {t("history.sessionUnavailable")}
            </p>
          ) : isSessionLoading ? (
            <div className="flex min-h-32 items-center justify-center">
              <Spinner className="size-5 text-primary" />
            </div>
          ) : sessionError ? (
            <EmptyState
              title={t("history.sessionLoadErrorTitle")}
              body={sessionError.message}
            />
          ) : messages.length ? (
            <div className="h-[34rem] overflow-hidden rounded-sm border border-border/80 bg-background">
              <MessageTimeline messages={messages} className="h-full" />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("history.noSessionMessages")}
            </p>
          )}
        </>
      )}
    </section>
  );
}
