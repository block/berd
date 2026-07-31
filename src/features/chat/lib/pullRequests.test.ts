import { describe, expect, it } from "vitest";
import type { Message } from "@/shared/types/messages";
import {
  advanceRelatedPullRequestScan,
  EMPTY_RELATED_PULL_REQUEST_SCAN,
  findRelatedPullRequests,
} from "./pullRequests";

function message(role: Message["role"], content: Message["content"]): Message {
  return { id: crypto.randomUUID(), role, created: 1, content };
}

function textMessage(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [{ type: "text", text }],
  };
}

describe("findRelatedPullRequests", () => {
  it("finds GitHub links in chat text and normalizes Graphite links", () => {
    const messages = [
      message("user", [
        {
          type: "text",
          text: "Please review https://github.com/squareup/berd/pull/941",
        },
      ]),
      message("assistant", [
        {
          type: "text",
          text: "Stack: https://app.graphite.com/github/pr/squareup/nexus/251",
        },
      ]),
    ];

    expect(findRelatedPullRequests(messages)).toEqual([
      {
        url: "https://github.com/squareup/berd/pull/941",
        repoSlug: "squareup/berd",
        number: 941,
      },
      {
        url: "https://github.com/squareup/nexus/pull/251",
        repoSlug: "squareup/nexus",
        number: 251,
      },
    ]);
  });

  it("finds links in tool requests and results", () => {
    const messages = [
      message("assistant", [
        {
          type: "toolRequest",
          id: "call-1",
          name: "shell",
          arguments: {
            command: "gh pr view https://github.com/squareup/berd/pull/900",
          },
          status: "completed",
        },
        {
          type: "toolResponse",
          id: "call-1",
          name: "shell",
          result: "Created https://github.com/squareup/berd/pull/901",
          isError: false,
        },
      ]),
    ];

    expect(findRelatedPullRequests(messages).map((pr) => pr.number)).toEqual([
      900, 901,
    ]);
  });

  it("deduplicates equivalent links and observes the limit", () => {
    const messages = [
      message("assistant", [
        {
          type: "text",
          text: [
            "https://app.graphite.dev/github/pr/SquareUp/Berd/42",
            "https://github.com/squareup/berd/pull/42",
            "https://github.com/squareup/berd/pull/43",
          ].join(" "),
        },
      ]),
    ];

    expect(findRelatedPullRequests(messages, 1)).toEqual([
      {
        url: "https://github.com/SquareUp/Berd/pull/42",
        repoSlug: "SquareUp/Berd",
        number: 42,
      },
    ]);
  });
});

describe("advanceRelatedPullRequestScan", () => {
  it("bootstraps after replay and only scans newly completed messages", () => {
    const historical = textMessage(
      "historical",
      "https://github.com/squareup/berd/pull/10",
    );
    const streaming = textMessage(
      "streaming",
      "https://github.com/squareup/berd/pull/20",
    );

    const loading = advanceRelatedPullRequestScan(
      EMPTY_RELATED_PULL_REQUEST_SCAN,
      [historical],
      null,
      true,
    );
    expect(loading).toBe(EMPTY_RELATED_PULL_REQUEST_SCAN);

    const bootstrapped = advanceRelatedPullRequestScan(
      loading,
      [historical, streaming],
      streaming.id,
      false,
    );
    expect(bootstrapped.pullRequests.map((pr) => pr.number)).toEqual([10]);
    expect(bootstrapped.processedMessageCount).toBe(1);

    const streamingUpdate = textMessage(
      "streaming",
      "https://github.com/squareup/berd/pull/21",
    );
    expect(
      advanceRelatedPullRequestScan(
        bootstrapped,
        [historical, streamingUpdate],
        streamingUpdate.id,
        false,
      ),
    ).toBe(bootstrapped);

    const completed = advanceRelatedPullRequestScan(
      bootstrapped,
      [historical, streamingUpdate],
      null,
      false,
    );
    expect(completed.pullRequests.map((pr) => pr.number)).toEqual([10, 21]);
    expect(completed.processedMessageCount).toBe(2);
  });

  it("rebuilds the index when processed history is replaced", () => {
    const original = textMessage(
      "original",
      "https://github.com/squareup/berd/pull/10",
    );
    const initial = advanceRelatedPullRequestScan(
      EMPTY_RELATED_PULL_REQUEST_SCAN,
      [original],
      null,
      false,
    );
    const replacement = textMessage(
      "replacement",
      "https://github.com/squareup/berd/pull/30",
    );

    const rebuilt = advanceRelatedPullRequestScan(
      initial,
      [replacement],
      null,
      false,
    );

    expect(rebuilt.pullRequests.map((pr) => pr.number)).toEqual([30]);
  });
});
