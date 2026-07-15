---
name: create-pr
description: >-
  Create a GitHub PR from the current branch: handle uncommitted changes, generate
  a summary, submit via gh CLI, then watch the PR to a ready state — fixing failing
  checks and addressing review comments. Use when the user says "create PR", "open PR",
  "submit PR", "push PR", or wants to create a pull request.
---

# Create PR

Create a GitHub PR from the current branch: handle uncommitted changes, generate a summary, submit, then watch the PR until it is in a ready state.

## Step 1: Resolve Base Branch

Before doing anything else, identify the PR base branch. Prefer the branch's upstream base or the repository's default branch from `git remote show origin`. Fall back to `origin/main` only if the repo does not expose a default branch.

Remind the user to rebase onto the base branch if they have not already. Ask if they would like to proceed or rebase first.

## Step 2: Check for Uncommitted Changes

Run `git status` to check for staged, unstaged, or untracked changes.

- If there are uncommitted changes, show the user what's outstanding and ask if they'd like to commit them before creating the PR.
- If the user says yes, stage the relevant files, draft a concise commit message based on the changes, and commit.
- If there are no uncommitted changes, move on.

## Step 3: Gather Branch Context

Run these commands in parallel to understand the branch:

1. `git log <base>..HEAD --oneline` to see all commits on this branch.
2. `git diff <base>..HEAD --stat` to get the list of changed files.
3. `git diff <base>..HEAD` to understand what changed in each file.
4. `git rev-parse --abbrev-ref HEAD` to get the current branch name.
5. `git status` to check if the branch has been pushed to remote.

## Step 4: Generate PR Title and Summary

**Title:** Generate a concise PR title (under 72 characters) that captures the intent of the change. Use conventional style: lowercase, imperative mood (e.g., "prevent chat list from reordering when renaming sessions").

**Body:** Generate a PR summary with these sections:

### Section 1: Overview

Start with metadata tags, then a Problem/Solution block:

- `**Category:**` — one of: `new-feature`, `improvement`, `fix`, `infrastructure`
- `**User Impact:**` — one sentence describing what changed from the user's perspective. Write this as a standalone sentence a non-technical stakeholder would understand (e.g., "Users can now create and schedule repeatable tasks directly from the desktop app."). This line is used for project changelogs.
- `**Problem:**` — describe the user-facing confusion, mismatch, or friction this PR addresses.
- `**Solution:**` — explain how the change resolves that UX problem and, if applicable, why the approach was chosen.

Keep Problem + Solution to 2-4 sentences total. Prioritize intent and expected user experience, but include brief high-level implementation rationale when it explains reliability, maintainability, or code quality.

### Section 2: Changes

Wrap this section in a collapsible `<details>` block with the summary "File changes".

Inside, list every changed file. For each file, use the filename as a bold header, then underneath write one or two sentences about what was changed and why. Focus on intent, not implementation details.

Format:
```
<details>
<summary>File changes</summary>

**path/to/file.ts**
What changed and why.

**path/to/other.rs**
What changed and why.

</details>
```

## Step 5: Resolve And Link Linear

Keep Linear tracking lightweight and automatic. Do this workflow outside the generated PR body. Complete the Linear decision before pushing or creating the PR; a user request to create a PR is not permission to skip Linear resolution.

Before creating the PR:

1. Look for an explicit Linear key, such as `BOT-361`, in the current conversation, branch name, commit messages, PR title, or PR body.
2. If no key is explicit, search active Goose Internal issues using the branch name, commit subjects, changed-file intent, and PR title. Prefer team `BOT`, project `Goose [Internal]`, and `backlog`, `unstarted`, or `started` issues.
3. If one issue clearly matches the same user need or implementation intent, use it. If a few issues could match, pause and ask the user which one to attach.

After the GitHub PR exists:

1. If an issue was resolved, attach the PR to it with `attachmentLinkGitHubPR` so Linear shows PR number and live status.
2. Verify the issue attachment points at the new PR and has GitHub metadata.
3. If Linear tooling is unavailable, do not block PR creation. Tell the user the PR was created but Linear linking was skipped.

## Step 6: Push and Create PR

1. Push the branch to remote if it hasn't been pushed yet: `git push -u origin HEAD`
2. Create the PR using `gh pr create` with the generated title and body. Use a HEREDOC for the body to preserve formatting.
3. Output the PR URL as a clickable hyperlink so the user can open it directly.

## Step 7: Watch the PR to a Ready State

Once the PR is created, do not stop. Own the loop from "PR is open" to "PR is in a ready state": watch GitHub, fix failing checks, and address review comments until checks pass and no actionable feedback remains. This step ends at a ready state — it does not merge the PR.

Keep track of the latest head SHA. Any new push changes the CI/review baseline and restarts this loop.

### Poll feedback first, then CI

Use a non-blocking polling loop until both review feedback and CI have settled. **Never use `gh pr checks --watch` or any other command that blocks until checks finish** because review feedback commonly arrives while CI is still running.

Each polling cycle must run in this order:

1. Fetch all new top-level comments, review summaries, inline comments, and unresolved review threads.
2. If actionable feedback exists, evaluate and address it immediately. Do not wait for pending checks; any fix will restart CI anyway.
3. Only when no actionable feedback remains, fetch the current check states and handle failures or pending checks.
4. If checks are still pending and no feedback needs action, sleep for a fixed interval, then begin a new cycle from step 1.

Use whatever non-blocking commands are available, such as:

- `gh pr view` for PR state, reviews, comments, and mergeability.
- Repeated `gh pr checks` without `--watch` for current check status.
- `gh run list`, `gh run view`, and `gh run rerun` for workflow failures and reruns.
- GitHub API/GraphQL to inspect review threads and unresolved conversations.

After every code push, comment reply, or thread resolution, restart from the latest head SHA and begin with a fresh feedback sweep.

### Handle failing or stuck checks

When a check fails or gets stuck, decide whether it looks flaky/infrastructure-related or caused by the PR.

**If it looks flaky or infrastructure-related:**

1. Try to rerun the failed job/check first.
2. If rerun is not available because of permissions or tooling limits, push an empty commit as a last-resort CI kick: confirm the working tree has no unrelated changes, then `git commit --allow-empty -m "chore: rerun CI"` and push.
3. After any rerun or empty commit, restart the loop from the latest head SHA.

**If it looks like a real failure:**

1. Read the failing logs enough to understand the cause.
2. Reproduce locally when practical.
3. Fix the root cause, not just the symptom.
4. Run the relevant local tests, linters, type checks, or targeted commands.
5. Commit only the intended changes and push, then restart the loop from the new head SHA.

Prefer rerunning before pushing an empty commit. Prefer fixing code before repeatedly rerunning a failure that has evidence of being real.

### Handle GitHub comments

Read all PR comments, review summaries, inline review comments, and unresolved review threads from both people and bots.

Evaluate every comment from two perspectives:

- Senior software engineer: correctness, maintainability, test coverage, reliability, security, architecture, readability, and long-term cost.
- Product designer: user behavior, UX clarity, accessibility, visual/system consistency, edge cases, and whether the implementation matches product intent.

For each comment, choose the path that best matches the intent of the PR:

1. **Apply the recommended fix** — the suggestion is right for the PR, so make it as described.
2. **Apply a better or different fix** — the comment points at a real issue, but a larger, more holistic, or a simpler fix more closely matches the PR's intent. Prefer the systemic fix over a band-aid, and use the design system and its tokens for UI work.
3. **Decline the fix** — the suggestion is not valid for the intention of the PR (incorrect, harmful, out of scope, or would work against the PR's goal).

After deciding:

- If you take path 1 or 2: make the code changes, commit, and push. Then **always comment back** explaining what changed, and **resolve the thread** when the comment is a resolvable review thread.
- If you take path 3: **always comment back** with a concise, respectful rationale for why you did not make the change, but **do not resolve** the thread — leave it open so the user can see that something was not resolved and decide for themselves.

Only review threads can be resolved. Top-level PR comments and review summaries are not resolvable threads, so reply to them when they call for it but do not try to resolve them.

After any code change, comment reply, or thread resolution, check whether new feedback arrived and restart this loop if needed.

### Done

The workflow is complete when all of the following are true on the latest head commit:

- Checks are passing.
- No actionable feedback remains. Every comment has either been addressed (fixed, committed, replied to, and its review thread resolved) or intentionally declined (replied to with a rationale and left open on purpose). Declined-but-open threads and non-resolvable top-level comments do not block the ready state — do not keep polling for them or try to resolve them.

When that state is reached, tell the user the PR is in a ready state, and include the PR URL, what CI/review issues you handled, and any commits you pushed. Stop watching unless the user asks you to keep going.

## Tone

Write from the perspective of a product designer explaining their thinking to engineers. Be clear and concise — just enough to establish intent. They can read the code; your job is to guide their understanding of the "why."
