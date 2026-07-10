import { describe, expect, it } from "vitest";
import {
  draftAttachmentsEqual,
  makeRemountSafeDraftAttachments,
} from "../draftAttachments";
import type { ChatAttachmentDraft } from "@/shared/types/messages";

describe("draft attachment helpers", () => {
  it("converts blob image previews to data urls so remounted drafts remain renderable", () => {
    const attachments: ChatAttachmentDraft[] = [
      {
        id: "image-1",
        kind: "image",
        name: "pasted.png",
        mimeType: "image/png",
        base64: "abc123",
        previewUrl: "blob:local-preview",
      },
      {
        id: "file-1",
        kind: "file",
        name: "report.pdf",
        path: "/tmp/report.pdf",
        mimeType: "application/pdf",
      },
    ];

    expect(makeRemountSafeDraftAttachments(attachments)).toEqual([
      {
        id: "image-1",
        kind: "image",
        name: "pasted.png",
        mimeType: "image/png",
        base64: "abc123",
        previewUrl: "data:image/png;base64,abc123",
      },
      attachments[1],
    ]);
  });

  it("preserves the original attachment array when previews are already remount-safe", () => {
    const attachments: ChatAttachmentDraft[] = [
      {
        id: "image-1",
        kind: "image",
        name: "screen.png",
        path: "/tmp/screen.png",
        mimeType: "image/png",
        base64: "abc123",
        previewUrl: "asset:///tmp/screen.png",
      },
    ];

    expect(makeRemountSafeDraftAttachments(attachments)).toBe(attachments);
  });

  it("compares draft attachments by value", () => {
    const first: ChatAttachmentDraft[] = [
      {
        id: "file-1",
        kind: "file",
        name: "report.pdf",
        path: "/tmp/report.pdf",
        mimeType: "application/pdf",
      },
    ];
    const matching: ChatAttachmentDraft[] = [
      {
        id: "file-1",
        kind: "file",
        name: "report.pdf",
        path: "/tmp/report.pdf",
        mimeType: "application/pdf",
      },
    ];
    const different: ChatAttachmentDraft[] = [
      {
        id: "file-1",
        kind: "file",
        name: "report.pdf",
        path: "/tmp/other.pdf",
        mimeType: "application/pdf",
      },
    ];

    expect(draftAttachmentsEqual(first, matching)).toBe(true);
    expect(draftAttachmentsEqual(first, different)).toBe(false);
  });
});
