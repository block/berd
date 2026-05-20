import { useHomeWidgetStore } from "../stores/homeWidgetStore";
import { WidgetCanvas } from "./WidgetCanvas";
import { HomeComposer } from "./HomeComposer";

export interface HomeViewProps {
  sessionId: string | null;
  onActivateSession: (sessionId: string) => void;
  onCreatePersona?: () => void;
  onCreateProject?: (options?: {
    onCreated?: (projectId: string) => void;
  }) => void;
  onOpenAgent?: (agentId: string) => void;
  onSelectSession?: (sessionId: string) => void;
  onOpenAutomation?: (automationId: string) => void;
}

export function HomeView({
  sessionId,
  onActivateSession,
  onCreatePersona,
  onCreateProject,
  onOpenAgent,
  onSelectSession,
  onOpenAutomation,
}: HomeViewProps) {
  const instances = useHomeWidgetStore((state) => state.instances);

  return (
    <div className="relative h-full w-full">
      <WidgetCanvas
        instances={instances}
        onOpenAgent={onOpenAgent}
        onSelectSession={onSelectSession}
        onOpenAutomation={onOpenAutomation}
      />
      {/* Composer pinned at bottom-center, not draggable */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-4">
        <div className="pointer-events-auto w-full max-w-[640px]">
          <HomeComposer
            sessionId={sessionId}
            onActivateSession={onActivateSession}
            onCreatePersona={onCreatePersona}
            onCreateProject={onCreateProject}
          />
        </div>
      </div>
    </div>
  );
}
