import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AddedMemoryEntry } from "../../lib/meMemoryWrites";
import { useAddedMemories } from "../useAddedMemories";

const mocks = vi.hoisted(() => ({
  listAddedEntries: vi.fn(),
  clearAddedEntry: vi.fn(),
  deleteAddedEntry: vi.fn(),
  drainMemoryQueue: vi.fn(),
}));

vi.mock("../../lib/meMemoryWrites", () => ({
  listAddedEntries: mocks.listAddedEntries,
  clearAddedEntry: mocks.clearAddedEntry,
  deleteAddedEntry: mocks.deleteAddedEntry,
}));

vi.mock("../../lib/memoryAutoApply", () => ({
  drainMemoryQueue: mocks.drainMemoryQueue,
}));

function entry(
  id: string,
  sessionId: string | null,
  content = "A fact.",
): AddedMemoryEntry {
  return {
    id,
    ts: 1_700_000_000,
    content,
    topic: null,
    path: "/home/u/.me/me.md",
    agent: null,
    sessionId,
  };
}

describe("useAddedMemories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.drainMemoryQueue.mockResolvedValue([]);
  });

  it("shows entries from this session and entries with no session", async () => {
    // The MCP server can't know which chat it is serving, so its entries
    // arrive with no session. Those still need to be disclosed somewhere.
    mocks.listAddedEntries.mockResolvedValue([
      entry("a", "chat-1", "Mine."),
      entry("b", null, "From the tool."),
      entry("c", "chat-2", "Someone else's chat."),
    ]);

    const { result } = renderHook(() => useAddedMemories("chat-1"));

    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    expect(result.current.entries.map((item) => item.content)).toEqual([
      "Mine.",
      "From the tool.",
    ]);
  });

  it("shows every entry when no session is given", async () => {
    // Settings → Memory passes no session: it is the full list.
    mocks.listAddedEntries.mockResolvedValue([
      entry("a", "chat-1"),
      entry("b", null),
      entry("c", "chat-2"),
    ]);

    const { result } = renderHook(() => useAddedMemories());

    await waitFor(() => expect(result.current.entries).toHaveLength(3));
  });

  it("drops an acknowledged entry without deleting it from memory", async () => {
    mocks.listAddedEntries.mockResolvedValue([entry("a", "chat-1")]);
    mocks.clearAddedEntry.mockResolvedValue(undefined);

    const { result } = renderHook(() => useAddedMemories("chat-1"));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    mocks.listAddedEntries.mockResolvedValue([]);
    await result.current.acknowledge(entry("a", "chat-1"));

    expect(mocks.clearAddedEntry).toHaveBeenCalledWith("a");
    expect(mocks.deleteAddedEntry).not.toHaveBeenCalled();
  });
});
