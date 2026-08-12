import type { ChatSession } from "../stores/chatSessionStore";

interface CapabilityVisibilityOptions {
  readOnly?: boolean;
}

export function isAgentBuilderVisible(
  session: ChatSession | null | undefined,
  { readOnly = false }: CapabilityVisibilityOptions = {},
): boolean {
  return (
    !readOnly &&
    session?.intent === "build-agent" &&
    session.agentBuilderOpen !== false
  );
}

export function isContextPanelVisible(
  session: ChatSession | null | undefined,
  isRightRailOpen: boolean,
  options: CapabilityVisibilityOptions = {},
): boolean {
  if (!isRightRailOpen) {
    return false;
  }

  return (
    !isAgentBuilderVisible(session, options) ||
    session?.agentBuilderContextState === "userOpened"
  );
}
