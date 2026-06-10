// This file is auto-generated — do not edit manually.

export interface ExtMethodProvider {
  extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

import type {
  AddConfigExtensionRequestUnstable,
  AddExtensionRequestUnstable,
  ArchiveSessionRequestUnstable,
  CreateSourceRequestUnstable,
  CreateSourceResponseUnstable,
  CustomProviderCreateRequestUnstable,
  CustomProviderCreateResponseUnstable,
  CustomProviderDeleteRequestUnstable,
  CustomProviderDeleteResponseUnstable,
  CustomProviderReadRequestUnstable,
  CustomProviderReadResponseUnstable,
  CustomProviderUpdateRequestUnstable,
  CustomProviderUpdateResponseUnstable,
  DefaultsReadRequestUnstable,
  DefaultsReadResponseUnstable,
  DefaultsSaveRequestUnstable,
  DeleteSessionRequest,
  DeleteSourceRequestUnstable,
  DictationConfigRequestUnstable,
  DictationConfigResponseUnstable,
  DictationModelCancelRequestUnstable,
  DictationModelDeleteRequestUnstable,
  DictationModelDownloadProgressRequestUnstable,
  DictationModelDownloadProgressResponseUnstable,
  DictationModelDownloadRequestUnstable,
  DictationModelSelectRequestUnstable,
  DictationModelsListRequestUnstable,
  DictationModelsListResponseUnstable,
  DictationSecretDeleteRequestUnstable,
  DictationSecretSaveRequestUnstable,
  DictationTranscribeRequestUnstable,
  DictationTranscribeResponseUnstable,
  ElicitationRespondRequestUnstable,
  ExportSessionRequestUnstable,
  ExportSessionResponseUnstable,
  ExportSourceRequestUnstable,
  ExportSourceResponseUnstable,
  GetAvailableExtensionsRequestUnstable,
  GetAvailableExtensionsResponseUnstable,
  GetConfigExtensionsRequestUnstable,
  GetConfigExtensionsResponseUnstable,
  GetSessionExtensionsRequestUnstable,
  GetSessionExtensionsResponseUnstable,
  GetToolsRequestUnstable,
  GetToolsResponseUnstable,
  GooseToolCallRequestUnstable,
  GooseToolCallResponseUnstable,
  ImportSessionRequestUnstable,
  ImportSessionResponseUnstable,
  ImportSourcesRequestUnstable,
  ImportSourcesResponseUnstable,
  ListProvidersRequestUnstable,
  ListProvidersResponseUnstable,
  ListSourcesRequestUnstable,
  ListSourcesResponseUnstable,
  OnboardingImportApplyRequestUnstable,
  OnboardingImportApplyResponseUnstable,
  OnboardingImportScanRequestUnstable,
  OnboardingImportScanResponseUnstable,
  PreferencesReadRequestUnstable,
  PreferencesReadResponseUnstable,
  PreferencesRemoveRequestUnstable,
  PreferencesSaveRequestUnstable,
  ProviderCatalogListRequestUnstable,
  ProviderCatalogListResponseUnstable,
  ProviderCatalogTemplateRequestUnstable,
  ProviderCatalogTemplateResponseUnstable,
  ProviderConfigAuthenticateRequestUnstable,
  ProviderConfigChangeResponseUnstable,
  ProviderConfigDeleteRequestUnstable,
  ProviderConfigReadRequestUnstable,
  ProviderConfigReadResponseUnstable,
  ProviderConfigSaveRequestUnstable,
  ProviderConfigStatusRequestUnstable,
  ProviderConfigStatusResponseUnstable,
  ProviderSetupCatalogListRequestUnstable,
  ProviderSetupCatalogListResponseUnstable,
  ProviderSupportedModelsListRequestUnstable,
  ProviderSupportedModelsListResponseUnstable,
  ReadResourceRequestUnstable,
  ReadResourceResponseUnstable,
  RefreshProviderInventoryRequestUnstable,
  RefreshProviderInventoryResponseUnstable,
  RemoveConfigExtensionRequestUnstable,
  RemoveExtensionRequestUnstable,
  RenameSessionRequestUnstable,
  SetConfigExtensionEnabledRequestUnstable,
  SetSessionSystemPromptRequestUnstable,
  UnarchiveSessionRequestUnstable,
  UpdateSessionProjectRequestUnstable,
  UpdateSourceRequestUnstable,
  UpdateSourceResponseUnstable,
  UpdateWorkingDirRequestUnstable,
} from './types.gen.js';
import {
  zCreateSourceResponseUnstable,
  zCustomProviderCreateResponseUnstable,
  zCustomProviderDeleteResponseUnstable,
  zCustomProviderReadResponseUnstable,
  zCustomProviderUpdateResponseUnstable,
  zDefaultsReadResponseUnstable,
  zDictationConfigResponseUnstable,
  zDictationModelDownloadProgressResponseUnstable,
  zDictationModelsListResponseUnstable,
  zDictationTranscribeResponseUnstable,
  zExportSessionResponseUnstable,
  zExportSourceResponseUnstable,
  zGetAvailableExtensionsResponseUnstable,
  zGetConfigExtensionsResponseUnstable,
  zGetSessionExtensionsResponseUnstable,
  zGetToolsResponseUnstable,
  zGooseToolCallResponseUnstable,
  zImportSessionResponseUnstable,
  zImportSourcesResponseUnstable,
  zListProvidersResponseUnstable,
  zListSourcesResponseUnstable,
  zOnboardingImportApplyResponseUnstable,
  zOnboardingImportScanResponseUnstable,
  zPreferencesReadResponseUnstable,
  zProviderCatalogListResponseUnstable,
  zProviderCatalogTemplateResponseUnstable,
  zProviderConfigChangeResponseUnstable,
  zProviderConfigReadResponseUnstable,
  zProviderConfigStatusResponseUnstable,
  zProviderSetupCatalogListResponseUnstable,
  zProviderSupportedModelsListResponseUnstable,
  zReadResourceResponseUnstable,
  zRefreshProviderInventoryResponseUnstable,
  zUpdateSourceResponseUnstable,
} from './zod.gen.js';

export class GooseExtClient {
  constructor(private conn: ExtMethodProvider) {}

  async GooseUnstableSessionExtensionsAdd(
    params: AddExtensionRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/session/extensions/add", params);
  }

  async GooseUnstableSessionExtensionsRemove(
    params: RemoveExtensionRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod(
      "_goose/unstable/session/extensions/remove",
      params,
    );
  }

  async GooseUnstableToolsList(
    params: GetToolsRequestUnstable,
  ): Promise<GetToolsResponseUnstable> {
    const raw = await this.conn.extMethod("_goose/unstable/tools/list", params);
    return zGetToolsResponseUnstable.parse(raw) as GetToolsResponseUnstable;
  }

  async GooseUnstableToolsCall(
    params: GooseToolCallRequestUnstable,
  ): Promise<GooseToolCallResponseUnstable> {
    const raw = await this.conn.extMethod("_goose/unstable/tools/call", params);
    return zGooseToolCallResponseUnstable.parse(
      raw,
    ) as GooseToolCallResponseUnstable;
  }

  async GooseUnstableResourcesRead(
    params: ReadResourceRequestUnstable,
  ): Promise<ReadResourceResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/resources/read",
      params,
    );
    return zReadResourceResponseUnstable.parse(
      raw,
    ) as ReadResourceResponseUnstable;
  }

  async GooseUnstableSessionWorkingDirUpdate(
    params: UpdateWorkingDirRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod(
      "_goose/unstable/session/working-dir/update",
      params,
    );
  }

  async GooseUnstableSessionSystemPromptSet(
    params: SetSessionSystemPromptRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod(
      "_goose/unstable/session/system-prompt/set",
      params,
    );
  }

  async sessionDelete(params: DeleteSessionRequest): Promise<void> {
    await this.conn.extMethod("session/delete", params);
  }

  async GooseUnstableConfigExtensionsList(
    params: GetConfigExtensionsRequestUnstable,
  ): Promise<GetConfigExtensionsResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/config/extensions/list",
      params,
    );
    return zGetConfigExtensionsResponseUnstable.parse(
      raw,
    ) as GetConfigExtensionsResponseUnstable;
  }

  async GooseUnstableExtensionsAvailable(
    params: GetAvailableExtensionsRequestUnstable,
  ): Promise<GetAvailableExtensionsResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/extensions/available",
      params,
    );
    return zGetAvailableExtensionsResponseUnstable.parse(
      raw,
    ) as GetAvailableExtensionsResponseUnstable;
  }

  async GooseUnstableConfigExtensionsAdd(
    params: AddConfigExtensionRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/config/extensions/add", params);
  }

  async GooseUnstableConfigExtensionsRemove(
    params: RemoveConfigExtensionRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod(
      "_goose/unstable/config/extensions/remove",
      params,
    );
  }

  async GooseUnstableConfigExtensionsSetEnabled(
    params: SetConfigExtensionEnabledRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod(
      "_goose/unstable/config/extensions/set-enabled",
      params,
    );
  }

  async GooseUnstableSessionExtensionsList(
    params: GetSessionExtensionsRequestUnstable,
  ): Promise<GetSessionExtensionsResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/session/extensions/list",
      params,
    );
    return zGetSessionExtensionsResponseUnstable.parse(
      raw,
    ) as GetSessionExtensionsResponseUnstable;
  }

  async GooseUnstableProvidersList(
    params: ListProvidersRequestUnstable,
  ): Promise<ListProvidersResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/providers/list",
      params,
    );
    return zListProvidersResponseUnstable.parse(
      raw,
    ) as ListProvidersResponseUnstable;
  }

  async GooseUnstableProvidersSupportedModelsList(
    params: ProviderSupportedModelsListRequestUnstable,
  ): Promise<ProviderSupportedModelsListResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/providers/supported-models/list",
      params,
    );
    return zProviderSupportedModelsListResponseUnstable.parse(
      raw,
    ) as ProviderSupportedModelsListResponseUnstable;
  }

  async GooseUnstableProvidersCatalogList(
    params: ProviderCatalogListRequestUnstable,
  ): Promise<ProviderCatalogListResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/providers/catalog/list",
      params,
    );
    return zProviderCatalogListResponseUnstable.parse(
      raw,
    ) as ProviderCatalogListResponseUnstable;
  }

  async GooseUnstableProvidersSetupCatalogList(
    params: ProviderSetupCatalogListRequestUnstable,
  ): Promise<ProviderSetupCatalogListResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/providers/setup/catalog/list",
      params,
    );
    return zProviderSetupCatalogListResponseUnstable.parse(
      raw,
    ) as ProviderSetupCatalogListResponseUnstable;
  }

  async GooseUnstableProvidersCatalogTemplate(
    params: ProviderCatalogTemplateRequestUnstable,
  ): Promise<ProviderCatalogTemplateResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/providers/catalog/template",
      params,
    );
    return zProviderCatalogTemplateResponseUnstable.parse(
      raw,
    ) as ProviderCatalogTemplateResponseUnstable;
  }

  async GooseUnstableProvidersCustomCreate(
    params: CustomProviderCreateRequestUnstable,
  ): Promise<CustomProviderCreateResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/providers/custom/create",
      params,
    );
    return zCustomProviderCreateResponseUnstable.parse(
      raw,
    ) as CustomProviderCreateResponseUnstable;
  }

  async GooseUnstableProvidersCustomRead(
    params: CustomProviderReadRequestUnstable,
  ): Promise<CustomProviderReadResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/providers/custom/read",
      params,
    );
    return zCustomProviderReadResponseUnstable.parse(
      raw,
    ) as CustomProviderReadResponseUnstable;
  }

  async GooseUnstableProvidersCustomUpdate(
    params: CustomProviderUpdateRequestUnstable,
  ): Promise<CustomProviderUpdateResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/providers/custom/update",
      params,
    );
    return zCustomProviderUpdateResponseUnstable.parse(
      raw,
    ) as CustomProviderUpdateResponseUnstable;
  }

  async GooseUnstableProvidersCustomDelete(
    params: CustomProviderDeleteRequestUnstable,
  ): Promise<CustomProviderDeleteResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/providers/custom/delete",
      params,
    );
    return zCustomProviderDeleteResponseUnstable.parse(
      raw,
    ) as CustomProviderDeleteResponseUnstable;
  }

  async GooseUnstableProvidersInventoryRefresh(
    params: RefreshProviderInventoryRequestUnstable,
  ): Promise<RefreshProviderInventoryResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/providers/inventory/refresh",
      params,
    );
    return zRefreshProviderInventoryResponseUnstable.parse(
      raw,
    ) as RefreshProviderInventoryResponseUnstable;
  }

  async GooseUnstableProvidersConfigRead(
    params: ProviderConfigReadRequestUnstable,
  ): Promise<ProviderConfigReadResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/providers/config/read",
      params,
    );
    return zProviderConfigReadResponseUnstable.parse(
      raw,
    ) as ProviderConfigReadResponseUnstable;
  }

  async GooseUnstableProvidersConfigStatus(
    params: ProviderConfigStatusRequestUnstable,
  ): Promise<ProviderConfigStatusResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/providers/config/status",
      params,
    );
    return zProviderConfigStatusResponseUnstable.parse(
      raw,
    ) as ProviderConfigStatusResponseUnstable;
  }

  async GooseUnstableProvidersConfigSave(
    params: ProviderConfigSaveRequestUnstable,
  ): Promise<ProviderConfigChangeResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/providers/config/save",
      params,
    );
    return zProviderConfigChangeResponseUnstable.parse(
      raw,
    ) as ProviderConfigChangeResponseUnstable;
  }

  async GooseUnstableProvidersConfigDelete(
    params: ProviderConfigDeleteRequestUnstable,
  ): Promise<ProviderConfigChangeResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/providers/config/delete",
      params,
    );
    return zProviderConfigChangeResponseUnstable.parse(
      raw,
    ) as ProviderConfigChangeResponseUnstable;
  }

  async GooseUnstableProvidersConfigAuthenticate(
    params: ProviderConfigAuthenticateRequestUnstable,
  ): Promise<ProviderConfigChangeResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/providers/config/authenticate",
      params,
    );
    return zProviderConfigChangeResponseUnstable.parse(
      raw,
    ) as ProviderConfigChangeResponseUnstable;
  }

  async GooseUnstablePreferencesRead(
    params: PreferencesReadRequestUnstable,
  ): Promise<PreferencesReadResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/preferences/read",
      params,
    );
    return zPreferencesReadResponseUnstable.parse(
      raw,
    ) as PreferencesReadResponseUnstable;
  }

  async GooseUnstablePreferencesSave(
    params: PreferencesSaveRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/preferences/save", params);
  }

  async GooseUnstablePreferencesRemove(
    params: PreferencesRemoveRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/preferences/remove", params);
  }

  async GooseUnstableDefaultsRead(
    params: DefaultsReadRequestUnstable,
  ): Promise<DefaultsReadResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/defaults/read",
      params,
    );
    return zDefaultsReadResponseUnstable.parse(
      raw,
    ) as DefaultsReadResponseUnstable;
  }

  async GooseUnstableDefaultsSave(
    params: DefaultsSaveRequestUnstable,
  ): Promise<DefaultsReadResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/defaults/save",
      params,
    );
    return zDefaultsReadResponseUnstable.parse(
      raw,
    ) as DefaultsReadResponseUnstable;
  }

  async GooseUnstableOnboardingImportScan(
    params: OnboardingImportScanRequestUnstable,
  ): Promise<OnboardingImportScanResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/onboarding/import/scan",
      params,
    );
    return zOnboardingImportScanResponseUnstable.parse(
      raw,
    ) as OnboardingImportScanResponseUnstable;
  }

  async GooseUnstableOnboardingImportApply(
    params: OnboardingImportApplyRequestUnstable,
  ): Promise<OnboardingImportApplyResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/onboarding/import/apply",
      params,
    );
    return zOnboardingImportApplyResponseUnstable.parse(
      raw,
    ) as OnboardingImportApplyResponseUnstable;
  }

  async GooseUnstableSessionExport(
    params: ExportSessionRequestUnstable,
  ): Promise<ExportSessionResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/session/export",
      params,
    );
    return zExportSessionResponseUnstable.parse(
      raw,
    ) as ExportSessionResponseUnstable;
  }

  async GooseUnstableSessionImport(
    params: ImportSessionRequestUnstable,
  ): Promise<ImportSessionResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/session/import",
      params,
    );
    return zImportSessionResponseUnstable.parse(
      raw,
    ) as ImportSessionResponseUnstable;
  }

  async GooseUnstableElicitationRespond(
    params: ElicitationRespondRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/elicitation/respond", params);
  }

  async GooseUnstableSessionProjectUpdate(
    params: UpdateSessionProjectRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/session/project/update", params);
  }

  async GooseUnstableSessionRename(
    params: RenameSessionRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/session/rename", params);
  }

  async GooseUnstableSessionArchive(
    params: ArchiveSessionRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/session/archive", params);
  }

  async GooseUnstableSessionUnarchive(
    params: UnarchiveSessionRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/session/unarchive", params);
  }

  async GooseUnstableSourcesCreate(
    params: CreateSourceRequestUnstable,
  ): Promise<CreateSourceResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/sources/create",
      params,
    );
    return zCreateSourceResponseUnstable.parse(
      raw,
    ) as CreateSourceResponseUnstable;
  }

  async GooseUnstableSourcesList(
    params: ListSourcesRequestUnstable,
  ): Promise<ListSourcesResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/sources/list",
      params,
    );
    return zListSourcesResponseUnstable.parse(
      raw,
    ) as ListSourcesResponseUnstable;
  }

  async GooseUnstableSourcesUpdate(
    params: UpdateSourceRequestUnstable,
  ): Promise<UpdateSourceResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/sources/update",
      params,
    );
    return zUpdateSourceResponseUnstable.parse(
      raw,
    ) as UpdateSourceResponseUnstable;
  }

  async GooseUnstableSourcesDelete(
    params: DeleteSourceRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/sources/delete", params);
  }

  async GooseUnstableSourcesExport(
    params: ExportSourceRequestUnstable,
  ): Promise<ExportSourceResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/sources/export",
      params,
    );
    return zExportSourceResponseUnstable.parse(
      raw,
    ) as ExportSourceResponseUnstable;
  }

  async GooseUnstableSourcesImport(
    params: ImportSourcesRequestUnstable,
  ): Promise<ImportSourcesResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/sources/import",
      params,
    );
    return zImportSourcesResponseUnstable.parse(
      raw,
    ) as ImportSourcesResponseUnstable;
  }

  async GooseUnstableDictationTranscribe(
    params: DictationTranscribeRequestUnstable,
  ): Promise<DictationTranscribeResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/dictation/transcribe",
      params,
    );
    return zDictationTranscribeResponseUnstable.parse(
      raw,
    ) as DictationTranscribeResponseUnstable;
  }

  async GooseUnstableDictationConfig(
    params: DictationConfigRequestUnstable,
  ): Promise<DictationConfigResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/dictation/config",
      params,
    );
    return zDictationConfigResponseUnstable.parse(
      raw,
    ) as DictationConfigResponseUnstable;
  }

  async GooseUnstableDictationSecretSave(
    params: DictationSecretSaveRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/dictation/secret/save", params);
  }

  async GooseUnstableDictationSecretDelete(
    params: DictationSecretDeleteRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod(
      "_goose/unstable/dictation/secret/delete",
      params,
    );
  }

  async GooseUnstableDictationModelsList(
    params: DictationModelsListRequestUnstable,
  ): Promise<DictationModelsListResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/dictation/models/list",
      params,
    );
    return zDictationModelsListResponseUnstable.parse(
      raw,
    ) as DictationModelsListResponseUnstable;
  }

  async GooseUnstableDictationModelsDownload(
    params: DictationModelDownloadRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod(
      "_goose/unstable/dictation/models/download",
      params,
    );
  }

  async GooseUnstableDictationModelsDownloadProgress(
    params: DictationModelDownloadProgressRequestUnstable,
  ): Promise<DictationModelDownloadProgressResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/dictation/models/download/progress",
      params,
    );
    return zDictationModelDownloadProgressResponseUnstable.parse(
      raw,
    ) as DictationModelDownloadProgressResponseUnstable;
  }

  async GooseUnstableDictationModelsCancel(
    params: DictationModelCancelRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod(
      "_goose/unstable/dictation/models/cancel",
      params,
    );
  }

  async GooseUnstableDictationModelsDelete(
    params: DictationModelDeleteRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod(
      "_goose/unstable/dictation/models/delete",
      params,
    );
  }

  async GooseUnstableDictationModelsSelect(
    params: DictationModelSelectRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod(
      "_goose/unstable/dictation/models/select",
      params,
    );
  }
}
