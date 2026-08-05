import { createContext, useContext, type ReactNode } from "react";
import type { StarterTaskCompletionState, StarterTaskId } from "./starterTasks";

export interface StarterTasksContextValue {
  completionState: StarterTaskCompletionState;
  visible: boolean;
  docked: boolean;
  starterProjectId: string | null;
  onTaskSelect: (id: StarterTaskId) => void;
  onTaskToggle: (id: StarterTaskId) => void;
  onBackHome: () => void;
  onDismiss: () => void;
}

const StarterTasksContext = createContext<StarterTasksContextValue | null>(
  null,
);

export function StarterTasksProvider({
  value,
  children,
}: {
  value: StarterTasksContextValue;
  children: ReactNode;
}) {
  return (
    <StarterTasksContext.Provider value={value}>
      {children}
    </StarterTasksContext.Provider>
  );
}

export function useStarterTasks(): StarterTasksContextValue | null {
  return useContext(StarterTasksContext);
}
