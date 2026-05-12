import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

export function usePersistedState<T>(
  key: string,
  defaults: T,
  validate: (value: unknown, defaults: T) => T,
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => {
    if (typeof window === "undefined") return defaults;
    try {
      const stored = window.localStorage.getItem(key);
      if (!stored) return defaults;
      return validate(JSON.parse(stored), defaults);
    } catch {
      return defaults;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // localStorage may be unavailable
    }
  }, [key, state]);

  return [state, setState];
}
