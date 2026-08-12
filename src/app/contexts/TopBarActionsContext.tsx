import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface TopBarActionsContextValue {
  actions: ReactNode | null;
  setActions: (actions: ReactNode | null) => void;
}

const TopBarActionsContext = createContext<TopBarActionsContextValue>({
  actions: null,
  setActions: () => {},
});

export function TopBarActionsProvider({ children }: { children: ReactNode }) {
  const [actions, setActionsState] = useState<ReactNode | null>(null);
  const setActions = useCallback(
    (next: ReactNode | null) => setActionsState(next),
    [],
  );
  const value = useMemo(() => ({ actions, setActions }), [actions, setActions]);
  return (
    <TopBarActionsContext.Provider value={value}>
      {children}
    </TopBarActionsContext.Provider>
  );
}

export function useTopBarActions(): ReactNode | null {
  return useContext(TopBarActionsContext).actions;
}

export function useSetTopBarActions(): (actions: ReactNode | null) => void {
  return useContext(TopBarActionsContext).setActions;
}
