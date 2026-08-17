import { getHomeDir, readTextFile, recordMeHistory } from "@/shared/api/system";
import { publishMeFile } from "./mePublish";

/**
 * Attribution for direct agent edits to memory files.
 *
 * Agents with file tools can edit `~/.me/*.md` directly when the user
 * tells them to ("update my family memories…"). We deliberately don't
 * block that — a confirmation after an explicit instruction is consent
 * theater — but the paper trail must say who made the change. Without
 * this, the next load sweeps the edit in as "Edited outside Berd", which
 * is wrong attribution.
 *
 * The chat notification handler calls `noteAgentMemoryEdits` when a tool
 * call completes with file locations. Anything under `~/.me/` gets a
 * history commit attributed to the agent; a spine edit also re-publishes
 * so the agents-file blocks other tools read stay current. Best-effort
 * throughout — attribution must never break chat.
 */

let cachedHomeDir: string | null = null;

async function homeDir(): Promise<string> {
  if (cachedHomeDir === null) {
    cachedHomeDir = await getHomeDir();
  }
  return cachedHomeDir;
}

/**
 * Paths under `~/.me/` that are memory documents.
 *
 * The spine sits at the root and topic docs live in `topics/`, so both
 * shapes count — a direct agent edit to `topics/family.md` needs the same
 * attribution as one to `me.md`. Everything else under `~/.me/` (the
 * proposal queue, tombstones, git internals) is excluded.
 */
export function filterMemoryPaths(paths: string[], home: string): string[] {
  const root = `${home}/.me/`;
  return [
    ...new Set(
      paths.filter((path) => {
        if (!path.startsWith(root) || !path.endsWith(".md")) return false;
        const relative = path.slice(root.length);
        if (!relative.includes("/")) return true;
        // One level deep, and only the topics folder.
        const [folder, ...rest] = relative.split("/");
        return folder === "topics" && rest.length === 1;
      }),
    ),
  ];
}

/**
 * Record agent attribution for any completed tool-call locations that are
 * memory files. Returns quietly on any failure.
 */
export async function noteAgentMemoryEdits(
  paths: string[],
  agentName?: string,
): Promise<void> {
  if (paths.length === 0) return;
  try {
    const home = await homeDir();
    const memoryPaths = filterMemoryPaths(paths, home);
    if (memoryPaths.length === 0) return;

    const source = `agent-edit:${agentName?.trim() || "Agent"}`;
    for (const path of memoryPaths) {
      await recordMeHistory(path, source).catch(() => {});
      if (path === `${home}/.me/me.md`) {
        // Spine changed: keep the published blocks other tools read current.
        try {
          const payload = await readTextFile(path);
          await publishMeFile(payload.contents);
        } catch {
          // Publication is best-effort, same as every other write path.
        }
      }
    }
  } catch {
    // Attribution must never break chat.
  }
}
