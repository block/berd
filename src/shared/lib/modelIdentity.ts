/** `goose` identifies the agent/provider, never a concrete model. */
export function normalizeConcreteModelId(
  modelId: string | null | undefined,
): string | undefined {
  const normalized = modelId?.trim();
  return normalized && normalized !== "goose" ? normalized : undefined;
}
