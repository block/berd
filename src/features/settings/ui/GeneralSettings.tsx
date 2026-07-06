import { ColorPicker } from "@/shared/ui/color-picker";
import { logout, type AuthStatus } from "@/features/auth/api/auth";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { type LocalePreference, useLocale } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { Button } from "@/shared/ui/button";
import { requestOpenSettings } from "@/features/settings/lib/settingsEvents";
import { useTheme } from "@/shared/theme/ThemeProvider";
import {
  Check,
  FolderOpen,
  Moon,
  RotateCcw,
  Sun,
  SunMoon,
  Terminal,
  Trash2,
} from "lucide-react";
import { IconCheck } from "@tabler/icons-react";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { GooseAutoCompactSettings } from "./GooseAutoCompactSettings";
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";
import { useAgentToolsTipsPreference } from "@/features/chat/lib/agentToolsTipPreferences";
import { useSessionCostPreference } from "@/features/chat/lib/sessionCostPreference";
import { useAnimatedAvatarsPreference } from "@/shared/avatars/avatarPlaybackPreferences";
import { useHomePinLabelsPreference } from "@/features/home/lib/homePinLabelPreference";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { clearLocalMediaCaches } from "@/shared/api/localMediaCaches";
import {
  clearUserTrustedDomains,
  getUserTrustedDomains,
  untrustDomain,
} from "@/shared/lib/trustedDomains";
import { useArtifactRootPreference } from "@/shared/artifacts/useArtifactRootPreference";
import { useTerminalFallbackCwdPreference } from "@/features/terminal/lib/terminalCwdPreference";
import {
  useStreamingShortcutPreference,
  type StreamingShortcutMode,
} from "@/features/chat/lib/streamingShortcutPreference";
import { useAtMentionDefaultCategoryPreference } from "@/features/chat/lib/mentionPreference";
import { useSidebarGitBranchSubtitlePreference } from "@/features/sidebar/lib/sidebarBranchSubtitlePreference";
import { useProfileCapability } from "@/shared/profile/capabilities";
import { RuntimeConfigSettings } from "./RuntimeConfigSettings";
import {
  DEFAULT_SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT,
  SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID,
  SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT_CONFIG_KEY,
} from "@/features/experiments/experimentDefinitions";
import {
  setExperimentConfigValue,
  useExperiment,
} from "@/features/experiments/experimentPreferences";
import { useStyleGuidelinesPreference } from "@/shared/preferences/styleGuidelinesPreference";
import {
  getBbCliStatus,
  installBbCli,
  type BbCliStatus,
} from "@/shared/api/bbCli";

interface AboutAppInfo {
  name: string;
  version: string;
  tauriVersion: string;
  identifier: string;
}

function SettingRow({
  label,
  description,
  children,
  className,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-8 px-4 py-4",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm">{label}</p>
        {description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function SettingsSection({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      {title ? <h4 className="text-base text-foreground">{title}</h4> : null}
      <div className="overflow-hidden rounded-md bg-background divide-y divide-border">
        {children}
      </div>
    </section>
  );
}

function AboutInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-sm">{value}</span>
    </div>
  );
}

interface GeneralSettingsProps {
  authStatus?: AuthStatus;
  onLoggedOut?: (status: AuthStatus) => void;
}

export function GeneralSettings({
  authStatus,
  onLoggedOut,
}: GeneralSettingsProps) {
  const { t } = useTranslation(["settings", "shortcuts"]);
  const { preference, setLocalePreference, systemLocaleLabel } = useLocale();
  const [appInfo, setAppInfo] = useState<AboutAppInfo | null>(null);
  const [bbCliStatus, setBbCliStatus] = useState<BbCliStatus | null>(null);
  const [bbCliLoading, setBbCliLoading] = useState(false);
  const [bbCliInstalling, setBbCliInstalling] = useState(false);
  const [clearCacheDialogOpen, setClearCacheDialogOpen] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [trustedDomainsDialogOpen, setTrustedDomainsDialogOpen] =
    useState(false);
  const [trustedDomains, setTrustedDomains] = useState<string[]>(() =>
    getUserTrustedDomains(),
  );
  const agentToolsTipsPreference = useAgentToolsTipsPreference();
  const sessionCostPreference = useSessionCostPreference();
  const sidebarFlatChatListExperiment = useExperiment(
    SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID,
  );
  const groupChatsByProject = Boolean(
    sidebarFlatChatListExperiment?.config[
      SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT_CONFIG_KEY
    ] ?? DEFAULT_SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT,
  );
  const streamingShortcutPreference = useStreamingShortcutPreference();
  const {
    category: atMentionDefaultCategory,
    setCategory: setAtMentionDefaultCategory,
  } = useAtMentionDefaultCategoryPreference();
  const animatedAvatarsPreference = useAnimatedAvatarsPreference();
  const homePinLabelsPreference = useHomePinLabelsPreference();
  const sidebarGitBranchSubtitlePreference =
    useSidebarGitBranchSubtitlePreference();
  const artifactRootPreference = useArtifactRootPreference();
  const terminalFallbackCwdPreference = useTerminalFallbackCwdPreference();
  const styleGuidelinesPreference = useStyleGuidelinesPreference();
  const [styleGuidelinesPromptDraft, setStyleGuidelinesPromptDraft] = useState(
    styleGuidelinesPreference.prompt,
  );
  const {
    themeMode,
    setThemeMode,
    themePrimaryColor,
    customPrimaryColor,
    setPrimaryColor,
    resetPrimaryColor,
  } = useTheme();
  const followUpBehavior =
    streamingShortcutPreference.mode === "cmd-enter-steers" ? "queue" : "steer";
  const showAgentToolsTipsSetting = useProfileCapability("agentToolsTip");

  // The picker is self-contained: a "follow theme" swatch (clears the custom
  // override so the primary tracks the active light/dark theme) plus the
  // built-in custom-color swatch. No separate status label or reset button.
  const THEME_PRIMARY_PRESET_ID = "theme";
  const primaryColorPresets = [
    {
      id: THEME_PRIMARY_PRESET_ID,
      label: t("appearance.primary.reset"),
      color: themePrimaryColor,
    },
  ];
  const gooseIcon = getProviderIcon("goose", "size-6");
  const terminalFallbackPath =
    terminalFallbackCwdPreference.fallbackCwd ??
    artifactRootPreference.rootPath;

  useEffect(() => {
    setStyleGuidelinesPromptDraft(styleGuidelinesPreference.prompt);
  }, [styleGuidelinesPreference.prompt]);

  useEffect(() => {
    let cancelled = false;

    async function loadAppInfo() {
      if (!window.__TAURI_INTERNALS__) {
        return;
      }

      try {
        const { getIdentifier, getName, getTauriVersion, getVersion } =
          await import("@tauri-apps/api/app");
        const [name, version, tauriVersion, identifier] = await Promise.all([
          getName(),
          getVersion(),
          getTauriVersion(),
          getIdentifier(),
        ]);

        if (!cancelled) {
          setAppInfo({ name, version, tauriVersion, identifier });
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

  const refreshBbCliStatus = useCallback(async () => {
    if (!window.__TAURI_INTERNALS__) {
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
  }, []);

  useEffect(() => {
    void refreshBbCliStatus();
  }, [refreshBbCliStatus]);

  const refreshTrustedDomains = useCallback(() => {
    setTrustedDomains(getUserTrustedDomains());
  }, []);

  function handleRemoveTrustedDomain(domain: string) {
    untrustDomain(domain);
    refreshTrustedDomains();
    toast.success(t("storage.trustedDomains.removeSuccess", { domain }));
  }

  function handleClearTrustedDomains() {
    clearUserTrustedDomains();
    refreshTrustedDomains();
    toast.success(t("storage.trustedDomains.clearSuccess"));
  }

  const trustedDomainsCount = t("storage.trustedDomains.count", {
    count: trustedDomains.length,
  });

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

  async function handleLogout() {
    setLoggingOut(true);
    try {
      const nextStatus = await logout();
      toast.success(t("account.logoutSuccess"));
      onLoggedOut?.(nextStatus);
    } catch (error) {
      console.warn("Failed to log out:", error);
      toast.error(t("account.logoutError"));
    } finally {
      setLoggingOut(false);
    }
  }

  function handleStyleGuidelinesPromptSave() {
    const didSave = styleGuidelinesPreference.setPrompt(
      styleGuidelinesPromptDraft,
    );
    if (!didSave) {
      toast.error(t("general.styleGuidelines.saveError"));
    }
  }

  function handleStyleGuidelinesPromptReset() {
    const didSave = styleGuidelinesPreference.resetPrompt();
    if (!didSave) {
      toast.error(t("general.styleGuidelines.saveError"));
    }
  }

  function handleSidebarChatGroupingChange(enabled: boolean) {
    const didSave = setExperimentConfigValue(
      SIDEBAR_FLAT_CHAT_LIST_EXPERIMENT_ID,
      SIDEBAR_FLAT_CHAT_LIST_GROUP_CHATS_BY_PROJECT_CONFIG_KEY,
      enabled,
    );
    if (!didSave) {
      toast.error(t("experiments.saveError"));
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

  const signedInAs =
    authStatus?.email ?? authStatus?.name ?? authStatus?.user ?? aboutFallback;
  const organization = authStatus?.org ?? aboutFallback;
  const showAccountSection = authStatus?.loggedIn === true;

  return (
    <SettingsPage contentClassName="space-y-8">
      {showAccountSection ? (
        <SettingsSection title={t("account.title")}>
          <SettingRow
            label={t("account.signedInAs")}
            description={signedInAs}
            className="items-start"
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
          </SettingRow>
          <AboutInfoRow
            label={t("account.organization")}
            value={organization}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection>
        <SettingRow
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
        </SettingRow>

        <SettingRow
          label={t("general.artifacts.label")}
          description={t("general.artifacts.description")}
          className="items-start"
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
                variant="default"
                size="xs"
                onClick={() => void handleChooseArtifactRoot()}
              >
                <FolderOpen className="size-3.5" />
                {t("general.artifacts.change")}
              </Button>
            </div>
          </div>
        </SettingRow>

        <SettingRow
          label={t("general.terminalFallback.label")}
          description={t("general.terminalFallback.description")}
          className="items-start"
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
                variant="default"
                size="xs"
                onClick={() => void handleChooseTerminalFallbackCwd()}
              >
                <FolderOpen className="size-3.5" />
                {t("general.terminalFallback.change")}
              </Button>
            </div>
          </div>
        </SettingRow>

        <SettingRow
          label={t("general.sessionCost.label")}
          description={t("general.sessionCost.description")}
        >
          <Switch
            checked={sessionCostPreference.enabled}
            onCheckedChange={sessionCostPreference.setEnabled}
            aria-label={t("general.sessionCost.label")}
          />
        </SettingRow>

        {showAgentToolsTipsSetting ? (
          <SettingRow
            label={t("general.agentToolsTips.label")}
            description={t("general.agentToolsTips.description")}
          >
            <Switch
              checked={agentToolsTipsPreference.enabled}
              onCheckedChange={agentToolsTipsPreference.setEnabled}
              aria-label={t("general.agentToolsTips.label")}
            />
          </SettingRow>
        ) : null}

        {sidebarFlatChatListExperiment?.enabled && (
          <SettingRow
            label={t("general.groupChatsByProject.label")}
            description={t("general.groupChatsByProject.description")}
          >
            <Switch
              checked={groupChatsByProject}
              onCheckedChange={handleSidebarChatGroupingChange}
              aria-label={t("general.groupChatsByProject.label")}
            />
          </SettingRow>
        )}

        <SettingRow
          label={t("shortcuts:settings.label")}
          description={t("shortcuts:settings.description")}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => requestOpenSettings("shortcuts")}
          >
            {t("shortcuts:settings.customize")}
          </Button>
        </SettingRow>

        <SettingRow
          label={t("general.followUpBehavior.label")}
          description={t("general.followUpBehavior.description")}
        >
          <fieldset className="flex items-center gap-1">
            <legend className="sr-only">
              {t("general.followUpBehavior.label")}
            </legend>
            <Button
              type="button"
              aria-pressed={followUpBehavior === "queue"}
              className="min-w-16"
              size="sm"
              variant={followUpBehavior === "queue" ? "default" : "ghost"}
              onClick={() =>
                streamingShortcutPreference.setMode(
                  "cmd-enter-steers" satisfies StreamingShortcutMode,
                )
              }
            >
              {t("general.followUpBehavior.queue")}
            </Button>
            <Button
              type="button"
              aria-pressed={followUpBehavior === "steer"}
              className="min-w-16"
              size="sm"
              variant={followUpBehavior === "steer" ? "default" : "ghost"}
              onClick={() =>
                streamingShortcutPreference.setMode(
                  "enter-steers" satisfies StreamingShortcutMode,
                )
              }
            >
              {t("general.followUpBehavior.steer")}
            </Button>
          </fieldset>
        </SettingRow>

        <SettingRow
          label={t("general.atMentionDefault.label")}
          description={t("general.atMentionDefault.description")}
        >
          <fieldset className="flex items-center gap-1">
            <legend className="sr-only">
              {t("general.atMentionDefault.label")}
            </legend>
            <Button
              type="button"
              aria-pressed={atMentionDefaultCategory === "agents"}
              className="min-w-16"
              size="sm"
              variant={
                atMentionDefaultCategory === "agents" ? "default" : "ghost"
              }
              onClick={() => setAtMentionDefaultCategory("agents")}
            >
              {t("general.atMentionDefault.agents")}
            </Button>
            <Button
              type="button"
              aria-pressed={atMentionDefaultCategory === "files"}
              className="min-w-16"
              size="sm"
              variant={
                atMentionDefaultCategory === "files" ? "default" : "ghost"
              }
              onClick={() => setAtMentionDefaultCategory("files")}
            >
              {t("general.atMentionDefault.files")}
            </Button>
          </fieldset>
        </SettingRow>

        <SettingRow
          label={t("general.sidebarBranchSubtitles.label")}
          description={t("general.sidebarBranchSubtitles.description")}
        >
          <Switch
            checked={sidebarGitBranchSubtitlePreference.enabled}
            onCheckedChange={sidebarGitBranchSubtitlePreference.setEnabled}
            aria-label={t("general.sidebarBranchSubtitles.label")}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t("general.styleGuidelines.title")}>
        <div className="space-y-3 px-4 py-4">
          <div>
            <label className="text-sm" htmlFor="style-guidelines-prompt">
              {t("general.styleGuidelines.promptLabel")}
            </label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("general.styleGuidelines.promptDescription")}
            </p>
          </div>
          <Textarea
            id="style-guidelines-prompt"
            value={styleGuidelinesPromptDraft}
            onChange={(event) =>
              setStyleGuidelinesPromptDraft(event.currentTarget.value)
            }
            onBlur={handleStyleGuidelinesPromptSave}
            placeholder={t("general.styleGuidelines.promptPlaceholder")}
            className="min-h-52"
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={handleStyleGuidelinesPromptReset}
            >
              <RotateCcw className="size-3.5" />
              {t("general.styleGuidelines.reset")}
            </Button>
            <Button
              type="button"
              variant="default"
              size="xs"
              onClick={handleStyleGuidelinesPromptSave}
              disabled={
                styleGuidelinesPromptDraft === styleGuidelinesPreference.prompt
              }
            >
              {t("general.styleGuidelines.save")}
            </Button>
          </div>
        </div>
      </SettingsSection>

      {/* A restricted build compiled with the `no-bb-cli-install` Cargo feature
          reports `unsupportedInBuild`; hide the install section entirely rather
          than showing a button that can never install. */}
      {!bbCliStatus?.unsupportedInBuild && (
        <SettingsSection title={t("general.bbCli.title")}>
          <SettingRow
            label={t("general.bbCli.label")}
            description={
              bbCliStatus
                ? `${bbCliStatus.message}. ${bbCliStatus.detail}`
                : t("general.bbCli.description")
            }
            className="items-start"
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
                  variant={bbCliStatus?.installed ? "outline" : "default"}
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
          </SettingRow>
        </SettingsSection>
      )}

      <SettingsSection title={t("appearance.title")}>
        <div className="space-y-3 px-4 py-4">
          <div>
            <p className="text-sm">{t("appearance.theme.label")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("appearance.theme.description")}
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            {(
              [
                {
                  value: "system",
                  icon: SunMoon,
                  label: t("appearance.theme.systemLabel"),
                  description: t("appearance.theme.systemDescription"),
                },
                {
                  value: "light",
                  icon: Sun,
                  label: t("appearance.theme.lightLabel"),
                },
                {
                  value: "dark",
                  icon: Moon,
                  label: t("appearance.theme.darkLabel"),
                },
              ] satisfies ReadonlyArray<{
                value: "system" | "light" | "dark";
                icon: typeof SunMoon;
                label: string;
                description?: string;
              }>
            ).map((option) => {
              const selected = themeMode === option.value;
              const ThemeIcon = option.icon;

              return (
                <button
                  aria-pressed={selected}
                  className={cn(
                    "flex min-w-0 items-center gap-3 rounded-md border border-border/70 bg-background/70 px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected
                      ? "border-primary/30 bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                  data-testid={`theme-option-${option.value}`}
                  key={option.value}
                  onClick={() => {
                    setThemeMode(option.value);
                  }}
                  type="button"
                >
                  <ThemeIcon className="h-4 w-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{option.label}</div>
                    {option.description ? (
                      <div className="truncate text-xs text-muted-foreground">
                        {option.description}
                      </div>
                    ) : null}
                  </div>
                  {selected ? (
                    <Check className="h-4 w-4 shrink-0 text-primary" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <SettingRow
          label={t("appearance.animatedAvatars.label")}
          description={t("appearance.animatedAvatars.description")}
        >
          <Switch
            checked={animatedAvatarsPreference.enabled}
            onCheckedChange={animatedAvatarsPreference.setEnabled}
            aria-label={t("appearance.animatedAvatars.label")}
          />
        </SettingRow>

        <SettingRow
          label={t("appearance.homePinLabels.label")}
          description={t("appearance.homePinLabels.description")}
        >
          <Switch
            checked={homePinLabelsPreference.enabled}
            onCheckedChange={homePinLabelsPreference.setEnabled}
            aria-label={t("appearance.homePinLabels.label")}
          />
        </SettingRow>

        <SettingRow
          label={t("appearance.primary.label")}
          description={t("appearance.primary.description")}
        >
          <ColorPicker
            value={customPrimaryColor ?? THEME_PRIMARY_PRESET_ID}
            onChange={(value) =>
              value === THEME_PRIMARY_PRESET_ID
                ? resetPrimaryColor()
                : setPrimaryColor(value)
            }
            label={t("appearance.primary.label")}
            presets={primaryColorPresets}
            customColorLabel={t("appearance.primary.custom")}
            swatchSize="sm"
            variant="swatches"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t("storage.title")}>
        <SettingRow
          label={t("storage.cachedMedia.label")}
          description={t("storage.cachedMedia.description")}
        >
          <Button
            type="button"
            variant="default"
            size="xs"
            onClick={() => setClearCacheDialogOpen(true)}
          >
            <Trash2 className="size-3.5" />
            {t("storage.cachedMedia.clear")}
          </Button>
        </SettingRow>

        <SettingRow
          label={t("storage.trustedDomains.label")}
          description={t("storage.trustedDomains.description")}
        >
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {trustedDomainsCount}
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => setTrustedDomainsDialogOpen(true)}
            >
              {t("storage.trustedDomains.manage")}
            </Button>
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t("compaction.title")}>
        <div className="flex items-start justify-between gap-4 px-4 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex size-6 items-center justify-center [&>*]:size-6">
              {gooseIcon}
            </div>
            <span className="mt-2 block text-sm">
              {t("compaction.goose.label")}
            </span>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("compaction.goose.description")}
            </p>
          </div>

          <div className="inline-flex items-center gap-1 rounded-xs bg-success/10 px-2 py-1 text-xxs font-medium text-success">
            <IconCheck className="size-3.5" />
            <span>{t("compaction.goose.builtIn")}</span>
          </div>
        </div>

        <div className="px-4 py-4">
          <GooseAutoCompactSettings />
        </div>
      </SettingsSection>

      {import.meta.env.DEV ? (
        <SettingsSection title={t("runtimeConfig.title")}>
          <RuntimeConfigSettings />
        </SettingsSection>
      ) : null}

      <SettingsSection title={t("about.title")}>
        <AboutInfoRow
          label={t("about.fields.name")}
          value={appInfo?.name ?? "Berd"}
        />
        <AboutInfoRow
          label={t("about.fields.version")}
          value={appInfo?.version ?? aboutFallback}
        />
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

      <Dialog
        open={trustedDomainsDialogOpen}
        onOpenChange={setTrustedDomainsDialogOpen}
      >
        <DialogContent className="max-w-md gap-5">
          <DialogHeader>
            <DialogTitle>{t("storage.trustedDomains.label")}</DialogTitle>
            <DialogDescription>
              {t("storage.trustedDomains.description")}
            </DialogDescription>
          </DialogHeader>

          {trustedDomains.length > 0 ? (
            <ul
              className="max-h-80 space-y-2 overflow-y-auto pr-1"
              aria-label={t("storage.trustedDomains.listLabel")}
            >
              {trustedDomains.map((domain) => (
                <li
                  key={domain}
                  className="flex items-center justify-between gap-3 rounded-md bg-background px-3 py-2"
                >
                  <span className="min-w-0 truncate text-sm" title={domain}>
                    {domain}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => handleRemoveTrustedDomain(domain)}
                    aria-label={t("storage.trustedDomains.removeAria", {
                      domain,
                    })}
                  >
                    <Trash2 className="size-3.5" />
                    {t("storage.trustedDomains.remove")}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-md bg-background px-3 py-3 text-sm text-muted-foreground">
              {t("storage.trustedDomains.empty")}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleClearTrustedDomains}
              disabled={trustedDomains.length === 0}
            >
              <Trash2 className="size-3.5" />
              {t("storage.trustedDomains.clear")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
    </SettingsPage>
  );
}
