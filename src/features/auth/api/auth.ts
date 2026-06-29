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
