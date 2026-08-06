import { describe, expect, it } from "vitest";

import { classifyPullRequest } from "./githubPullRequests";

describe("classifyPullRequest", () => {
  it.each([
    {
      name: "draft",
      input: {
        isDraft: true,
        reviewDecision: null,
        checks: null,
        mergeable: "UNKNOWN",
        mergeState: "UNKNOWN",
      },
      expected: "draft",
    },
    {
      name: "changes requested",
      input: {
        isDraft: false,
        reviewDecision: "CHANGES_REQUESTED",
        checks: "SUCCESS",
        mergeable: "MERGEABLE",
        mergeState: "CLEAN",
      },
      expected: "changesRequested",
    },
    {
      name: "failing checks",
      input: {
        isDraft: false,
        reviewDecision: "APPROVED",
        checks: "FAILURE",
        mergeable: "MERGEABLE",
        mergeState: "CLEAN",
      },
      expected: "checksFailing",
    },
    {
      name: "awaiting approval",
      input: {
        isDraft: false,
        reviewDecision: "REVIEW_REQUIRED",
        checks: "SUCCESS",
        mergeable: "MERGEABLE",
        mergeState: "BLOCKED",
      },
      expected: "awaitingApproval",
    },
    {
      name: "no required review and passing checks",
      input: {
        isDraft: false,
        reviewDecision: null,
        checks: "SUCCESS",
        mergeable: "MERGEABLE",
        mergeState: "CLEAN",
      },
      expected: "readyToMerge",
    },
    {
      name: "merge conflict",
      input: {
        isDraft: false,
        reviewDecision: "APPROVED",
        checks: "SUCCESS",
        mergeable: "CONFLICTING",
        mergeState: "DIRTY",
      },
      expected: "mergeBlocked",
    },
    {
      name: "pending checks with blocked merge state",
      input: {
        isDraft: false,
        reviewDecision: "APPROVED",
        checks: "PENDING",
        mergeable: "MERGEABLE",
        mergeState: "BLOCKED",
      },
      expected: "checksPending",
    },
    {
      name: "conflict with pending checks",
      input: {
        isDraft: false,
        reviewDecision: "APPROVED",
        checks: "PENDING",
        mergeable: "CONFLICTING",
        mergeState: "DIRTY",
      },
      expected: "mergeBlocked",
    },
    {
      name: "approved with pending checks",
      input: {
        isDraft: false,
        reviewDecision: "APPROVED",
        checks: "PENDING",
        mergeable: "MERGEABLE",
        mergeState: "CLEAN",
      },
      expected: "checksPending",
    },
    {
      name: "approved with no checks",
      input: {
        isDraft: false,
        reviewDecision: "APPROVED",
        checks: null,
        mergeable: "MERGEABLE",
        mergeState: "CLEAN",
      },
      expected: "readyToMerge",
    },
    {
      name: "no required review with no checks",
      input: {
        isDraft: false,
        reviewDecision: null,
        checks: null,
        mergeable: "MERGEABLE",
        mergeState: "CLEAN",
      },
      expected: "readyToMerge",
    },
    {
      name: "approved with passing checks but an out-of-date branch",
      input: {
        isDraft: false,
        reviewDecision: "APPROVED",
        checks: "SUCCESS",
        mergeable: "MERGEABLE",
        mergeState: "BEHIND",
      },
      expected: "mergeBlocked",
    },
    {
      name: "passing checks with pre-receive hooks",
      input: {
        isDraft: false,
        reviewDecision: "APPROVED",
        checks: "SUCCESS",
        mergeable: "MERGEABLE",
        mergeState: "HAS_HOOKS",
      },
      expected: "readyToMerge",
    },
    {
      name: "ready to merge",
      input: {
        isDraft: false,
        reviewDecision: "APPROVED",
        checks: "SUCCESS",
        mergeable: "MERGEABLE",
        mergeState: "CLEAN",
      },
      expected: "readyToMerge",
    },
  ])("classifies $name", ({ input, expected }) => {
    expect(classifyPullRequest(input)).toBe(expected);
  });
});
