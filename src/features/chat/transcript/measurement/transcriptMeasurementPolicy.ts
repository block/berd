import type {
  Message,
  MessageContent,
  ToolCallStatus,
} from "@/shared/types/messages";

export type TranscriptMeasurementPolicy =
  | "measure-real"
  | "measure-shell"
  | "estimate-only";

export type TranscriptLayoutPendingPolicy =
  | "can-finalize"
  | "requires-stable-descendants";

export type TranscriptRowKind =
  | "date-separator"
  | "message"
  | "assistant-message-chrome"
  | "assistant-content-fragment"
  | "assistant-message-actions"
  | "agent-work"
  | "top-loading-sentinel";

export type TranscriptKeepAlivePriority =
  | "none"
  | "focused"
  | "selection"
  | "open-ui"
  | "active-mcp"
  | "active-stream"
  | "recent";

export type TranscriptMeasurementSafetyReason =
  | "active-copy-feedback"
  | "active-mcp-host-work"
  | "active-nested-tool-request"
  | "active-selection"
  | "active-stream"
  | "active-timer"
  | "active-tool"
  | "action-required"
  | "async-code-highlighting"
  | "audited-real-measurement"
  | "date-separator"
  | "dynamic-async-layout"
  | "focused-row"
  | "host-calls"
  | "host-action-handlers"
  | "image-content"
  | "layout-animation"
  | "layout-pending"
  | "mcp-app"
  | "open-overlay"
  | "reasoning-or-thinking"
  | "side-effect-free-fragment"
  | "static-system-notice"
  | "stateful-row"
  | "text-row-requires-audit"
  | "tool-content"
  | "unknown-unsafe-descendant";

export interface TranscriptRowSafetyCapabilities {
  stateful: boolean;
  hasMcpApp: boolean;
  hasHostCalls: boolean;
  hasHostActionHandlers: boolean;
  hasActiveTimer: boolean;
  hasActiveToolWork: boolean;
  hasActiveMcpHostRequest: boolean;
  hasActiveNestedToolRequest: boolean;
  hasDynamicAsyncLayout: boolean;
  hasPendingLayout: boolean;
  hasFocusedDescendant: boolean;
  hasOpenOverlay: boolean;
  hasOpenMenu: boolean;
  hasOpenDialog: boolean;
  hasOpenPopover: boolean;
  hasOpenLightbox: boolean;
  hasCopyFeedback: boolean;
  hasImageContent: boolean;
  hasToolContent: boolean;
  hasReasoningContent: boolean;
  hasActionRequired: boolean;
  hasStreamingContent: boolean;
  hasUnknownUnsafeDescendants: boolean;
  protectsSelection: boolean;
  canOffscreenRenderReal: boolean;
  canOffscreenRenderShell: boolean;
}

export type TranscriptRowSafetyCapabilityOverride = Partial<
  Omit<
    TranscriptRowSafetyCapabilities,
    "canOffscreenRenderReal" | "canOffscreenRenderShell"
  >
>;

export interface TranscriptRowUiSafetyState {
  hasFocusedDescendant?: boolean;
  protectsSelection?: boolean;
  hasOpenOverlay?: boolean;
  hasOpenMenu?: boolean;
  hasOpenDialog?: boolean;
  hasOpenPopover?: boolean;
  hasOpenLightbox?: boolean;
  hasCopyFeedback?: boolean;
  hasActiveMcpHostRequest?: boolean;
  hasActiveNestedToolRequest?: boolean;
  hasActiveTimer?: boolean;
  hasActiveToolWork?: boolean;
  hasPendingLayout?: boolean;
  hasLayoutAnimation?: boolean;
  hasDynamicAsyncLayout?: boolean;
  hasAsyncCodeHighlighting?: boolean;
  hasRecentlyMcpResized?: boolean;
  hasRecentlyMcpMessaged?: boolean;
  hasUnknownUnsafeDescendants?: boolean;
}

export interface TranscriptMeasurementPolicyOptions {
  allowAuditedWholeTextRealMeasurement?: boolean;
  allowCompletedFragmentRealMeasurement?: boolean;
  hasSideEffectFreeShell?: boolean;
}

export interface TranscriptMeasurementPolicyInput {
  rowKind: TranscriptRowKind;
  message?: Message;
  content?: readonly MessageContent[];
  uiState?: TranscriptRowUiSafetyState;
  capabilities?: TranscriptRowSafetyCapabilityOverride;
  options?: TranscriptMeasurementPolicyOptions;
}

export interface TranscriptMeasurementPolicyDecision {
  policy: TranscriptMeasurementPolicy;
  layoutPendingPolicy: TranscriptLayoutPendingPolicy;
  keepAlivePriority: TranscriptKeepAlivePriority;
  capabilities: TranscriptRowSafetyCapabilities;
  reasons: readonly TranscriptMeasurementSafetyReason[];
}

const TERMINAL_TOOL_STATUSES = new Set<ToolCallStatus>([
  "completed",
  "failed",
  "stopped",
]);

const HARD_ESTIMATE_REASONS: readonly TranscriptMeasurementSafetyReason[] = [
  "focused-row",
  "active-selection",
  "open-overlay",
  "active-mcp-host-work",
  "active-nested-tool-request",
  "active-tool",
  "active-timer",
  "active-copy-feedback",
  "unknown-unsafe-descendant",
];

function createEmptyCapabilities(): TranscriptRowSafetyCapabilities {
  return {
    stateful: false,
    hasMcpApp: false,
    hasHostCalls: false,
    hasHostActionHandlers: false,
    hasActiveTimer: false,
    hasActiveToolWork: false,
    hasActiveMcpHostRequest: false,
    hasActiveNestedToolRequest: false,
    hasDynamicAsyncLayout: false,
    hasPendingLayout: false,
    hasFocusedDescendant: false,
    hasOpenOverlay: false,
    hasOpenMenu: false,
    hasOpenDialog: false,
    hasOpenPopover: false,
    hasOpenLightbox: false,
    hasCopyFeedback: false,
    hasImageContent: false,
    hasToolContent: false,
    hasReasoningContent: false,
    hasActionRequired: false,
    hasStreamingContent: false,
    hasUnknownUnsafeDescendants: false,
    protectsSelection: false,
    canOffscreenRenderReal: false,
    canOffscreenRenderShell: false,
  };
}

function addReason(
  reasons: Set<TranscriptMeasurementSafetyReason>,
  reason: TranscriptMeasurementSafetyReason,
): void {
  reasons.add(reason);
}

function isActiveToolStatus(status: ToolCallStatus): boolean {
  return !TERMINAL_TOOL_STATUSES.has(status);
}

function hasOnlyTextContent(content: readonly MessageContent[]): boolean {
  return content.length > 0 && content.every((block) => block.type === "text");
}

function hasOnlySystemNotificationContent(
  content: readonly MessageContent[],
): boolean {
  return (
    content.length > 0 &&
    content.every((block) => block.type === "systemNotification")
  );
}

function isMessage(
  value: Message | readonly MessageContent[],
): value is Message {
  return !Array.isArray(value);
}

function applyContentSafety(
  capabilities: TranscriptRowSafetyCapabilities,
  reasons: Set<TranscriptMeasurementSafetyReason>,
  message: Message | undefined,
  content: readonly MessageContent[],
): void {
  const completionStatus = message?.metadata?.completionStatus;
  if (completionStatus === "inProgress") {
    capabilities.hasStreamingContent = true;
    capabilities.hasDynamicAsyncLayout = true;
    addReason(reasons, "active-stream");
    addReason(reasons, "dynamic-async-layout");
  }

  if (message?.metadata?.attachments?.length) {
    capabilities.stateful = true;
    capabilities.hasHostActionHandlers = true;
    addReason(reasons, "stateful-row");
    addReason(reasons, "host-action-handlers");
  }

  for (const block of content) {
    switch (block.type) {
      case "text":
      case "systemNotification":
        break;
      case "image":
        capabilities.stateful = true;
        capabilities.hasImageContent = true;
        capabilities.hasDynamicAsyncLayout = true;
        addReason(reasons, "stateful-row");
        addReason(reasons, "image-content");
        addReason(reasons, "dynamic-async-layout");
        break;
      case "toolRequest":
        capabilities.stateful = true;
        capabilities.hasToolContent = true;
        capabilities.hasDynamicAsyncLayout = true;
        addReason(reasons, "stateful-row");
        addReason(reasons, "tool-content");
        addReason(reasons, "dynamic-async-layout");
        if (isActiveToolStatus(block.status)) {
          capabilities.hasActiveToolWork = true;
          addReason(reasons, "active-tool");
          if (block.startedAt !== undefined) {
            capabilities.hasActiveTimer = true;
            addReason(reasons, "active-timer");
          }
        }
        break;
      case "toolResponse":
        capabilities.stateful = true;
        capabilities.hasToolContent = true;
        addReason(reasons, "stateful-row");
        addReason(reasons, "tool-content");
        break;
      case "mcpApp":
        capabilities.stateful = true;
        capabilities.hasMcpApp = true;
        capabilities.hasHostCalls = true;
        capabilities.hasDynamicAsyncLayout = true;
        addReason(reasons, "stateful-row");
        addReason(reasons, "mcp-app");
        addReason(reasons, "host-calls");
        addReason(reasons, "dynamic-async-layout");
        break;
      case "thinking":
      case "redactedThinking":
      case "reasoning":
        capabilities.stateful = true;
        capabilities.hasReasoningContent = true;
        capabilities.hasDynamicAsyncLayout = true;
        addReason(reasons, "stateful-row");
        addReason(reasons, "reasoning-or-thinking");
        addReason(reasons, "dynamic-async-layout");
        break;
      case "actionRequired":
        capabilities.stateful = true;
        capabilities.hasActionRequired = true;
        capabilities.hasDynamicAsyncLayout = true;
        addReason(reasons, "stateful-row");
        addReason(reasons, "action-required");
        addReason(reasons, "dynamic-async-layout");
        break;
      default:
        block satisfies never;
    }
  }
}

function applyUiSafetyState(
  capabilities: TranscriptRowSafetyCapabilities,
  reasons: Set<TranscriptMeasurementSafetyReason>,
  uiState: TranscriptRowUiSafetyState | undefined,
): void {
  if (!uiState) {
    return;
  }

  if (uiState.hasFocusedDescendant) {
    capabilities.hasFocusedDescendant = true;
    addReason(reasons, "focused-row");
  }

  if (uiState.protectsSelection) {
    capabilities.protectsSelection = true;
    addReason(reasons, "active-selection");
  }

  const hasOpenOverlay = Boolean(
    uiState.hasOpenOverlay ||
      uiState.hasOpenMenu ||
      uiState.hasOpenDialog ||
      uiState.hasOpenPopover ||
      uiState.hasOpenLightbox,
  );
  if (hasOpenOverlay) {
    capabilities.hasOpenOverlay = true;
    addReason(reasons, "open-overlay");
  }

  if (uiState.hasOpenMenu) capabilities.hasOpenMenu = true;
  if (uiState.hasOpenDialog) capabilities.hasOpenDialog = true;
  if (uiState.hasOpenPopover) capabilities.hasOpenPopover = true;
  if (uiState.hasOpenLightbox) capabilities.hasOpenLightbox = true;

  if (uiState.hasCopyFeedback) {
    capabilities.hasCopyFeedback = true;
    addReason(reasons, "active-copy-feedback");
  }

  if (uiState.hasActiveMcpHostRequest) {
    capabilities.hasActiveMcpHostRequest = true;
    addReason(reasons, "active-mcp-host-work");
  }

  if (uiState.hasActiveNestedToolRequest) {
    capabilities.hasActiveNestedToolRequest = true;
    addReason(reasons, "active-nested-tool-request");
  }

  if (uiState.hasActiveToolWork) {
    capabilities.hasActiveToolWork = true;
    addReason(reasons, "active-tool");
  }

  if (uiState.hasActiveTimer) {
    capabilities.hasActiveTimer = true;
    addReason(reasons, "active-timer");
  }

  if (uiState.hasPendingLayout) {
    capabilities.hasPendingLayout = true;
    addReason(reasons, "layout-pending");
  }

  if (uiState.hasLayoutAnimation) {
    capabilities.hasDynamicAsyncLayout = true;
    addReason(reasons, "layout-animation");
  }

  if (uiState.hasDynamicAsyncLayout) {
    capabilities.hasDynamicAsyncLayout = true;
    addReason(reasons, "dynamic-async-layout");
  }

  if (uiState.hasAsyncCodeHighlighting) {
    capabilities.hasDynamicAsyncLayout = true;
    addReason(reasons, "async-code-highlighting");
  }

  if (uiState.hasUnknownUnsafeDescendants) {
    capabilities.hasUnknownUnsafeDescendants = true;
    addReason(reasons, "unknown-unsafe-descendant");
  }
}

function applyCapabilityOverrides(
  capabilities: TranscriptRowSafetyCapabilities,
  reasons: Set<TranscriptMeasurementSafetyReason>,
  overrides: TranscriptRowSafetyCapabilityOverride | undefined,
): void {
  if (!overrides) {
    return;
  }

  for (const key of Object.keys(overrides) as Array<keyof typeof overrides>) {
    if (overrides[key]) {
      capabilities[key] = true;
    }
  }

  if (overrides.stateful) addReason(reasons, "stateful-row");
  if (overrides.hasMcpApp) addReason(reasons, "mcp-app");
  if (overrides.hasHostCalls) addReason(reasons, "host-calls");
  if (overrides.hasHostActionHandlers)
    addReason(reasons, "host-action-handlers");
  if (overrides.hasActiveTimer) addReason(reasons, "active-timer");
  if (overrides.hasActiveToolWork) addReason(reasons, "active-tool");
  if (overrides.hasActiveMcpHostRequest)
    addReason(reasons, "active-mcp-host-work");
  if (overrides.hasActiveNestedToolRequest)
    addReason(reasons, "active-nested-tool-request");
  if (overrides.hasDynamicAsyncLayout)
    addReason(reasons, "dynamic-async-layout");
  if (overrides.hasPendingLayout) addReason(reasons, "layout-pending");
  if (overrides.hasFocusedDescendant) addReason(reasons, "focused-row");
  if (
    overrides.hasOpenOverlay ||
    overrides.hasOpenMenu ||
    overrides.hasOpenDialog ||
    overrides.hasOpenPopover ||
    overrides.hasOpenLightbox
  ) {
    addReason(reasons, "open-overlay");
  }
  if (overrides.hasCopyFeedback) addReason(reasons, "active-copy-feedback");
  if (overrides.hasImageContent) addReason(reasons, "image-content");
  if (overrides.hasToolContent) addReason(reasons, "tool-content");
  if (overrides.hasReasoningContent)
    addReason(reasons, "reasoning-or-thinking");
  if (overrides.hasActionRequired) addReason(reasons, "action-required");
  if (overrides.hasStreamingContent) addReason(reasons, "active-stream");
  if (overrides.hasUnknownUnsafeDescendants)
    addReason(reasons, "unknown-unsafe-descendant");
  if (overrides.protectsSelection) addReason(reasons, "active-selection");
}

function getKeepAlivePriority(
  capabilities: TranscriptRowSafetyCapabilities,
  uiState: TranscriptRowUiSafetyState | undefined,
): TranscriptKeepAlivePriority {
  if (capabilities.hasFocusedDescendant) return "focused";
  if (capabilities.protectsSelection) return "selection";
  if (
    capabilities.hasOpenOverlay ||
    capabilities.hasOpenMenu ||
    capabilities.hasOpenDialog ||
    capabilities.hasOpenPopover ||
    capabilities.hasOpenLightbox ||
    capabilities.hasCopyFeedback
  ) {
    return "open-ui";
  }
  if (
    capabilities.hasActiveMcpHostRequest ||
    capabilities.hasActiveNestedToolRequest
  ) {
    return "active-mcp";
  }
  if (capabilities.hasActiveToolWork || capabilities.hasStreamingContent) {
    return "active-stream";
  }
  if (uiState?.hasRecentlyMcpResized || uiState?.hasRecentlyMcpMessaged) {
    return "recent";
  }
  return "none";
}

function requiresShellMeasurement(
  rowKind: TranscriptRowKind,
  content: readonly MessageContent[],
  capabilities: TranscriptRowSafetyCapabilities,
): boolean {
  if (
    capabilities.stateful ||
    capabilities.hasMcpApp ||
    capabilities.hasHostCalls ||
    capabilities.hasHostActionHandlers ||
    capabilities.hasToolContent ||
    capabilities.hasImageContent ||
    capabilities.hasReasoningContent ||
    capabilities.hasActionRequired ||
    capabilities.hasDynamicAsyncLayout ||
    capabilities.hasPendingLayout
  ) {
    return true;
  }

  return rowKind === "message" && hasOnlyTextContent(content);
}

function canMeasureReal(
  rowKind: TranscriptRowKind,
  message: Message | undefined,
  content: readonly MessageContent[],
  capabilities: TranscriptRowSafetyCapabilities,
  options: TranscriptMeasurementPolicyOptions | undefined,
  reasons: Set<TranscriptMeasurementSafetyReason>,
): boolean {
  if (rowKind === "date-separator" || rowKind === "top-loading-sentinel") {
    addReason(reasons, "date-separator");
    return true;
  }

  if (
    message?.role === "system" &&
    hasOnlySystemNotificationContent(content) &&
    !capabilities.hasDynamicAsyncLayout
  ) {
    addReason(reasons, "static-system-notice");
    return true;
  }

  if (
    rowKind === "assistant-content-fragment" &&
    options?.allowCompletedFragmentRealMeasurement !== false &&
    !requiresShellMeasurement(rowKind, content, capabilities)
  ) {
    addReason(reasons, "side-effect-free-fragment");
    return true;
  }

  if (
    options?.allowAuditedWholeTextRealMeasurement &&
    hasOnlyTextContent(content) &&
    !requiresShellMeasurement(rowKind, content, capabilities)
  ) {
    addReason(reasons, "audited-real-measurement");
    return true;
  }

  if (rowKind === "message" && hasOnlyTextContent(content)) {
    addReason(reasons, "text-row-requires-audit");
  }

  return false;
}

export function classifyMessageContentSafety(
  messageOrContent: Message | readonly MessageContent[],
  uiState?: TranscriptRowUiSafetyState,
  overrides?: TranscriptRowSafetyCapabilityOverride,
): Pick<
  TranscriptMeasurementPolicyDecision,
  "capabilities" | "layoutPendingPolicy" | "keepAlivePriority" | "reasons"
> {
  const message = isMessage(messageOrContent) ? messageOrContent : undefined;
  const content = isMessage(messageOrContent)
    ? messageOrContent.content
    : messageOrContent;
  const capabilities = createEmptyCapabilities();
  const reasons = new Set<TranscriptMeasurementSafetyReason>();

  applyContentSafety(capabilities, reasons, message, content);
  applyUiSafetyState(capabilities, reasons, uiState);
  applyCapabilityOverrides(capabilities, reasons, overrides);

  const layoutPendingPolicy =
    capabilities.hasPendingLayout || capabilities.hasDynamicAsyncLayout
      ? "requires-stable-descendants"
      : "can-finalize";

  return {
    capabilities,
    layoutPendingPolicy,
    keepAlivePriority: getKeepAlivePriority(capabilities, uiState),
    reasons: [...reasons],
  };
}

export function classifyTranscriptMeasurementPolicy(
  input: TranscriptMeasurementPolicyInput,
): TranscriptMeasurementPolicyDecision {
  const message = input.message;
  const content = input.content ?? message?.content ?? [];
  const capabilities = createEmptyCapabilities();
  const reasons = new Set<TranscriptMeasurementSafetyReason>();

  applyContentSafety(capabilities, reasons, message, content);
  applyUiSafetyState(capabilities, reasons, input.uiState);
  applyCapabilityOverrides(capabilities, reasons, input.capabilities);

  const layoutPendingPolicy =
    capabilities.hasPendingLayout || capabilities.hasDynamicAsyncLayout
      ? "requires-stable-descendants"
      : "can-finalize";
  const keepAlivePriority = getKeepAlivePriority(capabilities, input.uiState);
  const hasHardEstimateReason = HARD_ESTIMATE_REASONS.some((reason) =>
    reasons.has(reason),
  );
  const hasSideEffectFreeShell = input.options?.hasSideEffectFreeShell ?? true;

  let policy: TranscriptMeasurementPolicy;
  if (hasHardEstimateReason) {
    policy = "estimate-only";
  } else if (
    canMeasureReal(
      input.rowKind,
      message,
      content,
      capabilities,
      input.options,
      reasons,
    )
  ) {
    policy = "measure-real";
  } else if (
    hasSideEffectFreeShell &&
    requiresShellMeasurement(input.rowKind, content, capabilities)
  ) {
    policy = "measure-shell";
  } else {
    policy = "estimate-only";
  }

  capabilities.canOffscreenRenderReal = policy === "measure-real";
  capabilities.canOffscreenRenderShell = policy === "measure-shell";

  return {
    policy,
    layoutPendingPolicy,
    keepAlivePriority,
    capabilities,
    reasons: [...reasons],
  };
}
