import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/shared/types/messages";

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

function userMessage(text: string): Message {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    role: "user",
    created: Date.now(),
    content: [{ type: "text", text }],
  };
}

function assistantMessage(text: string): Message {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    role: "assistant",
    created: Date.now(),
    content: [{ type: "text", text }],
  };
}

afterEach(() => {
  resetNoticerTracking();
  mocks.noticeFromTranscript.mockClear();
  vi.useRealTimers();
});

describe("userTranscript", () => {
  it("keeps only the user's own words", () => {
    const transcript = userTranscript([
      userMessage("My kid has soccer Mondays."),
      assistantMessage("Great, here's a schedule."),
      userMessage("And the dog goes out Wednesdays."),
    ]);
    expect(transcript).toContain("soccer Mondays");
    expect(transcript).toContain("dog goes out Wednesdays");
    expect(transcript).not.toContain("here's a schedule");
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
    // Single messages in isolation read as nothing worth keeping, so the
    // pass sees the full conversation; the queue and tombstones dedupe.
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
});
