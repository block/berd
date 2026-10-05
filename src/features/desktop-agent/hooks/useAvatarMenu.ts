// Avatar context-menu wiring: right-click pops the native menu
// (desktop_agent_avatar_menu_popup) — a leading fresh-chat entry (plain
// session, default avatar) plus the user's agents from Berd's persona
// list. Clicks come back as `desktop-agent:menu-fresh` /
// `desktop-agent:menu-agent` events and arm useSession's deferred chat;
// `desktop-agent:menu-dismiss` hides the agent (see DesktopAgentApp).
// Clicking the already-armed entry is a NO-OP (the menu only ever
// selects — un-checking is impossible; the checkmark still shows the
// armed state, falling back to the committed identity, falling back to
// the fresh entry: there is no "no identity" state).
//
// The Rust side is string-free: the header and fresh labels are passed
// in already translated (the webview owns i18n).

import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";

import { listPersonas } from "@/shared/api/agents";

import type { AgentInfo, PendingSelection } from "./useSession";

export function useAvatarMenu(args: {
  pendingSelection: PendingSelection | null;
  /** Committed agent binding of the CURRENT chat — the checkmark falls
   *  back to it when nothing is armed, so the menu always shows the
   *  effective identity. */
  activeAgentId: string | null;
  select(selection: PendingSelection | null): void;
  /** Agent selector experiment: when false the menu only has the settings
   *  and hide items. */
  agentSelector: boolean;
  /** "Hide Desktop Agent" menu item. */
  dismiss(): void;
}): { openMenu(): Promise<void> } {
  const { t } = useTranslation("desktop-agent");
  // The menu-event listener is registered once; refs keep it reading the
  // live values instead of a stale first-render closure.
  const agents = useRef<AgentInfo[]>([]);
  const pending = useRef(args.pendingSelection);
  pending.current = args.pendingSelection;
  const active = useRef(args.activeAgentId);
  active.current = args.activeAgentId;
  const select = useRef(args.select);
  select.current = args.select;
  const dismiss = useRef(args.dismiss);
  dismiss.current = args.dismiss;
  const agentSelector = args.agentSelector;

  useEffect(() => {
    // The menu only ever SELECTS: clicking an entry never cancels
    // anything. Clicking the already-ARMED entry is a no-op (arming twice
    // is meaningless); clicking anything else arms it, including the
    // committed identity (that's "new chat with the same agent" — a
    // legitimate ask). select(null) still exists in useSession for
    // programmatic cancel paths; no menu gesture reaches it.
    const unlistenAgent = listen<string>(
      "desktop-agent:menu-agent",
      (event) => {
        const agent = agents.current.find((a) => a.agentId === event.payload);
        if (!agent) return;
        const current = pending.current;
        if (
          current?.kind === "agent" &&
          current.agent.agentId === agent.agentId
        ) {
          return; // already armed: no-op
        }
        select.current({ kind: "agent", agent });
      },
    );
    const unlistenFresh = listen("desktop-agent:menu-fresh", () => {
      if (pending.current?.kind === "fresh") return; // already armed: no-op
      select.current({ kind: "fresh" });
    });
    const unlistenDismiss = listen("desktop-agent:menu-dismiss", () => {
      dismiss.current();
    });
    return () => {
      void unlistenAgent.then((fn) => fn());
      void unlistenFresh.then((fn) => fn());
      void unlistenDismiss.then((fn) => fn());
    };
  }, []);

  const openMenu = useCallback(async () => {
    const menuLabels = () => ({
      header: t("menu.header"),
      fresh: t("menu.fresh"),
      settings: t("menu.settings"),
      dismiss: t("menu.dismiss"),
      empty: t("menu.empty"),
    });
    try {
      if (!agentSelector) {
        await invoke("desktop_agent_avatar_menu_popup", {
          agentSelector: false,
          agents: [],
          pendingAgentId: null,
          pendingFresh: false,
          labels: menuLabels(),
        });
        return;
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
      // Checkmark shows the EFFECTIVE identity: the armed selection when
      // one exists, else the current chat's committed agent binding, else
      // the fresh entry — the menu is never uncheckmarked, because there
      // is no "no identity" state.
      const current = pending.current;
      const checkedAgentId =
        current !== null
          ? current.kind === "agent"
            ? current.agent.agentId
            : null
          : active.current;
      await invoke("desktop_agent_avatar_menu_popup", {
        agentSelector: true,
        agents: list.map((a) => ({ agentId: a.agentId, name: a.name })),
        pendingAgentId: checkedAgentId,
        pendingFresh:
          current !== null ? current.kind === "fresh" : active.current === null,
        labels: menuLabels(),
      });
    } catch {
      // Menu failure is non-fatal; the avatar just doesn't show a menu.
    }
  }, [agentSelector, t]);

  return { openMenu };
}
