import { invoke } from "@tauri-apps/api/core";

export interface BbCliStatus {
  installed: boolean;
  needsRepair: boolean;
  canInstall: boolean;
  linkPath: string;
  bundledPath?: string | null;
  currentTarget?: string | null;
  foundOnPath?: string | null;
  bundledVersion?: string | null;
  message: string;
  detail: string;
}

export async function getBbCliStatus(): Promise<BbCliStatus> {
  return invoke("get_bb_cli_status");
}

export async function installBbCli(): Promise<BbCliStatus> {
  return invoke("install_bb_cli");
}
