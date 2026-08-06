import { fetchGitHubPullRequests } from "./githubPullRequests";
import type { WorkStatusSnapshot } from "./types";

export async function buildWorkStatusSnapshot(
  previous: WorkStatusSnapshot,
): Promise<WorkStatusSnapshot> {
  const pullRequests = await fetchGitHubPullRequests();
  if (pullRequests.error && previous.pullRequests.length > 0) {
    return {
      ...previous,
      errors: [pullRequests.error],
      isFresh: false,
    };
  }
  return {
    chats: [],
    pullRequests: [...pullRequests.items].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    ),
    errors: pullRequests.error ? [pullRequests.error] : [],
    isFresh: !pullRequests.error,
    isTruncated: pullRequests.isTruncated,
  };
}
