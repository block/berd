import { isMemorySupported } from "@/features/me/lib/memoryAvailability";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, RefreshCw } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import {
  importMemoryMarkdown,
  exportMemoryMarkdown,
} from "@/shared/api/system";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
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
import { UnsafeMemoryTextError } from "../lib/memoryTextContract";
import { readMemoryPolicy, writeMemoryPolicy } from "../lib/memoryPolicyFile";

import {
  memoryStoreErrorKind,
  memoryStoreErrorCopy,
  type MemoryStoreErrorKind,
} from "../lib/memoryStoreError";

type LoadState =
  | { status: "loading" }
  | { status: "error"; kind: MemoryStoreErrorKind }
  | MeFileState;
type ViewMode = "preview" | "edit";

interface DocumentPanelProps {
  contents: string;
  path?: string;
  onSave: (next: string) => Promise<void> | void;
  editorLabel: string;
  saveErrorText: string;
  unsafeUnicodeErrorText: string;
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
export function DocumentPanel({
  contents,
  path,
  onSave,
  editorLabel,
  saveErrorText,
  unsafeUnicodeErrorText,
  cancelText,
  saveText,
  previewText,
  editText,
  unsavedText,
  refreshLabel,
  onRefresh,
  footer,
}: DocumentPanelProps) {
  const { t } = useTranslation("settings");
  const [busy, setBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [transferMessage, setTransferMessage] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("preview");
  const [draft, setDraft] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const isEditing = mode === "edit";
  const hasUnsavedChanges = draft !== null && draft !== contents;

  const handleModeChange = (next: string) => {
    if (next === "edit" && draft === null) {
      setDraft(contents);
      setSaveError(null);
    }
    setMode(next === "edit" ? "edit" : "preview");
  };

  const handleCancel = () => {
    setDraft(null);
    setSaveError(null);
    setTransferMessage(null);
    setMode("preview");
  };

  const handleSave = async () => {
    if (draft === null || busy) return;
    setBusy(true);
    try {
      await onSave(draft);
      setDraft(null);
      setTransferMessage(null);
      setSaveError(null);
      setMode("preview");
    } catch (error) {
      setSaveError(
        error instanceof UnsafeMemoryTextError
          ? unsafeUnicodeErrorText
          : saveErrorText,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      const imported = await importMemoryMarkdown();
      if (imported === null) return;
      setDraft(imported);
      setMode("edit");
      setTransferMessage(
        t("me.importReview", {
          defaultValue:
            "Imported as an unsaved draft. Review it, then Save to replace this document.",
        }),
      );
    } catch {
      setSaveError(
        t("me.importError", {
          defaultValue:
            "Couldn't import Markdown. Your document has not changed.",
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    if (!path) return;
    setBusy(true);
    setSaveError(null);
    try {
      const exported = await exportMemoryMarkdown(path);
      if (exported !== null) {
        setTransferMessage(
          t("me.exportComplete", {
            defaultValue: "Saved a plaintext Markdown export.",
          }),
        );
      }
    } catch {
      setSaveError(
        t("me.exportError", {
          defaultValue:
            "Couldn't export Markdown. Your document has not changed.",
        }),
      );
    } finally {
      setBusy(false);
      setExportOpen(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          size="xs"
          variant="ghost"
          disabled={busy || hasUnsavedChanges}
          onClick={() => void handleImport()}
        >
          {t("me.importMarkdown", { defaultValue: "Import Markdown" })}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy || hasUnsavedChanges || !path}
          onClick={() => setExportOpen(true)}
        >
          {t("me.exportMarkdown", { defaultValue: "Export Markdown" })}
        </Button>
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
          disabled={busy}
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

      {transferMessage && (
        <p className="text-xs text-muted-foreground" role="status">
          {transferMessage}
        </p>
      )}

      {saveError && (
        <p className="text-sm text-destructive" role="alert">
          {saveError}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {hasUnsavedChanges && !isEditing ? unsavedText : footer}
        </p>
        <div className="flex items-center gap-2">
          {isEditing || hasUnsavedChanges ? (
            <>
              <Button
                onClick={handleCancel}
                disabled={busy}
                size="xs"
                variant="ghost"
              >
                {cancelText}
              </Button>
              <Button
                onClick={() => void handleSave()}
                size="xs"
                variant="primary"
                disabled={busy || !hasUnsavedChanges}
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
      <ConfirmDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        title={t("me.exportTitle", {
          defaultValue: "Export plaintext Markdown?",
        })}
        description={t("me.exportWarning", {
          defaultValue:
            "The exported file will not be encrypted. Anyone with access to it can read your memory. Choose a safe location and share it carefully.",
        })}
        cancelLabel={cancelText}
        confirmLabel={t("me.exportMarkdown", {
          defaultValue: "Export Markdown",
        })}
        destructive={false}
        isLoading={busy}
        onConfirm={handleExport}
      />
    </div>
  );
}

export function MeSettings() {
  const { t } = useTranslation("settings");
  if (!isMemorySupported()) {
    return (
      <SettingsPage title={t("nav.me")}>
        <p>{t("me.unsupported")}</p>
      </SettingsPage>
    );
  }
  return <SupportedMeSettings />;
}

function SupportedMeSettings() {
  const { t } = useTranslation("settings");
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [topics, setTopics] = useState<TopicDoc[]>([]);
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  const [creatingTopic, setCreatingTopic] = useState(false);
  const [newTopicName, setNewTopicName] = useState("");
  const [topicsLoadError, setTopicsLoadError] =
    useState<MemoryStoreErrorKind | null>(null);
  const [policyError, setPolicyError] = useState(false);
  const [topicError, setTopicError] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState(false);
  const {
    proposals,
    approve,
    decline,
    error: proposalsLoadError,
    refresh: refreshProposals,
  } = useMemoryProposals();
  const [proposalDrafts, setProposalDrafts] = useState<Record<string, string>>(
    {},
  );
  const [proposalError, setProposalError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await loadMeFile());
    } catch (error) {
      setState({ status: "error", kind: memoryStoreErrorKind(error) });
    }
    try {
      setTopics(await listTopics());
      setTopicsLoadError(null);
    } catch (error) {
      setTopicsLoadError(memoryStoreErrorKind(error));
    }
    // policy.json is the one durable owner. Missing or malformed policy is off.
    const policy = await readMemoryPolicy();
    setMemoryEnabled(policy?.enabled === true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
          : error instanceof UnsafeMemoryTextError
            ? t("me.proposals.unsafeUnicodeError")
            : t("me.proposals.approveError"),
      );
    }
  };

  const handleDeclineProposal = async (proposal: MemoryProposal) => {
    setProposalError(null);
    try {
      await decline(proposal);
    } catch {
      setProposalError(
        t("me.proposals.declineError", {
          defaultValue: "Couldn't decline this memory. Try again.",
        }),
      );
    }
  };

  const retryInitialization = async () => {
    try {
      await createMeFile();
      await refresh();
      await refreshProposals();
    } catch (error) {
      setState({
        status: "error",
        kind: memoryStoreErrorKind(error, "initialization"),
      });
    }
  };

  const handleMemoryToggle = async (enabled: boolean) => {
    // policy.json is the source of truth. Don't present a toggle state the
    // store failed to persist.
    setPolicyError(false);
    if (!(await writeMemoryPolicy(enabled))) {
      setPolicyError(true);
      const policy = await readMemoryPolicy();
      setMemoryEnabled(policy?.enabled === true);
      return;
    }
    setMemoryEnabled(enabled);

    if (enabled && state.status === "missing") {
      try {
        setState(await createMeFile());
      } catch (error) {
        setState({
          status: "error",
          kind: memoryStoreErrorKind(error, "initialization"),
        });
      }
    }
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

  const storeErrorKind =
    state.status === "error"
      ? state.kind
      : (topicsLoadError ?? proposalsLoadError);

  const docStrings = {
    editorLabel: t("me.editorLabel"),
    saveErrorText: t("me.saveError"),
    unsafeUnicodeErrorText: t("me.unsafeUnicodeError"),
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
                      {t("me.encryptedLivesIn", {
                        defaultValue:
                          "Memory is stored in encrypted local files at",
                      })}{" "}
                      <StorePathLink
                        path={storeFolder.path}
                        label={storeFolder.display}
                      />
                      .{" "}
                    </>
                  )}
                </span>
                <span className="mt-2 block">
                  {t("me.storageBoundary", {
                    defaultValue:
                      "Edit memory here. Markdown exports are plaintext. Memory is not a secrets vault; encryption does not guarantee protection from other processes running as you.",
                  })}
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

        {storeErrorKind && (
          <div className="space-y-2">
            <p className="text-sm text-destructive" role="alert">
              {t(`me.storeErrors.${storeErrorKind}`, {
                defaultValue: memoryStoreErrorCopy[storeErrorKind],
              })}
            </p>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                void refresh();
                void refreshProposals();
              }}
            >
              {t("me.refresh")}
            </Button>
            {(storeErrorKind === "initialization" ||
              storeErrorKind === "keyUnavailable") && (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void retryInitialization()}
              >
                {t("me.retryInitialization")}
              </Button>
            )}
          </div>
        )}
        {policyError && (
          <p className="text-sm text-destructive" role="alert">
            {t("me.policyError", {
              defaultValue:
                "Couldn't change the memory setting. The saved setting is unchanged.",
            })}
          </p>
        )}

        {!memoryEnabled && (
          <div className="rounded-md border bg-muted/50 px-4 py-3">
            <p className="text-xs text-muted-foreground">
              {t("me.offBanner.description")}
            </p>
          </div>
        )}

        {proposals.length > 0 && !proposalsLoadError && (
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
                      await saveMeFile(state.path, next, true);
                      await refresh();
                    }}
                    refreshLabel={t("me.refresh")}
                    onRefresh={() => void refresh()}
                    {...docStrings}
                  />
                )}

                {state.status === "present" && (
                  <DocumentPanel
                    path={state.path}
                    contents={state.contents}
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
                      disabled={
                        Boolean(topicsLoadError) || state.status === "error"
                      }
                      onClick={() => setCreatingTopic(true)}
                    >
                      {t("me.addTopicAction")}
                    </Button>
                  ) : undefined
                }
              />

              {topics.length === 0 && !creatingTopic && !topicsLoadError && (
                <p className="pt-6 pb-3 text-xs text-muted-foreground">
                  {t("me.noTopics")}
                </p>
              )}

              {!topicsLoadError &&
                topics.map((topic) => (
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
                          className={cn(
                            openTopic === topic.path && "rotate-180",
                          )}
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
                            path={topic.path}
                            contents={topic.contents}
                            onSave={async (next) => {
                              await saveTopic(topic.path, next, topic.label);
                              await refresh();
                            }}
                            {...docStrings}
                            editorLabel={t("me.topicEditorLabel", {
                              defaultValue: "Edit memory topic",
                            })}
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
