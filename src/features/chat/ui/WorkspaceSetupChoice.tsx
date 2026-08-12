import { useLayoutEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { ComposerActionButton } from "@/shared/ui/composer-action-button";
import { Input } from "@/shared/ui/input";
import { Shimmer } from "@/shared/ui/ai-elements/shimmer";

interface WorkspaceSetupChoiceProps {
  state: "choice" | "naming" | "creating";
  worktreeCount?: number;
  branchCount?: number;
  exactCounts?: boolean;
  error?: string;
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
  error,
  onCancelName,
  onCreate,
  onSubmitName,
  onSkip,
}: WorkspaceSetupChoiceProps) {
  const { t } = useTranslation("chat");
  const shouldReduceMotion = useReducedMotion();
  const [name, setName] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState<number>();
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const updateHeight = () => setContentHeight(content.scrollHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  const trimmedName = name.trim();
  const invalidName =
    trimmedName === "." || trimmedName === ".." || /[/\\]/.test(trimmedName);
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
      initial={false}
      animate={contentHeight == null ? undefined : { height: contentHeight }}
      className="overflow-hidden"
      transition={
        shouldReduceMotion
          ? { duration: 0 }
          : { height: { duration: 0.42, ease: [0.4, 0, 0.2, 1] } }
      }
    >
      <div ref={contentRef} className="grid">
        <AnimatePresence initial={false} mode="sync">
          {state === "choice" ? (
            <motion.div
              key="choice"
              initial={false}
              animate={{ opacity: 1 }}
              exit={{
                opacity: 0,
                transition: { duration: shouldReduceMotion ? 0 : 0.08 },
              }}
              transition={{
                duration: shouldReduceMotion ? 0 : 0.18,
                ease: [0.165, 0.84, 0.44, 1],
              }}
              className="col-start-1 row-start-1 overflow-hidden"
            >
              <div className="flex min-h-10 items-center justify-between gap-3 px-5 py-1">
                <span className="text-sm font-normal text-foreground">
                  {choiceLabel}
                </span>
                <div className="flex shrink-0 items-center gap-3">
                  <Button
                    type="button"
                    size="compact"
                    variant="ghost"
                    onClick={onSkip}
                    flush
                  >
                    {t("queue.configureWorktreeSkip")}
                  </Button>
                  <ComposerActionButton
                    type="button"
                    size="icon-pill-sm"
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
              initial={shouldReduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{
                opacity: 0,
                transition: { duration: shouldReduceMotion ? 0 : 0.08 },
              }}
              transition={{
                duration: shouldReduceMotion ? 0 : 0.18,
                ease: [0.165, 0.84, 0.44, 1],
              }}
              className="col-start-1 row-start-1 overflow-hidden px-5 pb-3.5 pt-4.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (trimmedName && !invalidName) onSubmitName(trimmedName);
              }}
            >
              <div>
                <label
                  htmlFor="deferred-worktree-name"
                  className="grid gap-1.5 text-sm font-normal text-foreground"
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
                    className="border-transparent bg-background shadow-none placeholder:text-muted-foreground/60 hover:border-transparent focus-visible:border-ring/50 dark:bg-muted/55 dark:placeholder:text-muted-foreground/50 dark:hover:border-transparent dark:focus-visible:border-ring/50"
                  />
                </label>
              </div>
              <div className="mt-4 flex items-center justify-between gap-4">
                {error ? (
                  <p
                    className="min-w-0 flex-1 truncate text-sm text-destructive"
                    role="alert"
                    title={error}
                  >
                    {error}
                  </p>
                ) : (
                  <span aria-hidden="true" />
                )}
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    size="compact"
                    variant="ghost"
                    onClick={onCancelName}
                  >
                    {t("queue.cancelWorktree")}
                  </Button>
                  <Button
                    type="submit"
                    size="compact"
                    className="min-w-16"
                    disabled={!trimmedName || invalidName}
                  >
                    {t("queue.createWorktree")}
                  </Button>
                </div>
              </div>
            </motion.form>
          ) : (
            <motion.div
              key="creating"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14, ease: [0.165, 0.84, 0.44, 1] }}
              className="col-start-1 row-start-1 overflow-hidden"
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
      </div>
    </motion.div>
  );
}
