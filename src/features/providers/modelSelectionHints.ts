import { getCatalogEntry } from "./providerCatalog";

export function getProviderModelSelectionHint(
  providerId: string,
): string | null {
  const provider = getCatalogEntry(providerId);
  if (!provider || provider.supportsModelList !== false) {
    return null;
  }

  return (
    provider.modelSelectionHint ??
    `${provider.displayName} manages model selection itself and does not expose a model list.`
  );
}
