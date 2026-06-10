import toolLabels from "./toolLabels.json";

// `toolLabels.json` is vendored from g2 (`squareup/g2`: `web/src/assets/tools.json`).
// Keys are kgoose `namespace__tool` identifiers; values are the human-readable
// labels g2's chat UI shows for each tool. g2's `web` package is private, so the
// list cannot be imported cross-repo — keep this copy in sync whenever g2 adds or
// relabels tools.
const vendoredLabels: Record<string, string> = toolLabels;

// App-local labels for tools g2 does not define. `tile__render_tile` drives this
// app's automation draft preview (see `TILE_RENDER_TOOL_NAME` in
// `features/automations/api/automationBuilder.ts`); g2 has no label for it, so we
// add one here rather than in `toolLabels.json` to keep that file a faithful
// mirror of g2 — otherwise a re-sync from g2 would silently drop this entry.
const localLabels: Record<string, string> = {
  tile__render_tile: "Update automation draft",
};

/**
 * Resolve a kgoose `namespace__tool` identifier to its human-readable label.
 * App-local labels win over the vendored g2 list, and both fall back to the raw
 * tool name for tools missing from either — the same fallback semantics g2 uses.
 */
export function getToolLabel(toolName: string): string {
  return localLabels[toolName] ?? vendoredLabels[toolName] ?? toolName;
}
