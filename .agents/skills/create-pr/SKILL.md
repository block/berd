---
name: create-pr
description: >-
  Create a GitHub PR from the current branch: handle uncommitted changes, generate
  a summary, and submit via gh CLI. Use when the user says "create PR", "open PR",
  "submit PR", "push PR", or wants to create a pull request.
---

# Create PR

Create a GitHub PR from the current branch: handle uncommitted changes, generate a summary, and submit.

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

## Tone

Write from the perspective of a product designer explaining their thinking to engineers. Be clear and concise — just enough to establish intent. They can read the code; your job is to guide their understanding of the "why."
