import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  list: vi.fn(),
  export: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../acpApi", () => ({
  listSessionsPage: mocks.list,
  exportSession: mocks.export,
}));
import {
  matchExportedMessages,
  searchMessagesPage,
  MessageSearchTimeoutError,
  type MessageSearchMatch,
} from "../messageSearch";
import type { AcpSessionInfo } from "../acpApi";
function info(
  id = "unloaded",
  archivedAt: string | null = null,
): AcpSessionInfo {
  return {
    sessionId: id,
    title: "A synthetic session",
    updatedAt: "2026-01-02T00:00:00Z",
    createdAt: null,
    lastMessageAt: null,
    archivedAt,
    workingDir: "/synthetic/project",
    userSetName: false,
    messageCount: 3,
    subtitle: null,
    providerId: null,
    modelId: null,
    personaId: null,
  };
}
function exportMessages(...messages: unknown[]): string {
  return JSON.stringify({ conversation: messages });
}
function message(id: string, content: unknown, extra = {}) {
  return { id, role: "assistant", content, created: 1767225600, ...extra };
}
const match: MessageSearchMatch = {
  sessionId: "unloaded",
  title: "Synthetic",
  archivedAt: null,
  workingDir: "/synthetic/project",
  updatedAt: "2026-01-02T00:00:00Z",
  messageCreatedAt: "2026-01-01T00:00:00Z",
  messageId: "m1",
  messageIndex: 0,
  role: "assistant",
  snippet: "needle",
  matchCount: 1,
};
function nativeUnavailable() {
  mocks.invoke.mockRejectedValue({
    code: "MESSAGE_SEARCH_SOURCE_UNAVAILABLE",
    message: "Source unavailable",
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue({ sessions: [], nextCursor: null });
});

describe("visible exported message matching", () => {
  it("returns separate messages from one session, OR keywords and literal counts, newest first", () => {
    const result = matchExportedMessages(
      exportMessages(
        message("first", "Alpha alpha"),
        message("second", "beta"),
        message("third", "unrelated"),
      ),
      info(),
      "alpha beta alpha",
    );
    expect(result.complete).toBe(true);
    expect(
      result.matches.map((m) => [m.messageId, m.matchCount, m.messageIndex]),
    ).toEqual([
      ["second", 1, 1],
      ["first", 2, 0],
    ]);
  });
  it("excludes hidden, system, tool, reasoning and assistant-only annotations", () => {
    const exported = exportMessages(
      message("hidden", "needle", { metadata: { userVisible: false } }),
      message("snake-hidden", "needle", { metadata: { user_visible: false } }),
      message("system", "needle", { role: "system" }),
      message("tool-role", "needle", { role: "tool" }),
      message("secret", [
        { type: "thinking", text: "needle" },
        { type: "toolResponse", text: "needle" },
        { type: "newUnknownBlock", text: "needle" },
        {
          type: "text",
          text: "needle",
          annotations: { audience: ["assistant"] },
        },
        { type: "text", text: "needle", annotations: { audience: [] } },
      ]),
      message("shown", [
        {
          type: "text",
          text: "visible needle",
          annotations: { audience: ["user"] },
        },
      ]),
    );
    expect(
      matchExportedMessages(exported, info(), "needle").matches.map(
        (m) => m.messageId,
      ),
    ).toEqual(["shown"]);
  });
  it("keeps short and punctuation terms literal, and excerpts around late matches", () => {
    const result = matchExportedMessages(
      exportMessages(message("m", `${"prefix ".repeat(200)}[?] z`)),
      info(),
      "[?] z",
    );
    expect(result.matches[0].snippet).toContain("[?] z");
    expect(result.matches[0].snippet.length).toBeLessThan(200);
    expect(result.matches[0].snippet.startsWith("…")).toBe(true);
  });
  it("marks matching messages without persisted IDs incomplete instead of inventing navigation targets", () => {
    expect(
      matchExportedMessages(
        exportMessages(message("", "needle")),
        info(),
        "needle",
      ),
    ).toEqual({ matches: [], complete: false });
  });
  it("measures visible matching over a representative large synthetic export", () => {
    const exported = exportMessages(
      ...Array.from({ length: 15_000 }, (_, i) =>
        message(
          `synthetic-${i}`,
          `Conversation excerpt ${"context ".repeat(14)}${i % 1500 === 0 ? "rare-keyword" : "ordinary text"}`,
        ),
      ),
    );
    const started = performance.now();
    const result = matchExportedMessages(exported, info(), "rare-keyword");
    const elapsed = performance.now() - started;
    expect(result.matches).toHaveLength(10);
    expect(result.complete).toBe(true);
    console.log(
      `Synthetic fallback: 15000 messages, ${exported.length} chars, ${elapsed.toFixed(1)}ms`,
    );
  });

  it("keeps the excerpt at the match after Unicode lowercase expansion", () => {
    const result = matchExportedMessages(
      exportMessages(message("unicode", `${"İ".repeat(1000)} needle tail`)),
      info(),
      "needle",
    );
    expect(result.matches[0].snippet).toContain("needle");
    expect(result.matches[0].snippet.length).toBeLessThan(200);
  });

  it("rejects a malformed export rather than asserting no matches", () => {
    expect(() => matchExportedMessages("{}", info(), "needle")).toThrow(
      "no conversation",
    );
  });
});

describe("message search transport", () => {
  it("uses only Berd's native command for local indexed search, passing filters and page cursor", async () => {
    mocks.invoke.mockResolvedValue({
      matches: [match],
      complete: true,
      nextCursor: "second-page",
    });
    await expect(
      searchMessagesPage({
        query: " needle ",
        scope: "archived",
        workingDir: "/synthetic/project",
        types: ["acp"],
        limit: 20,
      }),
    ).resolves.toEqual({
      matches: [match],
      complete: true,
      nextCursor: "second-page",
    });
    expect(mocks.invoke).toHaveBeenCalledWith("search_session_messages", {
      request: {
        query: "needle",
        scope: "archived",
        limit: 20,
        workingDir: "/synthetic/project",
        types: ["acp"],
      },
    });
    expect(mocks.export).not.toHaveBeenCalled();
  });
  it("distinguishes a genuine complete zero from broken native responses", async () => {
    mocks.invoke.mockResolvedValueOnce({ matches: [], complete: true });
    await expect(searchMessagesPage({ query: "absent" })).resolves.toEqual({
      matches: [],
      complete: true,
      nextCursor: null,
    });
    mocks.invoke.mockResolvedValueOnce({ matches: [], complete: "true" });
    await expect(searchMessagesPage({ query: "absent" })).rejects.toThrow(
      "Invalid message search response",
    );
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("never falls back on native index/storage errors", async () => {
    mocks.invoke.mockRejectedValue(new Error("Index rebuild failed"));
    await expect(searchMessagesPage({ query: "needle" })).rejects.toThrow(
      "Index rebuild failed",
    );
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("maps a native bounded-index timeout and only the unavailable-source prefix permits fallback", async () => {
    mocks.invoke.mockRejectedValueOnce(
      "message_search_timeout: rebuild deadline reached",
    );
    await expect(
      searchMessagesPage({ query: "needle" }),
    ).rejects.toBeInstanceOf(MessageSearchTimeoutError);
    expect(mocks.list).not.toHaveBeenCalled();
    mocks.invoke.mockRejectedValueOnce(
      "local_search_unavailable: external ACP host selected",
    );
    await expect(
      searchMessagesPage({ query: "needle" }),
    ).resolves.toMatchObject({ matches: [], complete: true });
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("discovers unloaded remote sessions and preserves composite IDs/archive state", async () => {
    const archived = info("ssh:synthetic#older", "2026-01-03T00:00:00Z");
    mocks.list.mockResolvedValue({
      sessions: [info("ssh:synthetic#active"), archived],
      nextCursor: null,
    });
    mocks.export.mockResolvedValue(
      exportMessages(message("persisted", "needle")),
    );
    const page = await searchMessagesPage({
      query: "needle",
      backendId: "ssh:synthetic",
      scope: "archived",
      types: ["acp"],
      workingDir: "/synthetic/project",
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.export).toHaveBeenCalledExactlyOnceWith(archived.sessionId);
    expect(page.matches[0]).toMatchObject({
      sessionId: archived.sessionId,
      archivedAt: archived.archivedAt,
      messageId: "persisted",
    });
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({
        backendId: "ssh:synthetic",
        types: ["acp"],
        workingDir: "/synthetic/project",
        includeLastMessageSnippet: false,
      }),
    );
  });
  it("paginates every matching message within a session without discarding later hits", async () => {
    nativeUnavailable();
    mocks.list.mockResolvedValue({ sessions: [info()], nextCursor: null });
    mocks.export.mockResolvedValue(
      exportMessages(
        ...Array.from({ length: 7 }, (_, i) => message(`m${i}`, "needle")),
      ),
    );
    const first = await searchMessagesPage({ query: "needle", limit: 3 });
    const second = await searchMessagesPage({
      query: "needle",
      limit: 3,
      cursor: first.nextCursor,
    });
    const third = await searchMessagesPage({
      query: "needle",
      limit: 3,
      cursor: second.nextCursor,
    });
    expect(
      [...first.matches, ...second.matches, ...third.matches].map(
        (m) => m.messageId,
      ),
    ).toEqual(["m6", "m5", "m4", "m3", "m2", "m1", "m0"]);
    expect(third).toMatchObject({ complete: true, nextCursor: null });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
  it("caps exports per page and continues a full-store walk beyond a no-match first page", async () => {
    nativeUnavailable();
    const sessions = Array.from({ length: 25 }, (_, i) => info(`s${i}`));
    mocks.list.mockResolvedValue({ sessions, nextCursor: null });
    mocks.export.mockImplementation(async (id) =>
      exportMessages(message(id, id === "s24" ? "needle" : "absent")),
    );
    const first = await searchMessagesPage({ query: "needle" });
    expect(first.matches).toEqual([]);
    expect(first.nextCursor).toBeTruthy();
    expect(mocks.export).toHaveBeenCalledTimes(20);
    const last = await searchMessagesPage({
      query: "needle",
      cursor: first.nextCursor,
    });
    expect(last.matches.map((m) => m.sessionId)).toEqual(["s24"]);
    expect(last).toMatchObject({ nextCursor: null, complete: true });
  });
  it("keeps export failures partial across later pages, allowing fresh-query retry", async () => {
    nativeUnavailable();
    mocks.list.mockResolvedValue({
      sessions: [info("failed"), info("hit")],
      nextCursor: "older-page",
    });
    mocks.export
      .mockRejectedValueOnce(new Error("Export failed"))
      .mockResolvedValueOnce(exportMessages(message("m", "needle")));
    const first = await searchMessagesPage({ query: "needle" });
    expect(first).toMatchObject({ complete: false });
    mocks.list.mockResolvedValue({ sessions: [], nextCursor: null });
    const second = await searchMessagesPage({
      query: "needle",
      cursor: first.nextCursor,
    });
    expect(second).toMatchObject({ complete: false, nextCursor: null });
  });
  it("rejects source changes between fallback pages instead of silently skipping matches", async () => {
    nativeUnavailable();
    mocks.list.mockResolvedValue({ sessions: [info()], nextCursor: null });
    mocks.export.mockResolvedValue(
      exportMessages(message("one", "needle"), message("two", "needle")),
    );
    const first = await searchMessagesPage({ query: "needle", limit: 1 });
    mocks.list.mockResolvedValue({
      sessions: [{ ...info(), messageCount: 4 }],
      nextCursor: null,
    });
    await expect(
      searchMessagesPage({
        query: "needle",
        limit: 1,
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow("Sessions changed");
  });

  it("rejects cursor reuse with another query or scope", async () => {
    nativeUnavailable();
    mocks.list.mockResolvedValue({ sessions: [info()], nextCursor: "next" });
    mocks.export.mockResolvedValue(exportMessages(message("m", "needle")));
    const first = await searchMessagesPage({ query: "needle" });
    await expect(
      searchMessagesPage({ query: "other", cursor: first.nextCursor }),
    ).rejects.toThrow("Invalid message search cursor");
  });
  it("stops launching exports on cancellation and returns bounded timeout errors", async () => {
    nativeUnavailable();
    mocks.list.mockResolvedValue({
      sessions: [info("first"), info("second")],
      nextCursor: null,
    });
    mocks.export.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = searchMessagesPage({
      query: "needle",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mocks.export).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.export).toHaveBeenCalledTimes(1);
    mocks.invoke.mockReturnValue(new Promise(() => {}));
    await expect(
      searchMessagesPage({ query: "needle", timeoutMs: 5 }),
    ).rejects.toBeInstanceOf(MessageSearchTimeoutError);
  });
  it("skips huge exports as partial instead of blocking literal scanning", async () => {
    nativeUnavailable();
    mocks.list.mockResolvedValue({ sessions: [info()], nextCursor: null });
    mocks.export.mockResolvedValue(" ".repeat(4_000_001));
    await expect(searchMessagesPage({ query: "?" })).resolves.toMatchObject({
      matches: [],
      complete: false,
    });
  });
});
