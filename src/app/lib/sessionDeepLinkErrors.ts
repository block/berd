import { listen } from "@tauri-apps/api/event";

export const SESSION_DEEP_LINK_ERROR_EVENT = "berd:session-deep-link-error";

export interface SessionDeepLinkErrorPayload {
  sessionId: string;
  message: string;
}

export function listenSessionDeepLinkErrors(
  handler: (payload: SessionDeepLinkErrorPayload) => void,
) {
  if (!window.__TAURI_INTERNALS__) {
    return Promise.resolve(() => {});
  }

  return listen<SessionDeepLinkErrorPayload>(
    SESSION_DEEP_LINK_ERROR_EVENT,
    (event) => handler(event.payload),
  );
}
