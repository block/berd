import { describe, expect, it, vi } from "vitest";

import type { WorkStatusSnapshot } from "./types";
import { buildWorkStatusSnapshot } from "./workStatusData";

const fetchGitHubPullRequestsMock = vi.hoisted(() => vi.fn());

vi.mock("./githubPullRequests", () => ({
  fetchGitHubPullRequests: fetchGitHubPullRequestsMock,
}));

const previous: WorkStatusSnapshot = {
  chats: [],
  errors: [],
  isFresh: true,
  isTruncated: false,
  pullRequests: [
    {
      id: "existing",
      title: "Existing PR",
      groupName: "squareup/berd",
      source: "github",
      status: "draft",
      updatedAt: "2026-08-07T00:00:00.000Z",
      destination: {
        type: "url",
        url: "https://github.com/squareup/berd/pull/1",
      },
    },
  ],
};

describe("buildWorkStatusSnapshot", () => {
  it("keeps stale PR rows when refresh fails", async () => {
    fetchGitHubPullRequestsMock.mockResolvedValue({
      items: [],
      isTruncated: false,
      error: {
        id: "github",
        source: "github",
        code: "network",
        message: "raw network details",
      },
    });

    const result = await buildWorkStatusSnapshot(previous);

    expect(result.pullRequests).toEqual(previous.pullRequests);
    expect(result.errors[0]?.code).toBe("network");
    expect(result.isFresh).toBe(false);
  });
});
