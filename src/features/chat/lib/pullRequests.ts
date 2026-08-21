import type { Message } from "@/shared/types/messages";

export const MAX_RELATED_PULL_REQUESTS = 12;

export interface DetectedPullRequest {
  url: string;
  repoSlug: string;
  number: number;
}

export interface RelatedPullRequestScan {
  initialized: boolean;
  processedMessageCount: number;
  /** Immutable message references reveal same-id patches to scanned history. */
  processedMessages: readonly Message[];
  pullRequests: DetectedPullRequest[];
}

export const EMPTY_RELATED_PULL_REQUEST_SCAN: RelatedPullRequestScan = {
  initialized: false,
  processedMessageCount: 0,
  processedMessages: [],
  pullRequests: [],
};

const PULL_REQUEST_URL_PATTERN =
  /https?:\/\/(?:github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)|app\.graphite\.(?:com|dev)\/github\/pr\/([\w.-]+)\/([\w.-]+)\/(\d+))/gi;

function searchableMessageContent(message: Message): string[] {
  const searchable: string[] = [];

  for (const content of message.content) {
    if (content.type === "text") {
      searchable.push(content.text);
    } else if (content.type === "toolResponse") {
      searchable.push(content.result);
    } else if (content.type === "toolRequest") {
      searchable.push(JSON.stringify(content.arguments));
    }
  }

  return searchable;
}

export function findRelatedPullRequests(
  messages: Message[],
  limit = MAX_RELATED_PULL_REQUESTS,
): DetectedPullRequest[] {
  if (limit <= 0) return [];

  const results: DetectedPullRequest[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    for (const text of searchableMessageContent(message)) {
      for (const match of text.matchAll(PULL_REQUEST_URL_PATTERN)) {
        const owner = match[1] ?? match[4];
        const repo = match[2] ?? match[5];
        const numberText = match[3] ?? match[6];
        const number = Number(numberText);
        if (!owner || !repo || !Number.isSafeInteger(number) || number <= 0) {
          continue;
        }

        const repoSlug = `${owner}/${repo}`;
        const key = `${repoSlug.toLowerCase()}#${number}`;
        if (seen.has(key)) continue;

        seen.add(key);
        results.push({
          url: `https://github.com/${repoSlug}/pull/${number}`,
          repoSlug,
          number,
        });
        if (results.length >= limit) return results;
      }
    }
  }

  return results;
}

function mergePullRequests(
  existing: DetectedPullRequest[],
  additions: DetectedPullRequest[],
  limit: number,
): DetectedPullRequest[] {
  if (existing.length >= limit || additions.length === 0) return existing;

  const merged = [...existing];
  const seen = new Set(
    existing.map(
      (pullRequest) =>
        `${pullRequest.repoSlug.toLowerCase()}#${pullRequest.number}`,
    ),
  );

  for (const pullRequest of additions) {
    const key = `${pullRequest.repoSlug.toLowerCase()}#${pullRequest.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(pullRequest);
    if (merged.length >= limit) break;
  }

  return merged;
}

export function advanceRelatedPullRequestScan(
  scan: RelatedPullRequestScan,
  messages: Message[],
  streamingMessageId: string | null,
  isLoading: boolean,
  limit = MAX_RELATED_PULL_REQUESTS,
): RelatedPullRequestScan {
  if (isLoading) return EMPTY_RELATED_PULL_REQUEST_SCAN;

  const prefixChanged =
    scan.processedMessageCount > messages.length ||
    scan.processedMessages.some(
      (processedMessage, index) => messages[index] !== processedMessage,
    );
  const start =
    !scan.initialized || prefixChanged ? 0 : scan.processedMessageCount;

  let end = start;
  while (end < messages.length && messages[end]?.id !== streamingMessageId) {
    end += 1;
  }

  if (scan.initialized && !prefixChanged && end === start) return scan;

  const additions = findRelatedPullRequests(messages.slice(start, end), limit);
  const pullRequests =
    start === 0
      ? additions
      : mergePullRequests(scan.pullRequests, additions, limit);

  return {
    initialized: true,
    processedMessageCount: end,
    processedMessages: messages.slice(0, end),
    pullRequests,
  };
}
