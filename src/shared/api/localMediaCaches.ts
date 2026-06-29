import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const LOCAL_MEDIA_CACHES_CLEARED_EVENT =
  "berd:local-media-caches-cleared";

export interface LocalMediaCachesClearedPayload {
  avatars: boolean;
  artifacts: boolean;
}

export async function clearLocalMediaCaches(): Promise<void> {
  await invoke("clear_local_media_caches");
}

export function listenLocalMediaCachesCleared(
  handler: (payload: LocalMediaCachesClearedPayload) => void,
) {
  if (!window.__TAURI_INTERNALS__) {
    return Promise.resolve(() => {});
  }

  return listen<LocalMediaCachesClearedPayload>(
    LOCAL_MEDIA_CACHES_CLEARED_EVENT,
    (event) => handler(event.payload),
  );
}
