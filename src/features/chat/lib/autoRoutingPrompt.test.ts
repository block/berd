import { describe, expect, it, vi } from "vitest";
import { readTextFile } from "@/shared/api/system";
import { buildAutoRoutingPrompt } from "./autoRoutingPrompt";

vi.mock("@/shared/api/system", () => ({ readTextFile: vi.fn() }));

describe("auto routing task context", () => {
  it("includes loaded skill content and bounded file contents with metadata", async () => {
    vi.mocked(readTextFile).mockResolvedValue({
      contents: "content ".repeat(4_000),
      byteSize: 32_000,
      truncated: false,
    });
    const prompt = await buildAutoRoutingPrompt({
      text: "Review this migration",
      assistantPrompt:
        "# Loaded Skill: migrations\nSource: /skills/migrations/SKILL.md\nReview schema compatibility.",
      attachments: [
        {
          id: "file",
          kind: "file",
          name: "migration.sql",
          path: "/work/migration.sql",
          mimeType: "text/plain",
        },
      ],
    });
    expect(prompt).toContain("Review schema compatibility.");
    expect(prompt).toContain("Source: /skills/migrations/SKILL.md");
    expect(prompt).toContain("Size: 32000 bytes");
    expect(prompt).toContain("Contents:\ncontent");
    expect(prompt).toContain("[Truncated for model selection]");
    expect(prompt.length).toBeLessThan(25_000);
  });

  it("does not read remote files or image bytes and tolerates unreadable attachments", async () => {
    vi.mocked(readTextFile).mockClear();
    const attachment = {
      id: "file",
      kind: "file" as const,
      name: "file.bin",
      path: "/remote/file.bin",
    };
    const remote = await buildAutoRoutingPrompt({
      text: "Inspect",
      attachments: [attachment],
      remote: true,
    });
    expect(readTextFile).not.toHaveBeenCalled();
    expect(remote).toContain("Path: /remote/file.bin");
    vi.mocked(readTextFile).mockRejectedValue(new Error("binary file"));
    expect(
      await buildAutoRoutingPrompt({
        text: "Inspect",
        attachments: [attachment],
      }),
    ).toContain("Text preview unavailable");
  });

  it("caps the whole request, keeping task and selected skill before history", async () => {
    const prompt = await buildAutoRoutingPrompt({
      text: "t".repeat(40_000),
      assistantPrompt: "s".repeat(80_000),
    });
    expect(prompt.length).toBeLessThanOrEqual(176_000);
    expect(prompt).toContain("Selected skill and request instructions:");
  });

  it("retains 24k from every source without starving files or recent history", async () => {
    vi.mocked(readTextFile).mockResolvedValue({
      contents: "f".repeat(24_000) + "FILE_OVERFLOW",
      byteSize: 25_000,
      truncated: false,
    });
    const prompt = await buildAutoRoutingPrompt({
      text: "t".repeat(24_000) + "TASK_OVERFLOW",
      assistantPrompt: "s".repeat(24_000) + "SKILL_OVERFLOW",
      attachments: Array.from({ length: 4 }, (_, index) => ({
        id: String(index),
        kind: "file" as const,
        name: `file-${index}.ts`,
        path: `/work/file-${index}.ts`,
      })),
      messages: [
        {
          id: "history",
          role: "user",
          created: Date.now(),
          content: [
            { type: "text", text: "HISTORY_OVERFLOW" + "h".repeat(24_000) },
          ],
        },
      ],
    });
    expect(prompt).toContain("t".repeat(24_000));
    expect(prompt).toContain("s".repeat(24_000));
    expect(prompt.split("f".repeat(24_000))).toHaveLength(5);
    expect(prompt).toContain("h".repeat(24_000));
    expect(prompt).not.toContain("OVERFLOW");
    expect(prompt.length).toBeLessThanOrEqual(176_000);
  });
});
