import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FolderOpen, RotateCcw, Terminal, Trash2 } from "lucide-react";
import {
  listAuthWorkspaces,
  logout,
  switchAuthWorkspace,
  type AuthStatus,
  type AuthWorkspaceList,
} from "@/features/auth/api/auth";
import { resetChatRuntimeStartup } from "@/app/lib/chatRuntimeStartup";
import { cn } from "@/shared/lib/cn";
import { getPlatform } from "@/shared/lib/platform";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { SettingsRow } from "@/shared/ui/settings-row";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { clearLocalMediaCaches } from "@/shared/api/localMediaCaches";
import { type LocalePreference, useLocale } from "@/shared/i18n";
import { useArtifactRootPreference } from "@/shared/artifacts/useArtifactRootPreference";
import { useTerminalFallbackCwdPreference } from "@/features/terminal/lib/terminalCwdPreference";
import { useProfileCapability } from "@/shared/profile/capabilities";
import { UpdatesSettings } from "@/features/updates/ui/UpdatesSettings";
import { RuntimeConfigSettings } from "./RuntimeConfigSettings";
import { TelemetryConsentRow } from "./TelemetryConsentRow";
import { DoctorSettings } from "./DoctorSettings";
import { useDoctorStatusSummary } from "@/shared/api/useDoctorReport";
import {
  getBbCliStatus,
  installBbCli,
  type BbCliStatus,
} from "@/shared/api/bbCli";

interface AboutAppInfo {
  version: string;
  tauriVersion: string;
  identifier: string;
}

function AboutInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <SettingsRow
      label={<span className="text-muted-foreground">{label}</span>}
      action={
        <span className="block min-w-0 truncate text-right text-sm">
          {value}
        </span>
      }
    />
  );
}

interface SystemSettingsProps {
  authStatus?: AuthStatus;
  onLoggedOut?: (status: AuthStatus) => void;
}

// System (rev 3): "settings about Berd as installed software on this
// machine" -- split out of the old GeneralSettings.tsx. Language lives here
// (not Chat) per the settings-categories-and-content.md spec.
//
// Doctor (rev 4): opens as a dialog from this row instead of navigating to
// its own page -- feedback was that Doctor being the only settings surface
// with a deeper nav level felt off. This became workable once Doctor's
// action buttons (Copy report/Rerun) moved into a settings-surface actions
// slot instead of the app's top bar.
//
// Rev 4.1 (design feedback from Lauren): the row's problem indicator was
// originally a colored dot in the row's `leading` slot. Feedback: (1) a red
// dot implies "there's an action to take," when this just means "something
// looks off" -- closer to how AgentProviderCard shows a plain destructive-
// colored text line (e.g. "amp-acp not installed") than to a badge; (2) a
// leading-slot dot indents the row's title, breaking left alignment and
// reading as if Doctor were a sub-item of the row above; any indicator that
// can appear/disappear after the row has already rendered (once a report
// loads) also shouldn't shift the title when it does. Replaced with a plain
// status line under the row's description, in the same style as the
// destructive text health-check surfaces elsewhere use -- no dot, no
// indent, and it's just additional description text, not a badge.
//
// Rev 5 (Aug 19): "About" merged into System instead of staying its own nav
// destination -- both pages were "settings about Berd itself," just split
// across install-level vs. identity-level, which wasn't a distinction
// worth a second sidebar row. The embedded Updates card (app version + the
// "Check for updates" row) moved to the very top of this page, since
// checking for updates is the row people actually look for. The rest of
// About's content -- app identity fields and Account -- moved down to the
// bottom under an "About" subhead, in the same order they rendered on the
// old About page. `about` and the legacy `updates` route both redirect
// here now (see settingsSections.ts).
export function SystemSettings({
  authStatus,
  onLoggedOut,
}: SystemSettingsProps) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const { preference, setLocalePreference, systemLocaleLabel } = useLocale();
  const [bbCliStatus, setBbCliStatus] = useState<BbCliStatus | null>(null);
  const [bbCliLoading, setBbCliLoading] = useState(false);
  const [bbCliInstalling, setBbCliInstalling] = useState(false);
  const [clearCacheDialogOpen, setClearCacheDialogOpen] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [doctorDialogOpen, setDoctorDialogOpen] = useState(false);
  const [appInfo, setAppInfo] = useState<AboutAppInfo | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [workspaceList, setWorkspaceList] = useState<AuthWorkspaceList | null>(
    null,
  );
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState(false);
  const [workspaceSwitching, setWorkspaceSwitching] = useState(false);
  const artifactRootPreference = useArtifactRootPreference();
  const terminalFallbackCwdPreference = useTerminalFallbackCwdPreference();
  const doctorEnabled = useProfileCapability("doctor");
  const agentToolsEnabled = useProfileCapability("agentTools");
  const updatesEnabled = useProfileCapability("updates");
  const isMac = getPlatform() === "mac";
  const doctorStatus = useDoctorStatusSummary();
  const terminalFallbackPath =
    terminalFallbackCwdPreference.fallbackCwd ??
    artifactRootPreference.rootPath;

  const refreshBbCliStatus = useCallback(async () => {
    if (!isMac || !agentToolsEnabled || !window.__TAURI_INTERNALS__) {
      return;
    }

    setBbCliLoading(true);
    try {
      setBbCliStatus(await getBbCliStatus());
    } catch (error) {
      console.warn("Failed to load bb CLI status:", error);
      setBbCliStatus(null);
    } finally {
      setBbCliLoading(false);
    }
  }, [agentToolsEnabled, isMac]);

  useEffect(() => {
    void refreshBbCliStatus();
  }, [refreshBbCliStatus]);

  useEffect(() => {
    let cancelled = false;

    async function loadAppInfo() {
      if (!window.__TAURI_INTERNALS__) {
        return;
      }

      try {
        const { getIdentifier, getTauriVersion, getVersion } = await import(
          "@tauri-apps/api/app"
        );
        const [version, tauriVersion, identifier] = await Promise.all([
          getVersion(),
          getTauriVersion(),
          getIdentifier(),
        ]);

        if (!cancelled) {
          setAppInfo({ version, tauriVersion, identifier });
        }
      } catch {
        if (!cancelled) {
          setAppInfo(null);
        }
      }
    }

    void loadAppInfo();

    return () => {
      cancelled = true;
    };
  }, []);

  const aboutFallback = t("about.unavailable");

  async function handleLogout() {
    setLoggingOut(true);
    try {
      const nextStatus = await logout();
      // `onLoggedOut` flips the auth gate, which unmounts AppShell and remounts
      // it on the next login. Clear the startup latch first so that remount
      // re-runs startup instead of reusing this account's run.
      resetChatRuntimeStartup();
      toast.success(t("account.logoutSuccess"));
      onLoggedOut?.(nextStatus);
    } catch (error) {
      console.warn("Failed to log out:", error);
      toast.error(t("account.logoutError"));
    } finally {
      setLoggingOut(false);
    }
  }

  const loadWorkspaces = useCallback(async () => {
    if (authStatus?.loggedIn !== true) return;

    setWorkspaceLoading(true);
    setWorkspaceError(false);
    try {
      setWorkspaceList(await listAuthWorkspaces());
    } catch (error) {
      console.warn("Failed to list workspaces:", error);
      setWorkspaceError(true);
    } finally {
      setWorkspaceLoading(false);
    }
  }, [authStatus?.loggedIn]);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  async function handleWorkspaceSwitch(workspaceIdentifier: string) {
    if (
      workspaceSwitching ||
      workspaceIdentifier === workspaceList?.activeWorkspaceIdentifier
    ) {
      return;
    }

    setWorkspaceSwitching(true);
    try {
      const result = await switchAuthWorkspace(workspaceIdentifier);
      const activeWorkspaceIdentifier =
        result.workspace.workspaceIdentifier ?? workspaceIdentifier;
      setWorkspaceList((current) =>
        current
          ? {
              ...current,
              activeWorkspaceIdentifier,
            }
          : current,
      );
      await queryClient.invalidateQueries();
      toast.success(
        t("account.workspace.switchSuccess", {
          workspace: result.workspace.displayName ?? activeWorkspaceIdentifier,
        }),
      );
    } catch (error) {
      console.warn("Failed to switch workspace:", error);
      toast.error(t("account.workspace.switchError"));
    } finally {
      setWorkspaceSwitching(false);
    }
  }

  const signedInAs =
    authStatus?.email ?? authStatus?.name ?? authStatus?.user ?? aboutFallback;
  const organization = authStatus?.org ?? aboutFallback;
  const showAccountSection = authStatus?.loggedIn === true;
  const selectableWorkspaces =
    workspaceList?.workspaces.filter(
      (workspace) => workspace.workspaceIdentifier,
    ) ?? [];

  async function handleClearMediaCache() {
    setClearingCache(true);
    try {
      await clearLocalMediaCaches();
      toast.success(t("storage.cachedMedia.success"));
      setClearCacheDialogOpen(false);
    } catch (error) {
      console.warn("Failed to clear local media caches:", error);
      toast.error(t("storage.cachedMedia.error"));
    } finally {
      setClearingCache(false);
    }
  }

  async function handleChooseArtifactRoot() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        defaultPath: artifactRootPreference.rootPath ?? undefined,
        directory: true,
        multiple: false,
        title: t("general.artifacts.chooseDialogTitle"),
      });

      if (typeof selected !== "string") {
        return;
      }

      await artifactRootPreference.setRootPath(selected);
      toast.success(t("general.artifacts.saveSuccess"));
    } catch (error) {
      console.warn("Failed to choose artifact folder:", error);
      toast.error(t("general.artifacts.saveError"));
    }
  }

  async function handleResetArtifactRoot() {
    try {
      await artifactRootPreference.resetRootPath();
      toast.success(t("general.artifacts.resetSuccess"));
    } catch (error) {
      console.warn("Failed to reset artifact folder:", error);
      toast.error(t("general.artifacts.saveError"));
    }
  }

  async function handleChooseTerminalFallbackCwd() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        defaultPath: terminalFallbackPath ?? undefined,
        directory: true,
        multiple: false,
        title: t("general.terminalFallback.chooseDialogTitle"),
      });

      if (typeof selected !== "string") {
        return;
      }

      terminalFallbackCwdPreference.setFallbackCwd(selected);
      toast.success(t("general.terminalFallback.saveSuccess"));
    } catch (error) {
      console.warn("Failed to choose terminal fallback folder:", error);
      toast.error(t("general.terminalFallback.saveError"));
    }
  }

  function handleResetTerminalFallbackCwd() {
    try {
      terminalFallbackCwdPreference.resetFallbackCwd();
      toast.success(t("general.terminalFallback.resetSuccess"));
    } catch (error) {
      console.warn("Failed to reset terminal fallback folder:", error);
      toast.error(t("general.terminalFallback.saveError"));
    }
  }

  async function handleInstallBbCli() {
    setBbCliInstalling(true);
    try {
      const nextStatus = await installBbCli();
      setBbCliStatus(nextStatus);
      toast.success(t("general.bbCli.installSuccess"));
    } catch (error) {
      console.warn("Failed to install bb CLI:", error);
      toast.error(t("general.bbCli.installError"));
      await refreshBbCliStatus();
    } finally {
      setBbCliInstalling(false);
    }
  }

  const bbCliActionLabel =
    bbCliStatus?.installed || bbCliStatus?.needsRepair
      ? t("general.bbCli.repair")
      : t("general.bbCli.install");
  const bbCliBusy = bbCliLoading || bbCliInstalling;

  return (
    <SettingsPage title={t("nav.system")} contentClassName="space-y-8">
      <SettingsSections>
        {/* Check for updates, first (rev 5): the row people open System for
          most often. Renders app version + the release channel picker
          alongside it, same content as the old standalone Updates card. */}
        {updatesEnabled ? <UpdatesSettings embedded /> : null}

        <SettingsSection>
          <SettingsRow
            label={t("general.language.label")}
            description={t("general.language.description")}
          >
            <Select
              value={preference}
              onValueChange={(value) =>
                void setLocalePreference(value as LocalePreference)
              }
            >
              <SelectTrigger className="w-full min-w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">
                  {t("general.language.system", {
                    language: systemLocaleLabel,
                  })}
                </SelectItem>
                <SelectItem value="en">
                  {t("general.language.english")}
                </SelectItem>
                <SelectItem value="es">
                  {t("general.language.spanish")}
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>

          <SettingsRow
            label={t("general.artifacts.label")}
            description={t("general.artifacts.description")}
            align="start"
          >
            <div className="flex max-w-80 flex-col items-end gap-2">
              <p
                className="max-w-80 truncate text-right text-xs text-muted-foreground"
                title={artifactRootPreference.rootPath ?? undefined}
              >
                {artifactRootPreference.rootPath ??
                  t("general.artifacts.loading")}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => void handleResetArtifactRoot()}
                  disabled={!artifactRootPreference.hasCustomRoot}
                >
                  <RotateCcw className="size-3.5" />
                  {t("general.artifacts.reset")}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="xs"
                  onClick={() => void handleChooseArtifactRoot()}
                >
                  <FolderOpen className="size-3.5" />
                  {t("general.artifacts.change")}
                </Button>
              </div>
            </div>
          </SettingsRow>

          <SettingsRow
            label={t("general.terminalFallback.label")}
            description={t("general.terminalFallback.description")}
            align="start"
          >
            <div className="flex max-w-80 flex-col items-end gap-2">
              <p
                className="max-w-80 truncate text-right text-xs text-muted-foreground"
                title={terminalFallbackPath ?? undefined}
              >
                {terminalFallbackPath ?? t("general.terminalFallback.loading")}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={handleResetTerminalFallbackCwd}
                  disabled={!terminalFallbackCwdPreference.hasCustomFallbackCwd}
                >
                  <RotateCcw className="size-3.5" />
                  {t("general.terminalFallback.reset")}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="xs"
                  onClick={() => void handleChooseTerminalFallbackCwd()}
                >
                  <FolderOpen className="size-3.5" />
                  {t("general.terminalFallback.change")}
                </Button>
              </div>
            </div>
          </SettingsRow>

          <SettingsRow
            label={t("storage.cachedMedia.label")}
            description={t("storage.cachedMedia.description")}
          >
            <Button
              type="button"
              variant="primary"
              size="xs"
              onClick={() => setClearCacheDialogOpen(true)}
            >
              <Trash2 className="size-3.5" />
              {t("storage.cachedMedia.clear")}
            </Button>
          </SettingsRow>

          {doctorEnabled ? (
            <SettingsRow
              label={t("doctor.title")}
              description={
                <>
                  <span className="block">{t("doctor.rowDescription")}</span>
                  {doctorStatus && doctorStatus.status !== "pass" ? (
                    <span
                      className={cn(
                        "mt-0.5 block",
                        doctorStatus.status === "fail"
                          ? "text-destructive"
                          : "text-warning",
                      )}
                    >
                      {t("doctor.rowStatus", {
                        count: doctorStatus.attentionCount,
                      })}
                    </span>
                  ) : null}
                </>
              }
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDoctorDialogOpen(true)}
              >
                {t("doctor.open")}
              </Button>
            </SettingsRow>
          ) : null}
        </SettingsSection>

        {/* Renders nothing in enforced builds, where telemetry consent is
          build policy and not a user choice, or when the `telemetry`
          capability is off, where no event can emit whatever consent says. */}
        <TelemetryConsentRow />

        {/* bb CLI and Runtime config are both one-off developer-facing rows
          (not a growing list), so they share a single "Developer tools"
          section instead of each getting its own subheading -- this also
          gives them a divider between them for free via SettingsSection's
          divide-y content wrapper. A restricted build compiled with the
          `no-bb-cli-install` Cargo feature reports `unsupportedInBuild`;
          hide the bb CLI row entirely rather than showing a button that can
          never install. Runtime config only renders in dev builds. */}
        {(isMac && agentToolsEnabled && !bbCliStatus?.unsupportedInBuild) ||
        import.meta.env.DEV ? (
          <SettingsSection title={t("developerTools.title")}>
            {isMac && agentToolsEnabled && !bbCliStatus?.unsupportedInBuild ? (
              <SettingsRow
                label={t("general.bbCli.label")}
                description={
                  bbCliStatus
                    ? `${bbCliStatus.message}. ${bbCliStatus.detail}`
                    : t("general.bbCli.description")
                }
                align="start"
              >
                <div className="flex flex-col items-end gap-2">
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => void refreshBbCliStatus()}
                      disabled={bbCliBusy}
                    >
                      <RotateCcw className="size-3.5" />
                      {t("general.bbCli.refresh")}
                    </Button>
                    <Button
                      type="button"
                      variant={bbCliStatus?.installed ? "outline" : "primary"}
                      size="xs"
                      onClick={() => void handleInstallBbCli()}
                      disabled={bbCliBusy || bbCliStatus?.canInstall === false}
                    >
                      <Terminal className="size-3.5" />
                      {bbCliInstalling
                        ? t("general.bbCli.installing")
                        : bbCliActionLabel}
                    </Button>
                  </div>
                  <p className="max-w-80 truncate text-right text-xs text-muted-foreground">
                    {bbCliStatus?.bundledVersion
                      ? t("general.bbCli.version", {
                          version: bbCliStatus.bundledVersion,
                        })
                      : t("general.bbCli.versionUnknown")}
                  </p>
                </div>
              </SettingsRow>
            ) : null}

            {import.meta.env.DEV ? <RuntimeConfigSettings /> : null}
          </SettingsSection>
        ) : null}

        {/* About (rev 5): app identity rows + Account, moved here from the
          standalone About page and pushed to the bottom of System, under
          their own subhead. App version normally isn't duplicated here
          since the embedded Updates card above already shows it -- but in
          updater-disabled builds (VITE_UPDATER_ENABLED=false / capability
          off) that card doesn't render at all, and this is still the only
          app-identity surface, so restricted/custom builds would otherwise
          have no visible version anywhere. Show the row only when the card
          is absent. Caught by Builderbot review (carried over from About). */}
        <SettingsSection title={t("about.title")}>
          {!updatesEnabled ? (
            <AboutInfoRow
              label={t("about.fields.version")}
              value={appInfo?.version ?? aboutFallback}
            />
          ) : null}
          <AboutInfoRow
            label={t("about.fields.buildMode")}
            value={
              import.meta.env.DEV
                ? t("about.buildModes.development")
                : t("about.buildModes.production")
            }
          />
          <AboutInfoRow
            label={t("about.fields.tauriVersion")}
            value={appInfo?.tauriVersion ?? aboutFallback}
          />
          <AboutInfoRow
            label={t("about.fields.identifier")}
            value={appInfo?.identifier ?? aboutFallback}
          />
          <AboutInfoRow label={t("about.fields.license")} value="Apache-2.0" />
        </SettingsSection>

        {showAccountSection ? (
          <SettingsSection title={t("account.title")}>
            <SettingsRow
              label={t("account.signedInAs")}
              description={signedInAs}
              align="start"
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                feedbackState={loggingOut ? "loading" : "idle"}
                loadingLabel={t("account.loggingOut")}
                disabled={loggingOut}
                onClick={() => void handleLogout()}
              >
                {t("account.logout")}
              </Button>
            </SettingsRow>
            <AboutInfoRow
              label={t("account.organization")}
              value={organization}
            />
            <SettingsRow
              label={t("account.workspace.label")}
              description={
                workspaceError
                  ? t("account.workspace.loadError")
                  : t("account.workspace.description")
              }
            >
              {workspaceError ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={workspaceLoading}
                  onClick={() => void loadWorkspaces()}
                >
                  {t("account.workspace.retry")}
                </Button>
              ) : (
                <Select
                  value={workspaceList?.activeWorkspaceIdentifier ?? undefined}
                  disabled={
                    workspaceLoading ||
                    workspaceSwitching ||
                    selectableWorkspaces.length === 0
                  }
                  onValueChange={(value) => void handleWorkspaceSwitch(value)}
                >
                  <SelectTrigger
                    className="w-52"
                    aria-label={t("account.workspace.label")}
                  >
                    <SelectValue
                      placeholder={
                        workspaceLoading
                          ? t("account.workspace.loading")
                          : t("account.workspace.unavailable")
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {selectableWorkspaces.map((workspace) => (
                      <SelectItem
                        key={workspace.workspaceIdentifier}
                        value={workspace.workspaceIdentifier ?? ""}
                      >
                        {workspace.displayName ?? workspace.workspaceIdentifier}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </SettingsRow>
          </SettingsSection>
        ) : null}
      </SettingsSections>

      <ConfirmDialog
        open={clearCacheDialogOpen}
        onOpenChange={setClearCacheDialogOpen}
        title={t("storage.cachedMedia.confirmTitle")}
        description={t("storage.cachedMedia.confirmDescription")}
        cancelLabel={t("common:actions.cancel")}
        confirmLabel={t("storage.cachedMedia.confirm")}
        loadingLabel={t("storage.cachedMedia.clearing")}
        isLoading={clearingCache}
        onConfirm={handleClearMediaCache}
      />

      {doctorEnabled ? (
        <DoctorSettings
          open={doctorDialogOpen}
          onOpenChange={setDoctorDialogOpen}
        />
      ) : null}
    </SettingsPage>
  );
}
