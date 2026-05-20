import type { MouseEventHandler } from "react";
import { useCallback } from "react";

export function useWidgetActivationGuard(
  shouldIgnoreParentActivation: (() => boolean) | undefined,
  onActivate: () => void,
): MouseEventHandler<HTMLButtonElement> {
  return useCallback(
    (event) => {
      if (shouldIgnoreParentActivation?.()) {
        event.preventDefault();
        return;
      }

      onActivate();
    },
    [onActivate, shouldIgnoreParentActivation],
  );
}
