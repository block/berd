import { flushSync } from "react-dom";

type ViewTransition = {
  finished: Promise<void>;
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
  skipTransition: () => void;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (
    updateCallback: () => void | Promise<void>,
  ) => ViewTransition;
};

export type AgentViewTransitionKind =
  | "gallery-to-profile"
  | "profile-to-profile";

export const AGENT_PROFILE_FIELDS_TRANSITION_NAME = "agent-profile-fields";

interface RunAgentViewTransitionOptions {
  kind?: AgentViewTransitionKind;
}

function canUseViewTransitions(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return false;
  }

  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return false;
  }

  return Boolean((document as ViewTransitionDocument).startViewTransition);
}

function toTransitionIdent(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function getAgentAvatarTransitionName(personaId: string): string {
  return `agent-avatar-${toTransitionIdent(personaId)}`;
}

export function runAgentViewTransition(
  update: () => void,
  options: RunAgentViewTransitionOptions = {},
): void {
  if (!canUseViewTransitions()) {
    update();
    return;
  }

  const root = document.documentElement;
  if (options.kind) {
    root.dataset.agentTransition = options.kind;
  }

  const transition = (document as ViewTransitionDocument).startViewTransition?.(
    () => {
      flushSync(update);
    },
  );

  if (!options.kind) {
    return;
  }

  const clearTransitionKind = () => {
    if (root.dataset.agentTransition === options.kind) {
      delete root.dataset.agentTransition;
    }
  };

  if (!transition) {
    clearTransitionKind();
    return;
  }

  void transition.finished.then(clearTransitionKind, clearTransitionKind);
}
