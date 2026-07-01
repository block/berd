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
  };
}

// Model providers berd surfaces from goose's setup catalog so users can bring
// their own API key. goose serves these with their own secret API-key `fields`
// (OPENAI_API_KEY / ANTHROPIC_API_KEY); the runtime-config catalog does not, so
// they are merged into the catalog store at startup.
export const SETUP_CATALOG_BYO_KEY_PROVIDER_IDS = [
  "openai",
  "anthropic",
] as const;

const SETUP_CATALOG_BYO_KEY_PROVIDER_ID_SET = new Set<string>(
  SETUP_CATALOG_BYO_KEY_PROVIDER_IDS,
);
const SETUP_CATALOG_DATABRICKS_PROVIDER_ID = "databricks_v2";
const SETUP_CATALOG_DATABRICKS_HOST_FIELD_KEY = "DATABRICKS_HOST";

export function isByoKeyProvider(
  entry: Pick<ProviderCatalogEntry, "id" | "fields">,
): boolean {
  return (
    SETUP_CATALOG_BYO_KEY_PROVIDER_ID_SET.has(entry.id) &&
    (entry.fields?.length ?? 0) > 0
  );
}

export function selectByoKeyProviders(
  entries: ProviderCatalogEntry[],
): ProviderCatalogEntry[] {
  return entries.filter(isByoKeyProvider);
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
