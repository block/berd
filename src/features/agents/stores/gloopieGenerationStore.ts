import { create } from "zustand";
import { avatarRef, USER_AVATAR_REF_PREFIX } from "@/shared/avatars/catalog";
import type { AvatarLibraryState } from "@/features/agents/hooks/useAvatarLibrary";
import {
  animateGloopieOption,
  canUseNativeGloopieGeneration,
  generateGloopieOptions,
  normalizeGloopieGenerationError,
} from "@/shared/api/gloopies";
import { deleteUserAvatar } from "@/shared/api/avatars";

export type GloopiePhase =
  | "prompt"
  | "generating"
  | "choosing"
  | "animating"
  | "done"
  | "error";

export interface GloopieOption {
  id: string;
  avatarRef: string;
}

export type GloopieErrorCode =
  | "networkAccess"
  | "contentBlocked"
  | "unavailable";

export interface GloopieGenerationJob {
  phase: GloopiePhase;
  object: string;
  options: GloopieOption[];
  chosenOptionId: string | null;
  resultAvatarRef: string | null;
  errorCode: GloopieErrorCode | null;
  attemptId: number;
}

export interface ResetGloopieGenerationOptions {
  /** Generated refs that have just been committed elsewhere and must survive. */
  keepRefs?: readonly (string | null | undefined)[];
  /** Keep the user's text so starting over feels recoverable, not punitive. */
  keepObject?: boolean;
}

interface GloopieGenerationStore {
  jobs: Record<string, GloopieGenerationJob>;
}

const MOCK_GENERATE_MS = 2200;
const MOCK_ANIMATE_MS = 2600;
const MOCK_OPTION_COUNT = 4;
const DEFAULT_JOB_KEY = "__default__";

let nextAttemptId = 1;
const mockTimers = new Map<string, number>();

/**
 * Generated options are written to the user avatar store as real files the
 * moment they are produced, but only the chosen one survives. Anything we
 * abandon (regenerate, quit, a superseded attempt landing late) has to be
 * deleted or it stays on disk forever.
 *
 * `keepRefs` protects refs that are still in use — most importantly the finished
 * result, which the non-native fallback aliases to the chosen option's ref.
 * Only `user-avatar:` refs are deletable; bundled `app-avatar:` refs are not
 * ours to remove.
 */
function discardGeneratedMedia(
  refs: readonly (string | null | undefined)[],
  keepRefs: readonly (string | null | undefined)[] = [],
): void {
  const keep = new Set(keepRefs.filter((ref): ref is string => Boolean(ref)));
  const seen = new Set<string>();

  for (const ref of refs) {
    if (
      !ref ||
      keep.has(ref) ||
      seen.has(ref) ||
      !ref.startsWith(USER_AVATAR_REF_PREFIX)
    ) {
      continue;
    }
    seen.add(ref);
    void deleteUserAvatar(ref).catch((error) => {
      console.warn("Failed to delete abandoned gloopie media:", error);
    });
  }
}

function optionRefs(job: GloopieGenerationJob): string[] {
  return job.options.map((option) => option.avatarRef);
}

function createJob(attemptId = 0): GloopieGenerationJob {
  return {
    phase: "prompt",
    object: "",
    options: [],
    chosenOptionId: null,
    resultAvatarRef: null,
    errorCode: null,
    attemptId,
  };
}

export const useGloopieGenerationStore = create<GloopieGenerationStore>(() => ({
  jobs: {},
}));

export function gloopieJobKey(sessionId?: string): string {
  return sessionId || DEFAULT_JOB_KEY;
}

export function getGloopieGenerationJob(
  sessionId?: string,
): GloopieGenerationJob {
  return (
    useGloopieGenerationStore.getState().jobs[gloopieJobKey(sessionId)] ??
    createJob()
  );
}

function updateJob(
  sessionId: string | undefined,
  updater: (job: GloopieGenerationJob) => GloopieGenerationJob,
): void {
  const key = gloopieJobKey(sessionId);
  useGloopieGenerationStore.setState((state) => ({
    jobs: {
      ...state.jobs,
      [key]: updater(state.jobs[key] ?? createJob()),
    },
  }));
}

function replaceJob(
  sessionId: string | undefined,
  job: GloopieGenerationJob,
): void {
  const key = gloopieJobKey(sessionId);
  useGloopieGenerationStore.setState((state) => ({
    jobs: { ...state.jobs, [key]: job },
  }));
}

function clearMockTimer(sessionId?: string): void {
  const key = gloopieJobKey(sessionId);
  const timer = mockTimers.get(key);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    mockTimers.delete(key);
  }
}

function isCurrentAttempt(sessionId: string | undefined, attemptId: number) {
  return getGloopieGenerationJob(sessionId).attemptId === attemptId;
}

function pickMockOptionIds(
  library: AvatarLibraryState,
  count: number,
): string[] {
  const ids = (library.catalog?.assets ?? []).map((asset) => asset.id);
  if (ids.length === 0) {
    return [];
  }

  const step = Math.max(1, Math.floor(ids.length / count));
  const picked: string[] = [];
  for (
    let index = 0;
    index < ids.length && picked.length < count;
    index += step
  ) {
    picked.push(ids[index]);
  }
  for (let index = 0; index < ids.length && picked.length < count; index += 1) {
    if (!picked.includes(ids[index])) {
      picked.push(ids[index]);
    }
  }
  return picked;
}

export function setGloopieObject(
  sessionId: string | undefined,
  object: string,
): void {
  updateJob(sessionId, (job) => ({ ...job, object }));
}

export function startGloopieGeneration(
  sessionId: string | undefined,
  library: AvatarLibraryState,
): void {
  const current = getGloopieGenerationJob(sessionId);
  const object = current.object.trim();
  if (!object) {
    return;
  }

  clearMockTimer(sessionId);
  // Regenerating abandons the previous options and result.
  discardGeneratedMedia([...optionRefs(current), current.resultAvatarRef]);
  const attemptId = nextAttemptId++;
  replaceJob(sessionId, {
    ...current,
    phase: "generating",
    object: current.object,
    options: [],
    chosenOptionId: null,
    resultAvatarRef: null,
    errorCode: null,
    attemptId,
  });

  if (canUseNativeGloopieGeneration()) {
    void generateGloopieOptions({ object })
      .then((options) => {
        if (!isCurrentAttempt(sessionId, attemptId)) {
          // Abandoned while in flight (discard/quit/regenerate). The backend
          // still wrote these files, so this is the only chance to clean up.
          discardGeneratedMedia(options.map((option) => option.avatarRef));
          return;
        }
        updateJob(sessionId, (job) => ({ ...job, options, phase: "choosing" }));
      })
      .catch((error) => {
        if (!isCurrentAttempt(sessionId, attemptId)) return;
        updateJob(sessionId, (job) => ({
          ...job,
          errorCode: normalizeGloopieGenerationError(error).code,
          phase: "error",
        }));
      });
    return;
  }

  const key = gloopieJobKey(sessionId);
  const timer = window.setTimeout(() => {
    mockTimers.delete(key);
    if (!isCurrentAttempt(sessionId, attemptId)) return;
    const ids = pickMockOptionIds(library, MOCK_OPTION_COUNT);
    if (ids.length === 0) {
      updateJob(sessionId, (job) => ({
        ...job,
        errorCode: "unavailable",
        phase: "error",
      }));
      return;
    }
    updateJob(sessionId, (job) => ({
      ...job,
      options: ids.map((id) => ({ id, avatarRef: avatarRef(id) })),
      phase: "choosing",
    }));
  }, MOCK_GENERATE_MS);
  mockTimers.set(key, timer);
}

export function chooseGloopieOption(
  sessionId: string | undefined,
  optionId: string | null,
): void {
  updateJob(sessionId, (job) => ({ ...job, chosenOptionId: optionId }));
}

export function animateChosenGloopie(sessionId?: string): void {
  const current = getGloopieGenerationJob(sessionId);
  const chosen = current.options.find(
    (option) => option.id === current.chosenOptionId,
  );
  if (!chosen) {
    return;
  }

  clearMockTimer(sessionId);
  const attemptId = nextAttemptId++;
  replaceJob(sessionId, {
    ...current,
    phase: "animating",
    errorCode: null,
    attemptId,
  });

  if (canUseNativeGloopieGeneration()) {
    void animateGloopieOption({
      avatarRef: chosen.avatarRef,
      object: current.object.trim(),
    })
      .then((resultAvatarRef) => {
        if (!isCurrentAttempt(sessionId, attemptId)) {
          discardGeneratedMedia([resultAvatarRef]);
          return;
        }
        // The animation is the keeper; the options it was chosen from are dead.
        discardGeneratedMedia(optionRefs(current), [resultAvatarRef]);
        updateJob(sessionId, (job) => ({
          ...job,
          resultAvatarRef,
          phase: "done",
        }));
      })
      .catch((error) => {
        if (!isCurrentAttempt(sessionId, attemptId)) return;
        updateJob(sessionId, (job) => ({
          ...job,
          errorCode: normalizeGloopieGenerationError(error).code,
          phase: "error",
        }));
      });
    return;
  }

  const key = gloopieJobKey(sessionId);
  const timer = window.setTimeout(() => {
    mockTimers.delete(key);
    if (!isCurrentAttempt(sessionId, attemptId)) return;
    updateJob(sessionId, (job) => ({
      ...job,
      resultAvatarRef: chosen.avatarRef,
      phase: "done",
    }));
  }, MOCK_ANIMATE_MS);
  mockTimers.set(key, timer);
}

/**
 * Abandon the job and delete the media it produced.
 *
 * `keepRefs` lets callers retain a ref they have just committed elsewhere — e.g.
 * "use this avatar" writes the result onto the agent before resetting, so that
 * ref must survive.
 */
function normalizeResetOptions(
  optionsOrKeepRefs:
    | ResetGloopieGenerationOptions
    | readonly (string | null | undefined)[] = {},
): ResetGloopieGenerationOptions {
  return Array.isArray(optionsOrKeepRefs)
    ? { keepRefs: optionsOrKeepRefs }
    : (optionsOrKeepRefs as ResetGloopieGenerationOptions);
}

export function resetGloopieGeneration(
  sessionId?: string,
  optionsOrKeepRefs:
    | ResetGloopieGenerationOptions
    | readonly (string | null | undefined)[] = {},
): void {
  const options = normalizeResetOptions(optionsOrKeepRefs);
  clearMockTimer(sessionId);
  const current = getGloopieGenerationJob(sessionId);
  discardGeneratedMedia(
    [...optionRefs(current), current.resultAvatarRef],
    options.keepRefs,
  );
  replaceJob(sessionId, {
    ...createJob(nextAttemptId++),
    object: options.keepObject ? current.object : "",
  });
}

/**
 * Drop a session's job entirely when its chat/draft goes away. Without this the
 * module-level map grows for the lifetime of the app.
 *
 * Saving is blocked while a gloopie is unresolved, so by the time a draft is
 * promoted the job is either back at `prompt` or holds a ref the user already
 * committed to the agent (which `resetGloopieGeneration` preserved). That is why
 * evicting here cannot delete media the saved agent still points at.
 */
export function clearGloopieGenerationSession(sessionId: string): void {
  clearMockTimer(sessionId);
  const key = gloopieJobKey(sessionId);
  const job = useGloopieGenerationStore.getState().jobs[key];
  if (!job) return;

  discardGeneratedMedia([...optionRefs(job), job.resultAvatarRef]);
  useGloopieGenerationStore.setState((state) => {
    if (!(key in state.jobs)) return state;
    const { [key]: _removed, ...rest } = state.jobs;
    return { jobs: rest };
  });
}

/**
 * Phases that hold an avatar the user has not resolved yet.
 *
 * Exported as a type so surfaces that must explain *why* saving is blocked can
 * key their copy by phase and have the compiler reject a missing branch, rather
 * than silently rendering nothing for a phase added later.
 */
export type UnresolvedGloopiePhase =
  | "generating"
  | "choosing"
  | "animating"
  | "done";

/**
 * True for any phase holding an avatar the user has not resolved yet: the media
 * either does not exist yet, or exists but has not been committed to the agent
 * via "Use this avatar". Saving is blocked while this is true, so a draft can
 * never be promoted with a half-finished avatar.
 *
 * "error" is deliberately excluded — there is no pending avatar, so blocking
 * would trap the user with no way forward.
 *
 * Callers pass a phase rather than a session id because the builder rail must
 * evaluate its experiment-gated phase, not the raw stored one.
 *
 * Narrows so callers can index phase-keyed copy without re-asserting the set.
 */
export function isUnresolvedGloopiePhase(
  phase: GloopiePhase,
): phase is UnresolvedGloopiePhase {
  return (
    phase === "generating" ||
    phase === "choosing" ||
    phase === "animating" ||
    phase === "done"
  );
}

/** Session-scoped form of {@link isUnresolvedGloopiePhase}. */
export function isGloopieGenerationUnresolved(sessionId?: string): boolean {
  return isUnresolvedGloopiePhase(getGloopieGenerationJob(sessionId).phase);
}

/**
 * The i18n key explaining a failed attempt.
 *
 * Three surfaces describe the same failure — the in-rail creator prompt, the
 * rail's status card, and the takeover's prompt. They must never explain one
 * error differently, so they all read the copy from here instead of each
 * repeating the code-to-key mapping. Adding an error code is then one edit,
 * and the compiler flags the missing branch.
 */
export function gloopieErrorMessageKey(
  errorCode: GloopieErrorCode | null,
): string {
  switch (errorCode) {
    case "networkAccess":
      return "gloopie.errorNetwork";
    case "contentBlocked":
      return "gloopie.errorContentBlocked";
    default:
      return "gloopie.errorUnavailable";
  }
}

export function hasGloopieGenerationWork(sessionId: string): boolean {
  const job = getGloopieGenerationJob(sessionId);
  return job.phase !== "prompt" || job.object.trim().length > 0;
}

export function resetGloopieGenerationStoreForTests(): void {
  for (const timer of mockTimers.values()) {
    window.clearTimeout(timer);
  }
  mockTimers.clear();
  useGloopieGenerationStore.setState({ jobs: {} });
  nextAttemptId = 1;
}
