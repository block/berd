import { describe, expect, it } from "vitest";
import type { ProviderTemplate } from "@/features/providers/ui/CustomProviderForm";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import {
  mergeProviderChoices,
  PROMOTED_PROVIDER_IDS,
  searchProviderChoices,
  selectPromotedAndConnectedProviderChoices,
} from "./providerDirectory";

function setup(
  id: string,
  displayName: string,
  overrides: Partial<ProviderCatalogEntry> = {},
): ProviderCatalogEntry {
  return {
    id,
    displayName,
    category: "model",
    description: `${displayName} setup description`,
    setupMethod: "single_api_key",
    group: "default",
    ...overrides,
  };
}

function template(
  id: string,
  displayName: string,
  overrides: Partial<ProviderTemplate> = {},
): ProviderTemplate {
  return {
    id,
    displayName,
    engine: "openai_compatible",
    apiUrl: `https://${id}.example.com`,
    requiresAuth: true,
    supportsStreaming: true,
    models: [],
    headers: [],
    ...overrides,
  };
}

describe("mergeProviderChoices", () => {
  it("merges model setup entries and templates as discriminated choices", () => {
    const choices = mergeProviderChoices(
      [
        setup("openai", "OpenAI"),
        setup("goose", "Goose", { category: "agent" }),
      ],
      [template("groq", "Groq")],
    );

    expect(choices).toHaveLength(2);
    expect(choices[0]).toMatchObject({
      kind: "setup",
      id: "openai",
      entry: { id: "openai" },
    });
    expect(choices[1]).toMatchObject({
      kind: "template",
      id: "groq",
      template: { id: "groq" },
    });
  });

  it("deduplicates canonical IDs case-insensitively and lets setup win", () => {
    const choices = mergeProviderChoices(
      [setup("OpenAI", "OpenAI setup")],
      [
        template("openai", "OpenAI template"),
        template("GROQ", "Groq first"),
        template("groq", "Groq duplicate"),
      ],
    );

    expect(choices.map(({ kind, id }) => ({ kind, id }))).toEqual([
      { kind: "setup", id: "OpenAI" },
      { kind: "template", id: "GROQ" },
    ]);
  });

  it("lets native provider aliases suppress equivalent templates", () => {
    const choices = mergeProviderChoices(
      [setup("google", "Google", { aliases: ["gemini"] })],
      [template("gemini", "Gemini template")],
    );

    expect(choices.map(({ kind, id }) => ({ kind, id }))).toEqual([
      { kind: "setup", id: "google" },
    ]);
  });

  it("keeps distinct IDs that share a display name", () => {
    const choices = mergeProviderChoices(
      [setup("first", "Shared Provider")],
      [template("second", "Shared Provider")],
    );

    expect(choices.map((choice) => choice.id)).toEqual(["first", "second"]);
  });

  it("applies product-facing names without changing provider identities", () => {
    const google = setup("google", "Google", { aliases: ["vertex"] });
    const databricks = setup("databricks", "Databricks");
    const databricksV2 = setup("databricks_v2", "Databricks AI Gateway");
    const choices = mergeProviderChoices(
      [google, databricks, databricksV2],
      [],
    );

    expect(choices).toMatchObject([
      {
        kind: "setup",
        id: "google",
        displayName: "Gemini",
        entry: google,
      },
      {
        kind: "setup",
        id: "databricks",
        displayName: "Databricks Model Serving",
        entry: databricks,
      },
      {
        kind: "setup",
        id: "databricks_v2",
        displayName: "Databricks",
        entry: databricksV2,
      },
    ]);
  });
});

describe("searchProviderChoices", () => {
  const choices = mergeProviderChoices(
    [
      setup("google", "Google", {
        description: "Generative AI from Alphabet",
        aliases: ["vertex-ai", "palm"],
      }),
    ],
    [
      template("local-stack", "Local Stack", {
        description: "Runs on your machine",
        engine: "ollama_compatible",
        models: ["llama-3.3", "deepseek-r1"],
      }),
    ],
  );

  it.each([
    ["Gemini", "google"],
    ["Google", "google"],
    ["google", "google"],
    ["Alphabet", "google"],
    ["vertex-ai", "google"],
    ["Local Stack", "local-stack"],
    ["local-stack", "local-stack"],
    ["machine", "local-stack"],
    ["ollama", "local-stack"],
    ["deepseek-r1", "local-stack"],
  ])("searches %s", (query, expectedId) => {
    expect(
      searchProviderChoices(choices, query).map((choice) => choice.id),
    ).toEqual([expectedId]);
  });

  it("returns every choice for blank search", () => {
    expect(searchProviderChoices(choices, "  ")).toEqual(choices);
  });
});

describe("provider promotion", () => {
  it("exports the product promotion order", () => {
    expect(PROMOTED_PROVIDER_IDS).toEqual([
      "anthropic",
      "google",
      "openai",
      "openrouter",
    ]);
  });

  it("selects available promoted choices in order, then connected non-promoted choices", () => {
    const choices = mergeProviderChoices(
      [
        setup("extra", "Extra"),
        setup("openrouter", "OpenRouter"),
        setup("anthropic", "Anthropic"),
        setup("connected-custom", "Connected Custom"),
        setup("google", "Google"),
      ],
      [],
    );

    expect(
      selectPromotedAndConnectedProviderChoices(choices, [
        "CONNECTED-CUSTOM",
        "extra",
        "anthropic",
      ]).map((choice) => choice.id),
    ).toEqual([
      "anthropic",
      "google",
      "openrouter",
      "extra",
      "connected-custom",
    ]);
  });
});
