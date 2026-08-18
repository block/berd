/**
 * Confirmed-persistence gate for the `berd_home` Pin Pinned / Unpin Unpinned
 * events.
 *
 * Every pin surface mutates the widget store optimistically: the local canvas
 * updates synchronously and the layout is persisted afterwards by the runtime's
 * save loop. Emitting at the mutation therefore reports pin changes that may
 * never exist on the backend — the save can fail and roll the canvas back to
 * the last confirmed layout, and a revision conflict adopts the backend layout
 * while merging only *additions* forward, so a removal can silently un-happen.
 *
 * So the pin surfaces do not emit. They record an *intent* here ("the user
 * acted on this entity's pin state"), and the intent is resolved when the save
 * settles, against the layout the backend actually confirmed:
 *
 * - pinned in the confirmed layout, and it was not before -> Pin Pinned
 * - gone from the confirmed layout, and it was there before -> Unpin Unpinned
 * - no net change (rollback, conflict, or a pin the user undid inside the same
 *   save window) -> nothing, because nothing survived persistence
 *
 * The observed transition must also be one the user asked for, so a change they
 * did not make (a conflicting layout from another window) is never attributed
 * to them. One save window can carry more than one request for the same entity
 * — pin, then unpin before anything settles — and either can be the change that
 * survives: the pin's own save can land while the unpin behind it is still in
 * flight, and a failed unpin then rolls the canvas back onto that pin. So an
 * intent remembers every direction the user asked for, not only the latest one.
 *
 * Resolution is terminal. Both save-lifecycle events fire only once the save
 * queue has drained or been dropped, so nothing the user asked for is still in
 * flight when an intent resolves, and holding one back would leave a later
 * transition — one another window made — looking like their action arriving.
 *
 * The events carry only the item kind — no entity id rides the wire — but a
 * pinned chat's *identity* still moves under the intent: pinning a draft pins
 * it under a client-generated id that promotion later rewrites. So a chat
 * intent resolves through `chatPinIdentity`, keyed under the id the session
 * was created under and matched under every id the pin may currently be
 * stored under, so a pin recorded before promotion and a resolution after it
 * read as one action on one entity. Since no id is reported, a confirmed pin
 * of a still-draft chat resolves immediately rather than waiting on the id
 * promotion would assign.
 *
 * Programmatic canvas writes — starter-agent seeding, the onboarding reset —
 * record no intent and so stay silent, which is what the raw `seedWidget`
 * store path exists for.
 */
import {
  HOME_WIDGET_SAVE_CONFIRMED_EVENT,
  HOME_WIDGET_SAVE_DISCARDED_EVENT,
} from "@/features/home/onboarding/homeWidgetSaveLifecycle";
import { perfLog } from "@/shared/lib/perfLog";
import { useHomeWidgetStore } from "../stores/homeWidgetStore";
import type { WidgetInstance } from "../widgets/types";
import { resolveChatPinIdentity } from "./chatPinIdentity";
import { layoutItemsToHomeWidgets } from "./homeLayoutMapper";
import { isPinnedToHome, type PinToHomeTargetKind } from "./homePinTargets";
import { trackHomeItemPinned, trackHomeItemUnpinned } from "./homeTelemetry";

export interface HomePinIntent {
  kind: PinToHomeTargetKind;
  /**
   * Entity id as the surface saw it — never reported, only used to key the
   * intent and match it against the confirmed layout. For a chat item this is
   * the chat session id, which is a draft id when the chat has not sent its
   * first message yet (see chatPinIdentity).
   */
  itemId: string;
  /** Prior ids a skill pin may still be stored under; see skillPinIdentity. */
  legacyIds?: readonly string[] | null;
}

interface PendingPinIntent extends HomePinIntent {
  /** Whether the user asked to pin this entity during this save window. */
  requestedPin: boolean;
  /** Whether they asked to unpin it during this save window. */
  requestedUnpin: boolean;
  /** Whether the entity was pinned in the confirmed layout when they first acted. */
  pinnedBefore: boolean;
}

// Keyed by entity, so repeated actions on one item inside a single save window
// resolve as one net change rather than a burst of unpaired events.
const pendingIntents = new Map<string, PendingPinIntent>();
let subscribedToSaveLifecycle = false;

interface ResolvedPinIdentity {
  /** Map key: one entry per entity, stable across a draft chat's promotion. */
  key: string;
  /** Every id the pin may currently be stored under. */
  matchIds: string[];
}

/**
 * Only chat ids move: every other pinnable entity is pinned under an id it keeps
 * for life, so its id serves both roles at once.
 */
function resolvePinIdentity(intent: HomePinIntent): ResolvedPinIdentity {
  if (intent.kind !== "chat") {
    return {
      key: `${intent.kind}:${intent.itemId}`,
      matchIds: [intent.itemId],
    };
  }

  const { keyId, matchIds } = resolveChatPinIdentity(intent.itemId);
  return {
    key: `chat:${keyId}`,
    matchIds,
  };
}

/**
 * The last layout the backend confirmed. Local mutations never touch it, so it
 * is the only honest answer to "is this item actually pinned". Before the first
 * confirmed layout nothing is persisted, hence the empty fallback.
 */
function confirmedInstances(): WidgetInstance[] {
  const { lastConfirmedLayout } = useHomeWidgetStore.getState();
  return lastConfirmedLayout
    ? layoutItemsToHomeWidgets(lastConfirmedLayout.items)
    : [];
}

function isPinnedInConfirmedLayout(
  instances: WidgetInstance[],
  { kind, legacyIds }: HomePinIntent,
  matchIds: string[],
): boolean {
  return matchIds.some((id) =>
    isPinnedToHome(instances, { kind, id, legacyIds }),
  );
}

function flushPendingIntents(): void {
  if (pendingIntents.size === 0) {
    return;
  }

  // Drain before resolving, so resolution stays terminal even if it throws:
  // holding a spent intent back would leave a later transition — one another
  // window made — looking like this user's action arriving.
  const intents = [...pendingIntents.values()];
  pendingIntents.clear();

  // Observation only. This runs from the save-lifecycle listeners rather than a
  // product caller, so a throw cannot break a pin surface, but it maps the whole
  // confirmed layout, and a corrupt one should stay a dropped event rather than
  // become window.onerror noise.
  try {
    const confirmed = confirmedInstances();

    for (const intent of intents) {
      const { matchIds } = resolvePinIdentity(intent);
      const pinnedNow = isPinnedInConfirmedLayout(confirmed, intent, matchIds);
      if (pinnedNow === intent.pinnedBefore) {
        continue;
      }
      // The transition also has to be one this user asked for; anything else
      // came from another writer's layout. Every direction they asked for in
      // this window counts, not just their latest one: when they pin and then
      // unpin before anything settles, the pin can still be the change that
      // survives, and it is theirs to report.
      if (!(pinnedNow ? intent.requestedPin : intent.requestedUnpin)) {
        continue;
      }

      if (pinnedNow) {
        trackHomeItemPinned({ kind: intent.kind });
      } else {
        trackHomeItemUnpinned({ kind: intent.kind });
      }
    }
  } catch (error) {
    perfLog(`[telemetry] home pin intent flush failed: ${String(error)}`);
  }
}

function ensureSaveLifecycleSubscription(): void {
  if (subscribedToSaveLifecycle || typeof window === "undefined") {
    return;
  }

  // Both outcomes resolve the same way: the confirmed layout decides. The
  // discarded event covers a rejected save (rolled back) and a revision
  // conflict (backend layout adopted), and both drop the queued local edits.
  window.addEventListener(
    HOME_WIDGET_SAVE_CONFIRMED_EVENT,
    flushPendingIntents,
  );
  window.addEventListener(
    HOME_WIDGET_SAVE_DISCARDED_EVENT,
    flushPendingIntents,
  );
  subscribedToSaveLifecycle = true;
}

function recordIntent(intent: HomePinIntent, action: "pin" | "unpin"): void {
  // Observation only, structurally: recording resolves a chat's pin identity and
  // maps the whole confirmed layout, and it runs synchronously inside the pin and
  // unpin handlers *after* their optimistic store mutation has already applied.
  // A throw would therefore turn a change that succeeded into a false failure
  // toast (usePinToHomeWidget), an aborted half-batch (pinBatchToHome /
  // unpinBatchFromHome), or an uncaught error out of HomeView's canvas handlers.
  try {
    ensureSaveLifecycleSubscription();

    const { key, matchIds } = resolvePinIdentity(intent);
    const existing = pendingIntents.get(key);
    if (existing) {
      // Keep the baseline from when this window opened, and remember this
      // direction alongside any earlier one: either can be the change that
      // lands.
      if (action === "pin") {
        existing.requestedPin = true;
      } else {
        existing.requestedUnpin = true;
      }
      return;
    }

    pendingIntents.set(key, {
      ...intent,
      requestedPin: action === "pin",
      requestedUnpin: action === "unpin",
      pinnedBefore: isPinnedInConfirmedLayout(
        confirmedInstances(),
        intent,
        matchIds,
      ),
    });
  } catch (error) {
    perfLog(`[telemetry] home pin intent failed: ${String(error)}`);
  }
}

/** The user pinned an item to Home; reported if the pin survives persistence. */
export function recordHomeItemPinIntent(intent: HomePinIntent): void {
  recordIntent(intent, "pin");
}

/** The user unpinned an item from Home; reported if the removal persists. */
export function recordHomeItemUnpinIntent(intent: HomePinIntent): void {
  recordIntent(intent, "unpin");
}

export function resetHomePinTelemetryForTests(): void {
  pendingIntents.clear();
  if (subscribedToSaveLifecycle && typeof window !== "undefined") {
    window.removeEventListener(
      HOME_WIDGET_SAVE_CONFIRMED_EVENT,
      flushPendingIntents,
    );
    window.removeEventListener(
      HOME_WIDGET_SAVE_DISCARDED_EVENT,
      flushPendingIntents,
    );
  }
  // The next recorded intent re-subscribes, so a reset leaves the module in the
  // state a fresh import would be in rather than a half-torn-down one.
  subscribedToSaveLifecycle = false;
}
