import { useCallback, useEffect, useRef, type RefObject } from "react";
import { hasOpenKeyboardOwningLayer } from "@/app/focus/FocusRegionProvider";
import { eventMatchesShortcutCommand } from "@/features/shortcuts/lib/shortcutRegistry";

export type VoiceDictationShortcutSurface =
  | "centered-global"
  | "selected-chat"
  | "home-global";

type VoiceDictationShortcutTarget = {
  element: HTMLElement | null;
  surface: VoiceDictationShortcutSurface;
  canStart: boolean;
  isRecording: boolean;
  toggle: () => void;
};

type VoiceDictationShortcutState = Omit<
  VoiceDictationShortcutTarget,
  "element"
>;

const SURFACES: VoiceDictationShortcutSurface[] = [
  "centered-global",
  "selected-chat",
  "home-global",
];
const EDITABLE_SELECTOR =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']";
const registrations = new Set<() => VoiceDictationShortcutTarget>();

function isVisible(element: HTMLElement) {
  if (
    !element.isConnected ||
    element.closest("[hidden], [aria-hidden='true'], [inert]")
  ) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility !== "visible") return false;

  const rect = element.getBoundingClientRect();
  return (
    element.getClientRects().length > 0 || (rect.width > 0 && rect.height > 0)
  );
}

function eventIsAvailable(event: KeyboardEvent, allowEditableTarget = false) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.repeat ||
    hasOpenKeyboardOwningLayer() ||
    !eventMatchesShortcutCommand(event, "chat.toggleVoiceDictation")
  ) {
    return false;
  }

  const target = event.target;
  return (
    allowEditableTarget ||
    !(target instanceof Element) ||
    !target.closest(
      `${EDITABLE_SELECTOR}, [data-shortcut-recording="true"], .xterm`,
    )
  );
}

function eligible(target: VoiceDictationShortcutTarget) {
  return (
    target.element !== null &&
    isVisible(target.element) &&
    (target.isRecording || target.canStart)
  );
}

function selectTarget() {
  const targets = Array.from(registrations, (getTarget) => getTarget()).filter(
    eligible,
  );
  const prioritized = SURFACES.flatMap((surface) =>
    targets.filter((target) => target.surface === surface),
  );
  return (
    prioritized.find((target) => target.isRecording) ?? prioritized[0] ?? null
  );
}

function consume(event: KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function handleWindowKeyDown(event: KeyboardEvent) {
  if (!eventIsAvailable(event)) return;

  const target = selectTarget();
  if (!target) return;

  consume(event);
  target.element?.focus();
  target.toggle();
}

function register(getTarget: () => VoiceDictationShortcutTarget) {
  if (registrations.size === 0) {
    window.addEventListener("keydown", handleWindowKeyDown, true);
  }
  registrations.add(getTarget);

  return () => {
    registrations.delete(getTarget);
    if (registrations.size === 0) {
      window.removeEventListener("keydown", handleWindowKeyDown, true);
    }
  };
}

export function useVoiceDictationShortcutTarget<T extends HTMLElement>(
  elementRef: RefObject<T | null>,
  state: VoiceDictationShortcutState,
) {
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(
    () =>
      register(() => ({
        element: elementRef.current,
        ...stateRef.current,
      })),
    [elementRef],
  );

  return useCallback(
    (event: KeyboardEvent) => {
      const target = { element: elementRef.current, ...stateRef.current };
      if (
        !eventIsAvailable(event, true) ||
        target.element === null ||
        (!target.isRecording && !target.canStart)
      ) {
        return false;
      }

      consume(event);
      target.toggle();
      return true;
    },
    [elementRef],
  );
}

export function resetVoiceDictationShortcutControllerForTests() {
  registrations.clear();
  window.removeEventListener("keydown", handleWindowKeyDown, true);
}
