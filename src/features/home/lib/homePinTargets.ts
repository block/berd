/**
 * Identity and matching for the pinnable entities on the Home canvas: which
 * widget type carries which entity id, and whether a given entity is currently
 * pinned in a set of widget instances.
 *
 * This lives in `lib/` rather than in `usePinToHomeWidget` because both the pin
 * hooks and the confirmed-persistence telemetry gate (`homePinTelemetry.ts`)
 * need it, and the gate must not import the hooks module (the hooks import the
 * gate).
 */
import { areSkillPinIdsEquivalent } from "@/features/home/lib/skillPinIdentity";
import type { WidgetInstance } from "../widgets/types";

export const PIN_TARGET_CONFIG = {
  agent: { widgetType: "agentPin", stateKey: "agentId" },
  chat: { widgetType: "chatPin", stateKey: "sessionId" },
  project: { widgetType: "projectArtifactPin", stateKey: "projectId" },
  automation: { widgetType: "automationOutputPin", stateKey: "automationId" },
  skill: { widgetType: "skillPin", stateKey: "skillId" },
} as const;

export type PinToHomeTargetKind = keyof typeof PIN_TARGET_CONFIG;

export interface PinToHomeTarget {
  kind: PinToHomeTargetKind;
  id: string | null | undefined;
  /** All historical pin ids this target's current id should still resolve
   *  for. See areSkillPinIdsEquivalent. */
  legacyIds?: readonly string[] | null;
}

export function normalizedTargetId(
  id: string | null | undefined,
): string | null {
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

// Reverse of PIN_TARGET_CONFIG: canvas widget type -> the pinnable entity it
// represents. Used to fire pin/unpin telemetry for the canvas-native picker and
// frame-remove paths, which mutate the widget store directly and so bypass
// pinToHome/unpinFromHome.
const WIDGET_TYPE_TO_TARGET: Record<
  string,
  { kind: PinToHomeTargetKind; stateKey: string }
> = Object.fromEntries(
  (Object.keys(PIN_TARGET_CONFIG) as PinToHomeTargetKind[]).map((kind) => {
    const { widgetType, stateKey } = PIN_TARGET_CONFIG[kind];
    return [widgetType, { kind, stateKey }];
  }),
);

/**
 * Maps a Home canvas widget (its type + persisted state) back to the pinnable
 * entity it represents, or null for the utility widgets (clock/note/checklist)
 * that are *added* to the canvas rather than *pinned*. For a chat pin the id is
 * the chat session id. Used by the canvas-native pin/unpin telemetry wiring.
 */
export function entityPinTargetFromWidget(
  type: string,
  state: Record<string, unknown> | undefined,
): { kind: PinToHomeTargetKind; id: string } | null {
  const config = WIDGET_TYPE_TO_TARGET[type];
  if (!config) {
    return null;
  }
  const raw = state?.[config.stateKey];
  const id = normalizedTargetId(typeof raw === "string" ? raw : null);
  return id ? { kind: config.kind, id } : null;
}

export function findPinnedHomeWidgetId(
  instances: WidgetInstance[],
  target: PinToHomeTarget,
): string | null {
  const targetId = normalizedTargetId(target.id);
  if (!targetId) {
    return null;
  }

  const config = PIN_TARGET_CONFIG[target.kind];
  return (
    instances.find((instance) => {
      if (instance.type !== config.widgetType) return false;
      const pinnedId = instance.state?.[config.stateKey];
      return target.kind === "skill"
        ? areSkillPinIdsEquivalent(
            typeof pinnedId === "string" ? pinnedId : null,
            targetId,
            target.legacyIds,
          )
        : pinnedId === targetId;
    })?.id ?? null
  );
}

export function isPinnedToHome(
  instances: WidgetInstance[],
  target: PinToHomeTarget,
): boolean {
  return findPinnedHomeWidgetId(instances, target) !== null;
}
