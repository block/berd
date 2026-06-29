import { IconSparkles } from "@tabler/icons-react";
import {
  useCallback,
  useEffect,
  useMemo,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { ChatInput } from "@/features/chat/ui/ChatInput";
import { LoadingBerd } from "@/features/chat/ui/LoadingBerd";
import { MessageTimeline } from "@/features/chat/ui/MessageTimeline";
import { useAutomationBuilderSession } from "@/features/automations/hooks/useAutomationBuilderSession";
import { AutomationDraftRail } from "@/features/automations/ui/AutomationDraftRail";
import { usePersistedState } from "@/shared/hooks/usePersistedState";

export interface AutomationBuilderLeaveAction {
  hasUnsavedChanges: boolean;
  save: () => Promise<boolean>;
  discard: () => void;
}

interface AutomationBuilderViewProps {
  automationId?: string;
  onAutomationCreated?: (automationId?: string) => void;
  onAutomationUpdated?: (automationId?: string) => void;
  onLeaveActionChange?: (action: AutomationBuilderLeaveAction | null) => void;
}

const DRAFT_RAIL_LAYOUT_STORAGE_KEY = "goose:automation-builder:draft-rail";
const DRAFT_RAIL_DEFAULT_WIDTH = 337;
const DRAFT_RAIL_MIN_WIDTH = 280;
const DRAFT_RAIL_MAX_WIDTH = 560;
const DRAFT_RAIL_RESIZE_HANDLE_WIDTH = 12;

function clampDraftRailWidth(width: number) {
  return Math.min(DRAFT_RAIL_MAX_WIDTH, Math.max(DRAFT_RAIL_MIN_WIDTH, width));
}

function validateDraftRailWidthPreference(value: unknown, defaults: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaults;
  }
  return clampDraftRailWidth(value);
}

export function AutomationBuilderView({
  automationId,
  onAutomationCreated,
  onAutomationUpdated,
  onLeaveActionChange,
}: AutomationBuilderViewProps) {
  const { t } = useTranslation("automations");
  const isEditing = Boolean(automationId);
  const [draftRailWidth, setDraftRailWidth] = usePersistedState(
    DRAFT_RAIL_LAYOUT_STORAGE_KEY,
    DRAFT_RAIL_DEFAULT_WIDTH,
    validateDraftRailWidthPreference,
  );
  const builder = useAutomationBuilderSession({
    automationId,
    onAutomationCreated,
    onAutomationUpdated,
  });
  const leaveAction = useMemo(
    () => ({
      hasUnsavedChanges: builder.hasUnsavedDraftChanges,
      save: builder.approveDraft,
      discard: () => {},
    }),
    [builder.approveDraft, builder.hasUnsavedDraftChanges],
  );

  useEffect(() => {
    onLeaveActionChange?.(leaveAction);
    return () => onLeaveActionChange?.(null);
  }, [leaveAction, onLeaveActionChange]);
  const handleDraftRailResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = draftRailWidth;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        setDraftRailWidth(clampDraftRailWidth(startWidth - deltaX));
      };

      const cleanup = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", cleanup);
        window.removeEventListener("blur", cleanup);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", cleanup);
      window.addEventListener("blur", cleanup);
    },
    [draftRailWidth, setDraftRailWidth],
  );
  const handleDraftRailResizeDoubleClick = useCallback(() => {
    setDraftRailWidth(DRAFT_RAIL_DEFAULT_WIDTH);
  }, [setDraftRailWidth]);
  const composerFooter = (
    <>
      {builder.isStreaming ? <LoadingBerd chatState="thinking" /> : null}
      <div className="px-4">
        <div className="pointer-events-auto mx-auto w-full max-w-[var(--chat-composer-max-width)] rounded-md bg-surface-composer shadow-[var(--shadow-chat)] backdrop-blur-md">
          <ChatInput
            surface="bare"
            placeholder={isEditing ? t("builder.editPlaceholder") : undefined}
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
          {isEditing ? t("builder.editEmptyTitle") : t("builder.emptyTitle")}
        </h3>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          {isEditing ? t("builder.editEmptyBody") : t("builder.emptyBody")}
        </p>
      </div>
    </div>
  );

  return (
    <div className="page-transition flex h-full min-w-0 gap-3 px-3 pb-3 pt-[var(--spacing-app-panel-gutter-top)]">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <section
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-md bg-card"
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

      <div
        className="relative flex min-h-0 w-full shrink-0 lg:w-[var(--automation-draft-rail-width)]"
        style={
          {
            "--automation-draft-rail-width": `${draftRailWidth}px`,
          } as CSSProperties
        }
      >
        <div
          data-testid="automation-draft-rail-resize-handle"
          onMouseDown={handleDraftRailResizeStart}
          onDoubleClick={handleDraftRailResizeDoubleClick}
          className="group absolute bottom-0 left-0 top-0 z-10 flex -translate-x-1/2 cursor-col-resize items-center justify-center overflow-hidden"
          style={{ width: DRAFT_RAIL_RESIZE_HANDLE_WIDTH * 2 }}
          aria-hidden
        >
          <div className="h-full w-px bg-transparent transition-colors group-hover:bg-border group-active:bg-border" />
        </div>
        <AutomationDraftRail
          className="w-full"
          draftState={builder.draftState}
          error={builder.error}
          isSubmitting={builder.isSubmitting}
          isEditing={isEditing}
          sessionId={builder.sessionId}
          status={builder.status}
          onApprove={builder.approveDraft}
          onDraftOverride={builder.setDraftOverride}
        />
      </div>
    </div>
  );
}
