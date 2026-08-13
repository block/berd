import { createContext, useContext, type ReactNode } from "react";
import type { StarterTaskCompletionState, StarterTaskId } from "./starterTasks";

export interface StarterTasksContextValue {
  completionState: StarterTaskCompletionState;
  enabled: boolean;
  visible: boolean;
  docked: boolean;
  selectedTaskId: StarterTaskId | null;
  starterProjectId: string | null;
  omittedTaskIds: ReadonlySet<StarterTaskId>;
  onTaskSelect: (id: StarterTaskId) => void;
  onTaskToggle: (id: StarterTaskId) => void;
  onBackHome: () => void;
  onCloseSecondary: () => void;
  onDismiss: () => void;
  onRestore: () => void;
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
