import { invoke } from "@tauri-apps/api/core";

export interface RunningMonitor {
  sessionId: string;
  stateKey: string;
  label: string;
  instanceId: string;
  command?: string[] | null;
  startedAt?: number | null;
  stopping: boolean;
}

export async function getRunningMonitors(): Promise<RunningMonitor[]> {
  return invoke("get_running_monitors");
}

export async function stopRunningMonitor(
  monitor: RunningMonitor,
): Promise<void> {
  return invoke("stop_running_monitor", {
    sessionId: monitor.sessionId,
    stateKey: monitor.stateKey,
    instanceId: monitor.instanceId,
  });
}
