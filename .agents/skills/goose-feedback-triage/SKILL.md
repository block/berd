---
name: goose-feedback-triage
description: Triage and organize the Goose Internal Feedback Linear project. Use when asked to clean up, classify, prioritize, group, parent, deduplicate, or organize Goose Internal feedback tickets from the Linear feedback board.
---

# Goose Feedback Triage

Use this skill to keep the Goose Internal Feedback Linear project organized while preserving the integrity of individual user feedback tickets.

Default board:

- Project: `Goose Internal Feedback`
- Project URL: `https://linear.app/squareup/project/goose-internal-feedback-afb3fe63541b`
- Project ID: `30020116-3f42-4309-8b98-83a3d4a7b284`
- Team: `BOT` / `Builderbot`

## Operating Principle

Treat incoming feedback as user evidence. Do not collapse distinct user reports into one issue unless the user explicitly asks for duplicate marking. Prefer parent issues with subissues for related workstreams, because that preserves the original reports, screenshots, comments, and user context.

Make the smallest useful change:

1. Verify or add category and priority.
2. Organize new standalone issues into existing or new parent issues.
3. Recommend duplicate marking only for literal duplicate reports.
4. Confirm before creating new parent issues or changing hierarchy unless the user clearly asks you to do it.

## Tools

Use `sq agent-tools linear` for Linear work.

Start with:

```bash
sq agent-tools linear --help
sq agent-tools linear execute-graphql --query 'query($projectId: ID!) { issues(first: 100, filter: { project: { id: { eq: $projectId } } }) { nodes { id identifier title description priority url estimate state { name type } parent { identifier title } children(first: 20) { nodes { identifier title } } labels { nodes { id name } } assignee { name } createdAt updatedAt } } } }' --variables '{"projectId":"30020116-3f42-4309-8b98-83a3d4a7b284"}'
```

Prefer direct GraphQL mutations for precise issue updates. The friendly `save-issue` command can be useful for simple reads or creates, but for category, priority, and parent links use GraphQL so only the intended fields change.

## First Pass: Category And Priority

Every issue should have exactly one of these category labels:

- `bug`: broken behavior, regressions, errors, missing expected controls, flows that fail, confusing system failures.
- `improvement`: polish or extension of an existing surface, better clarity, better affordance, better visibility, better error copy.
- `feature request`: net-new capability, substantial parity ask, new workflow, new product surface, import/migration capability.

Use the team label IDs when mutating:

- `bug`: `cfd9897c-1973-49b1-91e9-a998fbce3533`
- `improvement`: `db0998e9-5bd8-4d71-b433-1ab7154721a3`
- `feature request`: `9079830e-9f9f-455d-9e7b-8a32a58f91bb`

Priority scale:

- `1` Urgent: major blocker, widespread breakage, security/safety, or executive/business-critical interruption.
- `2` High: blocks core use, migration, provider/model access, automation execution, or repeated high-value workflows.
- `3` Medium: meaningful usability/productivity issue, common workflow improvement, useful parity ask.
- `4` Low: small polish, already done/duplicate evidence, nice-to-have, low blast radius.
- `0` None: avoid for triaged issues unless the issue is too unclear to classify.

When a category or priority already exists, verify that it makes sense from the title, description, comments, state, and surrounding issues. Change it only when it is clearly wrong.

When updating category or priority, use a mutation shaped like:

```bash
sq agent-tools linear execute-graphql \
  --query 'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { identifier priority labels { nodes { id name } } } } }' \
  --variables '{"id":"ISSUE_UUID","input":{"priority":3,"labelIds":["LABEL_UUID"]}}'
```

This replaces the issue's label set with the chosen category label. If the issue has meaningful non-category labels, preserve them by including their IDs as well.

## Second Pass: Organize Standalone Issues

Focus on issues that still need organization:

- Issues with no `parent`.
- Issues with no `children`.
- Issues not already marked `duplicate`.
- Issues added or updated since the last cleanup.

Still compare against existing parent issues and existing children so new feedback can join an established group.

Use these questions:

- Does this issue belong under an existing parent workstream?
- Is it a literal duplicate of another ticket, or just related evidence?
- Would several standalone issues be easier to plan as one parent with subissues?
- Would one PR likely touch the same component, command, API boundary, or state machine?

Prefer linking to an existing parent when one already captures the workstream.

Known parent patterns from the first cleanup:

- Legacy recipe/skill migration: `BOT-696`
- Automation workflow parity: `BOT-697`
- Skills organization and discovery: `BOT-698`
- Provider setup and error handling: `BOT-699`
- Agent builder/editor save reliability: `BOT-700`

Likely implementation surfaces:

- Recipes, skills, and migration: `src/features/skills`, `src/features/migration`, `src-tauri/src/services/bundled_skills.rs`
- Automations: `src/features/automations`, `src-tauri/src/commands/automations.rs`
- Provider setup: `src/features/providers`, `src/features/settings`, `src/features/agents`, `src-tauri/src/commands/agent_setup.rs`
- Agent editing: `src/features/agents`
- Chat input and timeline: `src/features/chat/ui`, `src/features/chat/hooks`, `src/features/chat/lib`
- Projects: `src/features/projects`
- Connections: `src/features/connections`
- Window/app shell: `src-tauri`, `src/features/layout`, Tauri config/capabilities

## Parent Issues

Create a parent issue when several standalone issues share a real planning/implementation surface and no existing parent already fits.

Parent issue style:

- Title names the workstream, not one reporter's symptom.
- Description starts with the user need.
- Description lists the subissue evidence by identifier.
- Use the best category label and priority for the combined workstream.
- Create in the same `Goose Internal Feedback` project and `BOT` team.

After creating the parent, set each child issue's `parentId`.

Use direct GraphQL:

```bash
sq agent-tools linear execute-graphql \
  --query 'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { identifier parent { identifier title } } } }' \
  --variables '{"id":"CHILD_ISSUE_UUID","input":{"parentId":"PARENT_ISSUE_UUID"}}'
```

Do not change child state, assignee, labels, priority, description, or comments while linking children unless explicitly asked.

## Duplicate Recommendations

Only recommend duplicate marking when two issues are the same report or the same bug with no meaningful difference in user scenario.

When in doubt, use parent/subissue or related links instead of duplicate status.

If proposing duplicates, give the user a table:

- Canonical issue
- Candidate duplicate
- Evidence for duplicate
- What context would be lost, if any
- Recommendation

Do not mark duplicates without user approval unless the user explicitly asks you to.

## Output Shape

For a read-only pass, return a concise table:

- Proposed parent/workstream
- Candidate issues
- Reason they belong together
- Recommendation: existing parent, create parent, duplicate candidate, or leave standalone

For an execution pass, summarize:

- Category/priority changes made.
- Parent issues created.
- Subissue links created.
- Any issues intentionally left standalone.
- Any duplicate candidates that still need user approval.

Always include Linear links for newly created parent issues.

## Verification

After mutations, verify:

- Every touched issue has the intended category and priority.
- Every linked subissue shows the intended parent.
- Newly created parents show the intended children.
- No accidental state, assignee, or project changes occurred.

Use a final read query and report the verified result.
