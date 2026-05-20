import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { DEFAULT_PROJECT_COLOR } from "@/features/projects/lib/projectDefaults";
import { pillCssColor } from "@/features/projects/lib/pillTones";
import { useProjectStore } from "@/features/projects/stores/projectStore";

/**
 * Resolves the active chat session's project color as a CSS color string.
 * `ProjectInfo.color` stores a pill tone NAME ("pink", "olive", …) — this
 * hook maps it to the underlying hex via `pillCssColor`. Falls back to the
 * default tone for projects with no color set, and passes legacy hex values
 * through unchanged (so projects created before the tone migration keep
 * tinting). Returns null only when there's no project association at all.
 * The route gate (only-tint-when-on-chat-view) lives at the application
 * point in AppShell, not here — this hook stays a pure
 * session→project→color selector so it has one named place to test.
 */
export function useActiveProjectTint(): string | null {
  const activeSessionId = useChatSessionStore((s) => s.activeSessionId);
  const sessions = useChatSessionStore((s) => s.sessions);
  const projects = useProjectStore((s) => s.projects);

  if (!activeSessionId) return null;
  const session = sessions.find((s) => s.id === activeSessionId);
  if (!session?.projectId) return null;
  const project = projects.find((p) => p.id === session.projectId);
  if (!project) return null;
  const stored = project.color || DEFAULT_PROJECT_COLOR;
  // Tone name → hex; legacy hex passes through; anything else falls back.
  return pillCssColor(stored) ?? (stored.startsWith("#") ? stored : null);
}
