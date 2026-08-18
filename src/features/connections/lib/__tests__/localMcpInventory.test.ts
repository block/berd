import { describe, expect, it } from "vitest";
import type { McpInventory } from "@/features/connections/api/localMcpInventory";
import {
  filterMcpGroups,
  groupMcpServers,
  harnessesWithErrors,
} from "../localMcpInventory";

const inventory: McpInventory = {
  harnesses: [
    {
      harness: "goose",
      status: "configured",
      checkedLocations: [],
      servers: [
        {
          id: "goose:github",
          harness: "goose",
          source: { scope: "user", label: "Goose user config", path: "/g" },
          configKey: "github",
          name: "GitHub",
          transport: "stdio",
          enabled: true,
          command: "npx",
          urlHost: null,
        },
      ],
      message: null,
    },
    {
      harness: "claudeCode",
      status: "configured",
      checkedLocations: [],
      servers: [
        {
          id: "claude:github",
          harness: "claudeCode",
          source: {
            scope: "project",
            label: "Claude Code project config",
            path: "/repo/.mcp.json",
          },
          configKey: "github",
          name: "github",
          transport: "http",
          enabled: null,
          command: null,
          urlHost: "api.githubcopilot.com",
        },
        {
          id: "claude:context7",
          harness: "claudeCode",
          source: {
            scope: "project",
            label: "Claude Code project config",
            path: "/repo/.mcp.json",
          },
          configKey: "context7",
          name: "Context7",
          transport: "http",
          enabled: null,
          command: null,
          urlHost: "mcp.context7.com",
        },
      ],
      message: null,
    },
    {
      harness: "codex",
      status: "error",
      checkedLocations: [],
      servers: [],
      message: "Codex user config could not be parsed.",
    },
  ],
};

describe("MCP inventory grouping", () => {
  it("groups same-name MCPs across harnesses while preserving entries", () => {
    const groups = groupMcpServers(inventory);

    expect(groups.map((group) => group.displayName)).toEqual([
      "Context7",
      "GitHub",
    ]);
    expect(groups.find((group) => group.id === "github")?.harnesses).toEqual([
      "goose",
      "claudeCode",
    ]);
    expect(groups.find((group) => group.id === "github")?.entries).toHaveLength(
      2,
    );
  });

  it("does not merge punctuation-distinct config keys", () => {
    const collidingInventory: McpInventory = {
      harnesses: [
        {
          harness: "goose",
          status: "configured",
          checkedLocations: [],
          servers: [
            {
              id: "goose:block-app-kit",
              harness: "goose",
              source: { scope: "user", label: "Goose user config" },
              configKey: "block-app-kit",
              name: "Block App Kit",
              transport: "stdio",
            },
          ],
        },
        {
          harness: "codex",
          status: "configured",
          checkedLocations: [],
          servers: [
            {
              id: "codex:block.app.kit",
              harness: "codex",
              source: { scope: "user", label: "Codex user config" },
              configKey: "block.app.kit",
              name: "Block App Kit",
              transport: "stdio",
            },
          ],
        },
      ],
    };

    expect(groupMcpServers(collidingInventory)).toHaveLength(2);
  });

  it("filters by harness, source, transport, and safe endpoint host", () => {
    const groups = groupMcpServers(inventory);

    expect(filterMcpGroups(groups, "context7")).toHaveLength(1);
    expect(filterMcpGroups(groups, "Claude Code")).toHaveLength(2);
    expect(filterMcpGroups(groups, "mcp.context7.com")[0].id).toBe("context7");
  });

  it("exposes harness errors separately from configured groups", () => {
    expect(
      harnessesWithErrors(inventory).map((harness) => harness.harness),
    ).toEqual(["codex"]);
  });
});
