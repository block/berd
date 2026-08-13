import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  Folder,
  FolderGit,
  GitBranch,
  GitFork,
} from "lucide-react";
import type { WorkspaceAttachment } from "@/shared/types/chat";
import type { GitState } from "@/shared/types/git";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import {
  isPathWithin,
  isSamePath,
  toIdentityKey,
} from "@/shared/lib/pathIdentity";
import {
  classifyWorkspaceAttachmentIfInGitState,
  getWorkspaceDisplayName,
  getWorkspaceTitle,
} from "@/features/chat/lib/workspaceAttachments";

function findWorktreeForWorkspace(
  workspace: WorkspaceAttachment,
  gitState: GitState | undefined,
) {
  const matchingWorktrees =
    gitState?.worktrees.filter((worktree) =>
      isPathWithin(worktree.path, workspace.path),
    ) ?? [];
  matchingWorktrees.sort(
    (a, b) => toIdentityKey(b.path).length - toIdentityKey(a.path).length,
  );
  return matchingWorktrees[0] ?? null;
}

function displayNameForPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const displayName = getWorkspaceDisplayName(path);
  return displayName === "." || displayName === ".." ? null : displayName;
}

export interface WorkspaceGitContext {
  workspaceTitle: string;
  worktreePath: string | null;
  branch: string | null;
  actionPath: string;
  worktreeName: string | null;
  isLinkedWorktree: boolean;
  isBranchCheckout: boolean;
  isMainCheckoutContext: boolean;
  isGitBacked: boolean;
  canUseGitActions: boolean;
  canCreateWorktree: boolean;
}

export type WorkspaceIdentityIconKind = "folder" | "repository" | "worktree";

export interface WorkspaceIdentityMetadataItem {
  label: string;
  icon?: "branch" | "worktree";
}

export function getWorkspaceIdentityIconKind(
  context: Pick<WorkspaceGitContext, "isGitBacked" | "isLinkedWorktree">,
): WorkspaceIdentityIconKind {
  if (!context.isGitBacked) return "folder";
  return "repository";
}

export function getWorkspaceIdentityMetadataItems(
  context: Pick<
    WorkspaceGitContext,
    | "branch"
    | "isBranchCheckout"
    | "isGitBacked"
    | "isLinkedWorktree"
    | "worktreeName"
  >,
  labels: { mainCheckout: string; worktree: string },
): WorkspaceIdentityMetadataItem[] {
  if (!context.isGitBacked) return [];

  const contextLabel = context.isLinkedWorktree
    ? (context.worktreeName ?? labels.worktree)
    : context.isBranchCheckout
      ? (context.branch ?? labels.mainCheckout)
      : labels.mainCheckout;
  return [
    {
      label: contextLabel,
      icon: context.isLinkedWorktree
        ? "worktree"
        : context.isBranchCheckout
          ? "branch"
          : undefined,
    },
  ];
}

function isBranchCheckout(branch: string | null | undefined): boolean {
  const normalizedBranch = branch?.trim();
  if (!normalizedBranch || normalizedBranch === "HEAD") return false;
  return !isDefaultBranch(normalizedBranch);
}

function isDefaultBranch(branch: string): boolean {
  const normalizedBranch = branch.toLowerCase();
  return (
    normalizedBranch === "main" ||
    normalizedBranch === "master" ||
    normalizedBranch === "trunk"
  );
}

function WorkspaceKindIcon({
  kind,
  className,
}: {
  kind: WorkspaceIdentityIconKind;
  className?: string;
}) {
  if (kind === "worktree") {
    return <GitFork className={className} />;
  }
  if (kind === "repository") {
    return <FolderGit className={className} />;
  }
  return <Folder className={className} />;
}

function MetadataIcon({
  kind,
  className,
}: {
  kind: NonNullable<WorkspaceIdentityMetadataItem["icon"]>;
  className?: string;
}) {
  if (kind === "branch") {
    return <GitBranch className={className} aria-hidden="true" />;
  }
  return <GitFork className={className} aria-hidden="true" />;
}

export function getWorkspaceGitContext(
  workspace: WorkspaceAttachment,
  gitState: GitState | undefined,
): WorkspaceGitContext {
  const worktree = findWorktreeForWorkspace(workspace, gitState);
  const workspaceTitle = getWorkspaceTitle(workspace, gitState);
  const workspaceClassification = gitState?.isGitRepo
    ? classifyWorkspaceAttachmentIfInGitState(workspace.path, gitState)
    : null;
  const worktreePath = workspace.worktreePath ?? worktree?.path ?? null;
  const branch =
    worktree?.branch ??
    workspaceClassification?.branch ??
    gitState?.currentBranch ??
    workspace.branch ??
    null;
  const actionPath = worktreePath ?? workspace.repositoryPath ?? workspace.path;
  const actionClassification = gitState?.isGitRepo
    ? classifyWorkspaceAttachmentIfInGitState(actionPath, gitState)
    : null;
  const repositoryName = displayNameForPath(workspace.repositoryPath);
  const worktreeName =
    displayNameForPath(worktreePath) ??
    (branch && branch !== "HEAD" ? branch : null) ??
    repositoryName ??
    displayNameForPath(workspace.path);
  const savedWorktreeMatchesRepository =
    workspace.worktreePath && workspace.repositoryPath
      ? isSamePath(workspace.worktreePath, workspace.repositoryPath)
      : null;
  const classifiedWorktreeMatchesRepository =
    workspaceClassification?.worktreePath &&
    workspaceClassification.repositoryPath
      ? isSamePath(
          workspaceClassification.worktreePath,
          workspaceClassification.repositoryPath,
        )
      : null;
  const isLinkedWorktree =
    workspace.kind === "git-linked-worktree" ||
    workspace.kind === "git-detached-checkout" ||
    workspaceClassification?.kind === "git-linked-worktree" ||
    workspaceClassification?.kind === "git-detached-checkout" ||
    classifiedWorktreeMatchesRepository === false ||
    savedWorktreeMatchesRepository === false ||
    worktree?.isMain === false;
  const isBranchCheckoutContext = !isLinkedWorktree && isBranchCheckout(branch);
  const isMainCheckoutContext =
    workspaceClassification?.kind === "git-main-worktree" ||
    workspaceClassification?.kind === "repository" ||
    workspace.kind === "git-main-worktree" ||
    workspace.kind === "repository" ||
    classifiedWorktreeMatchesRepository === true ||
    savedWorktreeMatchesRepository === true ||
    worktree?.isMain === true;
  const isGitBacked =
    workspace.kind === "git-main-worktree" ||
    workspace.kind === "git-linked-worktree" ||
    workspace.kind === "git-detached-checkout" ||
    workspace.kind === "repository" ||
    workspace.kind === "subdirectory" ||
    Boolean(worktreePath);
  const canUseGitActions = Boolean(
    isGitBacked && gitState?.isGitRepo && actionClassification,
  );

  return {
    workspaceTitle,
    worktreePath,
    branch,
    actionPath,
    worktreeName,
    isLinkedWorktree,
    isBranchCheckout: isBranchCheckoutContext,
    isMainCheckoutContext,
    isGitBacked,
    canUseGitActions,
    canCreateWorktree: canUseGitActions,
  };
}

interface WorkspaceIdentityProps {
  workspace: WorkspaceAttachment;
  gitState: GitState | undefined;
  gitContext?: WorkspaceGitContext;
  showMetadata?: boolean;
  iconKind?: WorkspaceIdentityIconKind;
  className?: string;
  iconClassName?: string;
  titleClassName?: string;
  metadataClassName?: string;
  showHoverChevron?: boolean;
  iconTooltip?: string;
}

export function WorkspaceIdentity({
  workspace,
  gitState,
  gitContext,
  showMetadata = true,
  iconKind: iconKindOverride,
  className,
  iconClassName,
  titleClassName,
  metadataClassName,
  showHoverChevron = true,
  iconTooltip,
}: WorkspaceIdentityProps) {
  const { t } = useTranslation("chat");
  const context = gitContext ?? getWorkspaceGitContext(workspace, gitState);
  const iconKind = iconKindOverride ?? getWorkspaceIdentityIconKind(context);
  const metadataItems = getWorkspaceIdentityMetadataItems(context, {
    mainCheckout: t("contextPanel.includedWorkspaces.mainCheckout"),
    worktree: t("contextPanel.includedWorkspaces.worktree"),
  });

  return (
    <div className={cn("flex min-w-0 items-start gap-2", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="relative mt-px size-3.5 shrink-0 text-muted-foreground">
            <WorkspaceKindIcon
              kind={iconKind}
              className={cn(
                "absolute inset-0 size-3.5 transition-opacity duration-100",
                showHoverChevron && "group-hover/workspace-row:opacity-0",
                iconClassName,
              )}
            />
            {showHoverChevron ? (
              <ChevronDown
                className={cn(
                  "absolute inset-0 size-3.5 opacity-0 transition-opacity duration-100 group-hover/workspace-row:opacity-100",
                  iconClassName,
                )}
                aria-hidden="true"
              />
            ) : null}
          </span>
        </TooltipTrigger>
        {iconTooltip ? <TooltipContent>{iconTooltip}</TooltipContent> : null}
      </Tooltip>
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            "block min-w-0 truncate text-sm leading-[15px] text-foreground",
            titleClassName,
          )}
          title={workspace.path}
        >
          {context.workspaceTitle}
        </span>
        {showMetadata && metadataItems.length > 0 ? (
          <div
            className={cn(
              "mt-0.5 flex min-w-0 items-center gap-1.5 text-xs leading-none text-muted-foreground",
              metadataClassName,
            )}
          >
            {metadataItems.map((item, index) => (
              <span
                key={item.label}
                className="inline-flex min-w-0 max-w-full items-center gap-1"
              >
                {index > 0 ? (
                  <span className="shrink-0 text-muted-foreground/70">
                    {/* i18n-check-ignore — visual separator, not translatable copy */}
                    &middot;
                  </span>
                ) : null}
                {item.icon ? (
                  <MetadataIcon
                    kind={item.icon}
                    className="size-3 shrink-0 text-muted-foreground"
                  />
                ) : null}
                <span className="truncate">{item.label}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
