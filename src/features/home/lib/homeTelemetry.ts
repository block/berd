/**
 * Thin, feature-scoped wrappers over the vendored `berd_home` event factories,
 * mirroring `src/features/agents/lib/agentTelemetry.ts` and
 * `src/features/chat/lib/chatTelemetry.ts`.
 *
 * Each wrapper builds the vendored schema event and hands it to the shared
 * telemetry `track` chokepoint, inheriting its prod/staging gate, consent
 * gating, and startup buffering/backdating for free. Keeping the wrappers
 * here (rather than in `client.ts`) keeps `berd_home` wiring additive and local
 * to the home feature.
 *
 * Pin surfaces must not call these directly: pin changes are optimistic, so the
 * only caller is `homePinTelemetry.ts`, which reports a change once the backend
 * has confirmed it. Record an intent there instead.
 */
import { track } from "@/shared/telemetry/client";
import {
  type BerdHomeHomeItemType,
  berdHomePinPinned,
  berdHomeUnpinUnpinned,
} from "@/shared/telemetry/events";
import type { PinToHomeTargetKind } from "./homePinTargets";

/**
 * The five discriminated pin `kind` tokens map 1:1 onto the schema's
 * `HomeItemType` enum. The mapping is total — `PinToHomeTargetKind` is exactly
 * these five kinds — and adding a new pinnable kind would fail this `Record`'s
 * exhaustiveness check at compile time.
 */
const KIND_TO_ITEM_TYPE = {
  agent: "HOME_ITEM_TYPE_AGENT",
  chat: "HOME_ITEM_TYPE_CHAT",
  project: "HOME_ITEM_TYPE_PROJECT",
  automation: "HOME_ITEM_TYPE_AUTOMATION",
  skill: "HOME_ITEM_TYPE_SKILL",
} as const satisfies Record<PinToHomeTargetKind, BerdHomeHomeItemType>;

interface HomeItemTelemetryParams {
  kind: PinToHomeTargetKind;
}

/** The user pinned an item to the Home page (a confirmed pin). */
export function trackHomeItemPinned({ kind }: HomeItemTelemetryParams): void {
  track(
    berdHomePinPinned({
      item_type: KIND_TO_ITEM_TYPE[kind],
    }),
  );
}

/** The user unpinned an item from the Home page (a confirmed unpin). */
export function trackHomeItemUnpinned({ kind }: HomeItemTelemetryParams): void {
  track(
    berdHomeUnpinUnpinned({
      item_type: KIND_TO_ITEM_TYPE[kind],
    }),
  );
}
