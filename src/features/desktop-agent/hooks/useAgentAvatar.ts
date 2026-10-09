// Agent avatar resolution: maps the agent driving the NEXT or CURRENT
// chat to an AvatarChoice. Pending selection wins over the committed
// session binding (the avatar previews who you're about to talk to); no
// agent, no catalog asset, or fetch failure all fall back to the default
// avatar — an avatar miss must never look like an error.
//
// In-process integration: personas carry an avatar REF (app-avatar:<id>,
// user-avatar:<id>, or a remote URL). Catalog refs resolve through Berd's
// avatar cache (getCachedAvatarForRef → cachedAssetToMedia — the same
// path the main UI uses), which returns animated video media when the
// catalog has it. Plain invoke-based, deliberately: the panel webview
// mounts no React Query client.

import { useEffect, useRef, useState } from "react";

import { findBerdyPersonaId } from "@/features/onboarding/berdyAgent";

import { listPersonas } from "@/shared/api/agents";
import {
  cachedAssetToMedia,
  getCachedAvatarForRef,
} from "@/shared/api/avatars";
import { isAppAvatarRef, isUserAvatarRef } from "@/shared/avatars/catalog";
import { resolveAvatarSrc } from "@/shared/lib/avatarUrl";

import { DEFAULT_AVATAR, type AvatarChoice } from "../lib/avatarState";

async function avatarRefFor(
  agentId: string,
): Promise<{ ref: string | null; isBerdy: boolean }> {
  const personas = await listPersonas();
  const persona = personas.find((candidate) => candidate.id === agentId);
  const ref = persona?.avatar;
  return {
    ref: typeof ref === "string" && ref.trim().length > 0 ? ref.trim() : null,
    isBerdy: findBerdyPersonaId(personas) === agentId,
  };
}

type AgentAvatar = { choice: AvatarChoice; isBerdy: boolean };

async function choiceFor(agentId: string): Promise<AgentAvatar | null> {
  const { ref, isBerdy } = await avatarRefFor(agentId);
  if (ref === null) return null;

  if (isAppAvatarRef(ref) || isUserAvatarRef(ref)) {
    const cached = await getCachedAvatarForRef({ avatarRef: ref });
    if (cached === null) return { choice: DEFAULT_AVATAR, isBerdy };
    const media = cachedAssetToMedia(cached.asset);
    return {
      isBerdy,
      choice: {
        id: `agent:${agentId}`,
        label: "Agent",
        src: media.src,
        shape: "circle",
        kind: media.mediaType === "video" ? "video" : "image",
      },
    };
  }

  // Remote URL refs pass through as static images.
  const direct = resolveAvatarSrc(ref);
  if (!direct) return null;
  return {
    isBerdy: false,
    choice: {
      id: `agent:${agentId}`,
      label: "Agent",
      src: direct,
      shape: "circle",
      kind: "image",
    },
  };
}

export function useAgentAvatar(agentId: string | null): AgentAvatar {
  // Null is the intentional default/Berdy identity (including a fresh chat),
  // not an unresolved non-null agent or a missing catalog asset.
  const fallback = { choice: DEFAULT_AVATAR, isBerdy: agentId === null };
  const [resolved, setResolved] = useState<{
    agentId: string | null;
    value: AgentAvatar;
  } | null>(null);
  // Per-agent memo: avatars are static per session; refetching on every
  // pending/active flip would flash the probe swap needlessly.
  const cache = useRef(new Map<string, AgentAvatar>());

  useEffect(() => {
    const setChoice = (value: AgentAvatar) => setResolved({ agentId, value });
    if (agentId === null) {
      setChoice({ choice: DEFAULT_AVATAR, isBerdy: agentId === null });
      return;
    }
    const cached = cache.current.get(agentId);
    if (cached) {
      setChoice(cached);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const next = await choiceFor(agentId);
        if (cancelled) return;
        if (next === null) {
          setChoice({ choice: DEFAULT_AVATAR, isBerdy: agentId === null });
          return;
        }
        cache.current.set(agentId, next);
        setChoice(next);
      } catch {
        if (!cancelled)
          setChoice({ choice: DEFAULT_AVATAR, isBerdy: agentId === null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  // Never carry a previous agent's identity across an async resolution.
  return resolved?.agentId === agentId ? resolved.value : fallback;
}
