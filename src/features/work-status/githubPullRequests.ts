import { invoke } from "@tauri-apps/api/core";
import type {
  WorkStatusError,
  WorkStatusErrorCode,
  WorkStatusItem,
  WorkStatusState,
} from "./types";

interface GitHubPullRequestResponse {
  data: {
    search: {
      nodes: GitHubPullRequest[];
    };
  };
  isTruncated: boolean;
}

interface GitHubPullRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  headRefName: string;
  repository: {
    nameWithOwner: string;
  };
  headRepository: {
    nameWithOwner: string;
  } | null;
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          state: string;
        } | null;
      };
    }>;
  };
}

export interface GitHubPullRequestResult {
  items: WorkStatusItem[];
  isTruncated: boolean;
  error?: WorkStatusError;
}

export async function fetchGitHubPullRequests(): Promise<GitHubPullRequestResult> {
  try {
    const raw = await invoke<string>("list_pr_tracker_pull_requests");
    const response = JSON.parse(raw) as GitHubPullRequestResponse;
    if (response.data.search.nodes.length === 0) {
      return { items: [], isTruncated: response.isTruncated };
    }
    const projectIdsByPullRequest = await invoke<Record<string, string | null>>(
      "resolve_pr_tracker_projects",
      {
        pullRequests: response.data.search.nodes.map((pr) => ({
          id: pr.id,
          url: pr.url,
          repository: pr.repository.nameWithOwner,
          headRepository: pr.headRepository?.nameWithOwner ?? null,
          headRefName: pr.headRefName,
        })),
      },
    ).catch((error) => {
      console.warn(
        "Failed to associate pull requests with Berd projects:",
        error,
      );
      return {} as Record<string, string | null>;
    });
    return {
      items: response.data.search.nodes.map((pr) =>
        mapPullRequest(pr, projectIdsByPullRequest[pr.id] ?? null),
      ),
      isTruncated: response.isTruncated,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      items: [],
      isTruncated: false,
      error: {
        id: githubErrorId(message),
        source: "github",
        code: githubErrorCode(message),
        message,
      },
    };
  }
}

function githubErrorId(message: string): string {
  return githubErrorCode(message) === "authentication"
    ? "github-auth"
    : "github";
}

function githubErrorCode(message: string): WorkStatusErrorCode {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("authenticate") ||
    normalized.includes("not logged") ||
    normalized.includes("gh auth login") ||
    normalized.includes("authentication") ||
    normalized.includes("bad credentials") ||
    normalized.includes("expired token") ||
    normalized.includes("http 401") ||
    normalized.includes("status 401")
  ) {
    return "authentication";
  }
  if (
    normalized.includes("rate limit") ||
    normalized.includes("secondary rate") ||
    normalized.includes("http 429") ||
    normalized.includes("status 429")
  ) {
    return "rateLimited";
  }
  if (normalized.includes("cli was not found")) return "cliMissing";
  if (normalized.includes("timed out")) return "timeout";
  if (normalized.includes("database") || normalized.includes("sqlite")) {
    return "database";
  }
  if (
    normalized.includes("network") ||
    normalized.includes("connect") ||
    normalized.includes("could not resolve")
  ) {
    return "network";
  }
  return "unknown";
}

function mapPullRequest(
  pr: GitHubPullRequest,
  projectId: string | null,
): WorkStatusItem {
  return {
    id: `github-${pr.id}`,
    title: pr.title,
    subtitle: `#${pr.number}`,
    groupName: pr.repository.nameWithOwner,
    projectId,
    source: "github",
    status: classifyPullRequest({
      isDraft: pr.isDraft,
      reviewDecision: pr.reviewDecision,
      checks: pr.commits.nodes.at(0)?.commit.statusCheckRollup?.state,
      mergeable: pr.mergeable,
      mergeState: pr.mergeStateStatus,
    }),
    updatedAt: normalizeDate(pr.updatedAt),
    destination: {
      type: "url",
      url: pr.url,
    },
  };
}

export function classifyPullRequest({
  isDraft,
  reviewDecision,
  checks,
  mergeable,
  mergeState,
}: {
  isDraft: boolean;
  reviewDecision: string | null | undefined;
  checks: string | null | undefined;
  mergeable: string;
  mergeState: string;
}): WorkStatusState {
  if (isDraft) return "draft";
  if (reviewDecision === "CHANGES_REQUESTED") return "changesRequested";
  if (checks === "FAILURE" || checks === "ERROR") return "checksFailing";
  if (mergeable === "CONFLICTING" || mergeState === "DIRTY") {
    return "mergeBlocked";
  }
  if (checks === "PENDING" || checks === "EXPECTED") return "checksPending";
  if (
    reviewDecision === "REVIEW_REQUIRED" ||
    reviewDecision === "REVIEW_REQUIRED_BY_PROTECTED_BRANCH"
  ) {
    return "awaitingApproval";
  }
  if (mergeState === "BLOCKED" || mergeState === "BEHIND") {
    return "mergeBlocked";
  }
  if (
    (checks === "SUCCESS" || checks == null) &&
    mergeable === "MERGEABLE" &&
    (mergeState === "CLEAN" || mergeState === "HAS_HOOKS")
  ) {
    return "readyToMerge";
  }
  return "checksPending";
}

function normalizeDate(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : value;
}
