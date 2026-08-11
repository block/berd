import { invoke } from "@tauri-apps/api/core";

export interface AuthStatus {
  loggedIn: boolean;
  requiresOrg: boolean;
  org?: string | null;
  profile: string;
  kgooseBaseUrl: string;
  expiresAt?: string | null;
  user?: string | null;
  email?: string | null;
  name?: string | null;
  userId?: string | null;
}

// Workspace switching (main #965, ported during the BOT-1430 reconciliation,
// rev 2.5): lets an authenticated user view/switch the BuilderBot workspace
// attached to their session from Berd's Account settings, without leaving
// the app.
export interface AuthWorkspace {
  workspaceIdentifier?: string | null;
  displayName?: string | null;
  roles: string[];
}

export interface AuthWorkspaceList {
  workspaces: AuthWorkspace[];
  activeWorkspaceIdentifier?: string | null;
}

export interface AuthWorkspaceSwitchResult {
  workspace: AuthWorkspace;
  switched: boolean;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  return invoke<AuthStatus>("auth_status");
}

export async function startLogin(org?: string | null): Promise<AuthStatus> {
  return invoke<AuthStatus>("start_login", { org: org ?? null });
}

export async function cancelLogin(): Promise<void> {
  return invoke<void>("cancel_login");
}

export async function logout(): Promise<AuthStatus> {
  return invoke<AuthStatus>("logout");
}

export async function listAuthWorkspaces(): Promise<AuthWorkspaceList> {
  return invoke<AuthWorkspaceList>("list_auth_workspaces");
}

export async function switchAuthWorkspace(
  workspaceIdentifier: string,
): Promise<AuthWorkspaceSwitchResult> {
  return invoke<AuthWorkspaceSwitchResult>("switch_auth_workspace", {
    workspaceIdentifier,
  });
}
