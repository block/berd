import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_CONFIG,
  runtimeConfigSchema,
  runtimeConfigSourceSchema,
} from "./schema";

const managedProvider = {
  id: "databricks_v2",
  displayName: "Databricks AI Gateway",
  description: "Databricks AI Gateway models",
  setupMethod: "host_with_oauth_fallback" as const,
  group: "default" as const,
  aliases: ["databricks_v2", "databricks", "databricks-ai-gateway"],
  nativeConnectQuery: "databricks",
  models: [
    { id: "goose-gpt-5-5", name: "GPT-5.5", recommended: true },
    { id: "goose-gpt-5-6-sol", name: "GPT-5.6 Sol", featured: true },
  ],
};

const managedRuntimeConfig = {
  ...DEFAULT_RUNTIME_CONFIG,
  goose: {
    defaultModelProviderId: managedProvider.id,
    defaultModelId: managedProvider.models[0].id,
    modelProviders: [managedProvider],
  },
};

describe("runtimeConfigSchema", () => {
  function configWithProviders(
    modelProviders: unknown[],
    goose: Record<string, unknown> = {},
  ) {
    return {
      ...managedRuntimeConfig,
      goose: {
        ...managedRuntimeConfig.goose,
        ...goose,
        modelProviders,
      },
    };
  }

  function configWithProvider(provider: unknown) {
    return configWithProviders([provider]);
  }

  function configWithEndpointEnv(endpointEnv: Record<string, string>) {
    return configWithProvider({ ...managedProvider, endpointEnv });
  }

  function configWithCustomProvider(customProvider: Record<string, unknown>) {
    return configWithProviders(
      [
        {
          id: "block_openai_compatible",
          displayName: "Block AI Gateway",
          customProvider: {
            providerId: "block_openai_compatible",
            engine: "openai_compatible",
            displayName: "Block AI Gateway",
            apiUrl: "https://example.internal/openai/v1",
            requiresAuth: false,
            ...customProvider,
          },
          models: [{ id: "goose-gpt-5-5", name: "GPT-5.5" }],
        },
      ],
      { defaultModelProviderId: "block_openai_compatible" },
    );
  }

  function expectRuntimeConfigIssue(
    config: unknown,
    path: (string | number)[],
    message: RegExp,
  ) {
    const result = runtimeConfigSchema.safeParse(config);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path,
            message: expect.stringMatching(message),
          }),
        ]),
      );
    }
  }

  it("accepts the default runtime config", () => {
    expect(runtimeConfigSchema.parse(DEFAULT_RUNTIME_CONFIG)).toEqual(
      DEFAULT_RUNTIME_CONFIG,
    );
  });

  it("accepts distribution-owned response feedback policy", () => {
    expect(
      runtimeConfigSchema.parse({
        ...DEFAULT_RUNTIME_CONFIG,
        feedback: {
          enabled: true,
          responseRatingEnabled: true,
          sessionSurveySamplingRateBasisPoints: 250,
        },
      }).feedback,
    ).toEqual({
      enabled: true,
      responseRatingEnabled: true,
      sessionSurveySamplingRateBasisPoints: 250,
    });
  });

  it("accepts an empty managed-provider list as unrestricted policy", () => {
    expect(runtimeConfigSchema.parse(DEFAULT_RUNTIME_CONFIG)).toEqual(
      DEFAULT_RUNTIME_CONFIG,
    );
  });

  it("rejects defaults when the managed-provider list is empty", () => {
    expectRuntimeConfigIssue(
      {
        ...DEFAULT_RUNTIME_CONFIG,
        goose: {
          defaultModelProviderId: "databricks_v2",
          defaultModelId: "goose-gpt-5-5",
          modelProviders: [],
        },
      },
      ["goose", "defaultModelProviderId"],
      /must be omitted/,
    );
  });

  it("requires a default provider when managed providers are declared", () => {
    expectRuntimeConfigIssue(
      configWithProviders([managedProvider], {
        defaultModelProviderId: undefined,
        defaultModelId: undefined,
      }),
      ["goose", "defaultModelProviderId"],
      /is required/,
    );
  });

  it("allows a default model omitted from recommendation metadata", () => {
    const config = {
      ...managedRuntimeConfig,
      goose: {
        ...managedRuntimeConfig.goose,
        defaultModelId: "new-upstream-model",
      },
    };

    expect(runtimeConfigSchema.parse(config).goose.defaultModelId).toBe(
      "new-upstream-model",
    );
  });

  it("accepts the bundledFile source variant", () => {
    // Parity with RuntimeConfigSource::BundledFile in
    // src-tauri/src/commands/runtime_config.rs: a restricted build loads the
    // bundled runtime-config.json and reports this source, so the renderer must
    // parse it.
    expect(runtimeConfigSourceSchema.parse("bundledFile")).toBe("bundledFile");
  });

  it.each([
    [
      "default provider id",
      configWithProviders([managedProvider], {
        defaultModelProviderId: ` ${managedRuntimeConfig.goose.defaultModelProviderId} `,
      }),
      ["goose", "defaultModelProviderId"],
    ],
    [
      "default model id",
      configWithProviders([managedProvider], {
        defaultModelId: ` ${managedRuntimeConfig.goose.defaultModelId} `,
      }),
      ["goose", "defaultModelId"],
    ],
    [
      "model provider id",
      configWithProvider({
        ...managedProvider,
        id: ` ${managedProvider.id} `,
      }),
      ["goose", "modelProviders", 0, "id"],
    ],
    [
      "custom provider id",
      configWithCustomProvider({
        providerId: " block_openai_compatible ",
        engine: "anthropic",
      }),
      ["goose", "modelProviders", 0, "customProvider", "providerId"],
    ],
    [
      "fast model id",
      configWithProvider({
        ...managedProvider,
        fastModelId: " goose-fast-model ",
      }),
      ["goose", "modelProviders", 0, "fastModelId"],
    ],
    [
      "allowed model id prefix",
      configWithProvider({
        ...managedProvider,
        allowedModelIdPrefixes: [" team.approved. "],
      }),
      ["goose", "modelProviders", 0, "allowedModelIdPrefixes", 0],
    ],
    [
      "model id",
      configWithProvider({
        ...managedProvider,
        models: [
          {
            ...managedProvider.models[0],
            id: ` ${managedProvider.models[0].id} `,
          },
        ],
      }),
      ["goose", "modelProviders", 0, "models", 0, "id"],
    ],
  ] satisfies Array<
    [string, unknown, (string | number)[]]
  >)("rejects whitespace-padded %s", (_label, config, path) => {
    expectRuntimeConfigIssue(config, path, /leading or trailing whitespace/);
  });

  it("accepts a provider model id prefix allowlist", () => {
    expect(() =>
      runtimeConfigSchema.parse(
        configWithProvider({
          ...managedProvider,
          allowedModelIdPrefixes: ["goose-", "team.approved."],
        }),
      ),
    ).not.toThrow();
  });

  it("rejects a model id prefix allowlist on another provider", () => {
    expect(() =>
      runtimeConfigSchema.parse(
        configWithProvider({
          ...managedProvider,
          id: "other-managed",
          allowedModelIdPrefixes: ["team."],
        }),
      ),
    ).toThrow(/supported only for databricks_v2/);
  });

  it.each([
    ["empty", []],
    ["duplicate", ["goose-", "goose-"]],
  ])("rejects a model id prefix allowlist that is %s", (_label, prefixes) => {
    expect(() =>
      runtimeConfigSchema.parse(
        configWithProvider({
          ...managedProvider,
          allowedModelIdPrefixes: prefixes,
        }),
      ),
    ).toThrow(/allowedModelIdPrefixes/);
  });

  it("accepts a provider that declares a fastModelId", () => {
    // Stock defaults declare no fastModelId (the release-time distribution
    // injector supplies it), so pin acceptance with an explicit fixture.
    expect(() =>
      runtimeConfigSchema.parse(
        configWithProvider({
          ...managedProvider,
          fastModelId: "goose-fast-model",
        }),
      ),
    ).not.toThrow();
  });

  it("rejects duplicate provider aliases", () => {
    expect(() =>
      runtimeConfigSchema.parse(
        configWithProvider({
          ...managedProvider,
          aliases: ["openai", " openai "],
        }),
      ),
    ).toThrow(/aliases must not contain duplicates/);
  });

  it("rejects duplicate goose provider ids", () => {
    expect(() =>
      runtimeConfigSchema.parse(
        configWithProviders([
          managedProvider,
          {
            id: "databricks_v2",
            displayName: "Duplicate Databricks",
            models: [{ id: "goose-gpt-5-5", name: "GPT-5.5" }],
          },
        ]),
      ),
    ).toThrow(/duplicate provider 'databricks_v2'/);
  });

  it("rejects duplicate model ids within a model provider", () => {
    expect(() =>
      runtimeConfigSchema.parse(
        configWithProvider({
          ...managedProvider,
          models: [
            { id: "goose-gpt-5-5", name: "GPT-5.5" },
            { id: "goose-gpt-5-5", name: "GPT-5.5 duplicate" },
          ],
        }),
      ),
    ).toThrow(/duplicate model 'goose-gpt-5-5'/);
  });

  it("accepts benign custom provider headers", () => {
    // Mirrored in src-tauri/src/commands/runtime_config.rs to keep TS/Rust parity.
    expect(() =>
      runtimeConfigSchema.parse(
        configWithCustomProvider({
          headers: { "X-Goose-Runtime": "enabled" },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects secret-looking custom provider headers", () => {
    expect(() =>
      runtimeConfigSchema.parse(
        configWithCustomProvider({
          headers: { Authorization: "Bearer nope" },
        }),
      ),
    ).toThrow(/secret-looking/);
  });

  it.each([
    "HOME",
    "SSL_CERT_FILE",
    "NODE_OPTIONS",
    "PYTHONPATH",
    "GOOSE_CONFIG_FILE",
    "PATH",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "CUSTOM_PROXY",
    "databricks_host",
    "OPENAI_API_KEY",
  ])("rejects invalid endpoint env key %s", (key) => {
    expect(() =>
      runtimeConfigSchema.parse(configWithEndpointEnv({ [key]: "value" })),
    ).toThrow(/endpointEnv key is not allowed/);
  });

  it("rejects secret-looking endpoint env values", () => {
    expect(() =>
      runtimeConfigSchema.parse(
        configWithEndpointEnv({ DATABRICKS_HOST: "Bearer nope" }),
      ),
    ).toThrow(/secret-looking/);
  });

  it("allows only runtime-owned endpoint env keys", () => {
    expect(
      runtimeConfigSchema.parse(
        configWithEndpointEnv({
          DATABRICKS_HOST: "https://example.internal",
        }),
      ),
    ).toMatchObject(
      configWithEndpointEnv({
        DATABRICKS_HOST: "https://example.internal",
      }),
    );

    expect(() =>
      runtimeConfigSchema.parse(configWithEndpointEnv({ HOME: "value" })),
    ).toThrow(/endpointEnv key is not allowed/);
  });

  it("rejects custom provider ids that do not match the model provider id", () => {
    expect(() =>
      runtimeConfigSchema.parse(
        configWithCustomProvider({ providerId: "other_provider" }),
      ),
    ).toThrow(/providerId must match/);
  });

  it("rejects reserved admin custom providers with the wrong engine", () => {
    expect(() =>
      runtimeConfigSchema.parse(
        configWithCustomProvider({ engine: "anthropic" }),
      ),
    ).toThrow(/block_openai_compatible must use engine openai_compatible/);
  });

  it("rejects unsupported provider setup enum values", () => {
    expect(() =>
      runtimeConfigSchema.parse(
        configWithProvider({ ...managedProvider, setupMethod: "magic" }),
      ),
    ).toThrow(/Invalid option/);

    expect(() =>
      runtimeConfigSchema.parse(
        configWithProvider({ ...managedProvider, group: "primary" }),
      ),
    ).toThrow(/Invalid option/);

    expect(() =>
      runtimeConfigSchema.parse(
        configWithProvider({
          ...managedProvider,
          modelInventoryMode: "dynamic",
        }),
      ),
    ).toThrow(/Invalid option/);
  });
});
