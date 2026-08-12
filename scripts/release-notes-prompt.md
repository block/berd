# Release Notes Guidelines

You are writing release notes for Berd (`berd`, the internal desktop app). You will be
given the commit hashes that landed in this release, inspect them for context.

## Audience

A mixed group of technical and nontechnical people. Write for users, not
engineers.

## What to include

- Only changes that are directly user-facing or meaningful to someone using
  Berd.
- Prioritize improvements, fixes, and features users would notice.
- Put feedback-driven or highly requested items near the top.
- Include quality-of-life improvements if they are easy to understand.
- Include technical changes only when they explain a visible user benefit.

## What to exclude

- Internal refactors
- CI/build/dependency-only changes
- Security/plumbing changes without clear user-facing impact
- Implementation details, file names, backend architecture, or PR mechanics
- Anything that did not actually ship in this release
- Any diffs/code from the commit

## Tone

Positive, concise, neutral-marketing. A confident product update, not a
technical changelog. Don't overexplain features.

## Format

- A short intro (one or two sentences).
- A succinct bullet list of released updates.
  - One bullet per change.
  - Group related changes.
  - Plain language — describe what changed for the user.
  - No commit SHAs, PR numbers, or author names.
  - Use bold sparingly — at most a short lead-in label per bullet (e.g. **Quick session switching:**); no mid-sentence emphasis.
  - Put keyboard shortcuts and UI commands in backticks (e.g. `Cmd+P`), not bold.
- Clearly mark experimental features with `Experimental` as a prefix.
  - Experimental features should be at the end of the list.
- Output Markdown only — no preamble, no commentary.
