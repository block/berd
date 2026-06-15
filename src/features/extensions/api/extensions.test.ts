import { beforeEach, describe, expect, it, vi } from "vitest";
import { addExtension, listExtensions, toggleExtension } from "./extensions";

const mockGooseUnstableConfigExtensionsList = vi.fn();
const mockGooseUnstableConfigExtensionsAdd = vi.fn();
const mockGooseUnstableConfigExtensionsSetEnabled = vi.fn();

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({
    goose: {
      GooseUnstableConfigExtensionsList: mockGooseUnstableConfigExtensionsList,
      GooseUnstableConfigExtensionsAdd: mockGooseUnstableConfigExtensionsAdd,
      GooseUnstableConfigExtensionsSetEnabled:
        mockGooseUnstableConfigExtensionsSetEnabled,
    },
  }),
}));

describe("extensions api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes configured extensions from the Goose SDK shape", async () => {
    mockGooseUnstableConfigExtensionsList.mockResolvedValue({
      extensions: [
        {
          configKey: "github",
          enabled: true,
          extension: {
            type: "mcp",
            description: "GitHub MCP",
            envKeys: ["GITHUB_TOKEN"],
            server: {
              name: "github",
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-github"],
              env: [{ name: "DEBUG", value: "1" }],
            },
          },
        },
        {
          configKey: "remote",
          enabled: false,
          extension: {
            type: "mcp",
            description: "Remote MCP",
            server: {
              type: "http",
              name: "remote",
              url: "https://example.test/mcp",
              headers: [{ name: "Authorization", value: "Bearer token" }],
            },
          },
        },
      ],
    });

    await expect(listExtensions()).resolves.toEqual([
      {
        type: "stdio",
        name: "github",
        description: "GitHub MCP",
        cmd: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        envs: { DEBUG: "1" },
        env_keys: ["GITHUB_TOKEN"],
        config_key: "github",
        enabled: true,
      },
      {
        type: "streamable_http",
        name: "remote",
        description: "Remote MCP",
        uri: "https://example.test/mcp",
        headers: { Authorization: "Bearer token" },
        config_key: "remote",
        enabled: false,
      },
    ]);
  });

  it("adds extensions using the nested Goose SDK shape", async () => {
    await addExtension(
      "github",
      {
        type: "stdio",
        name: "github",
        description: "GitHub MCP",
        cmd: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        envs: { DEBUG: "1" },
        env_keys: ["GITHUB_TOKEN"],
      },
      true,
    );

    expect(mockGooseUnstableConfigExtensionsAdd).toHaveBeenCalledWith({
      enabled: true,
      extension: {
        type: "mcp",
        description: "GitHub MCP",
        bundled: undefined,
        timeout: undefined,
        envKeys: ["GITHUB_TOKEN"],
        server: {
          name: "github",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: [{ name: "DEBUG", value: "1" }],
        },
      },
    });
  });

  it("sets extension enabled state with the renamed SDK method", async () => {
    await toggleExtension("github", false);

    expect(mockGooseUnstableConfigExtensionsSetEnabled).toHaveBeenCalledWith({
      configKey: "github",
      enabled: false,
    });
  });
});
