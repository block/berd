export const SKILLS_CHANGED_EVENT = "goose:skills-changed";

export function listenSkillsChanged(handler: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const listener = () => {
    handler();
  };
  window.addEventListener(SKILLS_CHANGED_EVENT, listener);

  return () => {
    window.removeEventListener(SKILLS_CHANGED_EVENT, listener);
  };
}

export function emitSkillsChanged(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent(SKILLS_CHANGED_EVENT));
}
