import type { Message, MessageContent } from "@/shared/types/messages";
import {
  createVirtualReservedBlockSizeAttributes,
  type VirtualLayoutPendingReason,
} from "./transcriptLayoutPending";
import {
  classifyTranscriptMeasurementPolicy,
  type TranscriptMeasurementPolicyDecision,
  type TranscriptMeasurementPolicyInput,
  type TranscriptMeasurementSafetyReason,
  type TranscriptRowKind,
} from "./transcriptMeasurementPolicy";

export const VIRTUAL_ROW_MEASUREMENT_SHELL_ATTRIBUTE =
  "data-virtual-row-measurement-shell";
export const VIRTUAL_ROW_SHELL_KIND_ATTRIBUTE = "data-virtual-row-shell-kind";
export const VIRTUAL_ROW_SHELL_BLOCK_ATTRIBUTE = "data-virtual-row-shell-block";
export const VIRTUAL_ROW_SHELL_BLOCK_KIND_ATTRIBUTE =
  "data-virtual-row-shell-block-kind";

export type TranscriptShellMeasurementStatus =
  | "ready"
  | "not-eligible"
  | "blocked";

export type TranscriptShellBlockKind =
  | "action-required"
  | "attachment-strip"
  | "chip-strip"
  | "image"
  | "mcp-app"
  | "reasoning"
  | "system-notice"
  | "text"
  | "tool"
  | "unknown";

export interface TranscriptShellMeasurementBlock {
  key: string;
  kind: TranscriptShellBlockKind;
  estimatedBlockSize: number;
  reservedBlockSize?: number;
  pendingReason?: VirtualLayoutPendingReason;
}

export interface TranscriptShellMeasurementPlan {
  status: TranscriptShellMeasurementStatus;
  rowKind: TranscriptRowKind;
  policyDecision: TranscriptMeasurementPolicyDecision;
  estimatedBlockSize: number;
  reservedBlockSize: number | null;
  blocks: readonly TranscriptShellMeasurementBlock[];
  reasons: readonly TranscriptMeasurementSafetyReason[];
}

export interface TranscriptShellMeasurementInput
  extends TranscriptMeasurementPolicyInput {
  policyDecision?: TranscriptMeasurementPolicyDecision;
  estimatedBlockSize?: number;
}

export interface TranscriptShellRootAttributes {
  [VIRTUAL_ROW_MEASUREMENT_SHELL_ATTRIBUTE]: "true";
  [VIRTUAL_ROW_SHELL_KIND_ATTRIBUTE]: TranscriptRowKind;
  [key: string]: string;
}

export interface TranscriptShellBlockAttributes {
  [VIRTUAL_ROW_SHELL_BLOCK_ATTRIBUTE]: "true";
  [VIRTUAL_ROW_SHELL_BLOCK_KIND_ATTRIBUTE]: TranscriptShellBlockKind;
  [key: string]: string;
}

const MIN_SHELL_BLOCK_SIZE = 1;
const DEFAULT_MESSAGE_CHROME_SIZE = 76;
const ASSISTANT_MESSAGE_CHROME_SIZE = 96;
const STATIC_ROW_SIZE = 36;
const IMAGE_RESERVED_BLOCK_SIZE = 220;
const MCP_APP_RESERVED_BLOCK_SIZE = 260;
const TOOL_REQUEST_BLOCK_SIZE = 92;
const TOOL_RESPONSE_BASE_BLOCK_SIZE = 72;
const REASONING_BASE_BLOCK_SIZE = 72;
const REDACTED_REASONING_BLOCK_SIZE = 48;
const ACTION_REQUIRED_BLOCK_SIZE = 104;
const ATTACHMENT_STRIP_BLOCK_SIZE = 32;
const CHIP_STRIP_BLOCK_SIZE = 28;
const SYSTEM_NOTICE_BASE_BLOCK_SIZE = 40;
const TEXT_LINE_SIZE = 22;
const TEXT_WRAP_COLUMNS = 96;

function normalizeBlockSize(value: number): number {
  return Math.max(MIN_SHELL_BLOCK_SIZE, Math.ceil(value));
}

function estimateTextBlockSize(text: string): number {
  const hardLines = Math.max(1, text.split(/\r\n|\r|\n/).length);
  const softLines = Math.max(1, Math.ceil(text.length / TEXT_WRAP_COLUMNS));
  return normalizeBlockSize(Math.max(hardLines, softLines) * TEXT_LINE_SIZE);
}

function getMessageChromeSize(message: Message | undefined): number {
  if (!message) {
    return DEFAULT_MESSAGE_CHROME_SIZE;
  }
  return message.role === "assistant"
    ? ASSISTANT_MESSAGE_CHROME_SIZE
    : DEFAULT_MESSAGE_CHROME_SIZE;
}

function getContentBlockKey(block: MessageContent, index: number): string {
  if ("id" in block && typeof block.id === "string") {
    return `${block.type}:${block.id}`;
  }
  return `${block.type}:${index}`;
}

function createContentShellBlock(
  block: MessageContent,
  index: number,
): TranscriptShellMeasurementBlock {
  const key = getContentBlockKey(block, index);

  switch (block.type) {
    case "text":
      return {
        key,
        kind: "text",
        estimatedBlockSize: estimateTextBlockSize(block.text),
      };
    case "systemNotification":
      return {
        key,
        kind: "system-notice",
        estimatedBlockSize:
          SYSTEM_NOTICE_BASE_BLOCK_SIZE + estimateTextBlockSize(block.text),
      };
    case "image":
      return {
        key,
        kind: "image",
        estimatedBlockSize: IMAGE_RESERVED_BLOCK_SIZE,
        reservedBlockSize: IMAGE_RESERVED_BLOCK_SIZE,
        pendingReason: "image-loading",
      };
    case "toolRequest":
      return {
        key,
        kind: "tool",
        estimatedBlockSize: TOOL_REQUEST_BLOCK_SIZE,
      };
    case "toolResponse":
      return {
        key,
        kind: "tool",
        estimatedBlockSize:
          TOOL_RESPONSE_BASE_BLOCK_SIZE + estimateTextBlockSize(block.result),
      };
    case "mcpApp":
      return {
        key,
        kind: "mcp-app",
        estimatedBlockSize: MCP_APP_RESERVED_BLOCK_SIZE,
        reservedBlockSize: MCP_APP_RESERVED_BLOCK_SIZE,
        pendingReason: "mcp-iframe-sizing",
      };
    case "thinking":
    case "reasoning":
      return {
        key,
        kind: "reasoning",
        estimatedBlockSize:
          REASONING_BASE_BLOCK_SIZE + estimateTextBlockSize(block.text),
        pendingReason: "reasoning-animation",
      };
    case "redactedThinking":
      return {
        key,
        kind: "reasoning",
        estimatedBlockSize: REDACTED_REASONING_BLOCK_SIZE,
      };
    case "actionRequired":
      return {
        key,
        kind: "action-required",
        estimatedBlockSize: ACTION_REQUIRED_BLOCK_SIZE,
      };
    default:
      block satisfies never;
      return {
        key,
        kind: "unknown",
        estimatedBlockSize: DEFAULT_MESSAGE_CHROME_SIZE,
      };
  }
}

function createMetadataShellBlocks(
  message: Message | undefined,
): TranscriptShellMeasurementBlock[] {
  const blocks: TranscriptShellMeasurementBlock[] = [];

  if (message?.metadata?.attachments?.length) {
    blocks.push({
      key: `attachments:${message.id}`,
      kind: "attachment-strip",
      estimatedBlockSize: ATTACHMENT_STRIP_BLOCK_SIZE,
    });
  }

  if (message?.metadata?.chips?.length) {
    blocks.push({
      key: `chips:${message.id}`,
      kind: "chip-strip",
      estimatedBlockSize: CHIP_STRIP_BLOCK_SIZE,
    });
  }

  return blocks;
}

function getReservedBlockSize(
  blocks: readonly TranscriptShellMeasurementBlock[],
): number | null {
  const total = blocks.reduce((sum, block) => {
    return sum + (block.reservedBlockSize ?? 0);
  }, 0);
  return total > 0 ? normalizeBlockSize(total) : null;
}

function getEstimatedBlockSize({
  estimatedBlockSize,
  message,
  rowKind,
  blocks,
}: {
  estimatedBlockSize: number | undefined;
  message: Message | undefined;
  rowKind: TranscriptRowKind;
  blocks: readonly TranscriptShellMeasurementBlock[];
}): number {
  if (estimatedBlockSize !== undefined) {
    return normalizeBlockSize(estimatedBlockSize);
  }

  if (rowKind === "date-separator" || rowKind === "top-loading-sentinel") {
    return STATIC_ROW_SIZE;
  }

  const contentBlockSize = blocks.reduce(
    (sum, block) => sum + block.estimatedBlockSize,
    0,
  );
  return normalizeBlockSize(getMessageChromeSize(message) + contentBlockSize);
}

export function createTranscriptShellMeasurementPlan(
  input: TranscriptShellMeasurementInput,
): TranscriptShellMeasurementPlan {
  const policyDecision =
    input.policyDecision ?? classifyTranscriptMeasurementPolicy(input);
  const message = input.message;
  const content = input.content ?? message?.content ?? [];
  const blocks = [
    ...createMetadataShellBlocks(message),
    ...content.map(createContentShellBlock),
  ];
  const estimatedBlockSize = getEstimatedBlockSize({
    estimatedBlockSize: input.estimatedBlockSize,
    message,
    rowKind: input.rowKind,
    blocks,
  });
  const reservedBlockSize = getReservedBlockSize(blocks);

  let status: TranscriptShellMeasurementStatus;
  if (policyDecision.policy === "measure-shell") {
    status = "ready";
  } else if (policyDecision.policy === "estimate-only") {
    status = "blocked";
  } else {
    status = "not-eligible";
  }

  return {
    status,
    rowKind: input.rowKind,
    policyDecision,
    estimatedBlockSize,
    reservedBlockSize,
    blocks,
    reasons: policyDecision.reasons,
  };
}

export function canUseTranscriptShellMeasurement(
  plan: TranscriptShellMeasurementPlan,
): boolean {
  return plan.status === "ready";
}

export function createTranscriptShellRootAttributes(
  plan: TranscriptShellMeasurementPlan,
): TranscriptShellRootAttributes | Record<string, never> {
  if (!canUseTranscriptShellMeasurement(plan)) {
    return {};
  }

  return {
    [VIRTUAL_ROW_MEASUREMENT_SHELL_ATTRIBUTE]: "true",
    [VIRTUAL_ROW_SHELL_KIND_ATTRIBUTE]: plan.rowKind,
    ...(plan.reservedBlockSize !== null
      ? createVirtualReservedBlockSizeAttributes({
          blockSize: plan.reservedBlockSize,
        })
      : {}),
  };
}

export function createTranscriptShellBlockAttributes(
  block: TranscriptShellMeasurementBlock,
): TranscriptShellBlockAttributes {
  return {
    [VIRTUAL_ROW_SHELL_BLOCK_ATTRIBUTE]: "true",
    [VIRTUAL_ROW_SHELL_BLOCK_KIND_ATTRIBUTE]: block.kind,
    ...(block.reservedBlockSize !== undefined
      ? createVirtualReservedBlockSizeAttributes({
          blockSize: block.reservedBlockSize,
        })
      : {}),
  };
}
