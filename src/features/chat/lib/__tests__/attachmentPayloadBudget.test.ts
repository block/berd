import { describe, expect, it } from "vitest";
import type { ChatAttachmentDraft } from "@/shared/types/messages";
import {
  bytesToMb,
  MAX_PROMPT_ATTACHMENT_BYTES,
  promptAttachmentBytes,
} from "../attachmentPayloadBudget";

function imageDraft(base64: string): ChatAttachmentDraft {
  return {
    id: crypto.randomUUID(),
    kind: "image",
    name: "photo.jpeg",
    mimeType: "image/jpeg",
    base64,
    previewUrl: "blob:preview",
  };
}

describe("promptAttachmentBytes", () => {
  it("sums base64 length across image attachments", () => {
    const attachments = [
      imageDraft("a".repeat(100)),
      imageDraft("b".repeat(50)),
    ];
    expect(promptAttachmentBytes(attachments)).toBe(150);
  });

  it("ignores file and directory attachments (paths, not payload)", () => {
    const attachments: ChatAttachmentDraft[] = [
      {
        id: "1",
        kind: "file",
        name: "report.pdf",
        path: "/tmp/report.pdf",
        mimeType: "application/pdf",
      },
      {
        id: "2",
        kind: "directory",
        name: "docs",
        path: "/tmp/docs",
      },
    ];
    expect(promptAttachmentBytes(attachments)).toBe(0);
  });

  it("returns 0 for undefined or empty attachments", () => {
    expect(promptAttachmentBytes(undefined)).toBe(0);
    expect(promptAttachmentBytes([])).toBe(0);
  });
});

describe("MAX_PROMPT_ATTACHMENT_BYTES", () => {
  it("stays under the 16MiB ACP WebSocket frame limit with headroom", () => {
    expect(MAX_PROMPT_ATTACHMENT_BYTES).toBeLessThan(16 * 1024 * 1024);
  });
});

describe("bytesToMb", () => {
  it("rounds to one decimal place", () => {
    expect(bytesToMb(12 * 1024 * 1024)).toBe(12);
    expect(bytesToMb(1.25 * 1024 * 1024)).toBe(1.3);
    expect(bytesToMb(0)).toBe(0);
  });
});
