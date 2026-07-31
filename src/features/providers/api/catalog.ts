import type { ProviderSetupCatalogEntryDto } from "@aaif/goose-sdk";
import { getClient } from "@/shared/api/acpConnection";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { perfLog } from "@/shared/lib/perfLog";

export function mapProviderSetupCatalogEntryDto(
  dto: ProviderSetupCatalogEntryDto,
): ProviderCatalogEntry {
  return {
    id: dto.providerId,
    displayName: dto.name,
    category: dto.category,
    description: dto.description,
    setupMethod: dto.setupMethod,
    ...(dto.nativeConnectQuery
      ? { nativeConnectQuery: dto.nativeConnectQuery }
      : {}),
    ...(dto.fields?.length ? { fields: dto.fields } : {}),
    ...(dto.binaryName ? { binaryName: dto.binaryName } : {}),
    ...(dto.docUrl ? { docsUrl: dto.docUrl } : {}),
    group: dto.group,
    showOnlyWhenInstalled: dto.showOnlyWhenInstalled,
    ...(dto.aliases?.length ? { aliases: dto.aliases } : {}),
    supportsInstall: dto.supportsInstall,
    supportsAuth: dto.supportsAuth,
    supportsAuthStatus: dto.supportsAuthStatus,
    catalogSource: "setup",
    setupCatalogProvider: true,
  };
}

// Public/dev builds surface every model provider Goose exposes through its
// setup catalog. The catalog owns setup fields and behavior; Berd only curates
// which entries are promoted on the main page.
export function selectSetupCatalogModelProviders(
  entries: ProviderCatalogEntry[],
): ProviderCatalogEntry[] {
  return entries.filter((entry) => entry.category === "model");
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
  const fields = entry?.fields?.filter(
    (field) => field.key === SETUP_CATALOG_DATABRICKS_HOST_FIELD_KEY,
  );
  return entry && fields?.length ? { ...entry, fields } : null;
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
