import { z } from "zod/v4";
import type {
  ProviderGroup,
  ProviderSetupMethod,
} from "@/shared/types/providers";

function nonEmptyString(field: string) {
  return z
    .string()
    .refine((value) => value.trim().length > 0, `${field} must not be empty`);
}

function runtimeIdString(field: string) {
  return nonEmptyString(field).refine(
    (value) => value === value.trim(),
    `${field} must not have leading or trailing whitespace`,
  );
}

function hasUniqueTrimmedValues(values: readonly string[]) {
  const normalized = values.map((value) => value.trim());
  return new Set(normalized).size === normalized.length;
}

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const nonSecretRecordSchema = z
  .record(nonEmptyString("config keys"), nonEmptyString("config values"))
  .refine((values) => {
    const secretPattern =
      /secret|token|apikey|api-key|api_key|password|authorization|bearer/i;
    return Object.entries(values).every(
      ([key, value]) => !secretPattern.test(`${key} ${value}`),
    );
  }, "runtime config must not contain secret-looking keys or values");

const endpointEnvSecretPattern =
  /key|token|secret|password|authorization|bearer/i;

const allowedEndpointEnvKeys: readonly string[] = ["DATABRICKS_HOST"];

const endpointEnvKeySchema = nonEmptyString("endpointEnv keys").refine(
  (key) => allowedEndpointEnvKeys.includes(key),
  "endpointEnv key is not allowed for runtime config",
);

const endpointEnvValueSchema = nonEmptyString("endpointEnv values").refine(
  (value) => !endpointEnvSecretPattern.test(value),
  "endpointEnv must not contain secret-looking keys or values",
);

const endpointEnvSchema = z.record(
  endpointEnvKeySchema,
  endpointEnvValueSchema,
);

const providerSetupMethods = [
  "none",
  "single_api_key",
  "config_fields",
  "host_with_oauth_fallback",
  "oauth_browser",
  "oauth_device_code",
  "cloud_credentials",
  "local",
  "cli_auth",
] as const satisfies readonly [ProviderSetupMethod, ...ProviderSetupMethod[]];

const providerGroups = ["default", "additional"] as const satisfies readonly [
  ProviderGroup,
  ...ProviderGroup[],
];

const modelInventoryModes = ["authoritative", "refreshable"] as const;

export const runtimeIdentitySchema = z
  .object({
    id: nonEmptyString("identity id"),
    displayName: nonEmptyString("identity displayName").optional(),
  })
  .strict();

export const runtimeCustomProviderSchema = z
  .object({
    providerId: runtimeIdString("customProvider providerId"),
    engine: nonEmptyString("customProvider engine"),
    displayName: nonEmptyString("customProvider displayName"),
    apiUrl: nonEmptyString("customProvider apiUrl").refine(
      isHttpUrl,
      "customProvider apiUrl must be an http or https URL",
    ),
    basePath: nonEmptyString("customProvider basePath").optional(),
    models: z
      .array(nonEmptyString("customProvider models"))
      .refine(
        hasUniqueTrimmedValues,
        "customProvider models must not contain duplicates",
      )
      .optional(),
    requiresAuth: z.literal(false),
    supportsStreaming: z.boolean().optional(),
    preservesThinking: z.boolean().optional(),
    headers: nonSecretRecordSchema.optional(),
  })
  .strict()
  .refine(
    (provider) =>
      provider.providerId !== "block_openai_compatible" ||
      provider.engine === "openai_compatible",
    "admin custom provider block_openai_compatible must use engine openai_compatible",
  );

export const runtimeGooseModelSchema = z
  .object({
    id: runtimeIdString("goose model id"),
    name: nonEmptyString("goose model name"),
    recommended: z.boolean().optional(),
    featured: z.boolean().optional(),
    contextLimit: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const runtimeGooseModelProviderSchema = z
  .object({
    id: runtimeIdString("goose modelProvider id"),
    displayName: nonEmptyString("goose modelProvider displayName"),
    description: nonEmptyString("goose modelProvider description").optional(),
    setupMethod: z.enum(providerSetupMethods).optional(),
    group: z.enum(providerGroups).optional(),
    aliases: z
      .array(nonEmptyString("goose modelProvider aliases"))
      .refine(
        hasUniqueTrimmedValues,
        "goose modelProvider aliases must not contain duplicates",
      )
      .optional(),
    nativeConnectQuery: nonEmptyString(
      "goose modelProvider nativeConnectQuery",
    ).optional(),
    customProvider: runtimeCustomProviderSchema.optional(),
    endpointEnv: endpointEnvSchema.optional(),
    modelInventoryMode: z.enum(modelInventoryModes).optional(),
    models: z.array(runtimeGooseModelSchema),
  })
  .strict();

export const runtimeGooseConfigSchema = z
  .object({
    defaultModelProviderId: runtimeIdString("goose defaultModelProviderId"),
    defaultModelId: runtimeIdString("goose defaultModelId").optional(),
    modelProviders: z.array(runtimeGooseModelProviderSchema).min(1),
  })
  .strict()
  .superRefine((goose, ctx) => {
    const providerIds = new Set<string>();
    let defaultProvider: (typeof goose.modelProviders)[number] | undefined;

    for (const [providerIndex, provider] of goose.modelProviders.entries()) {
      const providerId = provider.id;
      if (providerIds.has(providerId)) {
        ctx.addIssue({
          code: "custom",
          path: ["modelProviders", providerIndex, "id"],
          message: `goose modelProviders must not contain duplicate provider '${providerId}'`,
        });
      }
      providerIds.add(providerId);

      if (providerId === goose.defaultModelProviderId) {
        defaultProvider = provider;
      }

      if (
        provider.customProvider &&
        provider.customProvider.providerId !== providerId
      ) {
        ctx.addIssue({
          code: "custom",
          path: [
            "modelProviders",
            providerIndex,
            "customProvider",
            "providerId",
          ],
          message:
            "customProvider.providerId must match containing modelProvider id",
        });
      }

      const modelIds = new Set<string>();
      for (const [modelIndex, model] of provider.models.entries()) {
        const modelId = model.id;
        if (modelIds.has(modelId)) {
          ctx.addIssue({
            code: "custom",
            path: ["modelProviders", providerIndex, "models", modelIndex, "id"],
            message: `goose modelProvider '${providerId}' must not contain duplicate model '${modelId}'`,
          });
        }
        modelIds.add(modelId);
      }
    }

    if (!providerIds.has(goose.defaultModelProviderId)) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultModelProviderId"],
        message: "goose defaultModelProviderId must reference modelProviders",
      });
    }

    if (goose.defaultModelId) {
      const defaultModelId = goose.defaultModelId;
      if (
        !defaultProvider?.models.some((model) => model.id === defaultModelId)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["defaultModelId"],
          message:
            "goose defaultModelId must reference models for default provider",
        });
      }
    }
  });

export const runtimeDoctorConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    kgooseConnectivity: z.boolean().optional(),
    internalToolingChecks: z.boolean().optional(),
  })
  .strict();

export const runtimeFeedbackConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    projectKey: nonEmptyString("feedback projectKey").optional(),
  })
  .strict();

export const runtimeKgooseConfigSchema = z
  .object({
    baseUrl: nonEmptyString("kgoose baseUrl")
      .refine(isHttpUrl, "kgoose baseUrl must be an http or https URL")
      .optional(),
    path: nonEmptyString("kgoose path").optional(),
  })
  .strict();

export const runtimeConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    customer: runtimeIdentitySchema.optional(),
    workspace: runtimeIdentitySchema.optional(),
    goose: runtimeGooseConfigSchema,
    featureToggles: z
      .record(nonEmptyString("featureToggles keys"), z.boolean())
      .optional(),
    doctor: runtimeDoctorConfigSchema.optional(),
    feedback: runtimeFeedbackConfigSchema.optional(),
    kgoose: runtimeKgooseConfigSchema.optional(),
  })
  .strict();

export const runtimeConfigSourceSchema = z.enum([
  "appDefault",
  "bundledFile",
  "cachedEndpoint",
  "endpoint",
  "fakeEndpoint",
]);

export const runtimeConfigUnavailableReasonSchema = z.enum([
  "endpointUnavailable",
  "invalid",
  "missing",
  "readFailed",
  "unsupportedBuild",
]);

export const runtimeConfigLoadResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      source: runtimeConfigSourceSchema,
      config: runtimeConfigSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      source: runtimeConfigSourceSchema,
      reason: runtimeConfigUnavailableReasonSchema,
      message: z.string(),
    })
    .strict(),
]);

export type RuntimeIdentity = z.infer<typeof runtimeIdentitySchema>;
export type RuntimeCustomProvider = z.infer<typeof runtimeCustomProviderSchema>;
export type RuntimeGooseModelProvider = z.infer<
  typeof runtimeGooseModelProviderSchema
>;
export type RuntimeModelInventoryMode = NonNullable<
  RuntimeGooseModelProvider["modelInventoryMode"]
>;
export type RuntimeGooseModel = z.infer<typeof runtimeGooseModelSchema>;
export type RuntimeGooseConfig = z.infer<typeof runtimeGooseConfigSchema>;
export type RuntimeDoctorConfig = z.infer<typeof runtimeDoctorConfigSchema>;
export type RuntimeFeedbackConfig = z.infer<typeof runtimeFeedbackConfigSchema>;
export type RuntimeKgooseConfig = z.infer<typeof runtimeKgooseConfigSchema>;
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type RuntimeConfigSource = z.infer<typeof runtimeConfigSourceSchema>;
export type RuntimeConfigUnavailableReason = z.infer<
  typeof runtimeConfigUnavailableReasonSchema
>;
export type RuntimeConfigLoadResult = z.infer<
  typeof runtimeConfigLoadResultSchema
>;

export const DEFAULT_RUNTIME_MODEL_PROVIDER_ID = "databricks_v2";
export const DEFAULT_RUNTIME_MODEL_ID = "goose-gpt-5-5";

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  schemaVersion: 1,
  goose: {
    defaultModelProviderId: DEFAULT_RUNTIME_MODEL_PROVIDER_ID,
    defaultModelId: DEFAULT_RUNTIME_MODEL_ID,
    modelProviders: [
      {
        id: DEFAULT_RUNTIME_MODEL_PROVIDER_ID,
        displayName: "Databricks AI Gateway",
        description: "Databricks AI Gateway models",
        setupMethod: "host_with_oauth_fallback",
        nativeConnectQuery: "databricks",
        group: "default",
        aliases: ["databricks_v2", "databricks", "databricks-ai-gateway"],
        endpointEnv: {
          DATABRICKS_HOST:
            "https://block-lakehouse-production.cloud.databricks.com",
        },
        models: [
          {
            id: DEFAULT_RUNTIME_MODEL_ID,
            name: "GPT-5.5",
            recommended: true,
          },
          {
            id: "goose-gpt-5-6-sol",
            name: "GPT-5.6 Sol",
            recommended: true,
            featured: true,
          },
          {
            id: "goose-gpt-5-6-terra",
            name: "GPT-5.6 Terra",
            recommended: true,
          },
          {
            id: "goose-gpt-5-6-luna",
            name: "GPT-5.6 Luna",
            recommended: true,
          },
        ],
      },
    ],
  },
};
