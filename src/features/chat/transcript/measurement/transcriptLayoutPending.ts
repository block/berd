export const VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE =
  "data-virtual-row-layout-pending";
export const VIRTUAL_ROW_LAYOUT_PENDING_SELECTOR = `[${VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE}]`;
export const VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE =
  "data-virtual-row-reserved-block-size";

export type VirtualLayoutPendingReason =
  | "image-loading"
  | "code-highlighting"
  | "streamdown-async"
  | "mcp-iframe-sizing"
  | "tool-animation"
  | "reasoning-animation"
  | "dynamic-layout";

export interface VirtualLayoutPendingAttributes {
  [VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE]: VirtualLayoutPendingReason;
}

export interface VirtualReservedBlockSizeAttributes {
  [VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE]: string;
}

export type VirtualLayoutStabilityAttributes = Partial<
  VirtualLayoutPendingAttributes & VirtualReservedBlockSizeAttributes
>;

export interface ReservedBlockSize {
  blockSize: number;
}

export interface VirtualLayoutStabilityAttributeInput {
  isPending: boolean;
  reason?: VirtualLayoutPendingReason;
  reservedBlockSize?: number | null;
}

export function createVirtualLayoutPendingAttributes(
  reason: VirtualLayoutPendingReason = "dynamic-layout",
): VirtualLayoutPendingAttributes {
  return {
    [VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE]: reason,
  };
}

export function createVirtualReservedBlockSizeAttributes(
  reservedSize: ReservedBlockSize,
): VirtualReservedBlockSizeAttributes {
  return {
    [VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE]: String(reservedSize.blockSize),
  };
}

export function createVirtualLayoutStabilityAttributes({
  isPending,
  reason = "dynamic-layout",
  reservedBlockSize,
}: VirtualLayoutStabilityAttributeInput): VirtualLayoutStabilityAttributes {
  return {
    ...(isPending ? createVirtualLayoutPendingAttributes(reason) : {}),
    ...(reservedBlockSize !== null && reservedBlockSize !== undefined
      ? createVirtualReservedBlockSizeAttributes({
          blockSize: reservedBlockSize,
        })
      : {}),
  };
}

export function parseVirtualReservedBlockSize(
  value: string | null | undefined,
): number | null {
  if (value === null || value === undefined || value.trim() === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function getVirtualReservedBlockSize(
  element: Pick<Element, "getAttribute">,
): number | null {
  return parseVirtualReservedBlockSize(
    element.getAttribute(VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE),
  );
}

export function hasVirtualLayoutPendingMarker(element: Element): boolean {
  return (
    element.hasAttribute(VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE) ||
    element.querySelector(VIRTUAL_ROW_LAYOUT_PENDING_SELECTOR) !== null
  );
}

export interface MeasurementFinalizationInput {
  measuredBlockSize: number;
  root: Element;
  reservedBlockSize?: number | null;
}

export interface MeasurementFinalizationDecision {
  canFinalize: boolean;
  blockSize: number;
  source: "measured" | "reserved";
}

export function getMeasurementFinalizationDecision(
  input: MeasurementFinalizationInput,
): MeasurementFinalizationDecision {
  const pending = hasVirtualLayoutPendingMarker(input.root);
  const reservedBlockSize =
    input.reservedBlockSize ?? getVirtualReservedBlockSize(input.root);

  if (pending && reservedBlockSize !== null) {
    return {
      canFinalize: false,
      blockSize: reservedBlockSize,
      source: "reserved",
    };
  }

  return {
    canFinalize: !pending,
    blockSize: input.measuredBlockSize,
    source: "measured",
  };
}
