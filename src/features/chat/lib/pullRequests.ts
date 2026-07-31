import type { Message } from "@/shared/types/messages";

export const MAX_RELATED_PULL_REQUESTS = 12;

export interface DetectedPullRequest {
  url: string;
  repoSlug: string;
  number: number;
}

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
