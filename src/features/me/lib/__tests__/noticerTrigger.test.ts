import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message, MessageContent } from "@/shared/types/messages";

const mocks = vi.hoisted(() => ({
  noticeFromTranscript: vi.fn(async (_transcript: string) => 0),
}));

vi.mock("../memoryNoticer", () => ({
  noticeFromTranscript: mocks.noticeFromTranscript,
}));

import {
  resetNoticerTracking,
  scheduleNoticerPass,
  userTranscript,
} from "../noticerTrigger";

let nextId = 0;

function message(
  role: Message["role"],
  content: MessageContent[],
  metadata: Message["metadata"] = { userVisible: true },
): Message {
  nextId += 1;
  return {
    id: `m-${nextId}`,
    role,
    created: nextId,
    content,
    metadata,
  };
}

function userMessage(text: string, id?: string): Message {
  const msg = message("user", [{ type: "text", text }]);
  if (id) msg.id = id;
  return msg;
}

function assistantMessage(text: string): Message {
  return message("assistant", [{ type: "text", text }]);
}

afterEach(() => {
  resetNoticerTracking();
  mocks.noticeFromTranscript.mockClear();
  vi.useRealTimers();
});

describe("userTranscript", () => {
  it("keeps only the user's own visible text words", () => {
    const transcript = userTranscript([
      userMessage("My kid has soccer Mondays."),
      assistantMessage("Great, here's a schedule."),
      message("assistant", [
        {
          type: "toolResponse",
          id: "tr1",
          name: "read",
          result: "tool secret",
          isError: false,
        },
      ]),
      message("system", [
        {
          type: "systemNotification",
          notificationType: "info",
          text: "system invisible",
        },
      ]),
      message("user", [
        { type: "thinking", text: "hidden thought" },
        {
          type: "text",
          text: "assistant-only steering",
          annotations: { audience: ["assistant"] },
        },
        {
          type: "image",
          data: "base64",
          mimeType: "image/png",
          uri: "file:///x.png",
        },
        { type: "text", text: "And the dog goes out Wednesdays." },
      ]),
      message("user", [], {
        userVisible: true,
        attachments: [
          { type: "file", name: "secret-attachment.txt", path: "/tmp/secret" },
        ],
      }),
      userMessage("invisible user text", undefined),
    ]);
    expect(transcript).toContain("soccer Mondays");
    expect(transcript).toContain("dog goes out Wednesdays");
    expect(transcript).not.toContain("here's a schedule");
    expect(transcript).not.toContain("tool secret");
    expect(transcript).not.toContain("system invisible");
    expect(transcript).not.toContain("hidden thought");
    expect(transcript).not.toContain("assistant-only steering");
    expect(transcript).not.toContain("base64");
    expect(transcript).not.toContain("secret-attachment");
  });

  it("drops user messages that are not visible to the user", () => {
    const transcript = userTranscript([
      message("user", [{ type: "text", text: "hidden steering" }], {
        userVisible: false,
        agentVisible: true,
      }),
    ]);
    expect(transcript).toBe("");
  });
});

describe("scheduleNoticerPass", () => {
  it("debounces: rescheduling resets the timer, one pass per lull", async () => {
    vi.useFakeTimers();
    const messages = [userMessage("First.")];
    scheduleNoticerPass(
      "s1",
      () => messages,
      { providerId: "p", modelId: "m" },
      { delayMs: 1000 },
    );
    vi.advanceTimersByTime(600);
    messages.push(userMessage("Second."));
    scheduleNoticerPass(
      "s1",
      () => messages,
      { providerId: "p", modelId: "m" },
      { delayMs: 1000 },
    );
    vi.advanceTimersByTime(600);
    expect(mocks.noticeFromTranscript).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.noticeFromTranscript).toHaveBeenCalledTimes(1);
    expect(mocks.noticeFromTranscript.mock.calls[0][0]).toContain("Second.");
  });

  it("triggers on new user text but extracts the whole conversation", async () => {
    vi.useFakeTimers();
    const messages = [userMessage("Old fact.")];
    scheduleNoticerPass(
      "s2",
      () => messages,
      { providerId: "p", modelId: "m" },
      { delayMs: 10 },
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(mocks.noticeFromTranscript).toHaveBeenCalledTimes(1);

    messages.push(assistantMessage("ok"), userMessage("New fact."));
    scheduleNoticerPass(
      "s2",
      () => messages,
      { providerId: "p", modelId: "m" },
      { delayMs: 10 },
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(mocks.noticeFromTranscript).toHaveBeenCalledTimes(2);
    const second = mocks.noticeFromTranscript.mock.calls[1][0];
    expect(second).toContain("New fact.");
    expect(second).toContain("Old fact.");
  });

  it("skips the pass entirely when there is no new user text", async () => {
    vi.useFakeTimers();
    const messages = [userMessage("Only fact.")];
    scheduleNoticerPass(
      "s3",
      () => messages,
      { providerId: "p", modelId: "m" },
      { delayMs: 10 },
    );
    await vi.advanceTimersByTimeAsync(20);
    messages.push(assistantMessage("assistant only"));
    scheduleNoticerPass(
      "s3",
      () => messages,
      { providerId: "p", modelId: "m" },
      { delayMs: 10 },
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(mocks.noticeFromTranscript).toHaveBeenCalledTimes(1);
  });

  it("notices after a longer history is replaced by a shorter replay", async () => {
    vi.useFakeTimers();
    let messages = [
      userMessage("Older fact one.", "old-1"),
      userMessage("Older fact two.", "old-2"),
      userMessage("Older fact three.", "old-3"),
    ];
    scheduleNoticerPass(
      "s4",
      () => messages,
      { providerId: "p", modelId: "m" },
      { delayMs: 10 },
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(mocks.noticeFromTranscript).toHaveBeenCalledTimes(1);

    messages = [
      userMessage("Replayed shorter history.", "replay-1"),
      userMessage("New durable fact after replay.", "new-after-replay"),
    ];
    scheduleNoticerPass(
      "s4",
      () => messages,
      { providerId: "p", modelId: "m" },
      { delayMs: 10 },
    );
    await vi.advanceTimersByTimeAsync(20);

    expect(mocks.noticeFromTranscript).toHaveBeenCalledTimes(2);
    expect(mocks.noticeFromTranscript.mock.calls[1][0]).toContain(
      "New durable fact after replay.",
    );
  });

  it("does not overlap runs for the same session", async () => {
    vi.useFakeTimers();
    let resolveRun: (() => void) | undefined;
    mocks.noticeFromTranscript.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          resolveRun = () => resolve(0);
        }),
    );
    const messages = [userMessage("First fact.")];
    scheduleNoticerPass(
      "s5",
      () => messages,
      { providerId: "p", modelId: "m" },
      { delayMs: 10 },
    );
    await vi.advanceTimersByTimeAsync(20);

    messages.push(userMessage("Second fact."));
    scheduleNoticerPass(
      "s5",
      () => messages,
      { providerId: "p", modelId: "m" },
      { delayMs: 10 },
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(mocks.noticeFromTranscript).toHaveBeenCalledTimes(1);

    resolveRun?.();
    await vi.waitFor(() =>
      expect(mocks.noticeFromTranscript).toHaveBeenCalledTimes(2),
    );
  });

  it("keeps the guard until the original run actually settles", async () => {
    vi.useFakeTimers();
    let resolveRun: (() => void) | undefined;
    mocks.noticeFromTranscript.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          resolveRun = () => resolve(0);
        }),
    );
    const messages = [userMessage("Original fact.")];
    scheduleNoticerPass(
      "s6",
      () => messages,
      { providerId: "p", modelId: "m" },
      { delayMs: 10 },
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(mocks.noticeFromTranscript).toHaveBeenCalledTimes(1);

    messages.push(userMessage("Deferred fact."));
    scheduleNoticerPass(
      "s6",
      () => messages,
      { providerId: "p", modelId: "m" },
      { delayMs: 10 },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.noticeFromTranscript).toHaveBeenCalledTimes(1);

    resolveRun?.();
    await vi.waitFor(() =>
      expect(mocks.noticeFromTranscript).toHaveBeenCalledTimes(2),
    );
  });
});
