import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, CircleIcon, ClockIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { viewableArtifacts } from "@/features/chat/lib/artifactViewerTypes";
import { ArtifactChips } from "./ArtifactChips";
import {
  createVirtualLayoutStabilityAttributes,
  useVirtualLayoutPendingForChange,
} from "@/features/chat/transcript/measurement";
import {
  useTranscriptActiveToolProtection,
  useTranscriptRowStateAdapter,
} from "@/features/chat/transcript/row-state";
import { ToolCallAdapter } from "./ToolCallAdapter";
import {
  getChainAggregateStatus,
  getToolItemName,
  getToolItemStatus,
  getToolItemToolName,
  shouldRenderAsGroupedChain,
  type ToolChainItem,
} from "@/features/chat/lib/toolChainGrouping";
import { summarizeToolChainSteps } from "@/features/chat/lib/toolChainSummary";
import type { ToolCallStatus } from "@/shared/types/messages";

export type { ToolChainItem };

const STEP_BULLET_ICON: Record<
  Exclude<ToolCallStatus, "failed" | "stopped">,
  LucideIcon
> = {
  pending: CircleIcon,
  in_progress: ClockIcon,
  completed: Check,
};

const STEP_BULLET_CLASS: Record<
  Exclude<ToolCallStatus, "failed" | "stopped">,
  string
> = {
  pending: "text-muted-foreground",
  in_progress: "text-muted-foreground animate-pulse",
  completed: "text-muted-foreground",
};

function ChainStepBullet({ status }: { status: ToolCallStatus }) {
  if (status === "failed") {
    return (
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full bg-destructive"
      />
    );
  }
  if (status === "stopped") {
    return (
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
    );
  }
  const Icon = STEP_BULLET_ICON[status];
  return (
    <Icon className={cn("size-3.5 shrink-0", STEP_BULLET_CLASS[status])} />
  );
}

function ChainStepRail({
  status,
  isLast = false,
  lineTailVisible = true,
}: {
  status: ToolCallStatus;
  /** Last row in the expanded chain: hides the spine stub below the bullet until `lineTailVisible`. */
  isLast?: boolean;
  lineTailVisible?: boolean;
}) {
  // The bullet circle and line tail are masks painted over the rail spine.
  // They must match the transcript surface (bg-card, see the timeline surface
  // in VirtualMessageTimeline) — bg-background diverges from it in dark mode
  // and shows as a clipped dark disc (BOT-1599).
  return (
    <div
      aria-hidden="true"
      className="relative flex w-4 shrink-0 justify-center self-stretch"
    >
      {isLast && (
        <div
          className={cn(
            "pointer-events-none absolute top-5 bottom-0 left-1/2 z-11 w-2.5 -translate-x-1/2 bg-card transition-opacity duration-150",
            lineTailVisible ? "opacity-0" : "opacity-100",
          )}
        />
      )}
      <div className="relative z-10 mt-1 flex h-4 w-4 items-center justify-center rounded-full bg-card ring-2 ring-card">
        <ChainStepBullet status={status} />
      </div>
    </div>
  );
}

const INTERNAL_TOOL_PREFIXES = new Set([
  "awk",
  "bash",
  "cat",
  "chmod",
  "cp",
  "echo",
  "find",
  "grep",
  "head",
  "ls",
  "mv",
  "open",
  "pip",
  "pip3",
  "python",
  "python3",
  "rm",
  "sed",
  "sh",
  "tail",
  "wc",
  "which",
  "zsh",
]);

function isLowSignalToolStep(item: ToolChainItem): boolean {
  if (getToolItemStatus(item) !== "completed") {
    return false;
  }
  if (item.response?.isError) {
    return false;
  }

  const name = getToolItemName(item).trim();
  if (!name) return false;

  const lower = name.toLowerCase();
  const firstToken = lower.split(/\s+/)[0];
  if (INTERNAL_TOOL_PREFIXES.has(firstToken)) {
    return true;
  }
  if (name.length > 88) {
    return true;
  }
  return (
    lower.includes("&&") ||
    lower.includes("||") ||
    lower.includes("2>&1") ||
    lower.includes("|")
  );
}

function partitionToolSteps(
  toolItems: ToolChainItem[],
  expandedKeys: Set<string>,
) {
  if (toolItems.length <= 3) {
    return { primaryItems: toolItems, hiddenItems: [] as ToolChainItem[] };
  }

  const primaryItems: ToolChainItem[] = [];
  const hiddenItems: ToolChainItem[] = [];

  for (const item of toolItems) {
    if (!expandedKeys.has(item.key) && isLowSignalToolStep(item)) {
      hiddenItems.push(item);
      continue;
    }
    primaryItems.push(item);
  }

  if (primaryItems.length === 0) {
    return { primaryItems: toolItems, hiddenItems: [] as ToolChainItem[] };
  }

  if (hiddenItems.length < 2) {
    return { primaryItems: toolItems, hiddenItems: [] as ToolChainItem[] };
  }

  return { primaryItems, hiddenItems };
}

function getFallbackToolChainStateId(
  toolItems: readonly ToolChainItem[],
): string {
  return toolItems.map((item) => item.key).join("|") || "tool-chain";
}

function InternalStepsContent({
  children,
  reduceMotion,
}: {
  children: ReactNode;
  reduceMotion: boolean;
}) {
  const isPresent = useIsPresent();

  return (
    <motion.div
      data-role="tool-chain-internal-steps"
      initial={reduceMotion ? false : { opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { duration: 0.18, ease: [0.215, 0.61, 0.355, 1] }
      }
      aria-hidden={isPresent ? undefined : true}
      inert={isPresent ? undefined : true}
    >
      {children}
    </motion.div>
  );
}

function InternalStepsTransition({
  children,
  reduceMotion,
  show,
}: {
  children: ReactNode;
  reduceMotion: boolean;
  show: boolean;
}) {
  return (
    <AnimatePresence initial={false} mode="popLayout">
      {show && (
        <InternalStepsContent key="internal-steps" reduceMotion={reduceMotion}>
          {children}
        </InternalStepsContent>
      )}
    </AnimatePresence>
  );
}

export function ToolChainCards({
  chainId,
  toolItems,
  hasDetailRow = false,
  detailOnly = false,
  externalChainExpanded,
}: {
  chainId?: string;
  toolItems: ToolChainItem[];
  hasDetailRow?: boolean;
  detailOnly?: boolean;
  externalChainExpanded?: boolean;
}) {
  const prefersReducedMotion = useReducedMotion();
  const { t } = useTranslation("chat");
  // Every viewable file this chain touched. Chips are the single way back into
  // the viewer for a chain: they render for any count and stay put when the
  // chain collapses. The old header "View" action only appeared for exactly
  // one file, so the same document surfaced as a different-looking control
  // depending on how the run happened to group — chips replace it outright.
  const chainArtifacts = useMemo(
    () => viewableArtifacts(toolItems.map((item) => item.request)),
    [toolItems],
  );
  const { rowState, updateRowState, markRowInteracted } =
    useTranscriptRowStateAdapter();
  const durableToolChainStateId =
    chainId ?? getFallbackToolChainStateId(toolItems);
  const durableToolChainState =
    rowState?.toolChains?.[durableToolChainStateId] ?? rowState?.toolChain;
  const [showInternalSteps, setShowInternalSteps] = useState(
    () => durableToolChainState?.showInternalSteps ?? false,
  );
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(
    () => new Set(durableToolChainState?.expandedToolKeys ?? []),
  );
  const { primaryItems, hiddenItems } = partitionToolSteps(
    toolItems,
    expandedKeys,
  );
  const grouped = shouldRenderAsGroupedChain(toolItems);
  const aggregateStatus = getChainAggregateStatus(toolItems);
  const summary = summarizeToolChainSteps(primaryItems);
  const isActiveChain =
    aggregateStatus === "in_progress" || aggregateStatus === "pending";
  // Chains that mount as already-complete (history replay) start collapsed;
  // untouched live chains mount mid-execution, stay open while running, and
  // auto-collapse once they finish so the chat keeps moving forward.
  const [chainExpandedLocal, setChainExpanded] = useState(
    () => durableToolChainState?.chainExpanded ?? isActiveChain,
  );
  const chainExpanded =
    externalChainExpanded !== undefined
      ? externalChainExpanded
      : chainExpandedLocal;
  const wasActiveChainRef = useRef(isActiveChain);
  const wasGroupedRef = useRef(grouped);
  const userInteractedRef = useRef(
    durableToolChainState?.userInteracted ?? false,
  );
  const hasExpandedToolItem = toolItems.some((item) =>
    expandedKeys.has(item.key),
  );
  useTranscriptActiveToolProtection(isActiveChain);

  const expandedToolKeys = useMemo(
    () => [...expandedKeys].sort(),
    [expandedKeys],
  );
  const layoutPendingKey = `${chainExpanded}:${showInternalSteps}:${expandedToolKeys.join("|")}`;
  const isLayoutPending = useVirtualLayoutPendingForChange(layoutPendingKey);
  const layoutPendingAttributes = createVirtualLayoutStabilityAttributes({
    isPending: isLayoutPending,
    reason: "tool-animation",
  });

  useEffect(() => {
    updateRowState(
      (current) => {
        const currentChainState =
          current.toolChains?.[durableToolChainStateId] ?? current.toolChain;
        return {
          ...current,
          toolChains: {
            ...current.toolChains,
            [durableToolChainStateId]: {
              ...currentChainState,
              chainExpanded,
              expandedToolKeys,
              showInternalSteps,
              userInteracted: userInteractedRef.current,
            },
          },
        };
      },
      { markRecent: false },
    );
  }, [
    chainExpanded,
    durableToolChainStateId,
    expandedToolKeys,
    showInternalSteps,
    updateRowState,
  ]);

  if (
    wasActiveChainRef.current &&
    !isActiveChain &&
    !userInteractedRef.current
  ) {
    setChainExpanded(false);
    setExpandedKeys(new Set());
    setShowInternalSteps(false);
  }

  if (!wasGroupedRef.current && grouped && hasExpandedToolItem) {
    setChainExpanded(true);
  }

  wasActiveChainRef.current = isActiveChain;
  wasGroupedRef.current = grouped;

  const markUserInteracted = () => {
    userInteractedRef.current = true;
    markRowInteracted("tool-chain");
  };

  const handleOpenChange = (key: string, open: boolean) => {
    markUserInteracted();
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (open) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
    // For ungrouped single tools with a paired detail row, the per-item open
    // state drives the detail row's visibility via chainExpanded.
    if (hasDetailRow && !grouped) {
      setChainExpanded(open);
    }
  };

  const renderToolItem = (
    item: ToolChainItem,
    options: {
      withRail: boolean;
      isLastInChain?: boolean;
      forceClose?: boolean;
    },
  ) => {
    const name = getToolItemName(item);
    const toolName = getToolItemToolName(item);
    const subagentAgentName = item.request?.subagentAgentName;
    const subagentTaskLabel = item.request?.subagentTaskLabel;
    const subagentTaskIsConfigured = item.request?.subagentTaskIsConfigured;
    const status = getToolItemStatus(item);
    const { request, response } = item;
    const isOpen = !options.forceClose && expandedKeys.has(item.key);

    if (!options.withRail) {
      return (
        <div
          key={item.key}
          data-role="tool-single"
          className="flex max-w-full items-start gap-2.5"
        >
          <button
            type="button"
            onClick={() => handleOpenChange(item.key, !isOpen)}
            aria-expanded={isOpen}
            aria-label={name}
            className="flex w-4 shrink-0 justify-center pt-1"
          >
            <span className="flex size-4 items-center justify-center">
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform",
                  isOpen && "rotate-90",
                )}
              />
            </span>
          </button>
          <div className="min-w-0 flex-1">
            <ToolCallAdapter
              name={name}
              toolName={toolName}
              subagentAgentName={subagentAgentName}
              subagentTaskLabel={subagentTaskLabel}
              subagentTaskIsConfigured={subagentTaskIsConfigured}
              arguments={request?.arguments ?? {}}
              status={status}
              locations={request?.locations}
              result={response?.result}
              structuredContent={response?.structuredContent}
              isError={response?.isError}
              startedAt={request?.startedAt}
              open={isOpen}
              onOpenChange={(open) => handleOpenChange(item.key, open)}
              showChevron={false}
            />
          </div>
        </div>
      );
    }

    return (
      <div
        key={item.key}
        data-role="tool-chain-step"
        className="relative z-1 flex max-w-full items-stretch gap-2.5"
      >
        <ChainStepRail
          status={status}
          isLast={options.isLastInChain}
          lineTailVisible={isOpen}
        />
        <div className="min-w-0 flex-1 pb-1">
          <ToolCallAdapter
            name={name}
            toolName={toolName}
            subagentAgentName={subagentAgentName}
            subagentTaskLabel={subagentTaskLabel}
            subagentTaskIsConfigured={subagentTaskIsConfigured}
            arguments={request?.arguments ?? {}}
            status={status}
            locations={request?.locations}
            result={response?.result}
            structuredContent={response?.structuredContent}
            isError={response?.isError}
            startedAt={request?.startedAt}
            open={isOpen}
            onOpenChange={(open) => handleOpenChange(item.key, open)}
            showStatusBadge={false}
            fitWidth
          />
        </div>
      </div>
    );
  };

  // Detail-only mode: render only the expanded step list, no header.
  if (detailOnly) {
    if (!chainExpanded) {
      return null;
    }
    // Single-tool items use ungrouped rendering (no rail) in the detail row.
    if (!grouped) {
      return (
        <div
          className="my-3 flex w-full min-w-0 max-w-full flex-col gap-3"
          {...layoutPendingAttributes}
        >
          {primaryItems.map((item) =>
            renderToolItem(item, { withRail: false }),
          )}
        </div>
      );
    }
    return (
      <div
        className="relative flex flex-col gap-1 pt-1.5"
        {...layoutPendingAttributes}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 bottom-0 left-2 z-0 w-px -translate-x-1/2 bg-border"
        />
        {primaryItems.map((item, index) => {
          const isLastPrimary = index === primaryItems.length - 1;
          const hasHiddenDisclosure = hiddenItems.length > 0;
          const isLastInChain =
            isLastPrimary &&
            !hasHiddenDisclosure &&
            !(showInternalSteps && hiddenItems.length > 0);
          return renderToolItem(item, { withRail: true, isLastInChain });
        })}
        {hiddenItems.length > 0 && (
          <div
            data-role="tool-chain-internal-disclosure"
            className="relative z-1 flex max-w-full items-stretch gap-2.5"
          >
            <ChainStepRail
              status="completed"
              isLast={!showInternalSteps}
              lineTailVisible={showInternalSteps}
            />
            <div className="min-w-0 flex-1 pb-1">
              <button
                type="button"
                onClick={() => {
                  markUserInteracted();
                  setShowInternalSteps((prev) => !prev);
                }}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    "h-3 w-3 transition-transform",
                    showInternalSteps && "rotate-90",
                  )}
                />
                {showInternalSteps
                  ? t("tool_chain.internalSteps.hide", {
                      count: hiddenItems.length,
                    })
                  : t("tool_chain.internalSteps.show", {
                      count: hiddenItems.length,
                    })}
              </button>
            </div>
          </div>
        )}
        <InternalStepsTransition
          reduceMotion={prefersReducedMotion === true}
          show={showInternalSteps}
        >
          {hiddenItems.map((item, index) =>
            renderToolItem(item, {
              withRail: true,
              isLastInChain: index === hiddenItems.length - 1,
            }),
          )}
        </InternalStepsTransition>
      </div>
    );
  }

  if (!grouped) {
    return (
      <div
        className="my-3 flex w-full min-w-0 max-w-full flex-col gap-3"
        {...layoutPendingAttributes}
      >
        {primaryItems.map((item) =>
          renderToolItem(item, { withRail: false, forceClose: hasDetailRow }),
        )}
        {/*
          A lone tool call is the most common "write me a doc" shape, so the
          chip contract has to hold here too — same control as grouped chains,
          not a different-looking per-card action.
        */}
        {chainArtifacts.length > 0 ? (
          <ArtifactChips artifacts={chainArtifacts} />
        ) : null}
      </div>
    );
  }

  // Prefer the server-generated LLM chain summary (anchored on the first tool
  // request of the chain) over the deterministic bucket phrase. The summary is
  // attached after every step in the chain has completed, so it's only
  // available for finished chains; while the chain is still active, fall back
  // to the deterministic phrase.
  const firstChainSummary = toolItems.find((item) => item.request?.chainSummary)
    ?.request?.chainSummary;
  const labelText =
    !isActiveChain && firstChainSummary
      ? firstChainSummary.summary
      : isActiveChain
        ? t("tool_chain.summary.active")
        : t(summary.titleKey);
  const headerText = isActiveChain
    ? t("tool_chain.title.active", { count: toolItems.length })
    : t("tool_chain.title.labeled", {
        label: labelText,
        count: toolItems.length,
      });

  const hasHiddenDisclosure = hiddenItems.length > 0;

  return (
    <section
      className="my-3 flex w-full min-w-0 max-w-full flex-col gap-0"
      data-role="tool-chain-card"
      data-status={aggregateStatus}
      {...layoutPendingAttributes}
    >
      <div className="flex w-full max-w-full items-center gap-1.5 pb-1">
        <button
          type="button"
          onClick={() => {
            markUserInteracted();
            if (chainExpanded) {
              setExpandedKeys(new Set());
              setShowInternalSteps(false);
            }
            setChainExpanded((prev) => !prev);
          }}
          aria-expanded={chainExpanded}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left text-sm font-medium text-muted-foreground"
        >
          <span
            aria-hidden="true"
            className="flex size-4 shrink-0 items-center justify-center"
          >
            <ChevronRight
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                chainExpanded && "rotate-90",
              )}
            />
          </span>
          <span className="min-w-0 flex-1 truncate">{headerText}</span>
        </button>
      </div>

      {/*
        One chip per viewable file, for any count. This is the only re-entry
        control on a chain: it survives collapse and looks the same whether the
        run wrote one document or six.
      */}
      {chainArtifacts.length > 0 ? (
        <ArtifactChips artifacts={chainArtifacts} className="pt-0.5 pb-1" />
      ) : null}

      {chainExpanded && !hasDetailRow && (
        <div className="relative flex flex-col gap-1 pt-1.5">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 bottom-0 left-2 z-0 w-px -translate-x-1/2 bg-border"
          />
          {primaryItems.map((item, index) => {
            const isLastPrimary = index === primaryItems.length - 1;
            const isLastInChain =
              isLastPrimary &&
              !hasHiddenDisclosure &&
              !(showInternalSteps && hiddenItems.length > 0);
            return renderToolItem(item, {
              withRail: true,
              isLastInChain,
            });
          })}

          {hasHiddenDisclosure && (
            <div
              data-role="tool-chain-internal-disclosure"
              className="relative z-1 flex max-w-full items-stretch gap-2.5"
            >
              <ChainStepRail
                status="completed"
                isLast={!showInternalSteps}
                lineTailVisible={showInternalSteps}
              />
              <div className="min-w-0 flex-1 pb-1">
                <button
                  type="button"
                  onClick={() => {
                    markUserInteracted();
                    setShowInternalSteps((prev) => !prev);
                  }}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      "h-3 w-3 transition-transform",
                      showInternalSteps && "rotate-90",
                    )}
                  />
                  {showInternalSteps
                    ? t("tool_chain.internalSteps.hide", {
                        count: hiddenItems.length,
                      })
                    : t("tool_chain.internalSteps.show", {
                        count: hiddenItems.length,
                      })}
                </button>
              </div>
            </div>
          )}

          <InternalStepsTransition
            reduceMotion={prefersReducedMotion === true}
            show={showInternalSteps}
          >
            {hiddenItems.map((item, index) =>
              renderToolItem(item, {
                withRail: true,
                isLastInChain: index === hiddenItems.length - 1,
              }),
            )}
          </InternalStepsTransition>
        </div>
      )}
    </section>
  );
}
