import { useCallback, useEffect, useRef, useState } from "react";

let activeClose: (() => void) | null = null;

export function useExclusiveMenu() {
  const [open, setOpenState] = useState(false);
  const closeRef = useRef<() => void>(() => {});
  closeRef.current = () => setOpenState(false);

  const onOpenChange = useCallback((next: boolean) => {
    if (next) {
      if (activeClose && activeClose !== closeRef.current) {
        activeClose();
      }
      activeClose = closeRef.current;
    } else if (activeClose === closeRef.current) {
      activeClose = null;
    }
    setOpenState(next);
  }, []);

  useEffect(() => {
    return () => {
      if (activeClose === closeRef.current) {
        activeClose = null;
      }
    };
  }, []);

  return [open, onOpenChange] as const;
}
