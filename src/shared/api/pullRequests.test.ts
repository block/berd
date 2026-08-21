import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { getPullRequestSummaries } from "./pullRequests";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("pull request API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requests summaries with the workspace path", async () => {
    vi.mocked(invoke).mockResolvedValue([]);

    await getPullRequestSummaries(
      ["https://github.com/squareup/berd/pull/42"],
      "/repo",
    );

    expect(invoke).toHaveBeenCalledWith("get_pull_request_summaries", {
      urls: ["https://github.com/squareup/berd/pull/42"],
      path: "/repo",
    });
  });
});
