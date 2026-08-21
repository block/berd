import type { ProviderSetupCatalogEntryDto } from "@aaif/goose-sdk";
import { CURATED_PROVIDER_CATALOG_BY_ID } from "@/features/providers/curatedProviders";
import { getClient } from "@/shared/api/acpConnection";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { perfLog } from "@/shared/lib/perfLog";

export function mapProviderSetupCatalogEntryDto(
  dto: ProviderSetupCatalogEntryDto,
): ProviderCatalogEntry {
  // Goose owns current setup data, while Berd's curated catalog carries stable
  // client identity and native-connect capabilities. A fetched same-id entry
  // must add to that metadata rather than make credentials and actions vanish.
  const curatedEntry = CURATED_PROVIDER_CATALOG_BY_ID.get(dto.providerId);
  const aliases = [
    ...new Set([...(curatedEntry?.aliases ?? []), ...(dto.aliases ?? [])]),
  ];
  const nativeConnectQuery =
    dto.nativeConnectQuery ?? curatedEntry?.nativeConnectQuery;

  return {
    id: dto.providerId,
    displayName: dto.name,
    category: dto.category,
    description: dto.description,
    setupMethod: dto.setupMethod,
    ...(nativeConnectQuery ? { nativeConnectQuery } : {}),
    ...(dto.fields?.length ? { fields: dto.fields } : {}),
    ...(dto.binaryName ? { binaryName: dto.binaryName } : {}),
    ...(dto.docUrl ? { docsUrl: dto.docUrl } : {}),
    group: dto.group,
    showOnlyWhenInstalled: dto.showOnlyWhenInstalled,
    ...(aliases.length ? { aliases } : {}),
    supportsInstall: dto.supportsInstall,
    supportsAuth: dto.supportsAuth,
    supportsAuthStatus: dto.supportsAuthStatus,
    catalogSource: "setup",
    setupCatalogProvider: true,
  };
}

// Legacy setup-catalog providers Goose still exposes but Berd no longer
// offers. `databricks` is the deprecated v1 provider; Berd only supports the
// Databricks AI Gateway (`databricks_v2`) entry.
const HIDDEN_SETUP_CATALOG_PROVIDER_IDS = new Set(["databricks"]);

// Public/dev builds surface every model provider Goose exposes through its
// setup catalog. The catalog owns setup fields and behavior; Berd only curates
// which entries are promoted on the main page.
export function selectSetupCatalogModelProviders(
  entries: ProviderCatalogEntry[],
): ProviderCatalogEntry[] {
  return entries.filter(
    (entry) =>
      entry.category === "model" &&
      !HIDDEN_SETUP_CATALOG_PROVIDER_IDS.has(entry.id),
  );
}

const SETUP_CATALOG_DATABRICKS_PROVIDER_ID = "databricks_v2";
const SETUP_CATALOG_DATABRICKS_HOST_FIELD_KEY = "DATABRICKS_HOST";

export function isSetupCatalogModelProvider(
  entry: Pick<
    ProviderCatalogEntry,
    "category" | "catalogSource" | "setupCatalogProvider"
  >,
): boolean {
  return (
    entry.category === "model" &&
    (entry.catalogSource === "setup" || entry.setupCatalogProvider === true)
  );
}

export function selectDatabricksHostConfigProvider(
  entries: ProviderCatalogEntry[],
): ProviderCatalogEntry | null {
  const entry = entries.find(
    (candidate) => candidate.id === SETUP_CATALOG_DATABRICKS_PROVIDER_ID,
  );
  const hasHostField = entry?.fields?.some(
    (field) => field.key === SETUP_CATALOG_DATABRICKS_HOST_FIELD_KEY,
  );
  return entry && hasHostField ? entry : null;
}

export async function listProviderSetupCatalog(): Promise<
  ProviderCatalogEntry[]
> {
  const client = await getClient();
  const t0 = performance.now();
  const response = await client.goose.GooseUnstableProvidersSetupCatalogList(
    {},
  );
  const providers = response.providers.map(mapProviderSetupCatalogEntryDto);

  perfLog(
    `[perf:catalog] listProviderSetupCatalog done in ${(performance.now() - t0).toFixed(1)}ms (n=${providers.length})`,
  );
  return providers;
}
