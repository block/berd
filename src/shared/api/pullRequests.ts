import { invoke } from "@tauri-apps/api/core";

export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";
export type PullRequestChecksStatus = "SUCCESS" | "PENDING" | "FAILURE";

export interface PullRequestSummary {
  url: string;
  repoSlug: string;
  number: number;
  title: string | null;
  state: PullRequestState | null;
  isDraft: boolean | null;
  checksStatus: PullRequestChecksStatus | null;
}

export async function getPullRequestSummaries(
  urls: string[],
  path?: string | null,
): Promise<PullRequestSummary[]> {
  return invoke<PullRequestSummary[]>("get_pull_request_summaries", {
    urls,
    path: path ?? null,
  });
}
