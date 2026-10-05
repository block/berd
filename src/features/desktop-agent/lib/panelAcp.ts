// Panel-side ACP operations, built on Berd's shared per-webview
// connection (src/shared/api/acpConnection) and thin wrappers
// (src/shared/api/acpApi). The panel is its own webview, so importing
// these modules gives it its OWN GooseClient — no coordination with the
// main window's connection.
//
// Agent sessions are created directly over ACP with the persona bound at
// create time:
//   1. session/new carrying personaId + provider in _meta (the same meta
//      the main UI writes, so the session list shows the persona badge
//      and goosed round-trips personaId in session info)
//   2. the persona system prompt via the goose system-prompt extension
//      (same seam the main UI uses for persona handoff)
//   3. the persona model pin via the session config-option seam
// The first response then STREAMS LIVE — no dispatch, no backfill.

import type { ContentBlock } from "@agentclientprotocol/sdk";

import {
  appendSessionSystemPrompt,
  cancelSession,
  loadSession,
  newSession,
  prompt as acpPrompt,
  setModel,
} from "@/shared/api/acpApi";
import { isClientReady } from "@/shared/api/acpConnection";
import { getHomeDir } from "@/shared/api/system";

import type { AgentInfo } from "../hooks/useSession";

/** The system-prompt slot the main UI uses for persona instructions —
 *  reusing it keeps panel-created sessions indistinguishable from
 *  main-UI persona sessions on the wire. */
const PERSONA_SYSTEM_PROMPT_KEY = "client_system_prompt";

/** DELIBERATE PR1 SCOPE (review 5.4): panel sessions get the persona
 *  system prompt only — NOT the main UI's full prompt stack (style
 *  guidelines + berdctl app-context appends from src/shared/api/acp.ts).
 *  The popover has its own renderer and no berdctl surface, so the same
 *  persona may read as less app-aware here than in the main window.
 *  Revisit at graduation alongside the design-system pass. */
export async function createAgentSession(agent: AgentInfo): Promise<string> {
  const cwd = await getHomeDir();
  const response = await newSession(cwd, {
    personaId: agent.agentId,
    ...(agent.provider ? { providerId: agent.provider } : {}),
  });
  const sessionId = response.sessionId;
  if (agent.systemPrompt.trim().length > 0) {
    await appendSessionSystemPrompt(
      sessionId,
      PERSONA_SYSTEM_PROMPT_KEY,
      agent.systemPrompt,
    );
  }
  if (agent.model) {
    try {
      await setModel(sessionId, agent.model);
    } catch (error) {
      // Soft-fail: the chat still works on the session's default model.
      // (Right words, default brain — visible in the main UI's session
      // config if the user checks; a hard failure here would eat the
      // user's first message over a preference.)
      console.warn("[desktop-agent] persona model pin failed:", error);
    }
  }
  return sessionId;
}

export async function createFreshSession(): Promise<string> {
  const cwd = await getHomeDir();
  const response = await newSession(cwd, {});
  return response.sessionId;
}

export async function promptSession(
  sessionId: string,
  content: Array<Record<string, unknown>>,
): Promise<void> {
  await acpPrompt(sessionId, content as unknown as ContentBlock[]);
}

export async function cancelPanelSession(sessionId: string): Promise<void> {
  await cancelSession(sessionId);
}

export type AdoptOutcome = "adopted" | "stale" | "transient";

/** Adopt probe: session/load replays the transcript through the
 *  notification handler and proves the id still exists.
 *
 *  Failure is TWO different stories and the caller must not conflate
 *  them (review finding: a transient failure once wiped persistence —
 *  one flaky moment at startup silently unlinked the conversation
 *  forever, even though the session still existed server-side):
 *  - "stale": the connection is still healthy, so the rejection came
 *    from goosed itself — the id is unloadable (deleted session, wiped
 *    server storage). The caller may clear persistence.
 *  - "transient": the connection died during the probe (socket drop
 *    mid-replay, goosed hiccup). The id may be perfectly fine — the
 *    caller must keep persistence and let the reconnect retry. */
export async function adoptSession(sessionId: string): Promise<AdoptOutcome> {
  try {
    await loadSession(sessionId, await getHomeDir());
    return "adopted";
  } catch {
    // isClientReady flips false when the closed-monitor clears the
    // cached client. A healthy connection + a rejection = goosed
    // refused the id; a dead connection = we never really asked.
    // One macrotask of grace first: the pending-request rejection and
    // the closed settlement race on the same socket-death event, and
    // misreading a dying connection as healthy would re-create the
    // exact wipe this classification exists to prevent.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return isClientReady() ? "stale" : "transient";
  }
}
