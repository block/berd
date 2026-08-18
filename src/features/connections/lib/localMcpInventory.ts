import type {
  McpConfiguredServer,
  McpHarnessId,
  McpHarnessInventory,
  McpInventory,
} from "@/features/connections/api/localMcpInventory";

export interface McpInventoryGroup {
  id: string;
  displayName: string;
  entries: McpConfiguredServer[];
  harnesses: McpHarnessId[];
}

const HARNESS_ORDER: Record<McpHarnessId, number> = {
  goose: 0,
  claudeCode: 1,
  codex: 2,
};

export const HARNESS_LABELS: Record<McpHarnessId, string> = {
  goose: "Goose",
  claudeCode: "Claude Code",
  codex: "Codex",
};

function normalizeIdentity(value: string): string {
  // Config keys are harness-authored identity. Case differences are safe to
  // reconcile, but punctuation is meaningful: `block-app-kit` and
  // `block.app.kit` may point at entirely different servers.
  return value.trim().toLowerCase();
}

export function mcpIdentityKey(server: McpConfiguredServer): string {
  const configKey = normalizeIdentity(server.configKey);
  const name = normalizeIdentity(server.name);
  if (!configKey || !name) return server.id;

  // A shared key alone is not identity: generic names such as `server` and
  // `default` commonly point at unrelated implementations. Reconcile only
  // when independently authored name and transport evidence also agree.
  return `${configKey}:${name}:${server.transport}:${server.identityFingerprint}`;
}

function displayNameForGroup(entries: McpConfiguredServer[]): string {
  return (
    entries.find((entry) => entry.name.trim().length > 0)?.name.trim() ??
    "Unnamed MCP"
  );
}

function compareServers(
  a: McpConfiguredServer,
  b: McpConfiguredServer,
): number {
  return (
    HARNESS_ORDER[a.harness] - HARNESS_ORDER[b.harness] ||
    a.source.scope.localeCompare(b.source.scope) ||
    a.name.localeCompare(b.name)
  );
}

export function groupMcpServers(
  inventory: McpInventory | null | undefined,
): McpInventoryGroup[] {
  const groups = new Map<string, McpConfiguredServer[]>();

  for (const harness of inventory?.harnesses ?? []) {
    for (const server of harness.servers) {
      const key = mcpIdentityKey(server);
      const entries = groups.get(key) ?? [];
      entries.push(server);
      groups.set(key, entries);
    }
  }

  return [...groups.entries()]
    .map(([id, entries]) => {
      const sortedEntries = [...entries].sort(compareServers);
      const harnesses = Array.from(
        new Set(sortedEntries.map((entry) => entry.harness)),
      ).sort((a, b) => HARNESS_ORDER[a] - HARNESS_ORDER[b]);
      return {
        id,
        displayName: displayNameForGroup(sortedEntries),
        entries: sortedEntries,
        harnesses,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function filterMcpGroups(
  groups: McpInventoryGroup[],
  searchTerm: string,
): McpInventoryGroup[] {
  const query = searchTerm.trim().toLowerCase();
  if (!query) return groups;

  return groups.filter((group) => {
    const searchable = [
      group.displayName,
      ...group.entries.flatMap((entry) => [
        entry.configKey,
        entry.name,
        HARNESS_LABELS[entry.harness],
        entry.source.label,
        entry.source.scope,
        entry.transport,
      ]),
    ]
      .join(" ")
      .toLowerCase();
    return searchable.includes(query);
  });
}

export function harnessesWithErrors(
  inventory: McpInventory | undefined,
): McpHarnessInventory[] {
  return (inventory?.harnesses ?? []).filter(
    (harness) => harness.status === "partial" || harness.status === "error",
  );
}
