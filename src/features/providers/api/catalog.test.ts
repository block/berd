import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import {
  listProviderSetupCatalog,
  mapProviderSetupCatalogEntryDto,
  selectSetupCatalogModelProviders,
  selectDatabricksHostConfigProvider,
} from "./catalog";

const mocks = vi.hoisted(() => ({
  catalogList: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: () => mocks.getClient(),
}));

describe("provider setup catalog API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClient.mockResolvedValue({
      goose: {
        GooseUnstableProvidersSetupCatalogList: mocks.catalogList,
      },
    });
  });

  it("maps setup catalog DTO fields to provider catalog entries", () => {
    expect(
      mapProviderSetupCatalogEntryDto({
        providerId: "claude-acp",
        name: "Claude Code",
        docUrl: "https://docs.anthropic.com/en/docs/claude-code",
        category: "agent",
        description: "Anthropic's agentic coding tool",
        setupMethod: "cli_auth",
        binaryName: "claude-agent-acp",
        group: "default",
        showOnlyWhenInstalled: false,
        aliases: ["claude-acp", "claude_code", "claude"],
        supportsInstall: true,
        supportsAuth: true,
        supportsAuthStatus: true,
      }),
    ).toEqual({
      id: "claude-acp",
      displayName: "Claude Code",
      category: "agent",
      catalogSource: "setup",
      setupCatalogProvider: true,
      description: "Anthropic's agentic coding tool",
      setupMethod: "cli_auth",
      binaryName: "claude-agent-acp",
      docsUrl: "https://docs.anthropic.com/en/docs/claude-code",
      group: "default",
      showOnlyWhenInstalled: false,
      aliases: ["claude-acp", "claude_code", "claude-code", "claude"],
      supportsInstall: true,
      supportsAuth: true,
      supportsAuthStatus: true,
    });
  });

  it("requests the setup catalog through ACP", async () => {
    mocks.catalogList.mockResolvedValue({
      providers: [
        {
          providerId: "ollama",
          name: "Ollama",
          category: "model",
          description: "Run local models",
          setupMethod: "config_fields",
          fields: [
            {
              key: "OLLAMA_HOST",
              label: "Host",
              secret: false,
              required: true,
            },
          ],
          group: "default",
          showOnlyWhenInstalled: false,
          supportsInstall: false,
          supportsAuth: false,
          supportsAuthStatus: false,
        },
      ],
    });

    await expect(listProviderSetupCatalog()).resolves.toEqual([
      {
        id: "ollama",
        displayName: "Ollama",
        category: "model",
        catalogSource: "setup",
        setupCatalogProvider: true,
        description: "Run local models",
        setupMethod: "config_fields",
        fields: [
          {
            key: "OLLAMA_HOST",
            label: "Host",
            secret: false,
            required: true,
          },
        ],
        group: "default",
        showOnlyWhenInstalled: false,
        supportsInstall: false,
        supportsAuth: false,
        supportsAuthStatus: false,
      },
    ]);
    expect(mocks.catalogList).toHaveBeenCalledWith({});
  });
});

describe("selectSetupCatalogModelProviders", () => {
  function entry(id: string, withFields = true): ProviderCatalogEntry {
    return {
      id,
      displayName: id,
      category: "model",
      description: id,
      setupMethod: "single_api_key",
      group: "default",
      catalogSource: "setup",
      ...(withFields
        ? {
            fields: [
              {
                key: `${id.toUpperCase()}_API_KEY`,
                label: "API Key",
                secret: true,
                required: true,
              },
            ],
          }
        : {}),
    };
  }

  it("keeps model providers, excluding agent providers and legacy databricks v1", () => {
    expect(
      selectSetupCatalogModelProviders([
        entry("openai"),
        entry("databricks"),
        entry("databricks_v2"),
        entry("anthropic"),
        { ...entry("claude-acp"), category: "agent" },
        entry("ollama", false),
      ]).map((provider) => provider.id),
    ).toEqual(["openai", "databricks_v2", "anthropic", "ollama"]);
  });

  it("selects the Databricks setup fields when an editable host is available", () => {
    expect(
      selectDatabricksHostConfigProvider([
        {
          ...entry("databricks_v2"),
          fields: [
            {
              key: "DATABRICKS_HOST",
              label: "Host URL",
              secret: false,
              required: true,
            },
            {
              key: "DATABRICKS_TOKEN",
              label: "Access Token",
              secret: true,
              required: false,
            },
          ],
        },
      ])?.fields?.map((field) => field.key),
    ).toEqual(["DATABRICKS_HOST", "DATABRICKS_TOKEN"]);
  });
});
