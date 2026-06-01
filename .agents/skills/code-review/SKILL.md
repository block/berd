---
name: code-review
description: >-
  Senior engineer code review focused on catching issues before they become PR
  comments. Reviews only changed lines, categorizes issues by priority, and fixes
  them one by one. Use when the user says "code review", "review my code",
  "review this branch", or wants pre-PR feedback.
---

# Pre-PR Code Review

You are a senior engineer conducting a thorough code review. Review **only the lines that changed** in this branch and provide actionable feedback on correctness, product behavior, maintainability, accessibility, tests, and project conventions. Do not flag issues in unchanged code, but follow changed code paths into surrounding modules when needed to verify a changed-line issue.

## Determine Files To Review

**Before starting the review**, identify which files to review by checking:

1. **Resolve the review base branch**:
   - Prefer the branch's upstream merge base when one exists
   - Otherwise, discover the default branch with `git remote show origin`
   - Fall back to `origin/main` only if the repo does not expose a default branch

2. **Run git commands** to check both:
   - Committed changes: `git diff --name-only <base>...HEAD`
   - Unstaged/staged changes: `git status --short`

3. **Ask the user which set to review** if both exist:
   - If there are both committed changes and unstaged/staged changes, ask: "I see both committed changes and unstaged/staged changes. Which would you like me to review?"
     - **Option A**: Committed changes in this branch (compare against the review base)
     - **Option B**: Current unstaged/staged changes
     - **Option C**: Both

4. **Proceed automatically** if only one set exists:
   - If only committed changes exist, review those
   - If only unstaged/staged changes exist, review those
   - If neither exists, tell the user there are no changes to review

5. **Get the file list** based on the user's choice:
   - For committed changes: use `git diff --name-only <base>...HEAD`
   - For unstaged/staged: use `git diff --name-only` and `git diff --cached --name-only`
   - Filter to only include files that still exist, unless deleted files are relevant to the review

**Only proceed with the review once you have the specific list of files to review.**

## Review Passes

Run these as passes, then consolidate findings before presenting them. A finding should appear once, even if multiple sections support it.

- Use the baseline safety pass for correctness, regressions, data flow, async state, accessibility, i18n completeness, CI failures, and obvious cleanup.
- Use the maintainability pass for decomposition, layering, hooks vs helpers, type hygiene, duplication, naming, module boundaries, and refactor structure.
- Prefer the repo's existing architecture, naming, test patterns, and design system over generic advice.
- Do not duplicate the same underlying concern across passes. Report each issue once under the clearest framing.

### Baseline Safety Pass

#### Correctness And Product Behavior
- Does the change preserve the intended user flow?
- Are edge cases, empty states, error states, and loading states handled?
- Could a user see stale, misleading, or contradictory state after a failed action?
- Are optimistic updates paired with rollback or confirmation when needed?
- Are defaults, saved preferences, cached values, and fallbacks validated before reuse?
- Do parent-child state changes clear or recompute dependent values so stale state does not linger?

#### React And Frontend Best Practices
- Are functional components and hooks used consistently where the project uses React?
- Are hooks called at the top level and in a stable order?
- Is state scoped to the smallest reasonable owner?
- Are list keys stable and unique?
- Are props and component contracts clear?
- Are expensive computations memoized only when needed?
- Are race conditions avoided in effects, async handlers, and animations?

#### Type Safety
- Is `const` used by default, with `let` only when reassignment is needed?
- Are types explicit enough to protect the behavior without adding noise?
- Are `any`, unchecked type assertions, and non-null assertions avoided?
- Are nullable values handled with guards or optional chaining?
- Are repeated or verbose inline object shapes extracted into named types when that improves readability?
- Are shared types placed where the repo expects shared contracts to live?

#### Design System And Styling
- Are design system components, tokens, and utilities used instead of custom styling?
- Are raw HTML controls avoided when the repo has shared primitives for the same job?
- Are theme tokens used for colors that must work across themes?
- For design-system changes, check the local guidance in `DESIGN.md`, `docs/color-token-mapping.md`, `src/shared/ui/AGENTS.md`, and `src/features/design-system/AGENTS.md` before judging the implementation.
- Check every changed visual surface in both light and dark mode. Missing dark-mode support is a review issue, not visual polish.
- Flag raw light/dark colors in component code, such as `text-black`, `bg-white`, `border-gray-*`, hex colors, or inline color styles, unless there is an approved design-system exception.
- Do not accept component-local `dark:` class patches for new color behavior when a semantic token can own the theme switch. New reusable color behavior must use semantic tokens with both `:root` and `.dark` values.
- When a PR adds a new token, require the token to have the right theme mapping, Tailwind bridge if needed, design-system manifest/docs coverage, and state coverage for default, hover, active/open, disabled, and focus-visible states.
- If a component creates a new visual pattern with repeated light/dark behavior, flag it as a design-system issue unless it is implemented as a shared variant or tokenized component pattern.
- Treat missing dark-mode support, raw light/dark colors, and new tokens without dark-mode mapping as [Must Fix] design-system findings unless the PR includes an explicit approved exception.
- New token names must describe product meaning, anatomy, property, and state, not the literal color or implementation. Use names shaped like `--<scope>-<role>-<property>` or `--<scope>-<role>-<property>-<state>`, such as `--app-top-bar-control-fg-disabled`; reject names like `--black-icon`, `--gray-hover`, `--light-button`, or broad aliases that duplicate shadcn tokens.
- Use shadcn token names first for shared anatomy (`background`, `foreground`, `card`, `popover`, `muted`, `accent`, `primary`, `destructive`, `border`, `input`, `ring`). Goose extension tokens are allowed only for narrow product-specific surfaces or identities that do not map honestly to shadcn.
- Shared component APIs must carry reusable visual behavior. Add or extend a `variant` when the component needs a reusable visual treatment, intent, or product-surface role. Add or extend `size` when only spatial scale changes. Add a named prop when the component owns a semantic behavior or state, such as `loading`, `selected`, `invalid`, `open`, `feedbackState`, or `leftIcon`.
- Do not add boolean props that only toggle arbitrary class bundles. If a prop would mean "make it black", "add the special hover", or "use this one-off layout", require a semantic variant, size, token, or small composed wrapper instead.
- `className` in feature code may handle local layout and positioning. It must not be the primary home for repeated color, typography, radius, shadow, icon sizing, hover, active, selected, disabled, or focus behavior. Flag repeated `className` styling as a design-system issue.
- If a PR adds or changes a shared component variant, prop, token, or state, require the design-system explorer/manifest/token docs to stay in sync and expect `pnpm design-system:generate`, `pnpm design-system:tokens`, `pnpm design-system:manifest-check`, and relevant checks/tests to pass.
- Are utility classes static and compatible with the project's build tooling?
- Does the layout work across the breakpoints this feature supports?
- Are visual changes consistent with the existing product surface?

#### Accessibility And Internationalization
- Are interactive controls keyboard-accessible and semantically correct?
- Do icon-only or color-only affordances have text alternatives?
- Are focus, selected, expanded, and disabled states exposed when relevant?
- Are user-facing strings routed through the project's localization system when one exists?
- Are translation keys stable and updated across required locales?
- Are user-facing errors understandable and routed through shared notification/error primitives?

#### Async State, Data Flow, And Boundaries
- Is there a clear source of truth for data that crosses component, feature, storage, or service boundaries?
- Does UI state update at the right time relative to persisted or service-confirmed state?
- Are service/API/client calls kept in the repo's expected layer instead of embedded in render-heavy components?
- Do best-effort lookups fail softly when the primary user flow can continue?
- Are request, response, and persistence shapes kept minimal and consumed on both sides of the boundary?

#### Code Cleanliness
- Are there leftover `console.log` statements, commented-out code, unused imports, dead exports, or unrelated files?
- Are names clear and domain-specific?
- Are magic numbers or hard-coded policies named or explained?
- Are comments reserved for non-obvious decisions rather than restating the code?
- Are unrelated changes separated from the branch's main purpose?

#### Tests And Verification
- Did logic move without moving or adding the right tests?
- Are new or changed behaviors covered at the right level?
- Are brittle tests asserting implementation details instead of user-visible behavior?
- Were obsolete tests removed only when the protected behavior was intentionally removed?

### Maintainability Pass

Use this focused pass when the user asks about cleanup, maintainability, decomposition, layering, type hygiene, duplication, dead code, readability, or extensibility.

Keep the focus on behavior-preserving improvement. Favor the repo's existing architecture and patterns over broad refactor advice.

- Review changed code for refactor quality, not just correctness.
- Review the final shape of the changed code, not whether it is better than what came before.
- Judge changes by whether they leave the code easier to maintain and extend in future work.
- Ask for approval before making code changes unless the user explicitly asks for fixes.

#### Smell Checklist
Before finalizing the review, explicitly ask:

- Is any view, module, or class still doing too many jobs?
- Is pure derivation logic trapped in a UI or orchestration layer?
- Is repeated async workflow ready for a focused helper or hook?
- Are helpers duplicated or living in the wrong layer?
- Are large inline shapes making the code hard to scan?
- Did logic move without moving or adding the right tests?
- Did the refactor preserve feature wiring while improving structure?

#### Size And Decomposition
- Treat these as smell thresholds, not hard limits:
  - components around 200 lines
  - functions around 40 lines
  - files around 300 lines
  - JSX nesting around 4 levels
- Treat many unrelated state variables, handlers, and effects in one place as a smell even when line count is acceptable.
- Treat a file that owns multiple unrelated responsibilities across loading, derivation, mutation, and rendering as a smell unless there is a strong project reason.
- Split by responsibility, not by arbitrary line count.
- If a component or module does more than its name claims, rename it or split it.
- When substantial pure logic appears in UI code, prefer extracting it into pure helpers with direct tests.
- When substantial effectful workflow logic appears in UI code, prefer extracting it into a focused hook or orchestration helper consistent with the repo.

#### Layer Discipline
- Keep rendering, state orchestration, transport, persistence, and pure domain logic in the layers where the project already expects them.
- Do not introduce a new architectural layer for a small local problem.
- Keep pure helpers free of framework, DOM, storage, network, or process side effects.
- Keep transport/client modules free of UI imports and presentation policy.
- Do not move local state into global state unless multiple consumers genuinely need it.
- If logic lives in the wrong layer after the PR, report that as an issue even if the PR reduced the amount of misplaced logic.

#### Module Encapsulation
- Export the minimum surface a module needs to share.
- Keep helpers, constants, and intermediate transforms private unless another module genuinely needs them.
- Treat removing stale exports as a quality improvement.
- If a helper is used in only one module, default to keeping it local.
- If similar helpers appear across modules, consider extracting them when the shared shape is stable.

#### Duplication And Abstractions
- Extract shared behavior once duplication is clear and the shared abstraction is stable.
- Two call sites can be enough when the shared shape is obvious and both call sites become simpler.
- Prefer hooks or stateful helpers for shared React state/effect orchestration.
- Prefer pure helpers for React-independent transforms, normalization, formatting, or parsing.
- Do not use a hook as the default extraction target for oversized components.
- Do not hide simple code behind an abstraction that makes the behavior harder to see.

## Review And Fix Process

### Step 0: Run Quality Checks

Before reading code, establish a baseline with the project's non-mutating checks.

1. Inspect project docs and scripts for the expected check commands. Useful places include `README`, `AGENTS.md`, `package.json`, `justfile`, `Makefile`, CI config, and language-specific config files.
2. Prefer check-only commands so the baseline does not mutate the working tree.
3. If a standard check command formats or rewrites files, do not run it as the baseline unless the user explicitly agrees or the tree is clean and you can clearly separate formatting output from authored changes.
4. Run targeted tests for the changed area when the project makes them easy to identify.

Report the results as pass/fail. Any quality-check failure that blocks merge should appear at the top of the findings list as a high-priority issue.

### Step 1: Conduct Review

For each file in the review list:

1. Run the relevant `git diff` command for that file to get the exact changed lines.
2. Review only changed lines against the review passes, following changed code paths into surrounding modules when needed to verify an issue.
3. For stateful UI or async flow changes, trace the user action through local state, persistence, service calls, success handling, and failure handling.
4. For refactors, run the maintainability pass before finalizing findings.
5. Note the file path and line numbers from the diff output for each issue found.

### Step 2: Categorize Issues

Assign each issue a priority level:

- **P0**: Breaks functionality, build/type errors, security issues, or merge-blocking quality-check failures
- **P1-P2**: Performance problems, accessibility issues, code quality risks, unnecessary complexity, poor practices, design system violations
- **P3**: Style inconsistencies, minor improvements, missing type safety, animation issues, theme token usage
- **P4**: Cleanup, console logs, unused imports, dead code, unnecessary comments, unrelated changes

If many high-severity issues exist in a file, assess whether a focused refactor would be simpler than individual fixes.

### Step 3: Present Findings

After reviewing all files, provide:

- **Summary**: total files reviewed and an overall quality rating from 1-5 stars
- **Issues**: a single numbered list ordered by priority, P0 first and P4 last

Each issue must follow this format:

```text
1. Short Issue Title (P0) [Must Fix]
   - Description of the issue and why it matters
   - User effect if this ships
   - Recommended fix

2. Short Issue Title (P3) [Your Call]
   - Description of the issue and why it may or may not need addressing
   - User effect if this ships
   - Recommended fix if the user chooses to act on it
```

Write the user-effect bullet in product language: describe what the user would experience, misunderstand, lose, or be blocked from doing if the issue reached production.

Use a short, descriptive title (3-6 words max) so issues can be referenced by number.

### Step 3b: Self-Check

Before presenting findings to the user, silently review the issue list:

1. For each issue, ask whether it is genuinely a problem or could be intentional/acceptable.
2. For each remaining issue, ask whether the recommended fix actually improves the code or is only a preference.
3. For async state or data-flow issues, ask whether state can truly disagree after a failure, fallback, or delayed update.
4. For refactor issues, ask whether a confirmed final-shape smell survives in decomposition, layering, effects, helpers, type shapes, duplication, tests, or feature wiring.

After these passes, tag each surviving issue as one of:

- **[Must Fix]**: clear violation, likely to get flagged in PR review
- **[Your Call]**: valid concern that may be intentional or a reasonable tradeoff

Only present issues that survived these passes.

Merge duplicate concerns before presenting findings. If there are no issues, say that clearly and mention any remaining test gaps or residual risk.

### Step 4: Fix Issues

**Before fixing**, ask: "Would you like me to fix these issues in order, or do you have questions about any of them first? I will fix each issue one by one and ask for approval before moving to the next one."

**When approved**, work through issues one at a time in numbered order, P0 through P4. After each fix:

1. Explain what changed and why.
2. Ask: "Does that look good? Ready to move on to issue [N]?"
3. Wait for confirmation before proceeding to the next issue.

When adding documentation comments:

- Only add comments for non-obvious things: magic numbers, complex logic, design decisions, or workarounds.
- If you call out something as confusing or hard-coded in your review and suggest documentation, it is acceptable to add a comment when approved.
- Do not add comments that simply restate what the code does.

Cleanup tasks like removing comments should be done last, because earlier fixes might introduce new comments that also need cleanup.

### Step 5: Ready To Ship

Once all approved issues are fixed, display:

---

**Code review complete. All approved issues have been addressed.**

Your code is ready to commit and push. Run the repo's configured gates before opening or updating the PR.

Next steps: generate a PR summary that explains the intent of this change, what files were modified and why, and how to verify the changes work.

---
