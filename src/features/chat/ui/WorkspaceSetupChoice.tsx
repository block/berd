import { useMemo, useState } from "react";
import { ArrowRight, ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import type { ProjectWorkspace } from "@/features/projects/api/projects";
import { getWorkspaceTitle } from "@/features/chat/lib/workspaceAttachments";
import { Button } from "@/shared/ui/button";
import { ComposerActionButton } from "@/shared/ui/composer-action-button";
import { Input } from "@/shared/ui/input";
import { Shimmer } from "@/shared/ui/ai-elements/shimmer";

interface WorkspaceSetupChoiceProps {
  state: "choice" | "naming" | "creating";
  worktreeCount?: number;
  branchCount?: number;
  exactCounts?: boolean;
  workspaces?: ProjectWorkspace[];
  onCancelName: () => void;
  onCreate: () => void;
  onSubmitName: (name: string) => void;
  onSkip: () => void;
}

export function WorkspaceSetupChoice({
  state,
  worktreeCount = 1,
  branchCount = 0,
  exactCounts = true,
  workspaces = [],
  onCancelName,
  onCreate,
  onSubmitName,
  onSkip,
}: WorkspaceSetupChoiceProps) {
  const { t } = useTranslation("chat");
  const [name, setName] = useState("");
  const trimmedName = name.trim();
  const invalidName =
    trimmedName === "." || trimmedName === ".." || /[/\\]/.test(trimmedName);
  const projectFolders = useMemo(
    () =>
      Array.from(
        new Map(
          workspaces
            .filter((workspace) => workspace.startupMode === "worktree")
            .map((workspace) => [
              workspace.repositoryPath ??
                workspace.worktreePath ??
                workspace.path,
              getWorkspaceTitle(workspace),
            ]),
        ).entries(),
      ),
    [workspaces],
  );
  const selectedProjectFolder = projectFolders[0]?.[0] || "";

  const choiceLabel = !exactCounts
    ? t("queue.configureWorkspaces")
    : worktreeCount === 1 && branchCount === 0
      ? t("queue.configureWorktree")
      : t(
          branchCount > 0
            ? "queue.configureWorkspacePlanWithBranch"
            : "queue.configureWorkspacePlan",
          {
            worktreeLabel: t("queue.worktreeCount", { count: worktreeCount }),
            branchLabel: t("queue.branchCount", { count: branchCount }),
          },
        );

  return (
    <motion.div
      layout="size"
      className="overflow-hidden"
      transition={{ layout: { duration: 0.18, ease: "easeOut" } }}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {state === "choice" ? (
          <motion.div
            key="choice"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="flex min-h-10 items-center justify-between gap-3 px-3 py-1.5">
              <span className="text-sm font-semibold text-foreground">
                {choiceLabel}
              </span>
              <div className="flex shrink-0 items-center gap-3">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={onSkip}
                  flush
                >
                  {t("queue.configureWorktreeSkip")}
                </Button>
                <ComposerActionButton
                  type="button"
                  size="icon-sm"
                  onClick={onCreate}
                  aria-label={t("queue.configureWorktreeYes")}
                >
                  <ArrowRight className="size-4" aria-hidden="true" />
                </ComposerActionButton>
              </div>
            </div>
          </motion.div>
        ) : state === "naming" ? (
          <motion.form
            key="naming"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            className="overflow-hidden px-3 pb-3 pt-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (trimmedName && !invalidName) onSubmitName(trimmedName);
            }}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(8rem,0.34fr)_minmax(0,1fr)]">
              <label className="grid gap-1 text-xs font-medium text-foreground">
                {t("queue.projectFolder")}
                <span className="relative">
                  <select
                    aria-label={t("queue.projectFolder")}
                    value={selectedProjectFolder}
                    disabled
                    className="h-9 w-full appearance-none rounded-sm border-0 bg-background px-3 pr-8 text-sm text-foreground outline-none disabled:cursor-default disabled:opacity-100 focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {projectFolders.length ? (
                      projectFolders.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))
                    ) : (
                      <option value="">
                        {t("queue.projectFolderCurrent")}
                      </option>
                    )}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                </span>
              </label>
              <label
                htmlFor="deferred-worktree-name"
                className="grid gap-1 text-xs font-medium text-foreground"
              >
                {t("queue.worktreeName")}
                <Input
                  id="deferred-worktree-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  aria-label={t("queue.worktreeName")}
                  placeholder={t("queue.worktreeNamePlaceholder")}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus
                  className="h-9 border-0 bg-background shadow-none"
                />
              </label>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onCancelName}
              >
                {t("queue.cancelWorktree")}
              </Button>
              <Button
                type="submit"
                size="sm"
                className="min-w-16 rounded-full"
                disabled={!trimmedName || invalidName}
              >
                {t("queue.createWorktree")}
              </Button>
            </div>
          </motion.form>
        ) : (
          <motion.div
            key="creating"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="px-3 py-2.5 text-sm text-foreground">
              <span className="font-semibold">
                {t("queue.preparingWorkspaceTitle")}
              </span>{" "}
              <Shimmer as="span" tone="current">
                {t("queue.preparingWorkspaceBody")}
              </Shimmer>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
