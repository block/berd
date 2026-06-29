import { describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG, runtimeConfigSchema } from "./schema";

const defaultProvider = DEFAULT_RUNTIME_CONFIG.goose.modelProviders[0];

describe("runtimeConfigSchema", () => {
  function configWithProviders(
    modelProviders: unknown[],
    goose: Record<string, unknown> = {},
  ) {
    return {
      ...DEFAULT_RUNTIME_CONFIG,
      goose: {
        ...DEFAULT_RUNTIME_CONFIG.goose,
        ...goose,
        modelProviders,
      },
    };
  }

  function configWithProvider(provider: unknown) {
    return configWithProviders([provider]);
  }

  function configWithEndpointEnv(endpointEnv: Record<string, string>) {
    return configWithProvider({ ...defaultProvider, endpointEnv });
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

  it.each([
    [
      "default provider id",
      configWithProviders([defaultProvider], {
        defaultModelProviderId: ` ${DEFAULT_RUNTIME_CONFIG.goose.defaultModelProviderId} `,
      }),
      ["goose", "defaultModelProviderId"],
    ],
    [
      "default model id",
      configWithProviders([defaultProvider], {
        defaultModelId: ` ${DEFAULT_RUNTIME_CONFIG.goose.defaultModelId} `,
      }),
      ["goose", "defaultModelId"],
    ],
    [
      "model provider id",
      configWithProvider({
        ...defaultProvider,
        id: ` ${defaultProvider.id} `,
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
      "model id",
      configWithProvider({
        ...defaultProvider,
        models: [
          {
            ...defaultProvider.models[0],
            id: ` ${defaultProvider.models[0].id} `,
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

  it("rejects duplicate provider aliases", () => {
    expect(() =>
      runtimeConfigSchema.parse(
        configWithProvider({
          ...defaultProvider,
          aliases: ["openai", " openai "],
        }),
      ),
    ).toThrow(/aliases must not contain duplicates/);
  });

  it("rejects duplicate goose provider ids", () => {
    expect(() =>
      runtimeConfigSchema.parse(
        configWithProviders([
          defaultProvider,
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
          ...defaultProvider,
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
        configWithProvider({ ...defaultProvider, setupMethod: "magic" }),
      ),
    ).toThrow(/Invalid option/);

    expect(() =>
      runtimeConfigSchema.parse(
        configWithProvider({ ...defaultProvider, group: "primary" }),
      ),
    ).toThrow(/Invalid option/);

    expect(() =>
      runtimeConfigSchema.parse(
        configWithProvider({
          ...defaultProvider,
          modelInventoryMode: "dynamic",
        }),
      ),
    ).toThrow(/Invalid option/);
  });
});
