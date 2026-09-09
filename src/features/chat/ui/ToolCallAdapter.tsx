import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, FolderOpen } from "lucide-react";
import { isViewableArtifact } from "@/features/chat/lib/artifactViewerTypes";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { CodeBlock } from "@/shared/ui/ai-elements/code-block";
import {
  Tool,
  ToolContent,
  ToolDetailsViewport,
  ToolHeader,
  ToolInput,
  ToolOutput,
  ToolSurface,
} from "@/shared/ui/ai-elements/tool";
import { toolStatusMap } from "../lib/toolStatusMap";
import {
  getToolInputSummaryRows,
  isHoistableText,
  isStringifiedCopyOfStructured,
  type ToolInputSummaryRow,
} from "@/features/chat/lib/toolCallPresentation";
import type { ToolCallLocation, ToolCallStatus } from "@/shared/types/messages";
import { useArtifactActionsContext } from "@/features/chat/hooks/ArtifactPolicyContext";
import { getSubagentToolCallInfo } from "@/features/chat/lib/subagentToolCalls";
import { AgentIdentityAvatar } from "./AgentIdentityAvatar";

interface ToolCallAdapterProps {
  className?: string;
  name: string;
  /** Real (wire-level) tool name from `_meta`, when the harness provides it. */
  toolName?: string;
  /** Named delegate source (custom agent) behind a subagent await/peek call. */
  subagentAgentName?: string;
  /** Plain-language task recovered from the spawning delegate. */
  subagentTaskLabel?: string;
  /** Whether the named source owns a configured task with no inline label. */
  subagentTaskIsConfigured?: boolean;
  arguments: Record<string, unknown>;
  status: ToolCallStatus;
  locations?: ToolCallLocation[];
  result?: string;
  structuredContent?: unknown;
  isError?: boolean;
  /** Epoch ms when the tool call started executing. */
  startedAt?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** When false, the chevron-side status badge is hidden (used inside chains). */
  showStatusBadge?: boolean;
  /** When false, hides the trailing disclosure chevron in the header. */
  showChevron?: boolean;
  /** When true, the card sizes to its content rather than filling its parent. */
  fitWidth?: boolean;
  titleClassName?: string;
  chevronClassName?: string;
  agentWorkLayout?: boolean;
}

function useElapsedTime(status: ToolCallStatus, startedAt?: number) {
  const [elapsed, setElapsed] = useState(0);
  const timerKey = `${status}:${startedAt ?? ""}`;
  const [previousTimerKey, setPreviousTimerKey] = useState(timerKey);
  if (previousTimerKey !== timerKey) {
    setPreviousTimerKey(timerKey);
    setElapsed(0);
  }

  useEffect(() => {
    if (status === "in_progress") {
      const origin = startedAt ?? Date.now();
      setElapsed(Math.floor((Date.now() - origin) / 1000));
      const interval = setInterval(() => {
        setElapsed(Math.floor((Date.now() - origin) / 1000));
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [status, startedAt]);

  return status === "in_progress" ? elapsed : 0;
}

function getLocationKind(path: string): "file" | "folder" | "path" {
  const normalized = path.trim();
  if (normalized.endsWith("/") || normalized.endsWith("\\")) return "folder";
  const name =
    normalized
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() ?? normalized;
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? "file" : "path";
}

function visibleLocations(locations: ToolCallLocation[] | undefined) {
  const seen = new Set<string>();
  return (locations ?? []).filter(
    (location): location is ToolCallLocation & { path: string } => {
      if (
        typeof location.path !== "string" ||
        location.path.trim().length === 0
      ) {
        return false;
      }
      const key = `${location.path}:${location.line ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  );
}

function ArtifactActions({ locations }: { locations?: ToolCallLocation[] }) {
  const { t } = useTranslation(["chat", "common"]);
  const [moreOutputsOpen, setMoreOutputsOpen] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const { openInApp } = useArtifactActionsContext();
  // Viewable files (markdown, images) are owned by the ArtifactChips row that
  // ToolChainCards anchors at the message level, so this per-card action list
  // only handles the rest: folders, code files, and other open-externally
  // targets. Rendering viewables here too would put two different-looking
  // controls for the same file on one expanded card.
  const artifactLocations = visibleLocations(locations).filter(
    (location) => !isViewableArtifact(location.path),
  );

  if (artifactLocations.length === 0) return null;

  const openLocation = async (location: ToolCallLocation) => {
    try {
      setOpenError(null);
      await openInApp(location.path);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    }
  };

  const primary = artifactLocations[0];
  const secondaryLocations = artifactLocations.slice(1);
  const kindLabel: Record<string, string> = {
    file: t("tools.openFile"),
    folder: t("tools.openFolder"),
    path: t("tools.openPath"),
  };

  const renderLocationButton = (
    location: ToolCallLocation & { path: string },
    className: string,
    iconClassName: string,
  ) => {
    const kind = getLocationKind(location.path);
    const label = kindLabel[kind] ?? t("common:actions.open");
    return (
      <Button
        type="button"
        variant="outline"
        onClick={() => void openLocation(location)}
        className={className}
        tooltip={location.path}
      >
        <FolderOpen className={iconClassName} />
        <span className="truncate">{label}</span>
        <span className="truncate text-[10px] text-muted-foreground">
          {location.path}
        </span>
      </Button>
    );
  };

  return (
    <div className="mt-1.5 ml-1 space-y-1.5">
      {renderLocationButton(
        primary,
        "h-auto max-w-full justify-start rounded-md border-accent/45 bg-background px-2.5 py-1 text-xs text-accent-foreground hover:bg-accent/55",
        "h-3.5 w-3.5 shrink-0",
      )}

      {secondaryLocations.length > 0 && (
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => setMoreOutputsOpen((prev) => !prev)}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ChevronRight
              className={cn(
                "h-3 w-3 transition-transform",
                moreOutputsOpen && "rotate-90",
              )}
            />
            {t("tools.moreOutputs", {
              count: secondaryLocations.length,
            })}
          </button>
          {moreOutputsOpen && (
            <div className="space-y-1.5 pl-4">
              {secondaryLocations.map((location) => (
                <div
                  key={`${location.path}:${location.line ?? ""}`}
                  className="space-y-0.5"
                >
                  {renderLocationButton(
                    location,
                    "h-auto max-w-full justify-start rounded-md border-border bg-background px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground",
                    "h-3 w-3 shrink-0",
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {openError && <p className="text-[11px] text-destructive">{openError}</p>}
    </div>
  );
}

const COMMAND_PREVIEW_CODEBLOCK_CLASSES =
  "rounded-none border-0 bg-transparent shadow-none [&>div]:overflow-hidden [&_pre]:m-0 [&_pre]:bg-transparent [&_pre]:p-0 [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:text-[12px] [&_pre]:leading-5 [&_code]:font-mono [&_code]:text-[12px] [&_code]:leading-5";

function InputSummary({
  rows,
  isOpen,
}: {
  rows: ToolInputSummaryRow[];
  isOpen: boolean;
}) {
  const { t } = useTranslation("chat");
  if (rows.length === 0) return null;

  return (
    <dl className="space-y-1.5">
      {rows.map((row) => {
        const label = t(`tools.inputSummary.${row.kind}`);
        const key = `${row.kind}:${row.value}`;
        if (row.renderAs === "bash") {
          return (
            <div key={key} className="space-y-0.5">
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {label}
              </dt>
              <dd>
                <CodeBlock
                  code={row.value}
                  language="bash"
                  data-tool-command-preview={!isOpen ? "" : undefined}
                  className={cn(
                    COMMAND_PREVIEW_CODEBLOCK_CLASSES,
                    !isOpen && "[&_pre]:line-clamp-3 [&_pre]:overflow-hidden",
                  )}
                />
              </dd>
            </div>
          );
        }
        return (
          <div key={key} className="flex items-baseline gap-2">
            <dt className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {label}
            </dt>
            <dd
              className={cn(
                "min-w-0 truncate text-[12px] text-foreground",
                row.monospace && "font-mono",
              )}
              title={row.title ?? row.value}
            >
              {row.value}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function formatToolValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function AgentWorkToolSection({
  label,
  value,
  destructive = false,
}: {
  label: string;
  value: string | null;
  destructive?: boolean;
}) {
  if (!value || value.trim().length === 0) return null;

  return (
    <section className="space-y-1.5">
      <div className="text-xs font-normal text-muted-foreground">{label}</div>
      <div
        className={cn(
          "rounded-sm bg-muted/30 px-3 py-2 text-muted-foreground",
          destructive && "text-destructive",
        )}
      >
        <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-current">
          {value}
        </pre>
      </div>
    </section>
  );
}

interface SubagentTitlePresentation {
  text: string;
  agentName?: string;
  beforeAgent?: string;
  afterAgent?: string;
}

const AGENT_NAME_MARKER = "\u{e000}";

function translatedAgentTitle(
  t: (key: string, options?: Record<string, unknown>) => string,
  key: string,
  agentName: string,
  options: Record<string, unknown> = {},
): SubagentTitlePresentation {
  const markedTitle = t(key, { ...options, name: AGENT_NAME_MARKER });
  const markerIndex = markedTitle.indexOf(AGENT_NAME_MARKER);
  if (markerIndex < 0) {
    return { text: t(key, { ...options, name: agentName }) };
  }
  const beforeAgent = markedTitle.slice(0, markerIndex);
  const afterAgent = markedTitle.slice(markerIndex + AGENT_NAME_MARKER.length);
  return {
    text: `${beforeAgent}${agentName}${afterAgent}`,
    agentName,
    beforeAgent,
    afterAgent,
  };
}

function subagentTitle(
  t: (key: string, options?: Record<string, unknown>) => string,
  info: NonNullable<ReturnType<typeof getSubagentToolCallInfo>>,
  resolvedAgentName?: string,
  resolvedTaskLabel?: string,
  resolvedTaskIsConfigured?: boolean,
): SubagentTitlePresentation {
  // Explicit key map keeps the i18n usage statically checkable.
  const keys = {
    delegating: [
      "tools.subagent.delegating",
      "tools.subagent.delegatingLabeled",
      "tools.subagent.delegatingAgent",
      "tools.subagent.delegatingAgentLabeled",
    ],
    messaging: [
      "tools.subagent.messaging",
      "tools.subagent.messagingLabeled",
      "tools.subagent.messagingAgent",
      "tools.subagent.messagingAgentLabeled",
    ],
    waiting: [
      "tools.subagent.waiting",
      "tools.subagent.waitingLabeled",
      "tools.subagent.waitingAgent",
      "tools.subagent.waitingAgentLabeled",
    ],
    checking: [
      "tools.subagent.checking",
      "tools.subagent.checkingLabeled",
      "tools.subagent.checkingAgent",
      "tools.subagent.checkingAgentLabeled",
    ],
    cancelling: [
      "tools.subagent.cancelling",
      "tools.subagent.cancellingLabeled",
      "tools.subagent.cancellingAgent",
      "tools.subagent.cancellingAgentLabeled",
    ],
    interrupting: [
      "tools.subagent.interrupting",
      "tools.subagent.interruptingLabeled",
      "tools.subagent.interruptingAgent",
      "tools.subagent.interruptingAgentLabeled",
    ],
  } as const;
  const [plain, labeled, agent, agentLabeled] = keys[info.activity];
  const configuredTaskKeys = {
    delegating: "tools.subagent.delegatingAgentConfiguredTask",
    messaging: "tools.subagent.messagingAgentConfiguredTask",
    waiting: "tools.subagent.waitingAgentConfiguredTask",
    checking: "tools.subagent.checkingAgentConfiguredTask",
    cancelling: "tools.subagent.cancellingAgentConfiguredTask",
    interrupting: "tools.subagent.interruptingAgentConfiguredTask",
  } as const;
  const taskLabeledKeys = {
    delegating: "tools.subagent.delegatingLabeled",
    messaging: "tools.subagent.messagingLabeled",
    waiting: "tools.subagent.waitingTaskLabeled",
    checking: "tools.subagent.checkingTaskLabeled",
    cancelling: "tools.subagent.cancellingTaskLabeled",
    interrupting: "tools.subagent.interruptingTaskLabeled",
  } as const;
  // Agent name comes from the call arguments (delegate source) or is
  // resolved from the transcript (load of a task spawned by a named
  // delegate). It replaces the word "subagent"; the task description is
  // kept alongside it: "Delegating to Rivet · Count markdown files…".
  const agentName = info.agentName ?? resolvedAgentName;
  const agentNames = info.agentNames;
  const taskLabel = info.label ?? resolvedTaskLabel;
  if (agentNames) {
    return {
      text: t("tools.subagent.waitingAgents", { names: agentNames.join(", ") }),
    };
  }
  if (agentName && (info.sourceDefinesTask || resolvedTaskIsConfigured)) {
    return translatedAgentTitle(
      t,
      configuredTaskKeys[info.activity],
      agentName,
    );
  }
  if (agentName && taskLabel) {
    return translatedAgentTitle(t, agentLabeled, agentName, {
      label: taskLabel,
    });
  }
  if (agentName) return translatedAgentTitle(t, agent, agentName);
  if (taskLabel) {
    return {
      text: info.taskId
        ? t(taskLabeledKeys[info.activity], { label: taskLabel })
        : t(labeled, { label: taskLabel }),
    };
  }
  // A task id is correlation identity, not a task description. When no
  // delegate context can be recovered, show only the known activity fact.
  return { text: t(plain) };
}

function sentenceCaseToolTitle(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return name;

  const shellTitle = trimmed.replace(
    /^shell(?=\s*(?:·|$))/i,
    "Running command",
  );
  const acronymTitle = shellTitle.replace(/^mcp(?=\s*(?::|·|$))/i, "MCP");
  return acronymTitle.charAt(0).toLocaleUpperCase() + acronymTitle.slice(1);
}

function splitHeaderTitleByPath(name: string, fileLabel: string) {
  const index = name.toLowerCase().lastIndexOf(fileLabel.toLowerCase());
  if (index === -1) return null;
  return {
    prefix: name.slice(0, index),
    fileLabel: name.slice(index, index + fileLabel.length),
    suffix: name.slice(index + fileLabel.length),
  };
}

export function ToolCallAdapter({
  className,
  name,
  toolName,
  subagentAgentName,
  subagentTaskLabel,
  subagentTaskIsConfigured,
  arguments: args,
  status,
  locations,
  result,
  structuredContent,
  isError,
  startedAt,
  open,
  onOpenChange,
  showStatusBadge = true,
  showChevron = true,
  fitWidth = false,
  titleClassName,
  chevronClassName,
  agentWorkLayout = false,
}: ToolCallAdapterProps) {
  const { t } = useTranslation("chat");
  const elapsed = useElapsedTime(status, startedAt);
  const state = toolStatusMap[status];
  const summaryRows = useMemo(
    () => getToolInputSummaryRows({ name, arguments: args }),
    [args, name],
  );
  const elapsedSeconds =
    status === "in_progress" && elapsed >= 3 ? elapsed : undefined;

  const { resolveMarkdownHref, openInApp } = useArtifactActionsContext();
  const subagentInfo = useMemo(
    () => getSubagentToolCallInfo({ toolName, arguments: args }),
    [toolName, args],
  );
  const subagentTitlePresentation = subagentInfo
    ? subagentTitle(
        t,
        subagentInfo,
        subagentAgentName,
        subagentTaskLabel,
        subagentTaskIsConfigured,
      )
    : undefined;
  const displayName =
    subagentTitlePresentation?.text ?? sentenceCaseToolTitle(name);

  const pathRow = summaryRows.find((row) => row.kind === "path");
  const headerFileLabel = pathRow?.value;
  const headerFilePath = pathRow?.title ?? pathRow?.value;
  const headerTitleParts =
    headerFileLabel && headerFilePath
      ? splitHeaderTitleByPath(displayName, headerFileLabel)
      : null;
  const headerFileCandidate = useMemo(
    () => (headerFilePath ? resolveMarkdownHref(headerFilePath) : null),
    [headerFilePath, resolveMarkdownHref],
  );
  const canOpenHeaderFile = Boolean(headerTitleParts && headerFileCandidate);

  const hasStructuredArgs = Object.keys(args).length > 0;
  const hasOutput = Boolean(result);
  const hasStructuredContent = !isError && structuredContent !== undefined;

  // De-dupe + title-hoisting matrix: when both a text result and structured
  // content are present, decide whether the text is a redundant stringified
  // copy of the structured payload (hide), short enough to hoist into the
  // header subtitle (lift), or worth rendering in the body alongside the
  // structured block (keep).
  const textIsStringifiedCopy =
    hasOutput &&
    hasStructuredContent &&
    isStringifiedCopyOfStructured(result, structuredContent);
  const canHoistResultIntoHeader =
    hasOutput &&
    hasStructuredContent &&
    !textIsStringifiedCopy &&
    !headerTitleParts &&
    isHoistableText(result);
  const showResultBody =
    hasOutput && !textIsStringifiedCopy && !canHoistResultIntoHeader;

  const subagentHeaderTitle: ReactNode =
    subagentTitlePresentation?.agentName ? (
      <span className="inline-flex min-w-0 max-w-full items-center">
        <span>{subagentTitlePresentation.beforeAgent}</span>
        <AgentIdentityAvatar
          agentName={subagentTitlePresentation.agentName}
          className="ml-1.5 mr-0.5"
        />
        <span className="min-w-0 truncate">
          {subagentTitlePresentation.agentName}
          {subagentTitlePresentation.afterAgent}
        </span>
      </span>
    ) : (
      displayName
    );
  const headerTitle: ReactNode = headerTitleParts ? (
    <>
      <span data-tool-title-prefix>{headerTitleParts.prefix}</span>
      {canOpenHeaderFile ? (
        <button
          type="button"
          data-clickable-file
          onClick={(event) => {
            event.stopPropagation();
            if (!headerFileCandidate) return;
            void openInApp(headerFileCandidate.resolvedPath).catch(() => {});
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
          }}
          title={headerFileCandidate?.resolvedPath ?? headerFilePath}
          aria-label={t("tools.openNamed", {
            name: headerTitleParts.fileLabel,
          })}
          className="inline truncate text-muted-foreground underline-offset-2 hover:underline"
        >
          {headerTitleParts.fileLabel}
        </button>
      ) : (
        <span>{headerTitleParts.fileLabel}</span>
      )}
      <span>{headerTitleParts.suffix}</span>
    </>
  ) : canHoistResultIntoHeader ? (
    <>
      {subagentHeaderTitle}
      <span aria-hidden="true" className="text-muted-foreground">
        {" · "}
      </span>
      <span data-tool-title-hoisted className="truncate text-muted-foreground">
        {(result ?? "").trim()}
      </span>
    </>
  ) : (
    subagentHeaderTitle
  );

  const showCombinedSurface = summaryRows.length > 0 || hasStructuredArgs;
  const commandRow = summaryRows.find((row) => row.renderAs === "bash");
  const nonCommandRows = summaryRows.filter((row) => row !== commandRow);
  const inputDetails =
    nonCommandRows.length > 0
      ? nonCommandRows
          .map((row) => {
            const label = t(`tools.inputSummary.${row.kind}`);
            return `${label}: ${row.title ?? row.value}`;
          })
          .join("\n")
      : null;
  const rawInputDetails =
    hasStructuredArgs && !commandRow ? formatToolValue(args) : null;
  const resultDetails = isError
    ? formatToolValue(result)
    : showResultBody
      ? formatToolValue(result)
      : null;
  const structuredDetails = hasStructuredContent
    ? formatToolValue(structuredContent)
    : null;
  return (
    <div className={cn("w-full min-w-0 max-w-full", className)}>
      <Tool open={open} onOpenChange={onOpenChange}>
        <ToolHeader
          type="dynamic-tool"
          toolName={name}
          title={headerTitle}
          state={state}
          showIcon={false}
          showStatusBadge={showStatusBadge}
          showChevron={showChevron}
          titleClassName={cn("text-muted-foreground", titleClassName)}
          chevronClassName={chevronClassName}
          splitTrigger={canOpenHeaderFile}
          layout={fitWidth ? "fit" : "fill"}
          elapsedSeconds={elapsedSeconds}
        />
        <ToolContent
          data-role="tool-call-content"
          className="text-muted-foreground [&_button]:text-muted-foreground [&_code]:text-muted-foreground [&_dd]:text-muted-foreground [&_dt]:text-muted-foreground [&_span]:text-muted-foreground"
        >
          {agentWorkLayout ? (
            <ToolDetailsViewport
              data-role="agent-work-tool-details"
              aria-label={t("tools.details")}
              className="max-h-48 space-y-3 overflow-y-auto overscroll-contain py-1"
            >
              <AgentWorkToolSection
                label={t("tools.inputSummary.command")}
                value={commandRow?.value ?? null}
              />
              <AgentWorkToolSection
                label={t("tools.input")}
                value={inputDetails ?? rawInputDetails}
              />
              <AgentWorkToolSection
                label={isError ? t("tools.error") : t("tools.result")}
                value={resultDetails}
                destructive={isError}
              />
              <AgentWorkToolSection
                label={t("tools.structuredContent")}
                value={structuredDetails}
              />
            </ToolDetailsViewport>
          ) : showCombinedSurface ? (
            <ToolSurface tone="muted" className="bg-muted">
              <ToolInput
                input={args}
                showLabel={false}
                embedded
                className="[&_pre]:text-muted-foreground"
                summary={({ isOpen }) => (
                  <InputSummary rows={summaryRows} isOpen={isOpen} />
                )}
              />
              {showResultBody && (
                <ToolOutput
                  output={isError ? undefined : result}
                  errorText={isError ? result : undefined}
                  showLabel={false}
                  embedded
                  embeddedMaxHeightClass="max-h-32"
                />
              )}
              {hasStructuredContent && (
                <ToolOutput
                  output={structuredContent}
                  errorText={undefined}
                  showLabel={false}
                  embedded
                  embeddedMaxHeightClass="max-h-32"
                />
              )}
            </ToolSurface>
          ) : (
            <>
              {showResultBody && (
                <ToolOutput
                  output={isError ? undefined : result}
                  errorText={isError ? result : undefined}
                  contentClassName="max-h-[28rem] overflow-y-auto"
                />
              )}
              {hasStructuredContent && (
                <ToolOutput
                  output={structuredContent}
                  errorText={undefined}
                  label={t("tools.structuredContent")}
                  contentClassName="max-h-[28rem] overflow-y-auto"
                />
              )}
            </>
          )}
        </ToolContent>
      </Tool>
      <ArtifactActions locations={locations} />
    </div>
  );
}
