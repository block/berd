import { describe, expect, it } from "vitest";
import type { OAuthProviderEntry } from "@/features/connections/catalog";
import type { ConnectionStatus } from "@/features/connections/lib/connectionStatus";
import type { ExtensionEntry } from "@/features/extensions/types";
import {
  compareGridItems,
  type ConnectionGridItem,
  filterGridItems,
  itemDescription,
  itemName,
  itemSection,
} from "../connectionGrid";

function oauthItem(
  displayName: string,
  status: ConnectionStatus,
  description = "",
): ConnectionGridItem {
  const entry = {
    provider: displayName.toLowerCase().replace(/\s/g, "-"),
    displayName,
    description,
    Icon: () => null,
  } as unknown as OAuthProviderEntry;
  return { kind: "oauth", entry, status };
}

function extensionItem(
  name: string,
  description = "",
  overrides: Partial<ExtensionEntry> = {},
): ConnectionGridItem {
  return {
    kind: "extension",
    extension: {
      type: "stdio",
      name,
      description,
      cmd: "npx",
      args: [],
      config_key: name.toLowerCase(),
      enabled: true,
      ...overrides,
    } as ExtensionEntry,
  };
}

describe("connection grid", () => {
  it("sorts the active section first: attention items, then alphabetical", () => {
    const items: ConnectionGridItem[] = [
      extensionItem("Zulip MCP"),
      oauthItem("Slack", { kind: "active" }),
      oauthItem("Linear", { kind: "expired" }),
      extensionItem("Airtable MCP"),
      oauthItem("Google Drive", { kind: "expiring", daysUntilExpiry: 2 }),
    ];

    const sorted = [...items].sort(compareGridItems);

    expect(sorted.map(itemName)).toEqual([
      "Linear",
      "Google Drive",
      "Airtable MCP",
      "Slack",
      "Zulip MCP",
    ]);
  });

  it("sorts inactive items (never-connected oauth, bundled extensions) last", () => {
    const items: ConnectionGridItem[] = [
      oauthItem("Asana", { kind: "disconnected" }),
      extensionItem("Supabase", "", { bundled: true, enabled: false }),
      oauthItem("Slack", { kind: "active" }),
      extensionItem("my-mcp"),
      oauthItem("Linear", { kind: "expired" }),
    ];

    const sorted = [...items].sort(compareGridItems);

    expect(sorted.map(itemName)).toEqual([
      "Linear",
      "my-mcp",
      "Slack",
      "Asana",
      "Supabase",
    ]);
  });

  it("classifies sections: user's connections are active, untouched inventory is inactive", () => {
    expect(itemSection(oauthItem("Slack", { kind: "active" }))).toBe("active");
    expect(itemSection(oauthItem("Slack", { kind: "expired" }))).toBe("active");
    expect(
      itemSection(oauthItem("Slack", { kind: "expiring", daysUntilExpiry: 1 })),
    ).toBe("active");
    expect(itemSection(oauthItem("Asana", { kind: "disconnected" }))).toBe(
      "inactive",
    );
    expect(itemSection(extensionItem("my-mcp"))).toBe("active");
    expect(itemSection(extensionItem("Supabase", "", { bundled: true }))).toBe(
      "inactive",
    );
  });

  it("filters across both oauth and extension items by name and description", () => {
    const items: ConnectionGridItem[] = [
      oauthItem("Google Drive", { kind: "active" }, "Access your files"),
      extensionItem("my-tools", "Query the drive inventory"),
      extensionItem("unrelated"),
    ];

    expect(filterGridItems(items, "drive").map(itemName)).toEqual([
      "Google Drive",
      "my-tools",
    ]);
    expect(filterGridItems(items, "")).toHaveLength(3);
    expect(filterGridItems(items, "nothing-matches")).toHaveLength(0);
  });

  it("falls back to the command for stdio extensions without a description", () => {
    const item = extensionItem("bare");
    expect(itemDescription(item)).toBe("npx");
  });
});
