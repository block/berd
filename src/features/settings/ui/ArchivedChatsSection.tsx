import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import {
  listArchivedProjects,
  listProjects,
  type ProjectInfo,
} from "@/features/projects/api/projects";
import { useLocaleFormatting } from "@/shared/i18n";

export function ArchivedChatsSection() {
  const { t } = useTranslation(["settings", "common"]);
  const { formatRelativeTimeToNow } = useLocaleFormatting();
  const [archivedChats, setArchivedChats] = useState<ChatSession[]>([]);
  const [loadingArchivedChats, setLoadingArchivedChats] = useState(true);
  const [projectsById, setProjectsById] = useState<Map<string, ProjectInfo>>(
    new Map(),
  );

  useEffect(() => {
    setArchivedChats(useChatSessionStore.getState().getArchivedSessions());
    setLoadingArchivedChats(false);
  }, []);

  useEffect(() => {
    Promise.all([listProjects(), listArchivedProjects()])
      .then(([active, archived]) => {
        const next = new Map<string, ProjectInfo>();
        for (const project of [...active, ...archived]) {
          next.set(project.id, project);
        }
        setProjectsById(next);
      })
      .catch(() => setProjectsById(new Map()));
  }, []);

  async function handleRestoreChat(id: string) {
    try {
      await useChatSessionStore.getState().unarchiveSession(id);
    } catch (err) {
      console.error("Failed to unarchive session in backend:", err);
      return;
    }
    setArchivedChats((prev) => prev.filter((session) => session.id !== id));
  }

  function describeChat(session: ChatSession): string {
    const date = formatRelativeTimeToNow(session.updatedAt);
    if (!session.projectId) {
      return date;
    }
    const project = projectsById.get(session.projectId);
    return project ? `${date} · ${project.name}` : date;
  }

  return (
    <div className="space-y-3">
      <h4 className="text-base text-foreground">{t("chats.sectionTitle")}</h4>
      {!loadingArchivedChats && archivedChats.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("chats.empty")}</p>
      ) : null}
      {archivedChats.map((session) => (
        <div
          key={session.id}
          className="flex items-center justify-between gap-3 rounded-sm bg-card px-3 py-2 text-card-foreground"
        >
          <div className="min-w-0">
            <div className="truncate text-sm">
              {getDisplaySessionTitle(
                session.title,
                t("common:session.defaultTitle"),
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {describeChat(session)}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => handleRestoreChat(session.id)}
            className="flex-shrink-0"
          >
            {t("common:actions.restore")}
          </Button>
        </div>
      ))}
    </div>
  );
}
