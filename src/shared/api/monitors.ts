import { invoke } from "@tauri-apps/api/core";

export interface RunningMonitor {
  sessionId: string;
  stateKey: string;
  label: string;
}

export async function getRunningMonitors(): Promise<RunningMonitor[]> {
  return invoke("get_running_monitors");
}
