import { useCallback, useRef, type RefObject } from "react";

interface CloseAutoFocusEvent {
  preventDefault: () => void;
}

type CloseFocusIntent = "return-to-composer" | "preserve-destination";

const FOCUS_DESTINATION_SELECTOR = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "summary",
  "audio[controls]",
  "video[controls]",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

function isFocusDestination(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(FOCUS_DESTINATION_SELECTOR) !== null
  );
}

interface UseComposerPickerCloseFocusOptions {
  triggerRef: RefObject<HTMLElement | null>;
  onRequestComposerFocus?: () => void;
}

/** Owns close-focus intent for a composer picker across one open cycle. */
export function useComposerPickerCloseFocus({
  triggerRef,
  onRequestComposerFocus,
}: UseComposerPickerCloseFocusOptions) {
  const intentRef = useRef<CloseFocusIntent>("return-to-composer");

  const beginOpenCycle = useCallback(() => {
    intentRef.current = "return-to-composer";
  }, []);

  const preserveFocusDestination = useCallback(() => {
    intentRef.current = "preserve-destination";
  }, []);

  const classifyOutsideInteraction = useCallback(
    (target: EventTarget | null) => {
      if (target instanceof Node && triggerRef.current?.contains(target)) {
        return;
      }
      intentRef.current = isFocusDestination(target)
        ? "preserve-destination"
        : "return-to-composer";
    },
    [triggerRef],
  );

  const handleCloseAutoFocus = useCallback(
    (event: CloseAutoFocusEvent) => {
      event.preventDefault();
      const intent = intentRef.current;
      intentRef.current = "return-to-composer";
      if (intent === "return-to-composer") {
        onRequestComposerFocus?.();
      }
    },
    [onRequestComposerFocus],
  );

  return {
    beginOpenCycle,
    preserveFocusDestination,
    classifyOutsideInteraction,
    handleCloseAutoFocus,
  };
}
