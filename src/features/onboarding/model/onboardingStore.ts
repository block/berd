import { useSyncExternalStore } from "react";
import {
  CURATED_HARNESS_IDS,
  RECOMMENDED_AGENTS,
  WORK_TYPE_IDS,
} from "./catalog";
import {
  INITIAL_ONBOARDING_STATE,
  type OnboardingAction,
  type OnboardingLifecycle,
  onboardingReducer,
  ONBOARDING_STEPS,
  type OnboardingState,
  type OnboardingStep,
} from "./onboardingState";

export const ONBOARDING_STORAGE_VERSION = 1;
export const ONBOARDING_STORAGE_KEY = "berd:onboarding:v1";

export type InstallationCohort =
  | "fresh-with-landing-v1"
  | "established-before-landing-v1"
  | "unknown";

interface PersistedOnboardingState {
  version: typeof ONBOARDING_STORAGE_VERSION;
  state: OnboardingState;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let storageListening = false;
let snapshot: OnboardingState = { ...INITIAL_ONBOARDING_STATE };
let hydrated = false;
let hasUnsupportedNewerRecord = false;
let storageOverrideForTests: Storage | null | undefined;

const workTypeIds = new Set<string>(WORK_TYPE_IDS);
const agentIds = new Set(RECOMMENDED_AGENTS.map((agent) => agent.id));
const retiredRecommendedAgentIds = new Set([
  "builder",
  "debugger",
  "generalist",
]);
const harnessIds = new Set<string>(CURATED_HARNESS_IDS);

function storage(): Storage | null {
  if (storageOverrideForTests !== undefined) return storageOverrideForTests;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Preserve authored onboarding state while graduating established installs. */
export function initializeOnboardingGraduation(
  cohort: InstallationCohort,
): void {
  const completedState: OnboardingState = {
    ...INITIAL_ONBOARDING_STATE,
    lifecycle: "completed",
    step: "complete",
  };
  const target = storage();
  if (!target) {
    if (cohort === "established-before-landing-v1") {
      snapshot = completedState;
      hydrated = true;
      emit();
    }
    return;
  }

  try {
    const raw = target.getItem(ONBOARDING_STORAGE_KEY);
    const preserveExisting = (() => {
      if (raw === null) return false;
      try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object") return false;
        const record = value as Partial<PersistedOnboardingState>;
        return (
          (typeof record.version === "number" &&
            record.version > ONBOARDING_STORAGE_VERSION) ||
          (record.version === ONBOARDING_STORAGE_VERSION &&
            isValidPersistedState(
              normalizeRetiredRecommendedAgent(
                (record.state as Partial<OnboardingState> | undefined) ?? {},
              ),
            ))
        );
      } catch {
        return false;
      }
    })();
    if (!preserveExisting && cohort === "established-before-landing-v1") {
      snapshot = completedState;
      hydrated = true;
      emit();
      target.setItem(
        ONBOARDING_STORAGE_KEY,
        JSON.stringify({
          version: ONBOARDING_STORAGE_VERSION,
          state: completedState,
        } satisfies PersistedOnboardingState),
      );
    }
  } catch {
    if (cohort === "established-before-landing-v1") {
      snapshot = completedState;
      hydrated = true;
      emit();
    }
    // Onboarding remains usable if localStorage is unavailable or full.
  }
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isStep(value: unknown): value is OnboardingStep {
  return ONBOARDING_STEPS.includes(value as OnboardingStep);
}

function isLifecycle(value: unknown): value is OnboardingLifecycle {
  return (
    value === "not-started" || value === "in-progress" || value === "completed"
  );
}

function isValidPersistedState(
  state: Partial<OnboardingState> | undefined,
): state is OnboardingState {
  return Boolean(
    state &&
      isLifecycle(state.lifecycle) &&
      isStep(state.step) &&
      isStringArray(state.selectedWorkTypeIds) &&
      state.selectedWorkTypeIds.every((id) => workTypeIds.has(id)) &&
      (state.selectedAgentId === null ||
        (typeof state.selectedAgentId === "string" &&
          agentIds.has(state.selectedAgentId))) &&
      (state.selectedHarnessId === null ||
        (typeof state.selectedHarnessId === "string" &&
          harnessIds.has(state.selectedHarnessId))) &&
      (state.completedHarnessSetupIds === undefined ||
        (isStringArray(state.completedHarnessSetupIds) &&
          state.completedHarnessSetupIds.every((id) => harnessIds.has(id)))) &&
      (state.shareUsageData === undefined ||
        state.shareUsageData === null ||
        typeof state.shareUsageData === "boolean") &&
      (state.step === "complete") === (state.lifecycle === "completed") &&
      (state.step !== "harness-setup" || state.selectedHarnessId !== null),
  );
}

function normalizeRetiredRecommendedAgent(
  state: Partial<OnboardingState>,
): Partial<OnboardingState> {
  return retiredRecommendedAgentIds.has(state.selectedAgentId ?? "")
    ? { ...state, selectedAgentId: null }
    : state;
}

function parsePersisted(raw: string | null): OnboardingState {
  hasUnsupportedNewerRecord = false;
  if (raw === null) return { ...INITIAL_ONBOARDING_STATE };

  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") {
      return { ...INITIAL_ONBOARDING_STATE };
    }
    const record = value as Partial<PersistedOnboardingState>;
    if (record.version !== ONBOARDING_STORAGE_VERSION) {
      hasUnsupportedNewerRecord =
        typeof record.version === "number" &&
        record.version > ONBOARDING_STORAGE_VERSION;
      return { ...INITIAL_ONBOARDING_STATE };
    }
    const state = normalizeRetiredRecommendedAgent(
      (record.state as Partial<OnboardingState> | undefined) ?? {},
    );
    if (!isValidPersistedState(state)) {
      return { ...INITIAL_ONBOARDING_STATE };
    }
    return {
      lifecycle: state.lifecycle,
      step: state.step,
      selectedWorkTypeIds: [...new Set(state.selectedWorkTypeIds)],
      selectedAgentId: state.selectedAgentId,
      selectedHarnessId: state.selectedHarnessId,
      completedHarnessSetupIds: [
        ...new Set(state.completedHarnessSetupIds ?? []),
      ],
      shareUsageData: state.shareUsageData ?? null,
    };
  } catch {
    return { ...INITIAL_ONBOARDING_STATE };
  }
}

function readStorage(): OnboardingState {
  const target = storage();
  if (!target) return { ...INITIAL_ONBOARDING_STATE };
  try {
    return parsePersisted(target.getItem(ONBOARDING_STORAGE_KEY));
  } catch {
    return { ...INITIAL_ONBOARDING_STATE };
  }
}

function hydrate(): void {
  if (hydrated) return;
  snapshot = readStorage();
  hydrated = true;
}

function currentStorageHasNewerVersion(target: Storage): boolean {
  try {
    const raw = target.getItem(ONBOARDING_STORAGE_KEY);
    if (!raw) return false;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return false;
    const version = (value as { version?: unknown }).version;
    return typeof version === "number" && version > ONBOARDING_STORAGE_VERSION;
  } catch {
    return false;
  }
}

function persist(state: OnboardingState): void {
  if (hasUnsupportedNewerRecord) return;
  const target = storage();
  if (!target || currentStorageHasNewerVersion(target)) return;
  try {
    const persisted: PersistedOnboardingState = {
      version: ONBOARDING_STORAGE_VERSION,
      state,
    };
    target.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // Onboarding remains usable when storage is unavailable or full.
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent): void {
  if (event.key !== ONBOARDING_STORAGE_KEY && event.key !== null) return;
  const next =
    event.key === null ? readStorage() : parsePersisted(event.newValue);
  snapshot = next;
  hydrated = true;
  emit();
}

function ensureStorageListener(): void {
  if (storageListening || typeof window === "undefined") return;
  window.addEventListener("storage", onStorage);
  storageListening = true;
}

export function getOnboardingSnapshot(): OnboardingState {
  hydrate();
  return snapshot;
}

export function subscribeToOnboarding(listener: Listener): () => void {
  ensureStorageListener();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dispatchOnboarding(action: OnboardingAction): OnboardingState {
  hydrate();
  snapshot = onboardingReducer(snapshot, action);
  persist(snapshot);
  emit();
  return snapshot;
}

export function resetOnboarding(): OnboardingState {
  const target = storage();
  try {
    if (
      target &&
      !hasUnsupportedNewerRecord &&
      !currentStorageHasNewerVersion(target)
    ) {
      target.removeItem(ONBOARDING_STORAGE_KEY);
    }
  } catch {
    // Keep the in-memory reset even if storage cannot be changed.
  }
  snapshot = { ...INITIAL_ONBOARDING_STATE };
  hydrated = true;
  emit();
  return snapshot;
}

export function replayOnboarding(): OnboardingState {
  return dispatchOnboarding({ type: "replay" });
}

export function useOnboardingState(): OnboardingState {
  return useSyncExternalStore(
    subscribeToOnboarding,
    getOnboardingSnapshot,
    () => INITIAL_ONBOARDING_STATE,
  );
}

/** Test-only lifecycle reset; unlike resetOnboarding, this does not alter storage. */
export function resetOnboardingStoreForTests(): void {
  snapshot = { ...INITIAL_ONBOARDING_STATE };
  hydrated = false;
  hasUnsupportedNewerRecord = false;
}

/** Test-only storage override for restricted WebView behavior. */
export function setOnboardingStorageForTests(
  target: Storage | null | undefined,
): void {
  storageOverrideForTests = target;
  resetOnboardingStoreForTests();
}
