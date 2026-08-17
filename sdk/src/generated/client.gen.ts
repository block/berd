// This file is auto-generated — do not edit manually.

export interface ExtMethodProvider {
  extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

import type {
  AddConfigExtensionRequestUnstable,
  AddSessionExtensionRequestUnstable,
  AppsDeleteRequestUnstable,
  AppsDeleteResponseUnstable,
  AppsExportRequestUnstable,
  AppsExportResponseUnstable,
  AppsImportRequestUnstable,
  AppsImportResponseUnstable,
  AppsListRequestUnstable,
  AppsListResponseUnstable,
  ArchiveSessionRequestUnstable,
  CanonicalModelInfoRequestUnstable,
  CanonicalModelInfoResponseUnstable,
  ConfigReadAllRequestUnstable,
  ConfigReadAllResponseUnstable,
  ConfigReadRequestUnstable,
  ConfigReadResponseUnstable,
  ConfigRemoveRequestUnstable,
  ConfigUpsertRequestUnstable,
  CreateScheduleRequestUnstable,
  CreateScheduleResponseUnstable,
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
  DecodeRecipeRequestUnstable,
  DecodeRecipeResponseUnstable,
  DefaultsClearRequestUnstable,
  DefaultsReadRequestUnstable,
  DefaultsReadResponseUnstable,
  DefaultsSaveRequestUnstable,
  DeleteRecipeRequestUnstable,
  DeleteScheduleRequestUnstable,
  DeleteSourceRequestUnstable,
  DiagnosticsGetRequestUnstable,
  DiagnosticsGetResponseUnstable,
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
  EncodeRecipeRequestUnstable,
  EncodeRecipeResponseUnstable,
  ExportSessionRequestUnstable,
  ExportSessionResponseUnstable,
  ExportSourceRequestUnstable,
  ExportSourceResponseUnstable,
  GetAvailableExtensionsRequestUnstable,
  GetAvailableExtensionsResponseUnstable,
  GetConfigExtensionsRequestUnstable,
  GetConfigExtensionsResponseUnstable,
  GetPromptRequestUnstable,
  GetPromptResponseUnstable,
  GetSessionExtensionsRequestUnstable,
  GetSessionExtensionsResponseUnstable,
  GetSessionInfoRequestUnstable,
  GetSessionInfoResponseUnstable,
  GetToolsRequestUnstable,
  GetToolsResponseUnstable,
  GooseToolCallRequestUnstable,
  GooseToolCallResponseUnstable,
  ImportSessionRequestUnstable,
  ImportSessionResponseUnstable,
  ImportSourcesRequestUnstable,
  ImportSourcesResponseUnstable,
  InspectRunningJobRequestUnstable,
  InspectRunningJobResponseUnstable,
  KillRunningJobRequestUnstable,
  KillRunningJobResponseUnstable,
  ListAgentMentionsRequestUnstable,
  ListAgentMentionsResponseUnstable,
  ListPromptsRequestUnstable,
  ListPromptsResponseUnstable,
  ListProvidersRequestUnstable,
  ListProvidersResponseUnstable,
  ListRecipesRequestUnstable,
  ListRecipesResponseUnstable,
  ListScheduleSessionsRequestUnstable,
  ListScheduleSessionsResponseUnstable,
  ListSchedulesRequestUnstable,
  ListSchedulesResponseUnstable,
  ListSlashCommandsRequestUnstable,
  ListSlashCommandsResponseUnstable,
  ListSourcesRequestUnstable,
  ListSourcesResponseUnstable,
  LocalInferenceBuiltinChatTemplatesListRequestUnstable,
  LocalInferenceBuiltinChatTemplatesListResponseUnstable,
  LocalInferenceHuggingFaceRepoVariantsRequestUnstable,
  LocalInferenceHuggingFaceRepoVariantsResponseUnstable,
  LocalInferenceHuggingFaceSearchRequestUnstable,
  LocalInferenceHuggingFaceSearchResponseUnstable,
  LocalInferenceModelDeleteRequestUnstable,
  LocalInferenceModelDownloadCancelRequestUnstable,
  LocalInferenceModelDownloadProgressRequestUnstable,
  LocalInferenceModelDownloadProgressResponseUnstable,
  LocalInferenceModelDownloadRequestUnstable,
  LocalInferenceModelDownloadResponseUnstable,
  LocalInferenceModelEvictRequestUnstable,
  LocalInferenceModelSettingsReadRequestUnstable,
  LocalInferenceModelSettingsReadResponseUnstable,
  LocalInferenceModelSettingsUpdateRequestUnstable,
  LocalInferenceModelSettingsUpdateResponseUnstable,
  LocalInferenceModelsListRequestUnstable,
  LocalInferenceModelsListResponseUnstable,
  OnboardingImportApplyRequestUnstable,
  OnboardingImportApplyResponseUnstable,
  OnboardingImportScanRequestUnstable,
  OnboardingImportScanResponseUnstable,
  ParseRecipeRequestUnstable,
  ParseRecipeResponseUnstable,
  PauseScheduleRequestUnstable,
  PreferencesReadRequestUnstable,
  PreferencesReadResponseUnstable,
  PreferencesRemoveRequestUnstable,
  PreferencesSaveRequestUnstable,
  PromptOperationResponseUnstable,
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
  ProviderReadinessCheckRequestUnstable,
  ProviderReadinessCheckResponseUnstable,
  ProviderSecretDeleteRequestUnstable,
  ProviderSecretsListRequestUnstable,
  ProviderSecretsListResponseUnstable,
  ProviderSetupCatalogListRequestUnstable,
  ProviderSetupCatalogListResponseUnstable,
  ProviderSupportedModelsListRequestUnstable,
  ProviderSupportedModelsListResponseUnstable,
  ReadResourceRequestUnstable,
  ReadResourceResponseUnstable,
  RecipeToYamlRequestUnstable,
  RecipeToYamlResponseUnstable,
  RefreshProviderInventoryRequestUnstable,
  RefreshProviderInventoryResponseUnstable,
  RemoveConfigExtensionRequestUnstable,
  RemoveSessionExtensionRequestUnstable,
  RenameSessionRequestUnstable,
  ResetPromptRequestUnstable,
  RunScheduleNowRequestUnstable,
  RunScheduleNowResponseUnstable,
  SavePromptRequestUnstable,
  SaveRecipeRequestUnstable,
  SaveRecipeResponseUnstable,
  ScanRecipeRequestUnstable,
  ScanRecipeResponseUnstable,
  ScheduleRecipeRequestUnstable,
  SetConfigExtensionEnabledRequestUnstable,
  SetRecipeSlashCommandRequestUnstable,
  SetSessionSystemPromptRequestUnstable,
  SetToolPermissionsRequestUnstable,
  SetToolPermissionsResponseUnstable,
  ShareSessionNostrRequestUnstable,
  ShareSessionNostrResponseUnstable,
  SteerSessionRequestUnstable,
  SteerSessionResponseUnstable,
  TruncateSessionConversationRequestUnstable,
  UnarchiveSessionRequestUnstable,
  UnpauseScheduleRequestUnstable,
  UpdateScheduleRequestUnstable,
  UpdateScheduleResponseUnstable,
  UpdateSessionProjectRequestUnstable,
  UpdateSourceRequestUnstable,
  UpdateSourceResponseUnstable,
  UpdateWorkingDirRequestUnstable,
} from './types.gen.js';
import {
  zAppsDeleteResponseUnstable,
  zAppsExportResponseUnstable,
  zAppsImportResponseUnstable,
  zAppsListResponseUnstable,
  zCanonicalModelInfoResponseUnstable,
  zConfigReadAllResponseUnstable,
  zConfigReadResponseUnstable,
  zCreateScheduleResponseUnstable,
  zCreateSourceResponseUnstable,
  zCustomProviderCreateResponseUnstable,
  zCustomProviderDeleteResponseUnstable,
  zCustomProviderReadResponseUnstable,
  zCustomProviderUpdateResponseUnstable,
  zDecodeRecipeResponseUnstable,
  zDefaultsReadResponseUnstable,
  zDiagnosticsGetResponseUnstable,
  zDictationConfigResponseUnstable,
  zDictationModelDownloadProgressResponseUnstable,
  zDictationModelsListResponseUnstable,
  zDictationTranscribeResponseUnstable,
  zEncodeRecipeResponseUnstable,
  zExportSessionResponseUnstable,
  zExportSourceResponseUnstable,
  zGetAvailableExtensionsResponseUnstable,
  zGetConfigExtensionsResponseUnstable,
  zGetPromptResponseUnstable,
  zGetSessionExtensionsResponseUnstable,
  zGetSessionInfoResponseUnstable,
  zGetToolsResponseUnstable,
  zGooseToolCallResponseUnstable,
  zImportSessionResponseUnstable,
  zImportSourcesResponseUnstable,
  zInspectRunningJobResponseUnstable,
  zKillRunningJobResponseUnstable,
  zListAgentMentionsResponseUnstable,
  zListPromptsResponseUnstable,
  zListProvidersResponseUnstable,
  zListRecipesResponseUnstable,
  zListScheduleSessionsResponseUnstable,
  zListSchedulesResponseUnstable,
  zListSlashCommandsResponseUnstable,
  zListSourcesResponseUnstable,
  zLocalInferenceBuiltinChatTemplatesListResponseUnstable,
  zLocalInferenceHuggingFaceRepoVariantsResponseUnstable,
  zLocalInferenceHuggingFaceSearchResponseUnstable,
  zLocalInferenceModelDownloadProgressResponseUnstable,
  zLocalInferenceModelDownloadResponseUnstable,
  zLocalInferenceModelSettingsReadResponseUnstable,
  zLocalInferenceModelSettingsUpdateResponseUnstable,
  zLocalInferenceModelsListResponseUnstable,
  zOnboardingImportApplyResponseUnstable,
  zOnboardingImportScanResponseUnstable,
  zParseRecipeResponseUnstable,
  zPreferencesReadResponseUnstable,
  zPromptOperationResponseUnstable,
  zProviderCatalogListResponseUnstable,
  zProviderCatalogTemplateResponseUnstable,
  zProviderConfigChangeResponseUnstable,
  zProviderConfigReadResponseUnstable,
  zProviderConfigStatusResponseUnstable,
  zProviderReadinessCheckResponseUnstable,
  zProviderSecretsListResponseUnstable,
  zProviderSetupCatalogListResponseUnstable,
  zProviderSupportedModelsListResponseUnstable,
  zReadResourceResponseUnstable,
  zRecipeToYamlResponseUnstable,
  zRefreshProviderInventoryResponseUnstable,
  zRunScheduleNowResponseUnstable,
  zSaveRecipeResponseUnstable,
  zScanRecipeResponseUnstable,
  zSetToolPermissionsResponseUnstable,
  zShareSessionNostrResponseUnstable,
  zSteerSessionResponseUnstable,
  zUpdateScheduleResponseUnstable,
  zUpdateSourceResponseUnstable,
} from './zod.gen.js';

export class GooseExtClient {
  constructor(private conn: ExtMethodProvider) {}

  async GooseUnstableSessionExtensionsAdd(
    params: AddSessionExtensionRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/session/extensions/add", params);
  }

  async GooseUnstableSessionExtensionsRemove(
    params: RemoveSessionExtensionRequestUnstable,
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

  async GooseUnstableToolsPermissionsSet(
    params: SetToolPermissionsRequestUnstable,
  ): Promise<SetToolPermissionsResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/tools/permissions/set",
      params,
    );
    return zSetToolPermissionsResponseUnstable.parse(
      raw,
    ) as SetToolPermissionsResponseUnstable;
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

  async GooseUnstableAppsList(
    params: AppsListRequestUnstable,
  ): Promise<AppsListResponseUnstable> {
    const raw = await this.conn.extMethod("_goose/unstable/apps/list", params);
    return zAppsListResponseUnstable.parse(raw) as AppsListResponseUnstable;
  }

  async GooseUnstableAppsExport(
    params: AppsExportRequestUnstable,
  ): Promise<AppsExportResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/apps/export",
      params,
    );
    return zAppsExportResponseUnstable.parse(raw) as AppsExportResponseUnstable;
  }

  async GooseUnstableAppsImport(
    params: AppsImportRequestUnstable,
  ): Promise<AppsImportResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/apps/import",
      params,
    );
    return zAppsImportResponseUnstable.parse(raw) as AppsImportResponseUnstable;
  }

  async GooseUnstableAppsDelete(
    params: AppsDeleteRequestUnstable,
  ): Promise<AppsDeleteResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/apps/delete",
      params,
    );
    return zAppsDeleteResponseUnstable.parse(raw) as AppsDeleteResponseUnstable;
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

  async GooseUnstableSessionSteer(
    params: SteerSessionRequestUnstable,
  ): Promise<SteerSessionResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/session/steer",
      params,
    );
    return zSteerSessionResponseUnstable.parse(
      raw,
    ) as SteerSessionResponseUnstable;
  }

  async GooseUnstableDiagnosticsGet(
    params: DiagnosticsGetRequestUnstable,
  ): Promise<DiagnosticsGetResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/diagnostics/get",
      params,
    );
    return zDiagnosticsGetResponseUnstable.parse(
      raw,
    ) as DiagnosticsGetResponseUnstable;
  }

  async GooseUnstableConfigPromptsList(
    params: ListPromptsRequestUnstable,
  ): Promise<ListPromptsResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/config/prompts/list",
      params,
    );
    return zListPromptsResponseUnstable.parse(
      raw,
    ) as ListPromptsResponseUnstable;
  }

  async GooseUnstableConfigPromptsGet(
    params: GetPromptRequestUnstable,
  ): Promise<GetPromptResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/config/prompts/get",
      params,
    );
    return zGetPromptResponseUnstable.parse(raw) as GetPromptResponseUnstable;
  }

  async GooseUnstableConfigPromptsSave(
    params: SavePromptRequestUnstable,
  ): Promise<PromptOperationResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/config/prompts/save",
      params,
    );
    return zPromptOperationResponseUnstable.parse(
      raw,
    ) as PromptOperationResponseUnstable;
  }

  async GooseUnstableConfigPromptsReset(
    params: ResetPromptRequestUnstable,
  ): Promise<PromptOperationResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/config/prompts/reset",
      params,
    );
    return zPromptOperationResponseUnstable.parse(
      raw,
    ) as PromptOperationResponseUnstable;
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

  async GooseUnstableProvidersReadinessCheck(
    params: ProviderReadinessCheckRequestUnstable,
  ): Promise<ProviderReadinessCheckResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/providers/readiness/check",
      params,
    );
    return zProviderReadinessCheckResponseUnstable.parse(
      raw,
    ) as ProviderReadinessCheckResponseUnstable;
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

  async GooseUnstableProvidersSecretsList(
    params: ProviderSecretsListRequestUnstable,
  ): Promise<ProviderSecretsListResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/providers/secrets/list",
      params,
    );
    return zProviderSecretsListResponseUnstable.parse(
      raw,
    ) as ProviderSecretsListResponseUnstable;
  }

  async GooseUnstableProvidersSecretsDelete(
    params: ProviderSecretDeleteRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod(
      "_goose/unstable/providers/secrets/delete",
      params,
    );
  }

  async GooseUnstableProvidersCanonicalModelInfo(
    params: CanonicalModelInfoRequestUnstable,
  ): Promise<CanonicalModelInfoResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/providers/canonical-model-info",
      params,
    );
    return zCanonicalModelInfoResponseUnstable.parse(
      raw,
    ) as CanonicalModelInfoResponseUnstable;
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

  async GooseUnstableConfigRead(
    params: ConfigReadRequestUnstable,
  ): Promise<ConfigReadResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/config/read",
      params,
    );
    return zConfigReadResponseUnstable.parse(raw) as ConfigReadResponseUnstable;
  }

  async GooseUnstableConfigUpsert(
    params: ConfigUpsertRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/config/upsert", params);
  }

  async GooseUnstableConfigRemove(
    params: ConfigRemoveRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/config/remove", params);
  }

  async GooseUnstableConfigReadAll(
    params: ConfigReadAllRequestUnstable,
  ): Promise<ConfigReadAllResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/config/read-all",
      params,
    );
    return zConfigReadAllResponseUnstable.parse(
      raw,
    ) as ConfigReadAllResponseUnstable;
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

  async GooseUnstableDefaultsClear(
    params: DefaultsClearRequestUnstable,
  ): Promise<DefaultsReadResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/defaults/clear",
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

  async GooseUnstableSessionShareNostr(
    params: ShareSessionNostrRequestUnstable,
  ): Promise<ShareSessionNostrResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/session/share/nostr",
      params,
    );
    return zShareSessionNostrResponseUnstable.parse(
      raw,
    ) as ShareSessionNostrResponseUnstable;
  }

  async GooseUnstableRecipesEncode(
    params: EncodeRecipeRequestUnstable,
  ): Promise<EncodeRecipeResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/recipes/encode",
      params,
    );
    return zEncodeRecipeResponseUnstable.parse(
      raw,
    ) as EncodeRecipeResponseUnstable;
  }

  async GooseUnstableRecipesDecode(
    params: DecodeRecipeRequestUnstable,
  ): Promise<DecodeRecipeResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/recipes/decode",
      params,
    );
    return zDecodeRecipeResponseUnstable.parse(
      raw,
    ) as DecodeRecipeResponseUnstable;
  }

  async GooseUnstableRecipesScan(
    params: ScanRecipeRequestUnstable,
  ): Promise<ScanRecipeResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/recipes/scan",
      params,
    );
    return zScanRecipeResponseUnstable.parse(raw) as ScanRecipeResponseUnstable;
  }

  async GooseUnstableRecipesList(
    params: ListRecipesRequestUnstable,
  ): Promise<ListRecipesResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/recipes/list",
      params,
    );
    return zListRecipesResponseUnstable.parse(
      raw,
    ) as ListRecipesResponseUnstable;
  }

  async GooseUnstableRecipesDelete(
    params: DeleteRecipeRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/recipes/delete", params);
  }

  async GooseUnstableRecipesSchedule(
    params: ScheduleRecipeRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/recipes/schedule", params);
  }

  async GooseUnstableRecipesSlashCommand(
    params: SetRecipeSlashCommandRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/recipes/slash-command", params);
  }

  async GooseUnstableRecipesSave(
    params: SaveRecipeRequestUnstable,
  ): Promise<SaveRecipeResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/recipes/save",
      params,
    );
    return zSaveRecipeResponseUnstable.parse(raw) as SaveRecipeResponseUnstable;
  }

  async GooseUnstableRecipesParse(
    params: ParseRecipeRequestUnstable,
  ): Promise<ParseRecipeResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/recipes/parse",
      params,
    );
    return zParseRecipeResponseUnstable.parse(
      raw,
    ) as ParseRecipeResponseUnstable;
  }

  async GooseUnstableRecipesToYaml(
    params: RecipeToYamlRequestUnstable,
  ): Promise<RecipeToYamlResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/recipes/to-yaml",
      params,
    );
    return zRecipeToYamlResponseUnstable.parse(
      raw,
    ) as RecipeToYamlResponseUnstable;
  }

  async GooseUnstableSchedulesList(
    params: ListSchedulesRequestUnstable,
  ): Promise<ListSchedulesResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/schedules/list",
      params,
    );
    return zListSchedulesResponseUnstable.parse(
      raw,
    ) as ListSchedulesResponseUnstable;
  }

  async GooseUnstableSchedulesSessionsList(
    params: ListScheduleSessionsRequestUnstable,
  ): Promise<ListScheduleSessionsResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/schedules/sessions/list",
      params,
    );
    return zListScheduleSessionsResponseUnstable.parse(
      raw,
    ) as ListScheduleSessionsResponseUnstable;
  }

  async GooseUnstableSchedulesCreate(
    params: CreateScheduleRequestUnstable,
  ): Promise<CreateScheduleResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/schedules/create",
      params,
    );
    return zCreateScheduleResponseUnstable.parse(
      raw,
    ) as CreateScheduleResponseUnstable;
  }

  async GooseUnstableSchedulesDelete(
    params: DeleteScheduleRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/schedules/delete", params);
  }

  async GooseUnstableSchedulesPause(
    params: PauseScheduleRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/schedules/pause", params);
  }

  async GooseUnstableSchedulesUnpause(
    params: UnpauseScheduleRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod("_goose/unstable/schedules/unpause", params);
  }

  async GooseUnstableSchedulesUpdate(
    params: UpdateScheduleRequestUnstable,
  ): Promise<UpdateScheduleResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/schedules/update",
      params,
    );
    return zUpdateScheduleResponseUnstable.parse(
      raw,
    ) as UpdateScheduleResponseUnstable;
  }

  async GooseUnstableSchedulesRunNow(
    params: RunScheduleNowRequestUnstable,
  ): Promise<RunScheduleNowResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/schedules/run-now",
      params,
    );
    return zRunScheduleNowResponseUnstable.parse(
      raw,
    ) as RunScheduleNowResponseUnstable;
  }

  async GooseUnstableSchedulesRunningJobKill(
    params: KillRunningJobRequestUnstable,
  ): Promise<KillRunningJobResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/schedules/running-job/kill",
      params,
    );
    return zKillRunningJobResponseUnstable.parse(
      raw,
    ) as KillRunningJobResponseUnstable;
  }

  async GooseUnstableSchedulesRunningJobInspect(
    params: InspectRunningJobRequestUnstable,
  ): Promise<InspectRunningJobResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/schedules/running-job/inspect",
      params,
    );
    return zInspectRunningJobResponseUnstable.parse(
      raw,
    ) as InspectRunningJobResponseUnstable;
  }

  async GooseUnstableSessionInfo(
    params: GetSessionInfoRequestUnstable,
  ): Promise<GetSessionInfoResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/session/info",
      params,
    );
    return zGetSessionInfoResponseUnstable.parse(
      raw,
    ) as GetSessionInfoResponseUnstable;
  }

  async GooseUnstableSessionConversationTruncate(
    params: TruncateSessionConversationRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod(
      "_goose/unstable/session/conversation/truncate",
      params,
    );
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

  async GooseUnstableAgentMentionsList(
    params: ListAgentMentionsRequestUnstable,
  ): Promise<ListAgentMentionsResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/agent-mentions/list",
      params,
    );
    return zListAgentMentionsResponseUnstable.parse(
      raw,
    ) as ListAgentMentionsResponseUnstable;
  }

  async GooseUnstableSlashCommandsList(
    params: ListSlashCommandsRequestUnstable,
  ): Promise<ListSlashCommandsResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/slash-commands/list",
      params,
    );
    return zListSlashCommandsResponseUnstable.parse(
      raw,
    ) as ListSlashCommandsResponseUnstable;
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

  async GooseUnstableLocalInferenceModelsList(
    params: LocalInferenceModelsListRequestUnstable,
  ): Promise<LocalInferenceModelsListResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/local-inference/models/list",
      params,
    );
    return zLocalInferenceModelsListResponseUnstable.parse(
      raw,
    ) as LocalInferenceModelsListResponseUnstable;
  }

  async GooseUnstableLocalInferenceModelsDownload(
    params: LocalInferenceModelDownloadRequestUnstable,
  ): Promise<LocalInferenceModelDownloadResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/local-inference/models/download",
      params,
    );
    return zLocalInferenceModelDownloadResponseUnstable.parse(
      raw,
    ) as LocalInferenceModelDownloadResponseUnstable;
  }

  async GooseUnstableLocalInferenceModelsDownloadProgress(
    params: LocalInferenceModelDownloadProgressRequestUnstable,
  ): Promise<LocalInferenceModelDownloadProgressResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/local-inference/models/download/progress",
      params,
    );
    return zLocalInferenceModelDownloadProgressResponseUnstable.parse(
      raw,
    ) as LocalInferenceModelDownloadProgressResponseUnstable;
  }

  async GooseUnstableLocalInferenceModelsDownloadCancel(
    params: LocalInferenceModelDownloadCancelRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod(
      "_goose/unstable/local-inference/models/download/cancel",
      params,
    );
  }

  async GooseUnstableLocalInferenceModelsDelete(
    params: LocalInferenceModelDeleteRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod(
      "_goose/unstable/local-inference/models/delete",
      params,
    );
  }

  async GooseUnstableLocalInferenceModelsEvict(
    params: LocalInferenceModelEvictRequestUnstable,
  ): Promise<void> {
    await this.conn.extMethod(
      "_goose/unstable/local-inference/models/evict",
      params,
    );
  }

  async GooseUnstableLocalInferenceModelsSettingsRead(
    params: LocalInferenceModelSettingsReadRequestUnstable,
  ): Promise<LocalInferenceModelSettingsReadResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/local-inference/models/settings/read",
      params,
    );
    return zLocalInferenceModelSettingsReadResponseUnstable.parse(
      raw,
    ) as LocalInferenceModelSettingsReadResponseUnstable;
  }

  async GooseUnstableLocalInferenceModelsSettingsUpdate(
    params: LocalInferenceModelSettingsUpdateRequestUnstable,
  ): Promise<LocalInferenceModelSettingsUpdateResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/local-inference/models/settings/update",
      params,
    );
    return zLocalInferenceModelSettingsUpdateResponseUnstable.parse(
      raw,
    ) as LocalInferenceModelSettingsUpdateResponseUnstable;
  }

  async GooseUnstableLocalInferenceHuggingfaceSearch(
    params: LocalInferenceHuggingFaceSearchRequestUnstable,
  ): Promise<LocalInferenceHuggingFaceSearchResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/local-inference/huggingface/search",
      params,
    );
    return zLocalInferenceHuggingFaceSearchResponseUnstable.parse(
      raw,
    ) as LocalInferenceHuggingFaceSearchResponseUnstable;
  }

  async GooseUnstableLocalInferenceHuggingfaceRepoVariants(
    params: LocalInferenceHuggingFaceRepoVariantsRequestUnstable,
  ): Promise<LocalInferenceHuggingFaceRepoVariantsResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/local-inference/huggingface/repo/variants",
      params,
    );
    return zLocalInferenceHuggingFaceRepoVariantsResponseUnstable.parse(
      raw,
    ) as LocalInferenceHuggingFaceRepoVariantsResponseUnstable;
  }

  async GooseUnstableLocalInferenceChatTemplatesBuiltinList(
    params: LocalInferenceBuiltinChatTemplatesListRequestUnstable,
  ): Promise<LocalInferenceBuiltinChatTemplatesListResponseUnstable> {
    const raw = await this.conn.extMethod(
      "_goose/unstable/local-inference/chat-templates/builtin/list",
      params,
    );
    return zLocalInferenceBuiltinChatTemplatesListResponseUnstable.parse(
      raw,
    ) as LocalInferenceBuiltinChatTemplatesListResponseUnstable;
  }
}
