import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  IconChevronRight,
  IconCircle,
  IconClock,
  IconMessageCircle,
  IconTool,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { viewableArtifacts } from "@/features/chat/lib/artifactViewerTypes";
import { ArtifactChips } from "./ArtifactChips";
import { cn } from "@/shared/lib/cn";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
import { Button } from "@/shared/ui/button";
import type {
  MessageContent,
  TextContent,
  ThinkingContent,
  ReasoningContent,
  ToolRequestContent,
  ToolResponseContent,
  ToolCallStatus,
} from "@/shared/types/messages";
import type { TranscriptAgentWorkPayload } from "@/features/chat/transcript/projection/transcriptItemTypes";
import { useTranscriptRowStateAdapter } from "@/features/chat/transcript/row-state";
import { ToolCallAdapter } from "./ToolCallAdapter";
import { VoiceSpeechStatusIndicator } from "./VoiceSpeechStatusIndicator";
import { getSubagentToolCallInfo } from "@/features/chat/lib/subagentToolCalls";
import { ActiveAgentFacepile } from "./AgentIdentityAvatar";

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
  content: TextContent;
}

interface ActivePreviewState {
  visibleItems: AgentWorkTimelineItem[];
  hiddenItems: AgentWorkTimelineItem[];
  hiddenStepCount: number;
}

type AgentWorkTimelineItem =
  | ToolTimelineItem
  | ThoughtTimelineItem
  | RedactedThoughtTimelineItem
  | ProgressTimelineItem;

const AGENT_THOUGHT_MARKDOWN_CLASSNAME =
  "[&_*]:font-normal [&_strong]:font-normal [&_b]:font-normal [&_h1]:font-normal [&_h2]:font-normal [&_h3]:font-normal [&_h4]:font-normal [&_h5]:font-normal [&_h6]:font-normal [&_strong]:text-foreground/75 [&_b]:text-foreground/75 [&_h1]:text-foreground/75 [&_h2]:text-foreground/75 [&_h3]:text-foreground/75 [&_h4]:text-foreground/75 [&_h5]:text-foreground/75 [&_h6]:text-foreground/75 [&_h1]:mb-0 [&_h2]:mb-0 [&_h3]:mb-0 [&_h4]:mb-0 [&_h5]:mb-0 [&_h6]:mb-0 [&_h1+p]:mt-0 [&_h2+p]:mt-0 [&_h3+p]:mt-0 [&_h4+p]:mt-0 [&_h5+p]:mt-0 [&_h6+p]:mt-0 [&_p:has(>strong:only-child)]:mb-0 [&_p:has(>b:only-child)]:mb-0 [&_p:has(>strong:only-child)+p]:mt-0 [&_p:has(>b:only-child)+p]:mt-0";
const COMPACT_ACTIVE_PREVIEW_ITEM_COUNT = 3;

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
      if (
        previous?.kind === "progress" &&
        previous.content.speech === undefined &&
        block.speech === undefined
      ) {
        previous.content = {
          ...previous.content,
          text: previous.content.text + block.text,
        };
      } else if (block.text.trim()) {
        items.push({
          kind: "progress",
          key: `progress-${index}`,
          content: block,
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

function getActivePreviewState(
  items: readonly AgentWorkTimelineItem[],
): ActivePreviewState {
  // The active preview is a chronological window over the work stream: the
  // last N items in true order, with everything older behind "previous steps".
  const visibleItems = items.slice(-COMPACT_ACTIVE_PREVIEW_ITEM_COUNT);
  const hiddenItems = items.slice(0, items.length - visibleItems.length);
  return {
    visibleItems,
    hiddenItems,
    hiddenStepCount: hiddenItems.length,
  };
}

const GOOSE_TASK_ID_PATTERN = /\b\d{8}_\w+\b/g;

function taskIdsFromToolResult(item: ToolTimelineItem): string[] {
  if (!item.response) return [];
  let structuredText = "";
  if (item.response.structuredContent !== undefined) {
    try {
      structuredText = JSON.stringify(item.response.structuredContent);
    } catch {
      // The plain result can still carry the task id.
    }
  }
  const text = `${item.response.result} ${structuredText}`;
  return [...new Set(text.match(GOOSE_TASK_ID_PATTERN) ?? [])];
}

function addUniqueAgentName(
  names: string[],
  seen: Set<string>,
  value?: string,
) {
  const name = value?.trim();
  if (!name) return;
  const key = name.toLocaleLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  names.push(name);
}

function getActiveDelegatedAgentNames(
  items: readonly AgentWorkTimelineItem[],
): string[] {
  const activeTaskAgents = new Map<string, string>();
  const activeToolAgents: string[] = [];
  const seenActiveTools = new Set<string>();

  for (const item of items) {
    if (item.kind !== "tool" || !item.request) continue;
    const status = getToolStatus(item);
    const info = getSubagentToolCallInfo({
      toolName: item.request.toolName,
      arguments: item.request.arguments ?? {},
    });
    if (!info) continue;

    const agentNames = info.agentNames ?? [
      info.agentName ?? item.request.subagentAgentName,
    ];
    const isRunningTool = status === "pending" || status === "in_progress";

    if (info.activity === "delegating" && isRunningTool) {
      for (const name of agentNames) {
        addUniqueAgentName(activeToolAgents, seenActiveTools, name);
      }
    }

    if (
      item.request.toolName === "delegate" &&
      item.request.arguments?.async === true &&
      item.response &&
      !item.response.isError
    ) {
      const agentName = agentNames[0]?.trim();
      if (agentName) {
        for (const taskId of taskIdsFromToolResult(item)) {
          activeTaskAgents.set(taskId, agentName);
        }
      }
    }

    if (item.request.toolName === "load" && info.taskId) {
      if (
        info.activity === "waiting" &&
        item.response &&
        !item.response.isError
      ) {
        activeTaskAgents.delete(info.taskId);
      } else if (
        info.activity === "cancelling" &&
        item.response &&
        !item.response.isError
      ) {
        activeTaskAgents.delete(info.taskId);
      }
    }
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const name of activeTaskAgents.values()) {
    addUniqueAgentName(names, seen, name);
  }
  for (const name of activeToolAgents) {
    addUniqueAgentName(names, seen, name);
  }
  return names;
}

function getRailColor(
  status: "thought" | "progress" | ToolCallStatus,
  primary = false,
): string {
  if (status !== "thought" && status !== "progress") {
    return "text-muted-foreground";
  }
  if (primary) {
    return "text-foreground";
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
  // The bullet circle masks the rail spine behind it. It must match the
  // transcript surface (bg-card) — bg-background diverges from it in dark
  // mode and shows as a clipped dark disc (BOT-1599).
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
          "relative z-10 mt-0.5 flex size-5 items-center justify-center rounded-full bg-card ring-2 ring-card",
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
          <MessageResponse
            mode="static"
            className={cn(
              AGENT_THOUGHT_MARKDOWN_CLASSNAME,
              usePrimaryText &&
                "[&_strong]:text-foreground [&_b]:text-foreground [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_h4]:text-foreground [&_h5]:text-foreground [&_h6]:text-foreground",
            )}
          >
            {item.content.text}
          </MessageResponse>
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
    const speechStatus = item.content.speech?.status;
    const strikethroughFrom =
      (speechStatus === "interrupted" || speechStatus === "failed") &&
      item.content.speech?.spokenThrough !== undefined
        ? item.content.speech.spokenThrough
        : speechStatus === "notSpoken"
          ? 0
          : undefined;
    const speechLabel = speechStatus
      ? {
          speaking: t("message.voiceSpeechSpeakingLabel"),
          spoken: t("message.voiceSpeechSpokenLabel"),
          interrupted: t("message.voiceSpeechInterruptedLabel"),
          notSpoken: t("message.voiceSpeechNotSpokenLabel"),
          failed: t("message.voiceSpeechFailedLabel"),
        }[speechStatus]
      : null;
    return (
      <div className="flex gap-2.5">
        <WorkRail isLast={isLast} status="progress" primary={usePrimaryText} />
        <div
          data-voice-speech-status={speechStatus}
          className={cn(
            "min-w-0 flex-1 pb-2 text-sm leading-relaxed",
            usePrimaryText ? "text-foreground" : "text-muted-foreground",
            speechStatus === "interrupted" && "opacity-80",
          )}
        >
          {speechStatus && speechLabel ? (
            <VoiceSpeechStatusIndicator
              status={speechStatus}
              label={speechLabel}
            />
          ) : null}
          <MessageResponse
            mode="static"
            strikethroughFrom={strikethroughFrom}
            strikethroughLabel={t("message.voiceSpeechNotSpokenLabel")}
          >
            {item.content.text}
          </MessageResponse>
        </div>
      </div>
    );
  }

  const status = getToolStatus(item);
  return (
    <div className="flex gap-2.5">
      <WorkRail isLast={isLast} status={status} />
      <div className="min-w-0 flex-1 pb-2">
        <ToolCallAdapter
          name={getToolName(item)}
          toolName={item.request?.toolName}
          subagentAgentName={item.request?.subagentAgentName}
          subagentTaskLabel={item.request?.subagentTaskLabel}
          subagentTaskIsConfigured={item.request?.subagentTaskIsConfigured}
          arguments={item.request?.arguments ?? {}}
          status={status}
          locations={item.request?.locations}
          result={item.response?.result}
          structuredContent={item.response?.structuredContent}
          isError={item.response?.isError}
          startedAt={item.request?.startedAt}
          showStatusBadge={false}
          fitWidth
          className="text-muted-foreground [&_button[data-clickable-file]]:text-muted-foreground [&_[data-tool-title-hoisted]]:text-muted-foreground [&_[data-tool-title-prefix]]:text-muted-foreground [&_code]:text-muted-foreground [&_dd]:text-muted-foreground [&_dt]:text-muted-foreground"
          titleClassName="font-normal text-muted-foreground"
          chevronClassName="text-muted-foreground"
          agentWorkLayout
        />
      </div>
    </div>
  );
}

export function AgentWorkPanel({
  payload,
  settleOnMount = false,
}: {
  payload: TranscriptAgentWorkPayload;
  settleOnMount?: boolean;
}) {
  const { t, i18n } = useTranslation("chat");
  const prefersReducedMotion = useReducedMotion();
  const { markRowInteracted, pinScrollAnchor } = useTranscriptRowStateAdapter();
  const items = useMemo(
    () => buildAgentWorkTimeline(payload.content),
    [payload.content],
  );
  // Every viewable file this work touched. Chips are the single way back into
  // the viewer: they render for any count and survive collapse. The old header
  // "View" action only appeared for exactly one file, so the same document
  // surfaced as a different-looking control depending on how the run grouped —
  // chips replace it outright.
  const workArtifacts = useMemo(
    () =>
      viewableArtifacts(
        items.map((item) => (item.kind === "tool" ? item.request : undefined)),
      ),
    [items],
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
  const isActiveWorkPreview = payload.isActiveWork;
  const activePreviewState = isActiveWorkPreview
    ? getActivePreviewState(items)
    : null;
  const visibleItems = activePreviewState?.visibleItems ?? items;
  const hiddenItems = activePreviewState?.hiddenItems ?? [];
  const hiddenStepCount = activePreviewState?.hiddenStepCount ?? 0;
  const shouldShowPreviousSteps = isActiveWorkPreview && hiddenStepCount > 0;
  const activeDelegatedAgentNames = useMemo(
    () => getActiveDelegatedAgentNames(items),
    [items],
  );

  return (
    <Collapsible
      open={open}
      onOpenChange={(nextOpen) => {
        markRowInteracted("agent-work-disclosure");
        pinScrollAnchor();
        setOpen(nextOpen);
      }}
      data-role="agent-work-panel"
      className="mt-3 w-full min-w-0 max-w-full"
    >
      <div>
        <div className="flex min-w-0 items-center gap-2">
          {showTrigger ? (
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                flush
                size="sm"
                className="flex h-auto w-full min-w-0 flex-1 justify-start rounded-md px-0 py-2 text-left"
                rightIcon={
                  <IconChevronRight
                    aria-hidden
                    className={cn(
                      "size-3.5 transition-transform",
                      open && "rotate-90",
                    )}
                  />
                }
              >
                <span className="min-w-0 truncate text-sm font-normal">
                  {t(
                    payload.hasFinalAnswer
                      ? "agent_work.summary.previousSteps"
                      : "agent_work.summary.steps",
                    { count: items.length },
                  )}
                </span>
              </Button>
            </CollapsibleTrigger>
          ) : null}
        </div>
        {/*
          One chip per viewable file, for any count. This is the only re-entry
          control on an agent-work panel: it survives collapse and looks the
          same whether the run wrote one document or six.
        */}
        {workArtifacts.length > 0 ? (
          <ArtifactChips artifacts={workArtifacts} className="px-1 pb-1.5" />
        ) : null}
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <div className="min-h-0 space-y-0">
            {shouldShowPreviousSteps ? (
              <motion.div
                key="previous-steps"
                initial={prefersReducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={
                  prefersReducedMotion
                    ? { duration: 0 }
                    : {
                        duration: 0.18,
                        ease: [0.215, 0.61, 0.355, 1],
                      }
                }
              >
                <Collapsible
                  open={previousStepsOpen}
                  onOpenChange={(nextOpen) => {
                    markRowInteracted("agent-work-previous-steps");
                    pinScrollAnchor();
                    setPreviousStepsOpen(nextOpen);
                  }}
                >
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      flush
                      size="sm"
                      className="mb-1 flex h-auto w-full justify-start rounded-md px-0 py-2 text-left"
                      rightIcon={
                        <IconChevronRight
                          aria-hidden
                          className={cn(
                            "size-3.5 transition-transform",
                            previousStepsOpen && "rotate-90",
                          )}
                        />
                      }
                    >
                      <span className="text-sm tabular-nums">
                        {t("agent_work.summary.previousSteps", {
                          count: hiddenStepCount,
                        })}
                      </span>
                      <ActiveAgentFacepile
                        agentNames={activeDelegatedAgentNames}
                        label={t("agent_work.summary.activeAgents", {
                          count: activeDelegatedAgentNames.length,
                          names: new Intl.ListFormat(i18n.resolvedLanguage, {
                            style: "long",
                            type: "conjunction",
                          }).format(activeDelegatedAgentNames),
                        })}
                      />
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
              </motion.div>
            ) : null}
            <motion.div
              key="live-steps"
              layout={prefersReducedMotion ? false : "position"}
              data-role="agent-work-live-steps"
              className="relative"
              transition={
                prefersReducedMotion
                  ? { duration: 0 }
                  : {
                      type: "spring",
                      duration: 0.26,
                      bounce: 0,
                    }
              }
            >
              <AnimatePresence initial={false} mode="popLayout">
                {visibleItems.map((item, index) => (
                  <motion.div
                    key={item.key}
                    layout={prefersReducedMotion ? false : "position"}
                    initial={
                      prefersReducedMotion ? false : { opacity: 0, y: 4 }
                    }
                    animate={{ opacity: 1, y: 0 }}
                    exit={
                      prefersReducedMotion ? undefined : { opacity: 0, y: -4 }
                    }
                    transition={
                      prefersReducedMotion
                        ? { duration: 0 }
                        : {
                            layout: {
                              type: "spring",
                              duration: 0.26,
                              bounce: 0,
                            },
                            opacity: {
                              duration: 0.18,
                              ease: [0.215, 0.61, 0.355, 1],
                            },
                            y: {
                              duration: 0.22,
                              ease: [0.215, 0.61, 0.355, 1],
                            },
                          }
                    }
                  >
                    <AgentWorkItemRow
                      item={item}
                      isLast={index === visibleItems.length - 1}
                      usePrimaryText={open}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
