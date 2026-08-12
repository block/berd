import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { HomeComposer } from "./HomeComposer";
import type { WorkspaceNameRequest } from "@/features/chat/hooks/useChatSessionController";

function HomeClock() {
  const [time, setTime] = useState(new Date());
  const { getTimeParts } = useLocaleFormatting();

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const { hour, minute, dayPeriod } = getTimeParts(time, {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className="mb-1 flex items-baseline gap-1.5 pl-4">
      <span className="text-6xl font-normal font-display tracking-tight text-foreground">
        {hour}:{minute}
      </span>
      {dayPeriod ? (
        <span className="text-lg font-normal text-muted-foreground">
          {dayPeriod}
        </span>
      ) : null}
    </div>
  );
}

function getGreetingKey(hour: number): "morning" | "afternoon" | "evening" {
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

export interface HomeScreenProps {
  sessionId: string | null;
  onActivateSession: (sessionId: string) => void;
  onCreatePersona?: () => void;
  onWorkspaceNameRequest?: (request: WorkspaceNameRequest) => void;
  onCreateProject?: (options?: {
    onCreated?: (projectId: string) => void;
  }) => void;
}

export function HomeScreen({
  sessionId,
  onActivateSession,
  onCreatePersona,
  onWorkspaceNameRequest,
  onCreateProject,
}: HomeScreenProps) {
  const { t } = useTranslation("home");
  const [hour] = useState(() => new Date().getHours());
  const greeting = t(`greeting.${getGreetingKey(hour)}`);

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="page-transition relative flex min-h-full flex-col items-center justify-center px-6 pb-4">
        <div className="flex w-full max-w-[600px] flex-col antialiased">
          <HomeClock />

          <p className="mb-6 pl-4 text-xl font-normal font-display text-muted-foreground">
            {greeting}
          </p>

          <HomeComposer
            sessionId={sessionId}
            onActivateSession={onActivateSession}
            onCreatePersona={onCreatePersona}
            onCreateProject={onCreateProject}
            onWorkspaceNameRequest={onWorkspaceNameRequest}
          />
        </div>
      </div>
    </div>
  );
}
