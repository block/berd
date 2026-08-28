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
    // Omit to expose every provider-discovered model. Runtime-declared models
    // are explicit and remain available regardless of this discovery policy.
    allowedModelIdPrefixes: z
      .array(
        runtimeIdString("goose modelProvider allowedModelIdPrefixes entries"),
      )
      .min(1, "goose modelProvider allowedModelIdPrefixes must not be empty")
      .refine(
        hasUniqueTrimmedValues,
        "goose modelProvider allowedModelIdPrefixes must not contain duplicates",
      )
      .optional(),
    // Model Goose's lightweight "fast" tasks run on (exported to `goose
    // serve` as GOOSE_FAST_MODEL). A served endpoint id the provider must be
    // able to route (databricks_v2 routes by model-name substring, e.g. a
    // `claude` id takes the Anthropic Messages route), not necessarily one
    // of `models` — fast models are not surfaced in the picker. Stock berd
    // defaults declare none; a distribution supplies one at release time via
    // scripts/set-runtime-config-distribution.ts.
    fastModelId: runtimeIdString("goose modelProvider fastModelId").optional(),
    models: z.array(runtimeGooseModelSchema),
  })
  .strict();

export const runtimeGooseConfigSchema = z
  .object({
    defaultModelProviderId: runtimeIdString(
      "goose defaultModelProviderId",
    ).optional(),
    defaultModelId: runtimeIdString("goose defaultModelId").optional(),
    modelProviders: z.array(runtimeGooseModelProviderSchema),
  })
  .strict()
  .superRefine((goose, ctx) => {
    const providerIds = new Set<string>();

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

      if (provider.allowedModelIdPrefixes && providerId !== "databricks_v2") {
        ctx.addIssue({
          code: "custom",
          path: ["modelProviders", providerIndex, "allowedModelIdPrefixes"],
          message:
            "goose modelProvider allowedModelIdPrefixes is supported only for databricks_v2",
        });
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

    if (goose.modelProviders.length === 0) {
      if (goose.defaultModelProviderId) {
        ctx.addIssue({
          code: "custom",
          path: ["defaultModelProviderId"],
          message:
            "goose defaultModelProviderId must be omitted when modelProviders is empty",
        });
      }
      if (goose.defaultModelId) {
        ctx.addIssue({
          code: "custom",
          path: ["defaultModelId"],
          message:
            "goose defaultModelId must be omitted when modelProviders is empty",
        });
      }
      return;
    }

    if (!goose.defaultModelProviderId) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultModelProviderId"],
        message:
          "goose defaultModelProviderId is required when modelProviders is not empty",
      });
    } else if (!providerIds.has(goose.defaultModelProviderId)) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultModelProviderId"],
        message: "goose defaultModelProviderId must reference modelProviders",
      });
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
    responseRatingEnabled: z.boolean().optional(),
    // This is a per-eligible-completion opportunity hazard, not a percentage
    // allocation of sessions.
    sessionSurveySamplingRateBasisPoints: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .optional(),
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

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  schemaVersion: 1,
  goose: {
    modelProviders: [],
  },
};
