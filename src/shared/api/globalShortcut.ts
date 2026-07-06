import { invoke } from "@tauri-apps/api/core";

interface LaunchGlobalShortcutOptions {
  initiallyHidden?: boolean;
}

export async function launchGlobalShortcutHandler(
  shortcut: string,
  options?: LaunchGlobalShortcutOptions,
): Promise<void> {
  await invoke("launch_global_shortcut_handler", {
    shortcut,
    initiallyHidden: options?.initiallyHidden ?? false,
  });
}

export async function stopGlobalShortcutHandler(): Promise<void> {
  await invoke("stop_global_shortcut_handler");
}
