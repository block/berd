import { getCurrent } from "@tauri-apps/plugin-deep-link";

import { dispatchCommand } from "@/features/berdctl/commands/registry";

type DispatchCommand = typeof dispatchCommand;

let handledStartupBatchKey: string | null = null;
let openingStartupBatchKey: string | null = null;

function startupBatchKey(urls: string[]): string {
  return urls.join("\n");
}

function strictPathSegments(url: URL): string[] | null {
  const segments = url.pathname.split("/");
  if (segments[0] !== "") {
    return null;
  }

  const pathSegments = segments.slice(1);
  return pathSegments.every(Boolean) ? pathSegments : null;
}

export function parseStartupSessionDeepLink(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "berd:") {
    return null;
  }

  const segments = strictPathSegments(url);
  if (!segments) {
    return null;
  }

  let encodedSessionId: string | undefined;
  if (url.hostname === "session" && segments.length === 1) {
    encodedSessionId = segments[0];
  } else if (
    url.hostname === "" &&
    segments.length === 2 &&
    segments[0] === "session"
  ) {
    encodedSessionId = segments[1];
  }

  if (!encodedSessionId) {
    return null;
  }

  try {
    const sessionId = decodeURIComponent(encodedSessionId);
    return sessionId ? sessionId : null;
  } catch {
    return null;
  }
}

export async function openStartupSessionDeepLinkUrls(
  urls: string[],
  dispatch: DispatchCommand = dispatchCommand,
): Promise<boolean> {
  for (const raw of urls) {
    const sessionId = parseStartupSessionDeepLink(raw);
    if (!sessionId) {
      continue;
    }

    await dispatch("sessions", { action: "open", session_id: sessionId }, {});
    return true;
  }

  return false;
}

export function installStartupSessionDeepLinkHandler(): () => void {
  if (!window.__TAURI_INTERNALS__) {
    return () => {};
  }

  let cancelled = false;
  void getCurrent()
    .then((urls) => {
      if (cancelled || !urls?.length) {
        return;
      }

      const key = startupBatchKey(urls);
      if (handledStartupBatchKey === key || openingStartupBatchKey === key) {
        return;
      }
      openingStartupBatchKey = key;

      void openStartupSessionDeepLinkUrls(urls)
        .then((opened) => {
          if (opened) {
            handledStartupBatchKey = key;
          }
        })
        .catch((error) => {
          console.warn("Failed to open startup session deep link", error);
        })
        .finally(() => {
          if (openingStartupBatchKey === key) {
            openingStartupBatchKey = null;
          }
        });
    })
    .catch((error) => {
      console.warn("Failed to read startup deep links", error);
    });

  return () => {
    cancelled = true;
  };
}
