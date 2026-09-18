import { beforeEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { loadMeFile } from "../meFile";
import { listTopics } from "../meTopics";
import { listProposals } from "../meProposals";
import {
  exportMemoryMarkdown,
  importMemoryMarkdown,
  readMemoryPolicy,
  writeMemoryPolicy,
  readMemoryRecallSnapshot,
  saveReviewedMemoryDocument,
} from "@/shared/api/system";
const path = "/fixture/.me/me.md";
beforeEach(() => {
  vi.resetAllMocks();
  invoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "get_home_dir":
        return "/fixture";
      case "list_memory_documents":
        return [
          { path, fileName: "me.md", contents: "# Me" },
          {
            path: "/fixture/.me/topics/work.md",
            fileName: "work.md",
            contents: "# Work\n\n- Keep it brief.",
          },
        ];
      case "path_exists":
        return true;
      case "read_memory_text_file":
        return {
          path: "/fixture/.me/proposals/pending.jsonl",
          contents: JSON.stringify({ id: "fixture", content: "Prefers tea." }),
        };
      default:
        throw new Error(`Unexpected command ${cmd}`);
    }
  });
});
describe("encrypted memory IPC", () => {
  it("loads the spine and topic index without generic file reads or initialization", async () => {
    expect(await loadMeFile()).toMatchObject({
      status: "present",
      contents: "# Me",
    });
    expect(await listTopics()).toMatchObject([
      { label: "Work", fileName: "work.md" },
    ]);
    const commands = invoke.mock.calls.map(([cmd]) => cmd);
    expect(commands).not.toContain("read_text_file");
    expect(commands).not.toContain("list_directory_entries");
    expect(commands).not.toContain("initialize_memory_store");
  });
  it("decrypts pending proposals with the dedicated reader", async () => {
    expect(await listProposals()).toMatchObject([
      { id: "fixture", content: "Prefers tea." },
    ]);
    expect(invoke).toHaveBeenCalledWith("read_memory_text_file", {
      path: "/fixture/.me/proposals/pending.jsonl",
    });
  });
  it("only a genuinely empty document list is a missing spine", async () => {
    invoke.mockResolvedValue([]);
    expect(await loadMeFile()).toMatchObject({ status: "missing" });
  });
  it("propagates locked and corrupt storage failures instead of empty documents", async () => {
    invoke.mockRejectedValue(new Error("locked"));
    await expect(loadMeFile()).rejects.toThrow("locked");
    await expect(listTopics()).rejects.toThrow("locked");
    await expect(listProposals()).rejects.toThrow("locked");
  });
  it("uses dedicated policy and picker commands without arbitrary persistence", async () => {
    invoke.mockResolvedValue(null);
    await readMemoryPolicy();
    await writeMemoryPolicy(false);
    await importMemoryMarkdown();
    await exportMemoryMarkdown(path);
    expect(invoke.mock.calls).toEqual([
      ["read_memory_policy"],
      ["write_memory_policy", { enabled: false }],
      ["import_memory_markdown"],
      ["export_memory_markdown", { path }],
    ]);
  });
});

it("uses the snapshot and reviewed save commands with the exact IPC shape", async () => {
  invoke
    .mockResolvedValueOnce({ documents: [] })
    .mockResolvedValueOnce(undefined);
  expect(await readMemoryRecallSnapshot()).toEqual({ documents: [] });
  await saveReviewedMemoryDocument(path, "# Me", null);
  expect(invoke.mock.calls).toEqual([
    ["read_memory_recall_snapshot"],
    ["save_reviewed_memory_document", { path, contents: "# Me", topic: null }],
  ]);
});
it.each([
  "{bad json",
  '{"id":"bad"}',
  '{"id":"bad","content":""}',
])("does not silently filter malformed queue lines: %s", async (invalid) => {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_home_dir") return "/fixture";
    if (cmd === "path_exists") return true;
    return {
      contents: `${JSON.stringify({ id: "valid", content: "Prefers tea." })}\n${invalid}\n`,
    };
  });
  await expect(listProposals()).rejects.toThrow(
    "Invalid encrypted memory queue record",
  );
});
it("treats only blank queue lines as empty", async () => {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "get_home_dir") return "/fixture";
    if (cmd === "path_exists") return true;
    return { contents: " \n\n\t" };
  });
  await expect(listProposals()).resolves.toEqual([]);
});
