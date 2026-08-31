import { describe, expect, it } from "vitest";
import { appendAttachmentPaths, remoteSafeAttachments } from "../attachments";
import type { ChatAttachmentDraft } from "@/shared/types/messages";

describe("appendAttachmentPaths", () => {
  it("appends file and directory paths to text", () => {
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
    expect(appendAttachmentPaths("review this", attachments)).toBe(
      "review this /tmp/report.pdf /tmp/docs",
    );
  });

  it("appends paths for realistic local file attachments without format-specific handling", () => {
    const attachments: ChatAttachmentDraft[] = [
      {
        id: "1",
        kind: "file",
        name: "notes.md",
        path: "/tmp/notes.md",
        mimeType: "text/markdown",
      },
      {
        id: "2",
        kind: "file",
        name: "feedback.xlsx",
        path: "/tmp/feedback.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      {
        id: "3",
        kind: "file",
        name: "report.pdf",
        path: "/tmp/report.pdf",
        mimeType: "application/pdf",
      },
    ];

    expect(appendAttachmentPaths("summarize these", attachments)).toBe(
      "summarize these /tmp/notes.md /tmp/feedback.xlsx /tmp/report.pdf",
    );
  });

  it("includes paths for local image attachments", () => {
    const attachments: ChatAttachmentDraft[] = [
      {
        id: "1",
        kind: "image",
        name: "pic.png",
        path: "/tmp/pic.png",
        mimeType: "image/png",
        base64: "abc",
        previewUrl: "blob:...",
      },
    ];

    expect(appendAttachmentPaths("hello", attachments)).toBe(
      "hello /tmp/pic.png",
    );
  });

  it("does not invent paths for pasted or browser-only image attachments", () => {
    const attachments: ChatAttachmentDraft[] = [
      {
        id: "1",
        kind: "image",
        name: "pasted.png",
        mimeType: "image/png",
        base64: "abc",
        previewUrl: "blob:...",
      },
    ];

    expect(appendAttachmentPaths("hello", attachments)).toBe("hello");
  });
});

describe("remoteSafeAttachments", () => {
  it("drops path-only attachments and strips the local path from content-backed images", () => {
    const attachments: ChatAttachmentDraft[] = [
      {
        id: "file",
        kind: "file",
        name: "notes.md",
        path: "/Users/me/notes.md",
      },
      {
        id: "directory",
        kind: "directory",
        name: "repo",
        path: "/Users/me/repo",
      },
      {
        id: "image",
        kind: "image",
        name: "diagram.png",
        path: "/Users/me/diagram.png",
        mimeType: "image/png",
        base64: "abc",
        previewUrl: "asset://diagram.png",
      },
    ];

    const safe = remoteSafeAttachments(attachments);

    expect(safe).toEqual([
      expect.objectContaining({ id: "image", path: undefined }),
    ]);
    expect(appendAttachmentPaths("review", safe)).toBe("review");
  });
});
