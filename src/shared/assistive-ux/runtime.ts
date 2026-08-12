import {
  getAssistiveUxRule,
  type AssistiveUxMomentId,
  type AssistiveUxRetiredReason,
} from "./registry";
import { readAssistiveUxState, updateAssistiveUxMoment } from "./state";

function nowIsoString(): string {
  return new Date().toISOString();
}

export function shouldShowAssistiveMoment(id: AssistiveUxMomentId): boolean {
  const rule = getAssistiveUxRule(id);
  const moment = readAssistiveUxState().moments[id];

  if (moment?.retiredAt) return false;
  if (
    rule.maxShows !== undefined &&
    (moment?.shownCount ?? 0) >= rule.maxShows
  ) {
    return false;
  }

  return true;
}

export function hasAssistiveMomentBeenShown(id: AssistiveUxMomentId): boolean {
  return (readAssistiveUxState().moments[id]?.shownCount ?? 0) > 0;
}

export function recordAssistiveMomentShown(id: AssistiveUxMomentId): void {
  const rule = getAssistiveUxRule(id);
  const shownAt = nowIsoString();

  updateAssistiveUxMoment(id, (moment) => {
    const shownCount = (moment?.shownCount ?? 0) + 1;
    const shouldExpire =
      rule.maxShows !== undefined && shownCount >= rule.maxShows;

    return {
      type: rule.type,
      shownCount,
      acceptedAt: moment?.acceptedAt,
      lastShownAt: shownAt,
      retiredAt: moment?.retiredAt ?? (shouldExpire ? shownAt : undefined),
      retiredReason:
        moment?.retiredReason ?? (shouldExpire ? "expired" : undefined),
    };
  });
}

export function recordAssistiveMomentAccepted(id: AssistiveUxMomentId): void {
  const rule = getAssistiveUxRule(id);
  const acceptedAt = nowIsoString();

  updateAssistiveUxMoment(id, (moment) => ({
    type: rule.type,
    shownCount: moment?.shownCount ?? 0,
    acceptedAt,
    lastShownAt: moment?.lastShownAt,
    retiredAt: acceptedAt,
    retiredReason: "accepted",
  }));
}

export function recordAssistiveMomentDismissed(
  id: AssistiveUxMomentId,
): number {
  const rule = getAssistiveUxRule(id);
  const dismissedAt = nowIsoString();
  let dismissedCount = 0;

  updateAssistiveUxMoment(id, (moment) => {
    dismissedCount = (moment?.shownCount ?? 0) + 1;
    return {
      type: rule.type,
      shownCount: dismissedCount,
      acceptedAt: moment?.acceptedAt,
      lastShownAt: dismissedAt,
      retiredAt: moment?.retiredAt,
      retiredReason: moment?.retiredReason,
    };
  });

  return dismissedCount;
}

export function recordAssistiveMomentRetired(
  id: AssistiveUxMomentId,
  reason: AssistiveUxRetiredReason,
): void {
  const rule = getAssistiveUxRule(id);
  const retiredAt = nowIsoString();

  updateAssistiveUxMoment(id, (moment) => ({
    type: rule.type,
    shownCount: moment?.shownCount ?? 0,
    acceptedAt: moment?.acceptedAt,
    lastShownAt: moment?.lastShownAt,
    retiredAt: moment?.retiredAt ?? retiredAt,
    retiredReason: moment?.retiredReason ?? reason,
  }));
}
