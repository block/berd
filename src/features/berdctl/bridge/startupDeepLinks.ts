import { getCurrent } from "@tauri-apps/plugin-deep-link";

import { dispatchCommand } from "@/features/berdctl/commands/registry";
import { parseSessionDeepLink } from "@/features/sessions/lib/sessionDeepLink";

type DispatchCommand = typeof dispatchCommand;

let handledStartupBatchKey: string | null = null;
let openingStartupBatchKey: string | null = null;

function startupBatchKey(urls: string[]): string {
  return urls.join("\n");
}

export const parseStartupSessionDeepLink = parseSessionDeepLink;

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
