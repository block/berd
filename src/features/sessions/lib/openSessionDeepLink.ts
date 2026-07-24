import { toast } from "sonner";

import { parseSessionDeepLink } from "@/features/sessions/lib/sessionDeepLink";

export type OpenSessionDeepLinkDispatch = (
  name: string,
  rawArgs: unknown,
  ctx: Record<string, never>,
) => Promise<unknown>;

const dispatchSessionOpen: OpenSessionDeepLinkDispatch = async (...args) => {
  const { dispatchCommand } = await import(
    "@/features/berdctl/commands/registry"
  );
  return dispatchCommand(...args);
};

export function openSessionDeepLink(
  href: string,
  dispatch: OpenSessionDeepLinkDispatch = dispatchSessionOpen,
): Promise<boolean> {
  const sessionId = parseSessionDeepLink(href);
  if (!sessionId) {
    return Promise.resolve(false);
  }

  return dispatch("sessions", { action: "open", session_id: sessionId }, {})
    .then(() => true)
    .catch((error: unknown) => {
      console.error("Failed to open session deep link:", error);
      toast.error(
        error instanceof Error && error.message.trim()
          ? error.message
          : `Could not open session "${sessionId}".`,
      );
      return true;
    });
}
