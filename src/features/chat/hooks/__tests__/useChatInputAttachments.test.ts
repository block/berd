import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResizeImage = vi.fn();
const mockNormalizeImageBase64 = vi.fn();

vi.mock("../../lib/resizeImage", () => ({
  resizeImage: (...args: unknown[]) => mockResizeImage(...args),
  normalizeImageBase64: (...args: unknown[]) =>
    mockNormalizeImageBase64(...args),
}));

vi.mock("@/shared/lib/platform", () => ({
  getPlatform: () => "mac",
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

vi.mock("@/shared/api/system", () => ({
  inspectAttachmentPaths: vi.fn(),
  readImageAttachment: vi.fn(),
}));

import { useChatInputAttachments } from "../useChatInputAttachments";

describe("useChatInputAttachments", () => {
  beforeEach(() => {
    mockResizeImage.mockReset();
    mockNormalizeImageBase64.mockReset();
  });

  it("drops undecodable browser images while keeping other attachments", async () => {
    // No raw pass-through fallback: an image the normalize pipeline rejects
    // never reaches the draft (BOT-1463).
    mockResizeImage.mockRejectedValue(new Error("resize failed"));

    const { result } = renderHook(() => useChatInputAttachments());

    await act(async () => {
      await result.current.addBrowserFiles([
        new File(["bad image"], "broken.png", { type: "image/png" }),
        new File(["report"], "report.txt", { type: "text/plain" }),
      ]);
    });

    expect(result.current.attachments).toEqual([
      expect.objectContaining({
        kind: "file",
        name: "report.txt",
        mimeType: "text/plain",
      }),
    ]);
  });

  it("normalizes picker and drag-drop images through the resize pipeline", async () => {
    const { inspectAttachmentPaths, readImageAttachment } = await import(
      "@/shared/api/system"
    );
    vi.mocked(inspectAttachmentPaths).mockResolvedValue([
      {
        kind: "file",
        name: "photo.heic",
        path: "/tmp/photo.heic",
        mimeType: "image/heic",
      },
    ]);
    vi.mocked(readImageAttachment).mockResolvedValue({
      base64: "raw-heic-bytes",
      mimeType: "image/heic",
    });
    mockNormalizeImageBase64.mockResolvedValue({
      base64: "normalized-jpeg-bytes",
      mimeType: "image/jpeg",
    });

    const { result } = renderHook(() => useChatInputAttachments());

    await act(async () => {
      await result.current.addPathAttachments(["/tmp/photo.heic"]);
    });

    expect(mockNormalizeImageBase64).toHaveBeenCalledWith(
      "raw-heic-bytes",
      "image/heic",
    );
    expect(result.current.attachments).toEqual([
      expect.objectContaining({
        kind: "image",
        name: "photo.heic",
        path: "/tmp/photo.heic",
        mimeType: "image/jpeg",
        base64: "normalized-jpeg-bytes",
      }),
    ]);
  });

  it("falls back to a path-only file attachment when normalization fails", async () => {
    const { inspectAttachmentPaths, readImageAttachment } = await import(
      "@/shared/api/system"
    );
    vi.mocked(inspectAttachmentPaths).mockResolvedValue([
      {
        kind: "file",
        name: "photo.tiff",
        path: "/tmp/photo.tiff",
        mimeType: "image/tiff",
      },
    ]);
    vi.mocked(readImageAttachment).mockResolvedValue({
      base64: "raw-tiff-bytes",
      mimeType: "image/tiff",
    });
    mockNormalizeImageBase64.mockRejectedValue(new Error("undecodable"));

    const { result } = renderHook(() => useChatInputAttachments());

    await act(async () => {
      await result.current.addPathAttachments(["/tmp/photo.tiff"]);
    });

    // The path still reaches the agent via appendAttachmentPaths; we just
    // never ship undecodable image bytes as an image content block.
    expect(result.current.attachments).toEqual([
      expect.objectContaining({
        kind: "file",
        name: "photo.tiff",
        path: "/tmp/photo.tiff",
        mimeType: "image/tiff",
      }),
    ]);
  });
});
