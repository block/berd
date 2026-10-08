// Avatar context-menu model: right-click opens the custom webview menu
// (ui/AvatarMenu.tsx — the native NSMenu is gone; a webview menu can show
// avatar previews and match the popover's dark glass). This hook owns the
// DATA side: fetching the persona list on open and the selection
// semantics; DesktopAgentApp owns the geometry (growing the panel window
// into "menu" mode) and the menu's open/closed lifecycle.
//
// Selection semantics: the menu only ever SELECTS — clicking an entry
// never cancels anything. Clicking the
// already-ARMED entry is a no-op (arming twice is meaningless); clicking
// anything else arms it, including the committed identity (that's "new
// chat with the same agent" — a legitimate ask). The checkmark shows the
// EFFECTIVE identity: the armed selection when one exists, else the
// current chat's committed agent binding, else the fresh/Berd entry —
// never uncheckmarked, because there is no "no identity" state.

import { useCallback, useRef } from "react";

import { listPersonas } from "@/shared/api/agents";

import type { AgentInfo, PendingSelection } from "./useSession";

export interface AvatarMenuModel {
  agents: AgentInfo[];
  /** Checked agent row, or null when the fresh/Berd entry is checked. */
  checkedAgentId: string | null;
  checkedFresh: boolean;
}

export function useAvatarMenu(args: {
  pendingSelection: PendingSelection | null;
  /** Committed agent binding of the CURRENT chat — the checkmark falls
   *  back to it when nothing is armed, so the menu always shows the
   *  effective identity. */
  activeAgentId: string | null;
  select(selection: PendingSelection | null): void;
  /** Agent selector experiment: when false the menu only has the
   *  settings and hide items (no "Switch agent" submenu). */
  agentSelector: boolean;
}): {
  prepareMenu(): Promise<AvatarMenuModel>;
  selectAgent(agentId: string): void;
  selectFresh(): void;
  newChat(messageCount: number): void;
} {
  // Callbacks capture refs so a menu opened against one render can still
  // act on the live values at click time.
  const pending = useRef(args.pendingSelection);
  pending.current = args.pendingSelection;
  const active = useRef(args.activeAgentId);
  active.current = args.activeAgentId;
  const select = useRef(args.select);
  select.current = args.select;
  const agents = useRef<AgentInfo[]>([]);
  const agentSelector = args.agentSelector;

  const prepareMenu = useCallback(async (): Promise<AvatarMenuModel> => {
    if (!agentSelector) {
      agents.current = [];
      return { agents: [], checkedAgentId: null, checkedFresh: false };
    }
    // Fresh list per open: personas are edited in the main window and
    // menu opens are rare — staleness would be worse than the fetch. A
    // failed fetch must not kill the menu — the fresh entry still works
    // with zero agents.
    const personas = await listPersonas().catch(() => []);
    const list: AgentInfo[] = personas.map((persona) => ({
      agentId: persona.id,
      name: persona.displayName,
      systemPrompt: persona.systemPrompt,
      provider: persona.provider ?? null,
      model: persona.model ?? null,
    }));
    agents.current = list;
    const current = pending.current;
    const checkedAgentId =
      current !== null
        ? current.kind === "agent"
          ? current.agent.agentId
          : null
        : active.current;
    return {
      agents: list,
      checkedAgentId,
      checkedFresh:
        current !== null ? current.kind === "fresh" : active.current === null,
    };
  }, [agentSelector]);

  const selectAgent = useCallback((agentId: string) => {
    const agent = agents.current.find((a) => a.agentId === agentId);
    if (!agent) return;
    const current = pending.current;
    if (current?.kind === "agent" && current.agent.agentId === agentId) {
      return; // already armed: no-op
    }
    select.current({ kind: "agent", agent });
  }, []);

  const selectFresh = useCallback(() => {
    if (pending.current?.kind === "fresh") return; // already armed: no-op
    select.current({ kind: "fresh" });
  }, []);

  const newChat = useCallback((messageCount: number) => {
    if (pending.current !== null) return; // already armed: empty new chat
    if (messageCount === 0) return; // current chat is already empty
    const activeAgent = agents.current.find(
      (agent) => agent.agentId === active.current,
    );
    if (activeAgent !== undefined) {
      select.current({ kind: "agent", agent: activeAgent });
      return;
    }
    select.current({ kind: "fresh" });
  }, []);

  return { prepareMenu, selectAgent, selectFresh, newChat };
}
