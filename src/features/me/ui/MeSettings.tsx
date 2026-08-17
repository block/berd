import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { RefreshCw } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";
import { SettingsRow } from "@/shared/ui/settings-row";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Switch } from "@/shared/ui/switch";
import { revealInFileManager } from "@/shared/lib/fileManager";
import {
  createMeFile,
  loadMeFile,
  saveMeFile,
  type MeFileState,
} from "../lib/meFile";
import {
  createTopic,
  listTopics,
  saveTopic,
  type TopicDoc,
} from "../lib/meTopics";
import { getMemoryPrefs, setMemoryPrefs } from "../lib/memoryPrefs";
import { setMemoryMcpEnabled } from "@/shared/api/system";
import {
  approveProposal,
  dismissProposal,
  listProposals,
  type MemoryProposal,
} from "../lib/meProposals";
import { publishMeFile } from "../lib/mePublish";

type LoadState = { status: "loading" } | { status: "error" } | MeFileState;
type ViewMode = "preview" | "edit";

interface DocumentPanelProps {
  contents: string;
  onSave: (next: string) => Promise<void> | void;
  editorLabel: string;
  saveErrorText: string;
  cancelText: string;
  saveText: string;
  previewText: string;
  editText: string;
  unsavedText: string;
  refreshLabel?: string;
  onRefresh?: () => void;
  /** Quiet footer content sharing the action row's left side, e.g. the file's location. */
  footer?: ReactNode;
}

/**
 * One contained document with Preview/Edit modes — the treatment every
 * memory doc gets, spine and topics alike.
 */
function DocumentPanel({
  contents,
  onSave,
  editorLabel,
  saveErrorText,
  cancelText,
  saveText,
  previewText,
  editText,
  unsavedText,
  refreshLabel,
  onRefresh,
  footer,
}: DocumentPanelProps) {
  const [mode, setMode] = useState<ViewMode>("preview");
  const [draft, setDraft] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  const isEditing = mode === "edit";
  const hasUnsavedChanges = draft !== null && draft !== contents;

  const handleModeChange = (next: string) => {
    if (next === "edit" && draft === null) {
      setDraft(contents);
      setSaveFailed(false);
    }
    setMode(next === "edit" ? "edit" : "preview");
  };

  const handleCancel = () => {
    setDraft(null);
    setSaveFailed(false);
    setMode("preview");
  };

  const handleSave = async () => {
    if (draft === null) return;
    try {
      await onSave(draft);
      setDraft(null);
      setSaveFailed(false);
      setMode("preview");
    } catch {
      setSaveFailed(true);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Tabs value={mode} onValueChange={handleModeChange}>
          <TabsList variant="buttons">
            <TabsTrigger value="preview" variant="buttons">
              {previewText}
            </TabsTrigger>
            <TabsTrigger value="edit" variant="buttons">
              {editText}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {isEditing ? (
        <Textarea
          value={draft ?? contents}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={editorLabel}
          spellCheck={false}
          variant="code"
          className="min-h-[360px] resize-y bg-background"
        />
      ) : (
        <article className="prose prose-sm dark:prose-invert max-w-none rounded-md border bg-muted/50 px-4 py-4 text-xs prose-p:text-xs prose-li:text-xs prose-headings:font-medium prose-h1:text-sm prose-h2:text-xs prose-h2:uppercase prose-h2:tracking-wide prose-h3:text-xs prose-em:text-muted-foreground">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{contents}</ReactMarkdown>
        </article>
      )}

      {saveFailed && (
        <p className="text-sm text-destructive" role="alert">
          {saveErrorText}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {hasUnsavedChanges && !isEditing ? unsavedText : footer}
        </p>
        <div className="flex items-center gap-2">
          {isEditing || hasUnsavedChanges ? (
            <>
              <Button onClick={handleCancel} size="xs" variant="ghost">
                {cancelText}
              </Button>
              <Button
                onClick={() => void handleSave()}
                size="xs"
                variant="primary"
                disabled={!hasUnsavedChanges}
              >
                {saveText}
              </Button>
            </>
          ) : (
            onRefresh && (
              <Button
                onClick={onRefresh}
                size="xs"
                variant="ghost"
                aria-label={refreshLabel}
              >
                <RefreshCw className="size-3.5" />
                {refreshLabel}
              </Button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

export function MeSettings() {
  const { t } = useTranslation("settings");
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [topics, setTopics] = useState<TopicDoc[]>([]);
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  const [creatingTopic, setCreatingTopic] = useState(false);
  const [newTopicName, setNewTopicName] = useState("");
  const [topicError, setTopicError] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState(
    () => getMemoryPrefs().enabled,
  );
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);

  const refresh = useCallback(async () => {
    try {
      setState(await loadMeFile());
    } catch {
      setState({ status: "error" });
    }
    try {
      setTopics(await listTopics());
    } catch {
      // Topic listing is additive; a failure leaves the section empty
      // rather than breaking the page.
      setTopics([]);
    }
    setProposals(await listProposals());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async () => {
    try {
      setState(await createMeFile());
    } catch {
      setState({ status: "error" });
    }
  };

  const handleApproveProposal = async (proposal: MemoryProposal) => {
    try {
      await approveProposal(proposal);
    } catch {
      // The proposal stays in the queue; refresh below re-reads reality.
    }
    await refresh();
  };

  const handleDismissProposal = async (proposal: MemoryProposal) => {
    try {
      await dismissProposal(proposal);
    } catch {
      // Same: never let a queue hiccup break the page.
    }
    await refresh();
  };

  const handleMemoryToggle = (enabled: boolean) => {
    setMemoryPrefs({ enabled });
    setMemoryEnabled(enabled);
    // Re-publish under the new setting: off removes our managed block from
    // the agent files other tools read; on restores it. Best-effort — the
    // toggle itself never fails.
    const contents = state.status === "present" ? state.contents : "";
    void publishMeFile(contents).catch(() => {});
    // And (de)register the memory MCP server for future goose sessions:
    // off means the memory tools don't exist in the session at all.
    void setMemoryMcpEnabled(enabled).catch(() => {});
  };

  const handleReveal = () => {
    if (state.status !== "present") return;
    void revealInFileManager(state.path).catch(() => {
      // Best-effort convenience; the path is shown right next to the link.
    });
  };

  const handleCreateTopic = async () => {
    const name = newTopicName.trim();
    if (!name) return;
    setTopicError(false);
    try {
      const topic = await createTopic(name);
      setCreatingTopic(false);
      setNewTopicName("");
      await refresh();
      setOpenTopic(topic.path);
    } catch {
      // Most likely cause: a topic with this file name already exists.
      setTopicError(true);
    }
  };

  const docStrings = {
    editorLabel: t("me.editorLabel"),
    saveErrorText: t("me.saveError"),
    cancelText: t("me.cancel"),
    saveText: t("me.save"),
    previewText: t("me.previewTab"),
    editText: t("me.editTab"),
    unsavedText: t("me.unsavedChanges"),
  };

  return (
    <SettingsPage title={t("me.title")}>
      <SettingsSections>
        <SettingsSection
          className={memoryEnabled ? "border-b border-border" : undefined}
        >
          <SettingsRow
            label={t("me.toggle.label")}
            description={t("me.toggle.description")}
          >
            <Switch
              checked={memoryEnabled}
              onCheckedChange={handleMemoryToggle}
              aria-label={t("me.toggle.label")}
            />
          </SettingsRow>
        </SettingsSection>

        {!memoryEnabled && (
          <Alert>
            <AlertTitle>{t("me.offBanner.title")}</AlertTitle>
            <AlertDescription>
              <p>
                {t("me.offBanner.description")}{" "}
                {state.status === "present" && (
                  <button
                    type="button"
                    onClick={handleReveal}
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    {t("me.offBanner.link")}
                  </button>
                )}
              </p>
            </AlertDescription>
          </Alert>
        )}

        {memoryEnabled && proposals.length > 0 && (
          <SettingsSection title={t("me.proposals.title")}>
            <p className="text-xs text-muted-foreground">
              {t("me.proposals.description")}
            </p>
            <div className="mt-3 space-y-2">
              {proposals.map((proposal) => (
                <div
                  key={proposal.id}
                  className="flex items-start justify-between gap-4 rounded-md border bg-muted/50 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-xs text-foreground">
                      {proposal.content}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {proposal.topic
                        ? t("me.proposals.topicLabel", {
                            topic: proposal.topic,
                          })
                        : t("me.proposals.generalLabel")}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void handleDismissProposal(proposal)}
                    >
                      {t("me.proposals.dismiss")}
                    </Button>
                    <Button
                      size="xs"
                      variant="primary"
                      onClick={() => void handleApproveProposal(proposal)}
                    >
                      {t("me.proposals.approve")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </SettingsSection>
        )}

        {memoryEnabled && (
          <>
            <SettingsSection title={t("me.spineTitle")}>
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  {t("me.description")} {t("me.ownership")}
                </p>

                {state.status === "error" && (
                  <p className="text-sm text-destructive">
                    {t("me.loadError")}
                  </p>
                )}

                {state.status === "missing" && (
                  <div className="space-y-2">
                    <Button onClick={() => void handleCreate()} size="sm">
                      {t("me.create")}
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      {t("me.emptyHint")}
                    </p>
                  </div>
                )}

                {state.status === "present" && (
                  <DocumentPanel
                    contents={state.contents}
                    onSave={async (next) => {
                      await saveMeFile(state.path, next);
                      await refresh();
                    }}
                    refreshLabel={t("me.refresh")}
                    onRefresh={() => void refresh()}
                    footer={
                      <>
                        {t("me.path", { path: state.displayPath })}{" "}
                        <button
                          type="button"
                          onClick={handleReveal}
                          className="underline underline-offset-2 hover:text-foreground"
                        >
                          {t("me.reveal")}
                        </button>
                      </>
                    }
                    {...docStrings}
                  />
                )}
              </div>
            </SettingsSection>

            <SettingsSection title={t("me.topicsTitle")}>
              {topics.length === 0 && !creatingTopic && (
                <p className="py-3 text-sm text-muted-foreground">
                  {t("me.noTopics")}
                </p>
              )}

              {topics.map((topic) => (
                <SettingsRow
                  key={topic.path}
                  label={topic.label}
                  description={topic.description ?? topic.fileName}
                  action={
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setOpenTopic(
                          openTopic === topic.path ? null : topic.path,
                        )
                      }
                    >
                      {openTopic === topic.path
                        ? t("me.closeTopic")
                        : t("me.openTopic")}
                    </Button>
                  }
                  details={
                    openTopic === topic.path ? (
                      <DocumentPanel
                        contents={topic.contents}
                        onSave={async (next) => {
                          await saveTopic(topic.path, next);
                          await refresh();
                        }}
                        {...docStrings}
                      />
                    ) : undefined
                  }
                />
              ))}

              {creatingTopic ? (
                <SettingsRow
                  label={t("me.newTopicLabel")}
                  description={t("me.newTopicDescription")}
                  action={
                    <div className="flex items-center gap-2">
                      <Input
                        value={newTopicName}
                        onChange={(event) =>
                          setNewTopicName(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void handleCreateTopic();
                          if (event.key === "Escape") {
                            setCreatingTopic(false);
                            setNewTopicName("");
                            setTopicError(false);
                          }
                        }}
                        placeholder={t("me.newTopicPlaceholder")}
                        aria-label={t("me.newTopicLabel")}
                        className="h-8 w-44"
                        autoFocus
                      />
                      <Button
                        size="sm"
                        onClick={() => void handleCreateTopic()}
                        disabled={!newTopicName.trim()}
                      >
                        {t("me.create")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setCreatingTopic(false);
                          setNewTopicName("");
                          setTopicError(false);
                        }}
                      >
                        {t("me.cancel")}
                      </Button>
                    </div>
                  }
                  details={
                    topicError ? (
                      <p className="text-sm text-destructive" role="alert">
                        {t("me.newTopicError")}
                      </p>
                    ) : undefined
                  }
                />
              ) : (
                <SettingsRow
                  label={t("me.addTopicLabel")}
                  description={t("me.topicsHint")}
                  action={
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setCreatingTopic(true)}
                    >
                      {t("me.addTopic")}
                    </Button>
                  }
                />
              )}
            </SettingsSection>
          </>
        )}
      </SettingsSections>
    </SettingsPage>
  );
}
