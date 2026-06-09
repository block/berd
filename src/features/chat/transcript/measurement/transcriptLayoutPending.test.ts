import { describe, expect, it } from "vitest";
import {
  VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE,
  VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE,
  createVirtualLayoutPendingAttributes,
  createVirtualLayoutStabilityAttributes,
  createVirtualReservedBlockSizeAttributes,
  getMeasurementFinalizationDecision,
  hasVirtualLayoutPendingMarker,
  parseVirtualReservedBlockSize,
} from "./transcriptLayoutPending";

describe("transcriptLayoutPending", () => {
  it("creates stable layout-pending marker attributes", () => {
    expect(createVirtualLayoutPendingAttributes("image-loading")).toEqual({
      [VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE]: "image-loading",
    });
  });

  it("creates combined pending and reserved layout attributes", () => {
    expect(
      createVirtualLayoutStabilityAttributes({
        isPending: true,
        reason: "mcp-iframe-sizing",
        reservedBlockSize: 240,
      }),
    ).toEqual({
      [VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE]: "mcp-iframe-sizing",
      [VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE]: "240",
    });

    expect(
      createVirtualLayoutStabilityAttributes({
        isPending: false,
        reason: "mcp-iframe-sizing",
        reservedBlockSize: 240,
      }),
    ).toEqual({
      [VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE]: "240",
    });
  });

  it("detects pending descendants inside a row", () => {
    const row = document.createElement("div");
    const image = document.createElement("img");
    image.setAttribute(VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE, "image-loading");
    row.append(image);

    expect(hasVirtualLayoutPendingMarker(row)).toBe(true);
  });

  it("uses reserved block size while layout is pending", () => {
    const row = document.createElement("div");
    row.setAttribute(VIRTUAL_ROW_LAYOUT_PENDING_ATTRIBUTE, "mcp-iframe-sizing");
    row.setAttribute(VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE, "320");

    expect(
      getMeasurementFinalizationDecision({
        root: row,
        measuredBlockSize: 12,
      }),
    ).toEqual({
      canFinalize: false,
      blockSize: 320,
      source: "reserved",
    });
  });

  it("allows measured size when there is no pending marker", () => {
    const row = document.createElement("div");

    expect(
      getMeasurementFinalizationDecision({
        root: row,
        measuredBlockSize: 48,
      }),
    ).toEqual({
      canFinalize: true,
      blockSize: 48,
      source: "measured",
    });
  });

  it("normalizes reserved block-size attributes", () => {
    expect(
      createVirtualReservedBlockSizeAttributes({ blockSize: 144 }),
    ).toEqual({
      [VIRTUAL_ROW_RESERVED_BLOCK_SIZE_ATTRIBUTE]: "144",
    });
    expect(parseVirtualReservedBlockSize("144")).toBe(144);
    expect(parseVirtualReservedBlockSize("-1")).toBeNull();
    expect(parseVirtualReservedBlockSize("nope")).toBeNull();
  });
});
