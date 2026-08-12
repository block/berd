/**
 * Decides whether a freshly-appeared artifact is *important enough* to pop the
 * viewer open on its own.
 *
 * The viewer's original auto-open rule was `isViewableArtifact(path)` — a pure
 * file-extension test. That made auto-open fire for machinery: reading a
 * markdown file, a skill writing agent instructions to `~/.agents/...`, a
 * throwaway PR-body temp file, or any screenshot a browser skill captured.
 *
 * "Viewable" (can this render in the panel?) and "important" (should it steal
 * the user's attention?) are different questions. `artifactViewerTypes` owns
 * the first; this module owns the second. Manual opens still only need
 * viewability — a user who clicks a file has already expressed intent.
 *
 * A candidate must clear four gates:
 *   1. Markdown only — documents are deliverables; images are usually
 *      incidental (screenshots, diagrams) and stay manually viewable.
 *   2. Produced by a write, never a read.
 *   3. Inside a place the user works: the session cwd OR the artifact root.
 *   4. Not agent machinery (skills, agent instructions, VCS/build scratch).
 */
import type { ToolKind } from "@/shared/types/messages";
import { isPathWithin } from "@/shared/lib/pathIdentity";
import type { Platform } from "@/shared/lib/platform";
import { artifactBasename, classifyArtifactView } from "./artifactViewerTypes";

/**
 * Tool kinds that produce content worth surfacing. `move` counts: a renamed
 * deliverable is still a deliverable at its new path.
 */
const WRITE_TOOL_KINDS: ReadonlySet<string> = new Set(["edit", "move"]);

/**
 * Kinds that definitively are not authorship. `delete` is excluded on purpose
 * — there is nothing left to render. These short-circuit before the tool-name
 * fallback so a tool named `read_file` can't be rescued by a name token.
 */
const NON_WRITE_TOOL_KINDS: ReadonlySet<string> = new Set([
  "read",
  "search",
  "fetch",
  "think",
  "switch_mode",
  "delete",
]);

/**
 * Substrings that imply authorship, used only when `toolKind` is absent or
 * non-committal. `toolKind` is optional on the ACP wire (the notification
 * handler writes it conditionally), so a strict kind allowlist would silently
 * disable auto-open against agents that omit it.
 */
const WRITE_NAME_TOKENS: readonly string[] = [
  "write",
  "edit",
  "create",
  "update",
  "replace",
  "insert",
  "patch",
  "append",
  "save",
];

/**
 * Path segments that mark agent/tool machinery rather than user deliverables.
 * Matched as whole segments so a legitimate `docs/target-audience.md` isn't
 * caught by the `target` build-output entry.
 */
const MACHINERY_SEGMENTS: ReadonlySet<string> = new Set([
  ".agents",
  ".goose",
  ".claude",
  ".git",
  ".github",
  ".cache",
  ".venv",
  "node_modules",
  "target",
  "dist",
  "build",
  "coverage",
  "__pycache__",
]);

/**
 * Files that are instructions *to* an agent or VCS plumbing, not documents
 * *for* the user. These are the "agent-browser skill wrote instructions" and
 * "PR copy was created" cases.
 */
const MACHINERY_FILENAMES: ReadonlySet<string> = new Set([
  "skill.md",
  "agents.md",
  "claude.md",
  "gemini.md",
  "goose.md",
  "cursorrules.md",
  "commit_editmsg",
  "pr_body.md",
  "pr-body.md",
  "pull_request_template.md",
]);

/** Machinery-ish basename shapes that a fixed list would miss. */
const MACHINERY_FILENAME_PATTERNS: readonly RegExp[] = [
  /^pr[-_.]?(body|description|desc|copy)\b/i,
  /^(commit|merge|squash)[-_.]?(msg|message)\b/i,
];

function normalize(path: string): string {
  return path.replace(/\\/g, "/").trim();
}

/**
 * True when the tool that touched this path was authoring it. `toolKind` wins
 * when it is decisive; otherwise the tool name breaks the tie.
 */
export function isWriteLikeTool(
  toolKind: ToolKind | string | null | undefined,
  toolName: string | null | undefined,
): boolean {
  if (toolKind) {
    if (WRITE_TOOL_KINDS.has(toolKind)) return true;
    if (NON_WRITE_TOOL_KINDS.has(toolKind)) return false;
    // "execute" / "other" are non-committal — fall through to the name.
  }
  if (!toolName) return false;
  const lower = toolName.toLowerCase();
  return WRITE_NAME_TOKENS.some((token) => lower.includes(token));
}

/** True when the path looks like agent/build machinery rather than a document. */
export function isMachineryPath(path: string): boolean {
  const normalized = normalize(path);
  if (!normalized) return true;

  const segments = normalized.split("/").filter(Boolean);
  // Drop the basename; only directory segments are checked for machinery dirs.
  for (const segment of segments.slice(0, -1)) {
    if (MACHINERY_SEGMENTS.has(segment.toLowerCase())) return true;
  }

  const filename = artifactBasename(normalized).toLowerCase();
  if (MACHINERY_FILENAMES.has(filename)) return true;
  return MACHINERY_FILENAME_PATTERNS.some((pattern) => pattern.test(filename));
}

/**
 * True when `resolvedPath` is `base` itself or a descendant of it.
 *
 * This is the single containment check for artifact scoping — the policy
 * gates here and `ArtifactPolicyContext`'s markdown-href scoping both consume
 * it, so the two surfaces cannot drift. Comparison is boundary-terminated
 * (a sibling like `/work-secrets` is not inside `/work`) and delegates case
 * handling to the shared path-identity module: Windows drive/UNC and macOS
 * paths fold case; Linux paths remain case-sensitive.
 */
export function isWithinBase(
  base: string | null | undefined,
  resolvedPath: string,
  platform?: Platform,
): boolean {
  return isPathWithin(base, resolvedPath, platform);
}

/**
 * True when the path sits under any of the places the user actually works.
 *
 * There is more than one such place. Project-backed sessions work in the
 * session cwd, but a projectless "general" chat has no project root and writes
 * to the artifact root instead (`~/goose artifacts` by default, or whatever
 * Settings points at) — `sessionActivation` falls back to it and even tells the
 * agent to treat it as the working directory. Checking the cwd alone meant a
 * projectless "write me a blog post" could never auto-open, which was a bug
 * rather than a policy decision.
 *
 * Empty/nullish roots are ignored, so passing none still yields false.
 */
export function isWithinWorkRoots(
  roots: readonly (string | null | undefined)[],
  resolvedPath: string,
): boolean {
  return roots.some((root) => isWithinBase(root, resolvedPath));
}

export interface AutoOpenCandidate {
  resolvedPath: string;
  toolKind?: ToolKind | string | null;
  toolName?: string | null;
}

export interface AutoOpenRoots {
  /** Session working directory, when the session has one. */
  sessionCwd?: string | null;
  /**
   * Artifact root for projectless chats. Kept distinct from `sessionCwd` so
   * the reason a path qualified stays legible.
   */
  artifactRoot?: string | null;
}

/**
 * The single predicate auto-open should consult. Ordered cheapest-first; each
 * gate is independently defensible, so a surprising auto-open can be traced to
 * exactly one rule.
 */
export function shouldAutoOpenArtifact(
  candidate: AutoOpenCandidate,
  roots: AutoOpenRoots,
): boolean {
  const { resolvedPath } = candidate;
  if (!resolvedPath) return false;

  // 1. Documents only — images stay manually viewable.
  if (classifyArtifactView(resolvedPath) !== "markdown") return false;

  // 2. Authored, not merely read.
  if (!isWriteLikeTool(candidate.toolKind, candidate.toolName)) return false;

  // 3. Somewhere the user works: the session cwd or the artifact root. A
  //    session with neither never auto-opens, which is the conservative
  //    outcome.
  if (
    !isWithinWorkRoots([roots.sessionCwd, roots.artifactRoot], resolvedPath)
  ) {
    return false;
  }

  // 4. Not agent machinery.
  if (isMachineryPath(resolvedPath)) return false;

  return true;
}
