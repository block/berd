import { invoke } from "@tauri-apps/api/core";

export const WORK_STATUS_REFRESH_EVENT = "berd:work-status-refresh";

export async function openWorkStatusUrl(url: string): Promise<void> {
  if (!window.__TAURI_INTERNALS__) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("open_pr_tracker_url", { url });
}
