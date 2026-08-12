import {
  ASSISTIVE_UX_STORAGE_KEY,
  ASSISTIVE_UX_STORAGE_VERSION,
  type AssistiveUxMomentId,
  type AssistiveUxMomentType,
  type AssistiveUxRetiredReason,
} from "./registry";

interface StoredAssistiveUxMoment {
  type: AssistiveUxMomentType;
  shownCount: number;
  acceptedAt?: string;
  retiredAt?: string;
  retiredReason?: AssistiveUxRetiredReason;
  lastShownAt?: string;
}

interface StoredAssistiveUxState {
  version: number;
  moments: Partial<Record<AssistiveUxMomentId, StoredAssistiveUxMoment>>;
}

function defaultAssistiveUxState(): StoredAssistiveUxState {
  return {
    version: ASSISTIVE_UX_STORAGE_VERSION,
    moments: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseMoment(value: unknown): StoredAssistiveUxMoment | null {
  if (!isRecord(value)) return null;

  const type = value.type;
  if (type !== "discover" && type !== "suggest" && type !== "autoApply") {
    return null;
  }

  return {
    type,
    shownCount:
      typeof value.shownCount === "number" && value.shownCount > 0
        ? value.shownCount
        : 0,
    acceptedAt:
      typeof value.acceptedAt === "string" ? value.acceptedAt : undefined,
    retiredAt:
      typeof value.retiredAt === "string" ? value.retiredAt : undefined,
    retiredReason: isRetiredReason(value.retiredReason)
      ? value.retiredReason
      : undefined,
    lastShownAt:
      typeof value.lastShownAt === "string" ? value.lastShownAt : undefined,
  };
}

function isRetiredReason(value: unknown): value is AssistiveUxRetiredReason {
  return (
    value === "accepted" ||
    value === "dismissed" ||
    value === "expired" ||
    value === "settingsChanged" ||
    value === "manualSettingChange" ||
    value === "autoApplied"
  );
}

function parseStoredAssistiveUxState(value: unknown): StoredAssistiveUxState {
  if (!isRecord(value) || !isRecord(value.moments)) {
    return defaultAssistiveUxState();
  }

  const moments: StoredAssistiveUxState["moments"] = {};
  for (const [id, moment] of Object.entries(value.moments)) {
    const parsedMoment = parseMoment(moment);
    if (parsedMoment) {
      moments[id as AssistiveUxMomentId] = parsedMoment;
    }
  }

  return {
    version: ASSISTIVE_UX_STORAGE_VERSION,
    moments,
  };
}

export function readAssistiveUxState(): StoredAssistiveUxState {
  if (typeof window === "undefined") return defaultAssistiveUxState();

  try {
    const raw = window.localStorage.getItem(ASSISTIVE_UX_STORAGE_KEY);
    if (!raw) return defaultAssistiveUxState();
    return parseStoredAssistiveUxState(JSON.parse(raw));
  } catch {
    return defaultAssistiveUxState();
  }
}

export function writeAssistiveUxState(nextState: StoredAssistiveUxState): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      ASSISTIVE_UX_STORAGE_KEY,
      JSON.stringify({
        ...nextState,
        version: ASSISTIVE_UX_STORAGE_VERSION,
      }),
    );
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
}

export function resetAssistiveUxMoment(id: AssistiveUxMomentId): void {
  const state = readAssistiveUxState();
  const { [id]: _removed, ...moments } = state.moments;
  writeAssistiveUxState({ ...state, moments });
}

export function updateAssistiveUxMoment(
  id: AssistiveUxMomentId,
  update: (
    moment: StoredAssistiveUxMoment | undefined,
  ) => StoredAssistiveUxMoment,
): void {
  const state = readAssistiveUxState();
  writeAssistiveUxState({
    ...state,
    moments: {
      ...state.moments,
      [id]: update(state.moments[id]),
    },
  });
}
