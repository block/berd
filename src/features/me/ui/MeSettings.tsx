import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, RefreshCw } from "lucide-react";
import { cn } from "@/shared/lib/cn";
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
import { Switch } from "@/shared/ui/switch";
import { StorePathLink } from "./StorePathLink";
import {
  createMeFile,
  loadMeFile,
  ME_FILE_TEMPLATE,
  saveMeFile,
  type MeFileState,
} from "../lib/meFile";
import {
  createTopic,
  listTopics,
  saveTopic,
  type TopicDoc,
} from "../lib/meTopics";
import { useMemoryProposals } from "../hooks/useMemoryProposals";
import type { MemoryProposal } from "../lib/meProposals";
import { CredentialMemoryError } from "../lib/memoryCredentialGuard";
import { readMemoryPolicy, writeMemoryPolicy } from "../lib/memoryPolicyFile";
import { publishMeFile } from "../lib/mePublish";
import {
  isMemoryContentApproved,
  writeMemoryAgentsProjection,
} from "@/shared/api/system";

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
            {/* h-7 matches the xs Button height used by every other action
                on this page (Add topic, View, Refresh). */}
            <TabsTrigger value="preview" variant="buttons" className="h-7">
              {previewText}
            </TabsTrigger>
            <TabsTrigger value="edit" variant="buttons" className="h-7">
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
        <article className="prose prose-sm dark:prose-invert max-w-none rounded-md border bg-muted/50 px-4 py-4 text-xs prose-p:text-xs prose-p:my-4 prose-li:text-xs prose-ul:pl-4 prose-headings:font-medium prose-headings:mb-1 prose-h1:text-sm prose-h2:text-xs prose-h2:mt-6 prose-h3:text-xs prose-h3:mt-5 prose-em:text-muted-foreground prose-li:marker:text-[color:inherit] [&_h1+p]:mt-1 [&_h2+p]:mt-1 [&_h3+p]:mt-1 [&_h1+ul]:mt-1 [&_h2+ul]:mt-1 [&_h3+ul]:mt-1">
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
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const { proposals, approve, decline } = useMemoryProposals();
  const [proposalDrafts, setProposalDrafts] = useState<Record<string, string>>(
    {},
  );
  const [proposalError, setProposalError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const loaded = await loadMeFile();
      setState(loaded);
      if (
        loaded.status === "present" &&
        !(await isMemoryContentApproved(loaded.path, loaded.contents))
      ) {
        // A same-user process may have bypassed Berd's approval boundary.
        // Remove the stale projection until the person explicitly saves.
        await writeMemoryAgentsProjection(null);
      }
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
    // policy.json is the one durable owner. Missing policy defaults on.
    const policy = await readMemoryPolicy();
    setMemoryEnabled(policy?.enabled ?? true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Memory is on by default, so most people arrive here without ever having
  // touched the switch. Seed the store on first visit for the same reason the
  // toggle does: the file existing is the normal state, and asking for a
  // decision the rest of the system makes silently is the odd one.
  useEffect(() => {
    if (!memoryEnabled || state.status !== "missing") return;
    void createMeFile()
      .then(setState)
      .catch(() => {
        // Best-effort: a failed seed leaves the create button in place.
      });
  }, [memoryEnabled, state.status]);

  const handleApproveProposal = async (proposal: MemoryProposal) => {
    setProposalError(null);
    try {
      await approve(
        proposal,
        proposalDrafts[proposal.id] ?? proposal.content,
        proposal.topic,
      );
      setProposalDrafts((current) => {
        const next = { ...current };
        delete next[proposal.id];
        return next;
      });
      await refresh();
    } catch (error) {
      setProposalError(
        error instanceof CredentialMemoryError
          ? t("me.proposals.credentialError")
          : t("me.proposals.approveError"),
      );
    }
  };

  const handleDeclineProposal = async (proposal: MemoryProposal) => {
    await decline(proposal);
  };

  const handleMemoryToggle = async (enabled: boolean) => {
    // policy.json is the source of truth. Don't present a toggle state the
    // store failed to persist.
    if (!(await writeMemoryPolicy(enabled))) {
      const policy = await readMemoryPolicy();
      setMemoryEnabled(policy?.enabled ?? true);
      return;
    }
    setMemoryEnabled(enabled);

    let contents = state.status === "present" ? state.contents : "";
    if (enabled && state.status !== "present") {
      try {
        const created = await createMeFile();
        setState(created);
        if (created.status === "present") contents = created.contents;
      } catch {
        // A failed seed leaves the create button in place.
      }
    }
    // Off removes the managed projection; on restores it.
    await publishMeFile(contents);
  };

  // The store folder, derived from the canonical spine path.
  const storeFolder =
    state.status === "present"
      ? {
          path: state.path.replace(/\/[^/]+$/, ""),
          display: state.displayPath.replace(/\/[^/]+$/, ""),
        }
      : null;

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
        <SettingsSection>
          <SettingsRow
            label={t("me.toggle.label")}
            description={
              <>
                {t("me.toggle.description")}
                <span className="mt-2 block">
                  {storeFolder && (
                    <>
                      {t("me.livesIn")}{" "}
                      <StorePathLink
                        path={storeFolder.path}
                        label={storeFolder.display}
                      />
                      .{" "}
                    </>
                  )}
                  {t("me.projectionHint")}
                </span>
              </>
            }
          >
            <Switch
              checked={memoryEnabled}
              onCheckedChange={handleMemoryToggle}
              aria-label={t("me.toggle.label")}
            />
          </SettingsRow>
        </SettingsSection>

        {!memoryEnabled && (
          <div className="rounded-md border bg-muted/50 px-4 py-3">
            <p className="text-xs text-muted-foreground">
              {t("me.offBanner.description")}
            </p>
          </div>
        )}

        {memoryEnabled && proposals.length > 0 && (
          <SettingsSection
            title={t("me.proposals.title")}
            className="border-b border-border pb-11"
          >
            <div className="space-y-3 pb-1">
              <p className="text-xs text-muted-foreground">
                {t("me.proposals.description")}
              </p>
              {proposalError && (
                <p className="text-sm text-destructive" role="alert">
                  {proposalError}
                </p>
              )}
              <div className="space-y-3">
                {proposals.map((proposal) => (
                  <div
                    key={proposal.id}
                    className="space-y-3 rounded-md border bg-muted/50 px-4 py-3"
                  >
                    <Textarea
                      value={proposalDrafts[proposal.id] ?? proposal.content}
                      onChange={(event) =>
                        setProposalDrafts((current) => ({
                          ...current,
                          [proposal.id]: event.target.value,
                        }))
                      }
                      aria-label={t("me.proposals.editorLabel")}
                      className="min-h-20 resize-y bg-background text-xs"
                    />
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs text-muted-foreground">
                        {proposal.topic
                          ? t("me.proposals.topicLabel", {
                              topic: proposal.topic,
                            })
                          : t("me.proposals.generalLabel")}
                      </p>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          destructive
                          onClick={() => void handleDeclineProposal(proposal)}
                        >
                          {t("me.proposals.dismiss")}
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={
                            !(
                              proposalDrafts[proposal.id] ?? proposal.content
                            ).trim()
                          }
                          onClick={() => void handleApproveProposal(proposal)}
                        >
                          {t("me.proposals.approve")}
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </SettingsSection>
        )}

        {memoryEnabled && (
          <>
            <SettingsSection title={t("me.spineTitle")}>
              {/* space-y-11 matches the 44px rhythm between settings sections,
                  giving the document block clear separation from the
                  About you description. */}
              <div className="space-y-11">
                <p className="text-xs text-muted-foreground">
                  {t("me.description")}
                </p>

                {state.status === "error" && (
                  <p className="text-sm text-destructive">
                    {t("me.loadError")}
                  </p>
                )}

                {/* No file yet just means the starter template hasn't been
                    written to disk — show it as the document, and the first
                    save creates the file. */}
                {state.status === "missing" && (
                  <DocumentPanel
                    contents={ME_FILE_TEMPLATE}
                    // One write, one publish: seeding with createMeFile first
                    // would race its template publication against this save's
                    // publication of the user's content.
                    onSave={async (next) => {
                      await saveMeFile(state.path, next);
                      await refresh();
                    }}
                    refreshLabel={t("me.refresh")}
                    onRefresh={() => void refresh()}
                    {...docStrings}
                  />
                )}

                {state.status === "present" && (
                  <DocumentPanel
                    // A file emptied by hand is the same story as no file
                    // yet: show the starter template rather than a blank
                    // card, and the next save writes it for real.
                    contents={
                      state.contents.trim() ? state.contents : ME_FILE_TEMPLATE
                    }
                    onSave={async (next) => {
                      await saveMeFile(state.path, next);
                      await refresh();
                    }}
                    refreshLabel={t("me.refresh")}
                    onRefresh={() => void refresh()}
                    {...docStrings}
                  />
                )}
              </div>
            </SettingsSection>

            <SettingsSection title={t("me.topicsTitle")}>
              <SettingsRow
                label={t("me.addTopic")}
                description={t("me.topicsHint")}
                className="border-b border-border"
                action={
                  !creatingTopic ? (
                    <Button
                      size="xs"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => setCreatingTopic(true)}
                    >
                      {t("me.addTopicAction")}
                    </Button>
                  ) : undefined
                }
              />

              {topics.length === 0 && !creatingTopic && (
                <p className="pt-6 pb-3 text-xs text-muted-foreground">
                  {t("me.noTopics")}
                </p>
              )}

              {topics.map((topic) => (
                <SettingsRow
                  key={topic.path}
                  label={topic.label}
                  description={topic.description ?? topic.fileName}
                  // The whole row toggles the topic open; the chevron is the
                  // keyboard-accessible control and stops propagation so the
                  // row handler doesn't double-toggle.
                  className="cursor-pointer"
                  onClick={() =>
                    setOpenTopic(openTopic === topic.path ? null : topic.path)
                  }
                  action={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-expanded={openTopic === topic.path}
                      aria-label={
                        openTopic === topic.path
                          ? t("me.closeTopic")
                          : t("me.openTopic")
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenTopic(
                          openTopic === topic.path ? null : topic.path,
                        );
                      }}
                    >
                      <ChevronDown
                        aria-hidden="true"
                        className={cn(openTopic === topic.path && "rotate-180")}
                      />
                    </Button>
                  }
                  details={
                    openTopic === topic.path ? (
                      // Interacting with the open document must not collapse
                      // the row.
                      // biome-ignore lint/a11y/noStaticElementInteractions: propagation guard, not an interactive control
                      // biome-ignore lint/a11y/useKeyWithClickEvents: propagation guard only; keyboard events don't bubble a click
                      <div onClick={(event) => event.stopPropagation()}>
                        <DocumentPanel
                          contents={topic.contents}
                          onSave={async (next) => {
                            await saveTopic(topic.path, next, topic.label);
                            await refresh();
                          }}
                          {...docStrings}
                        />
                      </div>
                    ) : undefined
                  }
                />
              ))}

              {creatingTopic && (
                <SettingsRow
                  label={
                    <span className="text-xs text-muted-foreground">
                      {t("me.newTopicDescription")}
                    </span>
                  }
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
              )}
            </SettingsSection>
          </>
        )}
      </SettingsSections>
    </SettingsPage>
  );
}
