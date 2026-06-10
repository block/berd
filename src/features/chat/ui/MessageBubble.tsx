import { memo, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Check, FileText, FolderClosed } from "lucide-react";
import { IconRobot } from "@tabler/icons-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { cn } from "@/shared/lib/cn";
import { useLocaleFormatting } from "@/shared/i18n";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { getCatalogEntryFromEntries } from "@/features/providers/providerCatalog";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import {
  getProviderIcon,
  formatProviderLabel,
} from "@/shared/ui/icons/ProviderIcons";
import {
  useTranscriptActiveStreamingProtection,
  useTranscriptRowRootAdapter,
  useTranscriptRowStateAdapter,
} from "@/features/chat/transcript/row-state";
import { useAvatarImage } from "@/shared/hooks/useAvatarSrc";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import {
  RunnableCodeBlock,
  type RunCommandOptions,
} from "@/shared/ui/ai-elements/runnable-code-block";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "@/shared/ui/ai-elements/reasoning";
import type { McpAppMessageHandler } from "./mcpAppTypes";
import { ToolChainCards, type ToolChainItem } from "./ToolChainCards";
import { ClickableImage } from "./ClickableImage";
import { McpAppView } from "./McpAppView";
import { useArtifactLinkHandler } from "@/features/chat/hooks/useArtifactLinkHandler";
import type { CustomRenderer } from "streamdown";
import { RUNNABLE_SHELL_LANGUAGES } from "@/shared/lib/runnableShellCommand";
import type {
  Message,
  MessageAttachment,
  MessageContent,
  TextContent,
  ImageContent,
  McpAppContent,
  ToolRequestContent,
  ToolResponseContent,
  ThinkingContent,
  ReasoningContent as ReasoningContentType,
  SystemNotificationContent,
} from "@/shared/types/messages";
import { Button } from "@/shared/ui/button";
import { MessageBubbleActions } from "./MessageBubbleActions";
import { MessageMetadataChip } from "./MessageMetadataChip";

function MessageAttachmentRow({
  attachment,
}: {
  attachment: MessageAttachment;
}) {
  const { t } = useTranslation("chat");
  const Icon = attachment.type === "directory" ? FolderClosed : FileText;
  const canOpen = Boolean(attachment.path);

  return (
    <button
      type="button"
      onClick={() => {
        if (!attachment.path) {
          return;
        }
        void openPath(attachment.path);
      }}
      disabled={!canOpen}
      className={cn(
        "flex max-w-full items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1.5 text-xs text-foreground",
        canOpen ? "hover:bg-muted/70" : "opacity-80",
      )}
      aria-label={
        canOpen
          ? t("attachments.open", { name: attachment.name })
          : attachment.name
      }
      title={attachment.path ?? attachment.name}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{attachment.name}</span>
    </button>
  );
}

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  contentOverride?: readonly MessageContent[];
  fragmentRole?: "single" | "start" | "middle" | "end";
  onCopy?: () => void;
  onRetryMessage?: (messageId: string) => void;
  onEditMessage?: (messageId: string) => void;
  onSendMcpAppMessage?: McpAppMessageHandler;
  onMcpAppAutoScroll?: (element: HTMLElement | null) => void;
  onRunShellCommand?: (command: string, options?: RunCommandOptions) => void;
  onEditProject?: (projectId: string) => void;
  onOpenContextPanel?: () => void;
}

interface ContentSection {
  key: string;
  type: "single" | "toolChain";
  items: MessageContent[] | ToolChainItem[];
}

function filterUserVisibleContent(content: MessageContent[]): MessageContent[] {
  return content.filter((b) => {
    const aud = "annotations" in b ? b.annotations?.audience : undefined;
    return !aud || aud.length === 0 || aud.includes("user");
  });
}

function findMatchingToolChainIndex(
  items: ToolChainItem[],
  response: ToolResponseContent,
): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item.request || item.response) {
      continue;
    }
    if (item.request.id === response.id) {
      return index;
    }
  }

  if (!response.name) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.request && !item.response) {
        return index;
      }
    }
  }

  return -1;
}

function groupContentSections(content: MessageContent[]): ContentSection[] {
  const sections: ContentSection[] = [];
  let currentToolChain: ToolChainItem[] = [];
  let currentToolChainKey: string | null = null;

  const flushToolChain = () => {
    if (currentToolChain.length > 0) {
      sections.push({
        key: currentToolChainKey ?? currentToolChain[0]?.key ?? "tool-chain",
        type: "toolChain",
        items: [...currentToolChain],
      });
      currentToolChain = [];
      currentToolChainKey = null;
    }
  };

  for (const [index, block] of content.entries()) {
    if (block.type === "toolRequest") {
      currentToolChainKey ??= `tool-chain-${block.id}-${index}`;
      currentToolChain.push({
        key: `tool-request-${block.id}-${index}`,
        request: block,
      });
      continue;
    }

    if (block.type === "toolResponse") {
      const matchingIndex = findMatchingToolChainIndex(currentToolChain, block);
      if (matchingIndex !== -1) {
        const requestName = currentToolChain[matchingIndex].request?.name ?? "";
        currentToolChain[matchingIndex] = {
          ...currentToolChain[matchingIndex],
          response: {
            ...block,
            name: block.name || requestName,
          },
        };
        continue;
      }
      currentToolChainKey ??= `tool-chain-${block.id}-${index}`;
      currentToolChain.push({
        key: `tool-response-${block.id}-${index}`,
        response: block,
      });
      continue;
    }

    flushToolChain();
    sections.push({
      key: `${block.type}-${"id" in block ? String(block.id) : index}`,
      type: "single",
      items: [block],
    });
  }

  flushToolChain();

  return sections;
}

function resolveNotificationAction(
  action: SystemNotificationContent["action"],
  options: {
    onEditProject?: (projectId: string) => void;
    onOpenContextPanel?: () => void;
    editProjectLabel?: string;
    changeFolderLabel?: string;
  },
): { label?: string; onClick: () => void } | null {
  if (!action) {
    return null;
  }
  const { onEditProject, onOpenContextPanel } = options;
  if (action.type === "editProject" && onEditProject) {
    return {
      label: options.editProjectLabel,
      onClick: () => onEditProject(action.projectId),
    };
  }
  // editProject falls back to the folder picker when no project-settings
  // surface exists (popped-out session windows pass no onEditProject).
  if (
    (action.type === "openContextPanel" || action.type === "editProject") &&
    onOpenContextPanel
  ) {
    return {
      label: options.changeFolderLabel,
      onClick: onOpenContextPanel,
    };
  }
  return null;
}

function renderContentBlock(
  content: MessageContent,
  index: number,
  options: {
    defaultImageAlt: string;
    redactedThinking: string;
    contentBlocks: MessageContent[];
    onSendMcpAppMessage?: McpAppMessageHandler;
    onMcpAppAutoScroll?: (element: HTMLElement | null) => void;
    onRunShellCommand?: (command: string, options?: RunCommandOptions) => void;
    runItCodeRenderers?: CustomRenderer[];
    onEditProject?: (projectId: string) => void;
    onOpenContextPanel?: () => void;
    editProjectLabel?: string;
    changeFolderLabel?: string;
    stateKey?: string;
  },
  isStreamingMsg?: boolean,
  isUserMessage?: boolean,
) {
  switch (content.type) {
    case "text": {
      const tc = content as TextContent;
      if (isUserMessage) {
        if (!tc.text.trim()) {
          return null;
        }
        return (
          <p
            key={`text-${index}`}
            className="whitespace-pre-wrap wrap-anywhere"
          >
            {tc.text}
          </p>
        );
      }
      return (
        <MessageResponse
          key={`text-${index}`}
          isAnimating={isStreamingMsg}
          mode={isStreamingMsg ? "streaming" : "static"}
          codeRenderers={
            options.onRunShellCommand ? options.runItCodeRenderers : undefined
          }
        >
          {tc.text}
        </MessageResponse>
      );
    }
    case "image": {
      const ic = content as ImageContent;
      const src = ic.uri ?? `data:${ic.mimeType};base64,${ic.data}`;
      return (
        <ClickableImage
          key={`image-${index}`}
          src={src}
          alt={options.defaultImageAlt}
        />
      );
    }
    case "toolRequest":
    case "toolResponse":
      // Handled by groupContentSections toolChain rendering
      return null;
    case "mcpApp": {
      const mcpApp = content as McpAppContent;
      const matchingToolInput = options.contentBlocks.find(
        (block): block is ToolRequestContent =>
          block.type === "toolRequest" &&
          block.id === mcpApp.payload.toolCallId,
      );
      const matchingToolResponse = options.contentBlocks.find(
        (block): block is ToolResponseContent =>
          block.type === "toolResponse" &&
          block.id === mcpApp.payload.toolCallId,
      );

      return (
        <McpAppView
          key={`mcp-app-${index}`}
          payload={mcpApp.payload}
          toolInput={matchingToolInput?.arguments}
          toolResponse={matchingToolResponse}
          onSendMessage={options.onSendMcpAppMessage}
          onAutoScrollRequest={options.onMcpAppAutoScroll}
        />
      );
    }
    case "thinking":
    case "reasoning": {
      const text = (content as ThinkingContent | ReasoningContentType).text;
      return (
        <Reasoning
          key={`${content.type}-${index}`}
          isStreaming={isStreamingMsg}
          defaultOpen={false}
          stateKey={options.stateKey}
        >
          <ReasoningTrigger />
          <ReasoningContent>{text}</ReasoningContent>
        </Reasoning>
      );
    }
    case "redactedThinking":
      return (
        <div
          key={`redacted-${index}`}
          className="text-xs italic text-muted-foreground"
        >
          {options.redactedThinking}
        </div>
      );
    case "systemNotification": {
      const sn = content as SystemNotificationContent;
      const isError = sn.notificationType === "error";
      const isCompaction = sn.notificationType === "compaction";
      const notificationAction = resolveNotificationAction(sn.action, options);
      return (
        <div
          key={`notification-${index}`}
          className={cn(
            "rounded-md border p-2 text-xs",
            isError
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : isCompaction
                ? "inline-flex items-center justify-center gap-2 border-success/30 bg-success/10 font-medium text-success"
                : "border-border bg-accent text-muted-foreground",
          )}
        >
          {isCompaction ? <Check className="size-3.5 shrink-0" /> : null}
          <span>{sn.text}</span>
          {notificationAction ? (
            <div className="mt-2">
              <Button
                type="button"
                variant="alert-action"
                size="xs"
                onClick={notificationAction.onClick}
              >
                {notificationAction.label}
              </Button>
            </div>
          ) : null}
        </div>
      );
    }
    default:
      return null;
  }
}

export const MessageBubble = memo(function MessageBubble({
  message,
  isStreaming,
  contentOverride,
  fragmentRole,
  onRetryMessage,
  onEditMessage,
  onSendMcpAppMessage,
  onMcpAppAutoScroll,
  onRunShellCommand,
  onEditProject,
  onOpenContextPanel,
}: MessageBubbleProps) {
  const { t } = useTranslation(["chat", "common"]);
  const { formatDate } = useLocaleFormatting();
  const { role, content: rawContent, created } = message;
  // Only user messages carry annotated blocks; skip the filter for others.
  const content = contentOverride
    ? [...contentOverride]
    : role === "user"
      ? filterUserVisibleContent(rawContent)
      : rawContent;
  const { handleContentClick, pathNotice } = useArtifactLinkHandler();
  const persona = useAgentStore((state) =>
    message.metadata?.personaId
      ? state.getPersonaById(message.metadata.personaId)
      : undefined,
  );
  const { isCopied: isCopyConfirmed, copyToClipboard } = useCopyToClipboard();
  const personaGutterImage = useAvatarImage(persona?.avatar);
  const catalogEntries = useProviderCatalogStore((state) => state.entries);
  const runItCodeRenderers = useMemo<CustomRenderer[]>(
    () =>
      onRunShellCommand
        ? [
            {
              language: [...RUNNABLE_SHELL_LANGUAGES],
              component: (props) => (
                <RunnableCodeBlock {...props} onRun={onRunShellCommand} />
              ),
            },
          ]
        : [],
    [onRunShellCommand],
  );
  const rowRootAttributes = useTranscriptRowRootAdapter();
  const { updateRowState } = useTranscriptRowStateAdapter();
  const hadPathNoticeRef = useRef(false);
  const hadCopyConfirmationRef = useRef(false);

  useTranscriptActiveStreamingProtection(Boolean(isStreaming));

  useEffect(() => {
    if (!pathNotice && !hadPathNoticeRef.current) {
      return;
    }

    hadPathNoticeRef.current = Boolean(pathNotice);
    updateRowState(
      (current) => ({
        ...current,
        pathNoticeText: pathNotice || undefined,
      }),
      { markRecent: Boolean(pathNotice) },
    );
  }, [pathNotice, updateRowState]);

  useEffect(() => {
    if (!isCopyConfirmed && !hadCopyConfirmationRef.current) {
      return;
    }

    hadCopyConfirmationRef.current = isCopyConfirmed;
    updateRowState(
      (current) => ({
        ...current,
        copyConfirmedUntilMs: isCopyConfirmed ? Date.now() + 2000 : undefined,
      }),
      { markRecent: isCopyConfirmed },
    );
  }, [isCopyConfirmed, updateRowState]);

  // Skip empty user bubbles (all blocks filtered as assistant-only).
  if (role === "user" && content.length === 0) return null;

  const textContent = content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const actionTextContent = fragmentRole
    ? rawContent
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n")
    : textContent;
  if (role === "system") {
    return (
      <div className="flex justify-center px-4 py-2" {...rowRootAttributes}>
        <div className="w-full max-w-md text-center text-xs text-muted-foreground">
          {content.map((c, i) =>
            renderContentBlock(c, i, {
              defaultImageAlt: t("message.defaultImageAlt"),
              redactedThinking: t("message.redactedThinking"),
              contentBlocks: content,
              onEditProject,
              onOpenContextPanel,
              editProjectLabel: t("toolbar.editProjectFolders"),
              changeFolderLabel: t("toolbar.changeFolder"),
              stateKey: `${c.type}-${i}`,
            }),
          )}
        </div>
      </div>
    );
  }
  const isUser = role === "user";
  const assistantProviderId = message.metadata?.providerId;
  const assistantProviderName = assistantProviderId
    ? (getCatalogEntryFromEntries(catalogEntries, assistantProviderId)
        ?.displayName ?? formatProviderLabel(assistantProviderId))
    : undefined;
  const assistantDisplayName =
    message.metadata?.personaName ??
    persona?.displayName ??
    assistantProviderName;
  const assistantProviderIcon = assistantProviderId
    ? getProviderIcon(assistantProviderId, "size-3.5")
    : null;
  const showPersonaGutterAvatar = Boolean(
    !isUser && (message.metadata?.personaId || personaGutterImage),
  );
  const isFragmentMiddleOrEnd =
    fragmentRole === "middle" || fragmentRole === "end";
  const showLeadingAssistantChrome =
    !fragmentRole || fragmentRole === "start" || fragmentRole === "single";
  const showMessageActions =
    !fragmentRole || fragmentRole === "end" || fragmentRole === "single";
  const outerSpacingClassName =
    fragmentRole === "start"
      ? "pt-1 pb-0"
      : fragmentRole === "middle"
        ? "-mt-1 py-0"
        : fragmentRole === "end"
          ? "-mt-1 pt-0 pb-1"
          : "py-1";
  const showAssistantIdentity = Boolean(
    !isUser &&
      showLeadingAssistantChrome &&
      !showPersonaGutterAvatar &&
      (assistantDisplayName || personaGutterImage || assistantProviderIcon),
  );
  const messageAttachments = message.metadata?.attachments ?? [];
  const messageChips = message.metadata?.chips ?? [];
  const timestamp = (
    <span
      data-role="message-timestamp"
      className="shrink-0 whitespace-nowrap px-1 text-[13px] leading-relaxed text-muted-foreground"
    >
      {formatDate(created, {
        hour: "2-digit",
        minute: "2-digit",
      })}
    </span>
  );

  return (
    <div
      className={cn(
        "flex",
        outerSpacingClassName,
        "animate-in fade-in duration-200 motion-reduce:animate-none",
        isUser ? "ml-auto flex-row-reverse gap-3" : "flex-row gap-3",
      )}
      data-role={isUser ? "user-message" : "assistant-message"}
      data-message-fragment-role={fragmentRole}
      {...rowRootAttributes}
    >
      {showPersonaGutterAvatar && showLeadingAssistantChrome ? (
        <div
          className={cn(
            "mt-0.5 flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md",
            // The persona PNGs are transparent — skip the muted backdrop
            // when we're rendering an actual image so the chat surface
            // shows through. Keep it for the icon fallback so the icon
            // has something behind it.
            !personaGutterImage && "bg-muted/40",
          )}
          data-role="assistant-persona-avatar"
        >
          {assistantDisplayName ? (
            <span className="sr-only">{assistantDisplayName}</span>
          ) : null}
          {personaGutterImage ? (
            <img
              src={personaGutterImage}
              alt=""
              className="h-full w-full object-contain"
            />
          ) : (
            <IconRobot size={16} className="text-muted-foreground" />
          )}
        </div>
      ) : showPersonaGutterAvatar && isFragmentMiddleOrEnd ? (
        <div
          aria-hidden="true"
          data-role="assistant-persona-avatar-spacer"
          className="size-9 shrink-0"
        />
      ) : null}
      <div
        data-role={
          isUser ? "user-message-content" : "assistant-message-content"
        }
        className={cn(
          "group relative min-w-0 flex flex-col gap-1",
          showMessageActions && "pb-8",
          isUser
            ? "max-w-[var(--chat-user-message-max-width)] items-end"
            : "w-full items-start",
        )}
      >
        {showAssistantIdentity ? (
          <div className="mb-0.5 flex items-center gap-1 text-xs">
            {personaGutterImage ? (
              <img
                src={personaGutterImage}
                alt=""
                className="h-5 w-5 rounded-full"
              />
            ) : assistantProviderIcon ? (
              <span className="flex h-5 w-5 items-center justify-center">
                {assistantProviderIcon}
              </span>
            ) : (
              <span className="flex h-5 w-5 items-center justify-center">
                <IconRobot size={14} className="text-muted-foreground" />
              </span>
            )}
            {assistantDisplayName ? (
              <span className="font-normal text-foreground">
                {assistantDisplayName}
              </span>
            ) : null}
          </div>
        ) : null}

        {/* biome-ignore lint/a11y/useKeyWithClickEvents: delegated link handler */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: delegated link handler */}
        <div
          className={cn(
            "min-w-0 text-sm leading-relaxed",
            isUser
              ? "rounded-sm bg-message-user-bg px-4 py-2 leading-normal"
              : "w-full",
          )}
          onClick={handleContentClick}
        >
          {isUser && messageChips.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {messageChips.map((chip) => (
                <MessageMetadataChip
                  key={`${chip.type}-${chip.label}`}
                  chip={chip}
                />
              ))}
            </div>
          )}
          {messageAttachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {messageAttachments.map((attachment) => (
                <MessageAttachmentRow
                  key={`${attachment.type}-${attachment.path ?? attachment.name}`}
                  attachment={attachment}
                />
              ))}
            </div>
          )}
          {groupContentSections(content).map((section, sectionIdx) => {
            if (section.type === "toolChain") {
              const toolItems = section.items as ToolChainItem[];
              return (
                <ToolChainCards
                  key={section.key}
                  chainId={section.key}
                  toolItems={toolItems}
                />
              );
            }
            const block = section.items[0] as MessageContent;
            return (
              <div key={`${message.id}-${section.key}`}>
                {renderContentBlock(
                  block,
                  sectionIdx,
                  {
                    defaultImageAlt: t("message.defaultImageAlt"),
                    redactedThinking: t("message.redactedThinking"),
                    contentBlocks: content,
                    onSendMcpAppMessage,
                    onMcpAppAutoScroll,
                    onRunShellCommand,
                    runItCodeRenderers,
                    stateKey: section.key,
                  },
                  isStreaming,
                  isUser,
                )}
              </div>
            );
          })}
          {pathNotice && (
            <p className="mt-2 text-xs text-destructive" role="status">
              {pathNotice}
            </p>
          )}
        </div>

        {showMessageActions ? (
          <div
            data-role="message-actions"
            data-copy-confirmed={isCopyConfirmed ? "true" : "false"}
            className={cn(
              "absolute bottom-0 transition-opacity duration-150 ease-out",
              "opacity-0 pointer-events-none",
              "group-hover:animate-in group-hover:slide-in-from-top-2 group-hover:opacity-100 group-hover:pointer-events-auto",
              "group-focus-within:animate-in group-focus-within:slide-in-from-top-2 group-focus-within:opacity-100 group-focus-within:pointer-events-auto",
              isCopyConfirmed && "opacity-100 pointer-events-auto",
              isUser ? "right-0" : "-left-3",
            )}
          >
            <MessageBubbleActions
              isUser={isUser}
              messageId={message.id}
              timestamp={timestamp}
              textContent={actionTextContent}
              copied={isCopyConfirmed}
              onCopy={() => copyToClipboard(actionTextContent)}
              onRetryMessage={onRetryMessage}
              onEditMessage={onEditMessage}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
});
