import type {
  ProviderSetupCatalogEntryDto,
  ProviderSetupCategoryDto,
  ProviderSetupFieldDto,
  ProviderSetupMethodDto,
  ProviderSetupGroupDto,
} from "@aaif/goose-sdk";

export type ProviderCategory = ProviderSetupCategoryDto;
export type ProviderSetupMethod = ProviderSetupMethodDto;
export type ProviderGroup = ProviderSetupGroupDto;
export type ProviderField = ProviderSetupFieldDto;

export type { ProviderConfigFieldValueDto as ProviderFieldValue } from "@aaif/goose-sdk";

export type ProviderCatalogEntry = Omit<
  ProviderSetupCatalogEntryDto,
  | "providerId"
  | "name"
  | "nativeConnectQuery"
  | "binaryName"
  | "docUrl"
  | "showOnlyWhenInstalled"
  | "supportsInstall"
  | "supportsAuth"
  | "supportsAuthStatus"
> & {
  id: string;
  displayName: string;
  nativeConnectQuery?: NonNullable<
    ProviderSetupCatalogEntryDto["nativeConnectQuery"]
  >;
  binaryName?: NonNullable<ProviderSetupCatalogEntryDto["binaryName"]>;
  docsUrl?: NonNullable<ProviderSetupCatalogEntryDto["docUrl"]>;
  showOnlyWhenInstalled?: ProviderSetupCatalogEntryDto["showOnlyWhenInstalled"];
  supportsInstall?: ProviderSetupCatalogEntryDto["supportsInstall"];
  supportsAuth?: ProviderSetupCatalogEntryDto["supportsAuth"];
  supportsAuthStatus?: ProviderSetupCatalogEntryDto["supportsAuthStatus"];
  customProvider?: boolean;
  bundledBridge?: boolean;
  supportsModelList?: boolean;
  modelSelectionHint?: string;
  /** Where Berd learned about this provider's primary inventory/presentation. */
  catalogSource?: "setup" | "runtime" | "custom";
  /** Goose also exposes first-class setup behavior for this provider. */
  setupCatalogProvider?: boolean;
};

export type ProviderSetupStatus =
  | "built_in"
  | "connected"
  /**
   * Goose reports the provider configured and a saved user-supplied value
   * exists, but the setup path is ambiguous (defaults/ambient access could
   * also explain it). Shown as "Configured", never promoted to connected.
   */
  | "configured"
  | "not_installed"
  | "not_configured"
  | "installing"
  | "authenticating"
  | "error";

export interface ProviderDisplayInfo extends ProviderCatalogEntry {
  status: ProviderSetupStatus;
}
