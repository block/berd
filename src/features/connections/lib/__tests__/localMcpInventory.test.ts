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
          source: { scope: "user", label: "Goose user config" },
          configKey: "github",
          name: "GitHub",
          transport: "stdio",
          identityFingerprint: "stdio-shared",
          enabled: true,
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
          },
          configKey: "github",
          name: "GitHub",
          transport: "stdio",
          identityFingerprint: "stdio-shared",
          enabled: null,
        },
        {
          id: "claude:context7",
          harness: "claudeCode",
          source: {
            scope: "project",
            label: "Claude Code project config",
          },
          configKey: "context7",
          name: "Context7",
          transport: "http",
          identityFingerprint: "http-shared",
          enabled: null,
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
    const github = groups.find((group) => group.displayName === "GitHub");
    expect(github?.harnesses).toEqual(["goose", "claudeCode"]);
    expect(github?.entries).toHaveLength(2);
  });

  it("does not merge same-key servers with different structural evidence", () => {
    const collidingInventory: McpInventory = {
      harnesses: [
        {
          harness: "goose",
          status: "configured",
          checkedLocations: [],
          servers: [
            {
              id: "goose:default",
              harness: "goose",
              source: { scope: "user", label: "Goose user config" },
              configKey: "default",
              name: "GitHub",
              transport: "stdio",
              identityFingerprint: "stdio-shared",
            },
          ],
        },
        {
          harness: "codex",
          status: "configured",
          checkedLocations: [],
          servers: [
            {
              id: "codex:default",
              harness: "codex",
              source: { scope: "user", label: "Codex user config" },
              configKey: "default",
              name: "Context7",
              transport: "http",
              identityFingerprint: "http-shared",
            },
          ],
        },
      ],
    };

    expect(groupMcpServers(collidingInventory)).toHaveLength(2);
  });

  it("does not merge same-key name and transport with different targets", () => {
    const targetCollision: McpInventory = {
      harnesses: [
        {
          harness: "goose",
          status: "configured",
          checkedLocations: [],
          servers: [
            {
              id: "goose:github",
              harness: "goose",
              source: { scope: "user", label: "Goose user config" },
              configKey: "github",
              name: "GitHub",
              transport: "stdio",
              identityFingerprint: "target-one",
            },
          ],
        },
        {
          harness: "codex",
          status: "configured",
          checkedLocations: [],
          servers: [
            {
              id: "codex:github",
              harness: "codex",
              source: { scope: "user", label: "Codex user config" },
              configKey: "github",
              name: "GitHub",
              transport: "stdio",
              identityFingerprint: "target-two",
            },
          ],
        },
      ],
    };

    expect(groupMcpServers(targetCollision)).toHaveLength(2);
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
              identityFingerprint: "stdio-shared",
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
              identityFingerprint: "stdio-shared",
            },
          ],
        },
      ],
    };

    expect(groupMcpServers(collidingInventory)).toHaveLength(2);
  });

  it("filters by visible identity, harness, source, and transport", () => {
    const groups = groupMcpServers(inventory);

    expect(filterMcpGroups(groups, "context7")).toHaveLength(1);
    expect(filterMcpGroups(groups, "Claude Code")).toHaveLength(2);
    expect(filterMcpGroups(groups, "http")).toHaveLength(1);
  });

  it("exposes harness errors separately from configured groups", () => {
    expect(
      harnessesWithErrors(inventory).map((harness) => harness.harness),
    ).toEqual(["codex"]);
  });
});
