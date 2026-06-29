import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconChevronRight,
  IconCircle,
  IconClock,
  IconMessageCircle,
  IconTool,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";
import { cn } from "@/shared/lib/cn";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
import { Button } from "@/shared/ui/button";
import type {
  MessageContent,
  ThinkingContent,
  ReasoningContent,
  ToolRequestContent,
  ToolResponseContent,
  ToolCallStatus,
} from "@/shared/types/messages";
import type { TranscriptAgentWorkPayload } from "@/features/chat/transcript/projection/transcriptItemTypes";
import { ToolCallAdapter } from "./ToolCallAdapter";

interface ToolTimelineItem {
  kind: "tool";
  key: string;
  request?: ToolRequestContent;
  response?: ToolResponseContent;
}

interface ThoughtTimelineItem {
  kind: "thought";
  key: string;
  content: ThinkingContent | ReasoningContent;
}

interface RedactedThoughtTimelineItem {
  kind: "redactedThought";
  key: string;
}

interface ProgressTimelineItem {
  kind: "progress";
  key: string;
  text: string;
}

interface ActivePreviewState {
  visibleItems: AgentWorkTimelineItem[];
  hiddenItems: AgentWorkTimelineItem[];
  hiddenStepCount: number;
  liveTextTail: ProgressTimelineItem[];
}

type AgentWorkTimelineItem =
  | ToolTimelineItem
  | ThoughtTimelineItem
  | RedactedThoughtTimelineItem
  | ProgressTimelineItem;

const AGENT_THOUGHT_MARKDOWN_CLASSNAME =
  "[&_*]:font-normal [&_strong]:font-normal [&_b]:font-normal [&_h1]:font-normal [&_h2]:font-normal [&_h3]:font-normal [&_h4]:font-normal [&_h5]:font-normal [&_h6]:font-normal [&_strong]:text-foreground/75 [&_b]:text-foreground/75 [&_h1]:text-foreground/75 [&_h2]:text-foreground/75 [&_h3]:text-foreground/75 [&_h4]:text-foreground/75 [&_h5]:text-foreground/75 [&_h6]:text-foreground/75 [&_h1]:mb-0 [&_h2]:mb-0 [&_h3]:mb-0 [&_h4]:mb-0 [&_h5]:mb-0 [&_h6]:mb-0 [&_h1+p]:mt-0 [&_h2+p]:mt-0 [&_h3+p]:mt-0 [&_h4+p]:mt-0 [&_h5+p]:mt-0 [&_h6+p]:mt-0 [&_p:has(>strong:only-child)]:mb-0 [&_p:has(>b:only-child)]:mb-0 [&_p:has(>strong:only-child)+p]:mt-0 [&_p:has(>b:only-child)+p]:mt-0";
const COMPACT_ACTIVE_PREVIEW_ITEM_COUNT = 4;

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function getToolStatus(item: ToolTimelineItem): ToolCallStatus {
  if (item.response) {
    return item.response.isError ? "failed" : "completed";
  }
  return item.request?.status ?? "completed";
}

function getToolName(item: ToolTimelineItem): string {
  return item.request?.name || item.response?.name || "Tool result";
}

function pairToolResponse(
  items: AgentWorkTimelineItem[],
  response: ToolResponseContent,
): boolean {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== "tool" || !item.request || item.response) {
      continue;
    }
    if (item.request.id === response.id) {
      items[index] = {
        ...item,
        response: {
          ...response,
          name: response.name || item.request.name,
        },
      };
      return true;
    }
  }
  return false;
}

function buildAgentWorkTimeline(
  content: readonly MessageContent[],
): AgentWorkTimelineItem[] {
  const items: AgentWorkTimelineItem[] = [];
  let previousThoughtText: string | null = null;

  for (const [index, block] of content.entries()) {
    if (block.type === "thinking" || block.type === "reasoning") {
      const normalized = normalizeText(block.text);
      if (normalized && normalized === previousThoughtText) {
        continue;
      }
      previousThoughtText = normalized;
      items.push({
        kind: "thought",
        key: `${block.type}-${index}-${normalized.slice(0, 32)}`,
        content: block,
      });
      continue;
    }

    previousThoughtText = null;

    if (block.type === "redactedThinking") {
      items.push({
        kind: "redactedThought",
        key: `redacted-thinking-${index}`,
      });
      continue;
    }

    if (block.type === "text") {
      const previous = items[items.length - 1];
      if (previous?.kind === "progress") {
        previous.text += block.text;
      } else if (block.text.trim()) {
        items.push({
          kind: "progress",
          key: `progress-${index}`,
          text: block.text,
        });
      }
      continue;
    }

    if (block.type === "toolRequest") {
      items.push({
        kind: "tool",
        key: `tool-${block.id}-${index}`,
        request: block,
      });
      continue;
    }

    if (block.type === "toolResponse") {
      if (!pairToolResponse(items, block)) {
        items.push({
          kind: "tool",
          key: `tool-response-${block.id}-${index}`,
          response: block,
        });
      }
    }
  }

  return items;
}

function isWorkSignalItem(item: AgentWorkTimelineItem): boolean {
  return (
    item.kind === "tool" ||
    item.kind === "thought" ||
    item.kind === "redactedThought"
  );
}

function getActivePreviewState(
  items: readonly AgentWorkTimelineItem[],
): ActivePreviewState {
  const latestProgressItem = items.findLast(
    (item): item is ProgressTimelineItem => item.kind === "progress",
  );
  const workSignals = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isWorkSignalItem(item));
  const liveTextTail =
    workSignals.length > 0 && latestProgressItem ? [latestProgressItem] : [];

  if (workSignals.length > 0) {
    const visibleWorkSignals = workSignals.slice(
      -COMPACT_ACTIVE_PREVIEW_ITEM_COUNT,
    );
    const firstVisibleIndex = visibleWorkSignals[0]?.index ?? items.length;
    const hiddenItems = items
      .slice(0, firstVisibleIndex)
      .filter((item) => item !== latestProgressItem);
    return {
      visibleItems: visibleWorkSignals.map(({ item }) => item),
      hiddenItems,
      hiddenStepCount: hiddenItems.length,
      liveTextTail,
    };
  }

  const visibleItems = items.slice(-COMPACT_ACTIVE_PREVIEW_ITEM_COUNT);
  const hiddenItems = items.slice(0, -visibleItems.length);
  return {
    visibleItems,
    hiddenItems,
    hiddenStepCount: hiddenItems.length,
    liveTextTail: [],
  };
}

function getRailColor(
  status: "thought" | "progress" | ToolCallStatus,
  primary = false,
): string {
  if (primary) {
    return "text-foreground";
  }
  if (status === "pending" || status === "in_progress") {
    return "text-foreground/70";
  }
  return "text-muted-foreground/80";
}

function WorkRail({
  isLast,
  status,
  primary = false,
}: {
  isLast: boolean;
  status: "thought" | "progress" | ToolCallStatus;
  primary?: boolean;
}) {
  const isActive = status === "pending" || status === "in_progress";
  const colorClassName = getRailColor(status, primary);
  return (
    <div
      aria-hidden
      className="relative flex w-5 shrink-0 justify-center self-stretch"
    >
      {!isLast ? (
        <div className="absolute top-5 bottom-0 left-1/2 w-px -translate-x-1/2 bg-border" />
      ) : null}
      <div
        className={cn(
          "relative z-10 mt-0.5 flex size-5 items-center justify-center rounded-full bg-background ring-2 ring-background",
          colorClassName,
          isActive && "animate-pulse",
        )}
      >
        {status === "thought" || status === "progress" ? (
          <IconMessageCircle className="size-3.5" />
        ) : status === "pending" || status === "in_progress" ? (
          <IconClock className="size-3.5" />
        ) : status === "completed" ? (
          <IconTool className="size-3.5" />
        ) : (
          <IconCircle className="size-2.5 fill-current" />
        )}
      </div>
    </div>
  );
}

function AgentWorkItemRow({
  item,
  isLast,
  usePrimaryText = false,
}: {
  item: AgentWorkTimelineItem;
  isLast: boolean;
  usePrimaryText?: boolean;
}) {
  const { t } = useTranslation("chat");
  if (item.kind === "thought") {
    return (
      <div className="flex gap-2.5">
        <WorkRail isLast={isLast} status="thought" primary={usePrimaryText} />
        <div
          className={cn(
            "min-w-0 flex-1 pb-2 text-sm leading-relaxed",
            usePrimaryText ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <Streamdown
            className={cn(
              AGENT_THOUGHT_MARKDOWN_CLASSNAME,
              usePrimaryText &&
                "[&_strong]:text-foreground [&_b]:text-foreground [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_h4]:text-foreground [&_h5]:text-foreground [&_h6]:text-foreground",
            )}
          >
            {item.content.text}
          </Streamdown>
        </div>
      </div>
    );
  }

  if (item.kind === "redactedThought") {
    return (
      <div className="flex gap-2.5">
        <WorkRail isLast={isLast} status="thought" primary={usePrimaryText} />
        <div
          className={cn(
            "min-w-0 flex-1 pb-2 text-xs italic",
            usePrimaryText ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {t("agent_work.redactedThinking")}
        </div>
      </div>
    );
  }

  if (item.kind === "progress") {
    return (
      <div className="flex gap-2.5">
        <WorkRail isLast={isLast} status="progress" primary={usePrimaryText} />
        <div
          className={cn(
            "min-w-0 flex-1 pb-2 text-sm leading-relaxed",
            usePrimaryText ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <Streamdown>{item.text}</Streamdown>
        </div>
      </div>
    );
  }

  const status = getToolStatus(item);
  return (
    <div className="flex gap-2.5">
      <WorkRail isLast={isLast} status={status} primary={usePrimaryText} />
      <div className="min-w-0 flex-1 pb-2">
        <ToolCallAdapter
          name={getToolName(item)}
          arguments={item.request?.arguments ?? {}}
          status={status}
          locations={item.request?.locations}
          result={item.response?.result}
          structuredContent={item.response?.structuredContent}
          isError={item.response?.isError}
          startedAt={item.request?.startedAt}
          showStatusBadge={false}
          fitWidth
          className={cn(
            usePrimaryText
              ? "text-foreground [&_button[data-clickable-file]]:text-foreground [&_[data-tool-title-hoisted]]:text-foreground [&_[data-tool-title-prefix]]:text-foreground [&_dd]:text-foreground [&_dt]:text-foreground [&_pre]:text-foreground [&_code]:text-foreground"
              : "text-muted-foreground [&_button[data-clickable-file]]:text-foreground/70 [&_[data-tool-title-hoisted]]:text-foreground/70 [&_[data-tool-title-prefix]]:text-foreground/75 [&_dd]:text-muted-foreground [&_pre]:text-muted-foreground [&_code]:text-muted-foreground",
          )}
          titleClassName={cn(
            "font-normal",
            usePrimaryText ? "text-foreground" : "text-foreground/75",
          )}
          chevronClassName={
            usePrimaryText ? "text-foreground" : "text-muted-foreground/80"
          }
          agentWorkLayout
          agentWorkUsePrimaryText={usePrimaryText}
        />
      </div>
    </div>
  );
}

function getStepSummary(
  payload: TranscriptAgentWorkPayload,
  itemCount: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const count = payload.toolCount || itemCount;
  return t("agent_work.summary.steps", { count });
}

export function AgentWorkPanel({
  payload,
  settleOnMount = false,
}: {
  payload: TranscriptAgentWorkPayload;
  settleOnMount?: boolean;
}) {
  const { t } = useTranslation("chat");
  const items = useMemo(
    () => buildAgentWorkTimeline(payload.content),
    [payload.content],
  );
  const shouldOpenActiveWork = payload.isActiveWork;
  const [open, setOpen] = useState(shouldOpenActiveWork || settleOnMount);
  const [previousStepsOpen, setPreviousStepsOpen] = useState(false);
  const wasActiveRef = useRef(shouldOpenActiveWork || settleOnMount);
  const settleCloseFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const cancelScheduledSettleClose = () => {
      if (settleCloseFrameRef.current == null) {
        return;
      }
      cancelAnimationFrame(settleCloseFrameRef.current);
      settleCloseFrameRef.current = null;
    };

    cancelScheduledSettleClose();

    if (payload.isActiveWork) {
      setOpen(shouldOpenActiveWork);
      wasActiveRef.current = shouldOpenActiveWork;
      return cancelScheduledSettleClose;
    }

    if (wasActiveRef.current || settleOnMount) {
      // The streaming rows move from the live-tail container into the virtual
      // history container when a turn completes, which remounts this panel even
      // though the row id is stable. Mount the settled history row open, then
      // close after a paint so Radix/CSS has a real open -> closed transition.
      setOpen(true);
      settleCloseFrameRef.current = requestAnimationFrame(() => {
        settleCloseFrameRef.current = requestAnimationFrame(() => {
          settleCloseFrameRef.current = null;
          setOpen(false);
        });
      });
    } else {
      setOpen(false);
    }

    wasActiveRef.current = false;
    return cancelScheduledSettleClose;
  }, [payload.isActiveWork, settleOnMount, shouldOpenActiveWork]);

  const showTrigger = !payload.isActiveWork;
  const label = t("agent_work.label");
  const isActiveWorkPreview = payload.isActiveWork;
  const activePreviewState = isActiveWorkPreview
    ? getActivePreviewState(items)
    : null;
  const visibleItems = activePreviewState?.visibleItems ?? items;
  const hiddenItems = activePreviewState?.hiddenItems ?? [];
  const hiddenStepCount = activePreviewState?.hiddenStepCount ?? 0;
  const liveTextTail = activePreviewState?.liveTextTail ?? [];
  const shouldShowPreviousSteps = isActiveWorkPreview && hiddenStepCount > 0;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="my-3 w-full min-w-0 max-w-full"
    >
      <div>
        <div>
          {showTrigger ? (
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="quiet"
                size="sm"
                className="flex h-auto w-full justify-start rounded-md px-0 py-2 text-left"
              >
                <IconChevronRight
                  aria-hidden
                  className={cn(
                    "size-3.5 text-foreground transition-transform",
                    open && "rotate-90",
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-sm font-normal text-foreground">
                  {label}
                  <span className="ml-2 text-muted-foreground/70">
                    {getStepSummary(payload, items.length, t)}
                  </span>
                </span>
              </Button>
            </CollapsibleTrigger>
          ) : null}
        </div>
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <div className="min-h-0 space-y-0">
            {shouldShowPreviousSteps ? (
              <Collapsible
                open={previousStepsOpen}
                onOpenChange={setPreviousStepsOpen}
              >
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="quiet"
                    size="sm"
                    className="mb-1 flex h-auto w-full justify-start rounded-md px-0 py-1 text-left text-muted-foreground"
                  >
                    <IconChevronRight
                      aria-hidden
                      className={cn(
                        "size-3.5 transition-transform",
                        previousStepsOpen && "rotate-90",
                      )}
                    />
                    <span className="text-xs">
                      {t("agent_work.summary.previousSteps", {
                        count: hiddenStepCount,
                      })}
                    </span>
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
                  {hiddenItems.map((item) => (
                    <AgentWorkItemRow
                      key={item.key}
                      item={item}
                      isLast={false}
                      usePrimaryText={open}
                    />
                  ))}
                </CollapsibleContent>
              </Collapsible>
            ) : null}
            {visibleItems.map((item, index) => (
              <AgentWorkItemRow
                key={item.key}
                item={item}
                isLast={
                  index === visibleItems.length - 1 && liveTextTail.length === 0
                }
                usePrimaryText={open}
              />
            ))}
            {liveTextTail.map((item, index) => (
              <AgentWorkItemRow
                key={item.key}
                item={item}
                isLast={index === liveTextTail.length - 1}
                usePrimaryText={open}
              />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
