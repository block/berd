import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";

import { getDisplaySessionTitle } from "@/features/chat/lib/sessionTitle";
import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import {
  getVisibleSessions,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { selectLocalMessageCountsBySession } from "@/features/chat/stores/chatSelectors";
import {
  buildQuickSwitchResults,
  type QuickSwitchResult,
} from "@/features/sessions/lib/sessionQuickSwitch";
import { ActiveChatBerdIndicator } from "@/shared/ui/SessionActivityIndicator";
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/shared/ui/command";

interface SessionQuickSwitcherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectSession: (sessionId: string) => void;
}

function HighlightedTitle({
  title,
  positions,
}: {
  title: string;
  positions: ReadonlySet<number> | null;
}) {
  if (!positions || positions.size === 0) {
    return <span className="truncate">{title}</span>;
  }
  // fzf reports UTF-16 indexes, so track the UTF-16 offset while iterating
  // code points to keep surrogate pairs (e.g. emoji) intact.
  const characters: Array<{ char: string; offset: number }> = [];
  let offset = 0;
  for (const char of title) {
    characters.push({ char, offset });
    offset += char.length;
  }
  // Dim the unmatched characters so matches read at full strength.
  return (
    <span className="truncate text-muted-foreground">
      {characters.map(({ char, offset }) =>
        positions.has(offset) ? (
          <span key={offset} className="font-semibold text-foreground">
            {char}
          </span>
        ) : (
          char
        ),
      )}
    </span>
  );
}

export function SessionQuickSwitcher({
  open,
  onOpenChange,
  onSelectSession,
}: SessionQuickSwitcherProps) {
  const { t } = useTranslation(["sessions", "common"]);
  const [query, setQuery] = useState("");
  const [previousOpen, setPreviousOpen] = useState(open);

  // Clear the query whenever the dialog closes, including closes triggered
  // outside this component (e.g. the Cmd+P toggle in AppShell).
  if (previousOpen !== open) {
    setPreviousOpen(open);
    if (!open) {
      setQuery("");
    }
  }

  const sessions = useChatSessionStore((state) => state.sessions);
  const localMessageCountsBySession = useChatStore(
    useShallow(selectLocalMessageCountsBySession),
  );
  const sessionStateById = useChatStore((state) => state.sessionStateById);

  const results = useMemo<QuickSwitchResult[]>(() => {
    const candidates = getVisibleSessions(sessions, localMessageCountsBySession)
      .filter((session) => !session.archivedAt)
      .map((session) => ({
        id: session.id,
        title: getDisplaySessionTitle(
          session.title,
          t("common:session.defaultTitle"),
        ),
        updatedAt: session.updatedAt,
        lastMessageAt: session.lastMessageAt,
        isRunning: isSessionRunning(
          sessionStateById[session.id]?.chatState ?? "idle",
        ),
      }));
    return buildQuickSwitchResults(candidates, query);
  }, [sessions, localMessageCountsBySession, sessionStateById, query, t]);

  const handleSelect = (sessionId: string) => {
    onOpenChange(false);
    onSelectSession(sessionId);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("sessions:quickSwitch.title")}
      description={t("sessions:quickSwitch.description")}
      commandProps={{
        shouldFilter: false,
        // Denser rows than the shared dialog default.
        className: "[&_[cmdk-item]]:py-2",
      }}
      // Anchor near the top so the input stays put while results shrink/grow.
      positionerClassName="place-items-start justify-items-center pt-[15vh]"
    >
      <CommandInput
        placeholder={t("sessions:quickSwitch.placeholder")}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList className="p-1">
        <CommandEmpty>{t("sessions:quickSwitch.empty")}</CommandEmpty>
        {results.map(({ session, positions }) => (
          <CommandItem
            key={session.id}
            value={session.id}
            onSelect={handleSelect}
          >
            <HighlightedTitle title={session.title} positions={positions} />
            {session.isRunning ? (
              <ActiveChatBerdIndicator className="ml-auto" />
            ) : null}
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
