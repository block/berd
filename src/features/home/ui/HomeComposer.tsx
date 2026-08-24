import {
  ConversationComposerCapability,
  useConversationComposerBinding,
} from "@/features/chat/capabilities/ConversationComposerCapability";
import type { WorkspaceNameRequest } from "@/features/chat/hooks/useChatSessionController";
import type { HomeScreenProps } from "./HomeScreen";

interface HomeComposerProps {
  sessionId: string | null;
  onActivateSession: (sessionId: string) => void;
  onCreatePersona?: () => void;
  onWorkspaceNameRequest?: (request: WorkspaceNameRequest) => void;
  onCreateProject?: HomeScreenProps["onCreateProject"];
}

export function HomeComposer({
  sessionId,
  onActivateSession,
  onCreatePersona,
  onWorkspaceNameRequest,
  onCreateProject,
}: HomeComposerProps) {
  const binding = useConversationComposerBinding({
    target: { kind: "pendingConversation", sessionId },
    onMessageAccepted: onActivateSession,
    onCreatePersonaRequested: onCreatePersona,
    onWorkspaceNameRequest,
  });

  return (
    <ConversationComposerCapability
      binding={binding}
      renderingPolicy={{
        presentation: {
          surface: "pill",
          providerColumnMode: "visible",
        },
      }}
      onCreateProject={onCreateProject}
    />
  );
}
