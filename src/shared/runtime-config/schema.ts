import { z } from "zod/v4";

function nonEmptyString(field: string) {
  return z
    .string()
    .refine((value) => value.trim().length > 0, `${field} must not be empty`);
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

export const runtimeIdentitySchema = z
  .object({
    id: nonEmptyString("identity id"),
    displayName: nonEmptyString("identity displayName").optional(),
  })
  .strict();

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
    providerAllowlist: z
      .array(nonEmptyString("providerAllowlist entries"))
      .refine(
        hasUniqueTrimmedValues,
        "providerAllowlist must not contain duplicates",
      )
      .optional(),
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

export const DEFAULT_RUNTIME_PROVIDER_ALLOWLIST = ["databricks_v2"] as const;

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  schemaVersion: 1,
  providerAllowlist: [...DEFAULT_RUNTIME_PROVIDER_ALLOWLIST],
};
