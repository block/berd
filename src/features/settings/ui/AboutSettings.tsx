import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  listAuthWorkspaces,
  logout,
  switchAuthWorkspace,
  type AuthStatus,
  type AuthWorkspaceList,
} from "@/features/auth/api/auth";
import { resetChatRuntimeStartup } from "@/app/lib/chatRuntimeStartup";
import { Button } from "@/shared/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { SettingsRow } from "@/shared/ui/settings-row";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";
import { UpdatesSettings } from "@/features/updates/ui/UpdatesSettings";
import { useProfileCapability } from "@/shared/profile/capabilities";

interface AboutAppInfo {
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

interface AboutSettingsProps {
  authStatus?: AuthStatus;
  onLoggedOut?: (status: AuthStatus) => void;
}

// About (rev 3): app identity + "is it current" (the Updates card) are one
// concept -- split out of the old GeneralSettings.tsx, with the standalone
// UpdatesSettings page embedded here rather than being its own nav
// destination. Account rows (signed in, workspace switcher, log out) also
// live here as an interim placement pending a pinned profile-card decision.
export function AboutSettings({ authStatus, onLoggedOut }: AboutSettingsProps) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [appInfo, setAppInfo] = useState<AboutAppInfo | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [workspaceList, setWorkspaceList] = useState<AuthWorkspaceList | null>(
    null,
  );
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState(false);
  const [workspaceSwitching, setWorkspaceSwitching] = useState(false);
  const updatesEnabled = useProfileCapability("updates");

  useEffect(() => {
    let cancelled = false;

    async function loadAppInfo() {
      if (!window.__TAURI_INTERNALS__) {
        return;
      }

      try {
        const { getIdentifier, getTauriVersion } = await import(
          "@tauri-apps/api/app"
        );
        const [tauriVersion, identifier] = await Promise.all([
          getTauriVersion(),
          getIdentifier(),
        ]);

        if (!cancelled) {
          setAppInfo({ tauriVersion, identifier });
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

  return (
    <SettingsPage title={t("about.title")} contentClassName="space-y-8">
      <SettingsSections>
        {updatesEnabled ? <UpdatesSettings embedded /> : null}

        {/* Untitled, like the primary section on other pages (System,
          Security, Appearance) -- a title here would just repeat the page
          title "About" without adding information. App name dropped: it's
          always just "Berd" (the bundle name), not something worth a row.
          App version dropped too: the embedded Updates card above already
          shows it (updates.card.currentVersion) -- this used to duplicate
          that same getVersion() value in a second row. */}
        <SettingsSection>
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
    </SettingsPage>
  );
}
