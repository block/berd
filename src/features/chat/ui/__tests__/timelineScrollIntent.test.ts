import { describe, expect, it } from "vitest";
import { shouldResumeTimelineFollowFromUserScroll } from "../timelineScrollIntent";

describe("timelineScrollIntent", () => {
  it("does not keep following when explicit user scroll intent moves upward inside the pinned range", () => {
    expect(
      shouldResumeTimelineFollowFromUserScroll({
        hasUserScrollIntent: true,
        isNearLatest: true,
        isPinnedToLatest: true,
        isStreaming: false,
        scrollingTowardLatest: false,
      }),
    ).toBe(false);
  });

  it("keeps following when pinned without upward user intent", () => {
    expect(
      shouldResumeTimelineFollowFromUserScroll({
        hasUserScrollIntent: false,
        isNearLatest: true,
        isPinnedToLatest: true,
        isStreaming: false,
        scrollingTowardLatest: false,
      }),
    ).toBe(true);
  });

  it("resumes streaming follow when the user scrolls downward near latest", () => {
    expect(
      shouldResumeTimelineFollowFromUserScroll({
        hasUserScrollIntent: true,
        isNearLatest: true,
        isPinnedToLatest: false,
        isStreaming: true,
        scrollingTowardLatest: true,
      }),
    ).toBe(true);
  });
});
