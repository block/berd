import type { OAuthProviderEntry } from "@/features/connections/catalog";
import {
  CONNECTION_STATUS_PRIORITY,
  type ConnectionStatus,
} from "@/features/connections/lib/connectionStatus";
import {
  getDisplayName,
  type ExtensionEntry,
} from "@/features/extensions/types";

/**
 * One item in the unified Connections grid. Every MCP the user can see lives
 * in this single list:
 * - `oauth`: a service from the org-managed catalog, connected via OAuth.
 * - `extension`: a user-added custom MCP server.
 */
export type ConnectionGridItem =
  | { kind: "oauth"; entry: OAuthProviderEntry; status: ConnectionStatus }
  | { kind: "extension"; extension: ExtensionEntry };

export function gridItemKey(item: ConnectionGridItem): string {
  return item.kind === "oauth"
    ? `oauth:${item.entry.provider}`
    : `extension:${item.extension.config_key}`;
}

export function itemName(item: ConnectionGridItem): string {
  return item.kind === "oauth"
    ? item.entry.displayName
    : getDisplayName(item.extension);
}

export function itemDescription(item: ConnectionGridItem): string {
  if (item.kind === "oauth") return item.entry.description;
  const extension = item.extension;
  if (extension.description) return extension.description;
  if (extension.type === "stdio") return extension.cmd;
  if (extension.type === "streamable_http") return extension.uri;
  return extension.type;
}

/**
 * The grid renders as two sections separated by a divider:
 * - "active": connections that are yours — OAuth services you've connected
 *   (including expired/expiring ones needing attention) and every extension
 *   you added yourself.
 * - "inactive": inventory you haven't touched — OAuth services never
 *   connected (Connect button) and bundled extensions you never set up.
 */
export type ConnectionGridSection = "active" | "inactive";

export function itemSection(item: ConnectionGridItem): ConnectionGridSection {
  if (item.kind === "oauth") {
    return item.status.kind === "disconnected" ? "inactive" : "active";
  }
  // Bundled extensions were seeded by the app, not chosen by the user.
  const bundled =
    "bundled" in item.extension && item.extension.bundled === true;
  return bundled ? "inactive" : "active";
}

// Items needing attention (expired / expiring) sort first within their
// section; everything else is alphabetical so custom MCPs and healthy
// connections interleave naturally.
function itemAttentionBucket(item: ConnectionGridItem): number {
  if (item.kind === "extension") return 2;
  const priority = CONNECTION_STATUS_PRIORITY[item.status.kind];
  return priority <= 1 ? priority : 2;
}

export function compareGridItems(
  a: ConnectionGridItem,
  b: ConnectionGridItem,
): number {
  const sectionDiff =
    (itemSection(a) === "inactive" ? 1 : 0) -
    (itemSection(b) === "inactive" ? 1 : 0);
  if (sectionDiff !== 0) return sectionDiff;
  const bucketDiff = itemAttentionBucket(a) - itemAttentionBucket(b);
  if (bucketDiff !== 0) return bucketDiff;
  return itemName(a).localeCompare(itemName(b));
}

export function filterGridItems(
  items: ConnectionGridItem[],
  searchTerm: string,
): ConnectionGridItem[] {
  const query = searchTerm.trim().toLowerCase();
  if (!query) return items;
  return items.filter(
    (item) =>
      itemName(item).toLowerCase().includes(query) ||
      itemDescription(item).toLowerCase().includes(query),
  );
}
