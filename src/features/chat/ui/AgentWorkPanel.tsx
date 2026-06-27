import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
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

type AgentWorkTimelineItem =
  | ToolTimelineItem
  | ThoughtTimelineItem
  | RedactedThoughtTimelineItem
  | ProgressTimelineItem;

const AGENT_THOUGHT_MARKDOWN_CLASSNAME =
  "[&_*]:font-normal [&_strong]:font-normal [&_b]:font-normal [&_h1]:font-normal [&_h2]:font-normal [&_h3]:font-normal [&_h4]:font-normal [&_h5]:font-normal [&_h6]:font-normal [&_strong]:text-foreground/75 [&_b]:text-foreground/75 [&_h1]:text-foreground/75 [&_h2]:text-foreground/75 [&_h3]:text-foreground/75 [&_h4]:text-foreground/75 [&_h5]:text-foreground/75 [&_h6]:text-foreground/75 [&_h1]:mb-0 [&_h2]:mb-0 [&_h3]:mb-0 [&_h4]:mb-0 [&_h5]:mb-0 [&_h6]:mb-0 [&_h1+p]:mt-0 [&_h2+p]:mt-0 [&_h3+p]:mt-0 [&_h4+p]:mt-0 [&_h5+p]:mt-0 [&_h6+p]:mt-0 [&_p:has(>strong:only-child)]:mb-0 [&_p:has(>b:only-child)]:mb-0 [&_p:has(>strong:only-child)+p]:mt-0 [&_p:has(>b:only-child)+p]:mt-0";

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

function getRailColor(status: "thought" | "progress" | ToolCallStatus): string {
  if (status === "pending" || status === "in_progress") {
    return "text-foreground/70";
  }
  return "text-muted-foreground/80";
}

function WorkRail({
  isLast,
  status,
}: {
  isLast: boolean;
  status: "thought" | "progress" | ToolCallStatus;
}) {
  const isActive = status === "pending" || status === "in_progress";
  const colorClassName = getRailColor(status);
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
}: {
  item: AgentWorkTimelineItem;
  isLast: boolean;
}) {
  const { t } = useTranslation("chat");
  if (item.kind === "thought") {
    return (
      <div className="flex gap-2.5">
        <WorkRail isLast={isLast} status="thought" />
        <div className="min-w-0 flex-1 pb-2 text-sm leading-relaxed text-muted-foreground">
          <Streamdown className={AGENT_THOUGHT_MARKDOWN_CLASSNAME}>
            {item.content.text}
          </Streamdown>
        </div>
      </div>
    );
  }

  if (item.kind === "redactedThought") {
    return (
      <div className="flex gap-2.5">
        <WorkRail isLast={isLast} status="thought" />
        <div className="min-w-0 flex-1 pb-2 text-xs italic text-muted-foreground">
          {t("agent_work.redactedThinking")}
        </div>
      </div>
    );
  }

  if (item.kind === "progress") {
    return (
      <div className="flex gap-2.5">
        <WorkRail isLast={isLast} status="progress" />
        <div className="min-w-0 flex-1 pb-2 text-sm leading-relaxed text-muted-foreground">
          <Streamdown>{item.text}</Streamdown>
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
          arguments={item.request?.arguments ?? {}}
          status={status}
          locations={item.request?.locations}
          result={item.response?.result}
          structuredContent={item.response?.structuredContent}
          isError={item.response?.isError}
          startedAt={item.request?.startedAt}
          showStatusBadge={false}
          fitWidth
          className="text-muted-foreground [&_button[data-clickable-file]]:text-foreground/70 [&_[data-tool-title-hoisted]]:text-foreground/70 [&_[data-tool-title-prefix]]:text-foreground/75 [&_dd]:text-muted-foreground [&_pre]:text-muted-foreground [&_code]:text-muted-foreground"
          titleClassName="font-normal text-foreground/75"
          chevronClassName="text-muted-foreground/80"
          agentWorkLayout
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
}: {
  payload: TranscriptAgentWorkPayload;
}) {
  const { t } = useTranslation("chat");
  const items = useMemo(
    () => buildAgentWorkTimeline(payload.content),
    [payload.content],
  );
  const [open, setOpen] = useState(payload.isActiveWork);
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const wasActiveRef = useRef(payload.isActiveWork);

  useEffect(() => {
    if (payload.isActiveWork) {
      setOpen(true);
    }
    if (wasActiveRef.current && !payload.isActiveWork) {
      setOpen(false);
    }
    wasActiveRef.current = payload.isActiveWork;
  }, [payload.isActiveWork]);

  useEffect(() => {
    const contentLength = payload.content.length;
    if (!payload.isActiveWork || !open || contentLength === 0) return;
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [open, payload.content, payload.isActiveWork]);

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const element = scrollRef.current;
      if (!element) return;

      const startY = event.clientY;
      const startHeight = element.getBoundingClientRect().height;
      const minHeight = 96;
      const maxHeight = 640;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const nextHeight = Math.min(
          maxHeight,
          Math.max(minHeight, startHeight + moveEvent.clientY - startY),
        );
        setPanelHeight(nextHeight);
      };

      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
    },
    [],
  );

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="my-3 w-full min-w-0 max-w-full"
    >
      <div className="rounded-md border border-border bg-background">
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="quiet"
            size="sm"
            className="flex h-auto w-full justify-start rounded-md px-3 py-2 text-left"
          >
            <IconChevronRight
              aria-hidden
              className={cn(
                "size-3.5 text-foreground transition-transform",
                open && "rotate-90",
              )}
            />
            <span className="min-w-0 flex-1 truncate text-sm font-normal text-foreground">
              {t("agent_work.label")}
              <span className="ml-2 text-muted-foreground/70">
                {getStepSummary(payload, items.length, t)}
              </span>
            </span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <div className="relative">
            <div
              ref={scrollRef}
              className="scrollbar-visible max-h-[18rem] overflow-y-auto overflow-x-hidden px-3 pt-1 pb-3 [scrollbar-gutter:stable]"
              style={panelHeight ? { height: panelHeight } : undefined}
            >
              <div className="min-h-0 space-y-0">
                {items.map((item, index) => (
                  <AgentWorkItemRow
                    key={item.key}
                    item={item}
                    isLast={index === items.length - 1}
                  />
                ))}
              </div>
            </div>
            <div
              aria-hidden
              className="absolute right-0 bottom-0 left-0 h-3 cursor-ns-resize"
              onPointerDown={handleResizePointerDown}
            />
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
