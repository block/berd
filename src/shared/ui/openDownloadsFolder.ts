/**
 * Open the OS Downloads folder. Only meaningful under Tauri; callers should
 * gate on `window.__TAURI_INTERNALS__` before offering this action.
 */
export async function openDownloadsFolder(): Promise<void> {
  const [{ downloadDir }, { openPath }] = await Promise.all([
    import("@tauri-apps/api/path"),
    import("@tauri-apps/plugin-opener"),
  ]);
  await openPath(await downloadDir());
}
