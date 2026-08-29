import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, FileText, FolderClosed, ImageIcon } from "lucide-react";
import { IconRobot } from "@tabler/icons-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
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
  useTranscriptOpenOverlayProtection,
  useTranscriptRowRootAdapter,
  useTranscriptRowStateAdapter,
} from "@/features/chat/transcript/row-state";
import { AvatarVisual } from "@/shared/ui/avatar-visual";
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
import { MarkdownImage } from "./MarkdownImage";
import { resolveImageContentSrc } from "./resolveImageContentSrc";
import { McpAppView } from "./McpAppView";
import { useArtifactLinkHandler } from "@/features/chat/hooks/useArtifactLinkHandler";
import { detectProviderErrorNotice } from "@/features/chat/lib/providerErrorNotice";
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
import { LinkifiedText } from "@/shared/ui/LinkifiedText";
import { useProfileCapability } from "@/shared/profile/capabilities";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { MessageBubbleActions } from "./MessageBubbleActions";
import { MessageMetadataChip } from "./MessageMetadataChip";
import { isResponseFeedbackEligible } from "../response-feedback/responseFeedbackState";
import { SessionFeedbackSurvey } from "../response-feedback/SessionFeedbackSurvey";
import type { ActiveSessionFeedbackSurvey } from "../response-feedback/sessionFeedbackSurveyState";
import {
  couldOverflowUserMessagePreview,
  UserMessageClamp,
} from "./UserMessageClamp";
import { ImageLightbox } from "@/shared/ui/ImageLightbox";
import { VoiceSpeechStatusIndicator } from "./VoiceSpeechStatusIndicator";

interface MessageAttachmentPreviewItem {
  key: string;
  attachment: MessageAttachment;
  attachmentIndex: number;
  imageSrc: string | null;
  imageContentIndex?: number;
}

const EMPTY_MESSAGE_ATTACHMENTS: readonly MessageAttachment[] = [];

function isImageAttachment(attachment: MessageAttachment): boolean {
  return attachment.mimeType?.toLowerCase().startsWith("image/") ?? false;
}

function getAttachmentExtension(attachment: MessageAttachment): string {
  if (attachment.type === "directory") {
    return "DIR";
  }

  const trimmedName = attachment.name.trim();
  const lastDot = trimmedName.lastIndexOf(".");
  if (lastDot > 0 && lastDot < trimmedName.length - 1) {
    return trimmedName.slice(lastDot + 1, lastDot + 6).toUpperCase();
  }

  const subtype = attachment.mimeType?.split("/")[1]?.split(/[;+]/)[0];
  return subtype ? subtype.slice(0, 5).toUpperCase() : "FILE";
}

function resolveAttachmentImageSrc(
  attachment: MessageAttachment,
  imageContent?: ImageContent,
): string | null {
  const contentSrc = imageContent ? resolveImageContentSrc(imageContent) : null;
  if (contentSrc) {
    return contentSrc;
  }

  if (!isImageAttachment(attachment)) {
    return null;
  }

  if (attachment.path) {
    return convertFileSrc(attachment.path, "asset");
  }

  return attachment.url ?? null;
}

function buildAttachmentPreviewItems(
  attachments: readonly MessageAttachment[],
  content: readonly MessageContent[],
): MessageAttachmentPreviewItem[] {
  const imageContentBlocks = content.flatMap((block, contentIndex) =>
    block.type === "image"
      ? [{ block: block as ImageContent, contentIndex }]
      : [],
  );
  const imageAttachmentCount = attachments.filter(isImageAttachment).length;
  const canPairImageContent =
    imageContentBlocks.length === imageAttachmentCount;
  let imageContentCursor = 0;

  return attachments.map((attachment, attachmentIndex) => {
    const imageContent =
      canPairImageContent && isImageAttachment(attachment)
        ? imageContentBlocks[imageContentCursor++]
        : undefined;

    return {
      key: `${attachment.type}-${attachment.path ?? attachment.url ?? attachment.name}-${attachmentIndex}`,
      attachment,
      attachmentIndex,
      imageSrc: resolveAttachmentImageSrc(attachment, imageContent?.block),
      ...(imageContent ? { imageContentIndex: imageContent.contentIndex } : {}),
    };
  });
}

function collectAttachedImageContentIndexes(
  attachmentItems: readonly MessageAttachmentPreviewItem[],
): Set<number> {
  return new Set(
    attachmentItems.flatMap((item) =>
      item.imageContentIndex == null ? [] : [item.imageContentIndex],
    ),
  );
}

function MessageAttachmentTile({
  item,
  onViewImage,
}: {
  item: MessageAttachmentPreviewItem;
  onViewImage: (item: MessageAttachmentPreviewItem) => void;
}) {
  const { t } = useTranslation("chat");
  const { attachment, imageSrc } = item;
  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const displayedImageSrc =
    imageSrc && failedImageSrc !== imageSrc ? imageSrc : null;
  const canOpen = Boolean(
    displayedImageSrc || attachment.path || attachment.url,
  );
  const extension = getAttachmentExtension(attachment);
  const Icon =
    attachment.type === "directory"
      ? FolderClosed
      : isImageAttachment(attachment)
        ? ImageIcon
        : FileText;

  return (
    <button
      type="button"
      data-role="message-attachment-tile"
      onClick={() => {
        if (displayedImageSrc) {
          onViewImage(item);
          return;
        }
        if (attachment.path) {
          void openPath(attachment.path);
          return;
        }
        if (attachment.url) {
          void openUrl(attachment.url);
        }
      }}
      disabled={!canOpen}
      className={cn(
        "group relative flex size-16 shrink-0 overflow-hidden rounded-xl border border-border/70 bg-background/50 text-left shadow-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        canOpen
          ? "hover:border-foreground/20 hover:bg-muted/70"
          : "cursor-default opacity-75",
      )}
      aria-label={
        displayedImageSrc
          ? t("attachments.viewFullSize", { name: attachment.name })
          : canOpen
            ? t("attachments.open", { name: attachment.name })
            : t("attachments.unavailable", { name: attachment.name })
      }
      title={attachment.path ?? attachment.url ?? attachment.name}
    >
      {displayedImageSrc ? (
        <>
          <img
            src={displayedImageSrc}
            alt=""
            onError={() => setFailedImageSrc(displayedImageSrc)}
            className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-[1.03]"
          />
          <span className="absolute bottom-1 right-1 rounded bg-background/85 px-1 text-[9px] font-medium leading-4 text-foreground shadow-sm backdrop-blur-sm">
            {extension}
          </span>
        </>
      ) : (
        <span className="flex h-full w-full flex-col items-center justify-center gap-1 px-1.5 text-center">
          <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
          <span className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium leading-none text-muted-foreground">
            {extension}
          </span>
        </span>
      )}
      <span className="sr-only">{attachment.name}</span>
    </button>
  );
}

function MessageAttachmentGrid({
  items,
}: {
  items: readonly MessageAttachmentPreviewItem[];
}) {
  const { t } = useTranslation("chat");
  const [lightboxImageIndex, setLightboxImageIndex] = useState<number | null>(
    null,
  );
  const imageItems = items.filter((item) => item.imageSrc);
  const currentLightboxItem =
    lightboxImageIndex == null
      ? null
      : (imageItems[lightboxImageIndex] ?? null);

  useTranscriptOpenOverlayProtection({
    open: Boolean(currentLightboxItem),
    overlayKind: "lightbox",
    overlayId: "attachment-image-lightbox",
  });

  useEffect(() => {
    if (imageItems.length === 0) {
      setLightboxImageIndex(null);
      return;
    }

    if (lightboxImageIndex != null && lightboxImageIndex >= imageItems.length) {
      setLightboxImageIndex(imageItems.length - 1);
    }
  }, [imageItems.length, lightboxImageIndex]);

  if (items.length === 0) {
    return null;
  }

  return (
    <>
      <fieldset
        data-role="message-attachments"
        aria-label={t("attachments.groupLabel", { count: items.length })}
        className="m-0 mb-2 flex min-w-0 flex-wrap gap-2 border-0 p-0"
      >
        {items.map((item) => (
          <MessageAttachmentTile
            key={item.key}
            item={item}
            onViewImage={(selectedItem) => {
              const imageIndex = imageItems.findIndex(
                (imageItem) => imageItem.key === selectedItem.key,
              );
              setLightboxImageIndex(imageIndex >= 0 ? imageIndex : null);
            }}
          />
        ))}
      </fieldset>
      <ImageLightbox
        src={currentLightboxItem?.imageSrc ?? ""}
        downloadFilename={currentLightboxItem?.attachment.name}
        alt={
          currentLightboxItem
            ? t("attachments.previewAlt", {
                name: currentLightboxItem.attachment.name,
              })
            : t("attachments.imagePreviewTitle")
        }
        open={Boolean(currentLightboxItem)}
        onOpenChange={(open) => {
          if (!open) {
            setLightboxImageIndex(null);
          }
        }}
        onPrevious={
          imageItems.length > 1
            ? () =>
                setLightboxImageIndex((current) =>
                  current == null
                    ? current
                    : (current - 1 + imageItems.length) % imageItems.length,
                )
            : undefined
        }
        onNext={
          imageItems.length > 1
            ? () =>
                setLightboxImageIndex((current) =>
                  current == null ? current : (current + 1) % imageItems.length,
                )
            : undefined
        }
      />
    </>
  );
}

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  actionsAlwaysVisible?: boolean;
  animateEntry?: boolean;
  contentOverride?: readonly MessageContent[];
  contentContext?: readonly MessageContent[];
  actionMessageId?: string;
  feedbackSessionId?: string;
  sessionFeedbackSurvey?: ActiveSessionFeedbackSurvey;
  sessionFeedbackSurveyMeasurementOnly?: boolean;
  fragmentRole?: "single" | "start" | "middle" | "end";
  onCopy?: () => void;
  onRetryMessage?: (messageId: string) => void;
  onEditMessage?: (messageId: string) => void;
  onJumpToResponseStart?: (messageId: string) => void;
  onForkFromMessage?: (messageId: string) => void;
  showJumpToResponseStartHint?: boolean;
  onJumpToResponseStartHintClose?: (messageId: string) => void;
  onJumpToResponseStartHintDismiss?: (messageId: string) => void;
  onSendMcpAppMessage?: McpAppMessageHandler;
  onMcpAppAutoScroll?: (element: HTMLElement | null) => void;
  onRunShellCommand?: (command: string, options?: RunCommandOptions) => void;
  onEditProject?: (projectId: string) => void;
  onChangeFolder?: () => void;
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
    onChangeFolder?: () => void;
    onOpenContextPanel?: () => void;
    editProjectLabel?: string;
    changeFolderLabel?: string;
  },
): { label?: string; onClick: () => void } | null {
  if (!action) {
    return null;
  }
  const { onEditProject, onChangeFolder, onOpenContextPanel } = options;
  if (action.type === "editProject" && onEditProject) {
    return {
      label: options.editProjectLabel,
      onClick: () => onEditProject(action.projectId),
    };
  }
  // editProject falls back to the folder picker when no project-settings
  // surface exists (popped-out session windows pass no onEditProject).
  // Prefer opening the folder picker directly (onChangeFolder); showing the
  // context panel is only a legacy fallback for hosts without the picker.
  if (action.type === "openContextPanel" || action.type === "editProject") {
    const onClick = onChangeFolder ?? onOpenContextPanel;
    if (onClick) {
      return {
        label: options.changeFolderLabel,
        onClick,
      };
    }
  }
  return null;
}

function renderContentBlock(
  content: MessageContent,
  index: number,
  options: {
    defaultImageAlt: string;
    redactedThinking: string;
    voiceSpeechSpeakingLabel: string;
    voiceSpeechSpokenLabel: string;
    voiceSpeechInterruptedLabel: string;
    voiceSpeechNotSpokenLabel: string;
    voiceSpeechFailedLabel: string;
    contentBlocks: readonly MessageContent[];
    onSendMcpAppMessage?: McpAppMessageHandler;
    onMcpAppAutoScroll?: (element: HTMLElement | null) => void;
    onRunShellCommand?: (command: string, options?: RunCommandOptions) => void;
    runItCodeRenderers?: CustomRenderer[];
    onEditProject?: (projectId: string) => void;
    onChangeFolder?: () => void;
    onOpenContextPanel?: () => void;
    editProjectLabel?: string;
    changeFolderLabel?: string;
    stateKey?: string;
    resolveProviderErrorNotice?: (text: string) => string | null;
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
        return <LinkifiedText key={`text-${index}`} text={tc.text} />;
      }
      const providerErrorNotice =
        options.resolveProviderErrorNotice?.(tc.text) ?? null;
      const displayText = providerErrorNotice ?? tc.text;
      const speechStatus = tc.speech?.status;
      const strikethroughFrom =
        providerErrorNotice === null &&
        (speechStatus === "interrupted" || speechStatus === "failed") &&
        tc.speech?.spokenThrough !== undefined
          ? tc.speech.spokenThrough
          : providerErrorNotice === null && speechStatus === "notSpoken"
            ? 0
            : undefined;
      const speechLabel = speechStatus
        ? {
            speaking: options.voiceSpeechSpeakingLabel,
            spoken: options.voiceSpeechSpokenLabel,
            interrupted: options.voiceSpeechInterruptedLabel,
            notSpoken: options.voiceSpeechNotSpokenLabel,
            failed: options.voiceSpeechFailedLabel,
          }[speechStatus]
        : null;
      return (
        <div
          key={`text-${index}`}
          data-voice-speech-status={speechStatus}
          className={cn(speechStatus === "interrupted" && "opacity-80")}
        >
          {speechStatus && speechLabel ? (
            <VoiceSpeechStatusIndicator
              status={speechStatus}
              label={speechLabel}
            />
          ) : null}
          <MessageResponse
            isAnimating={isStreamingMsg}
            mode={isStreamingMsg ? "streaming" : "static"}
            codeRenderers={
              options.onRunShellCommand ? options.runItCodeRenderers : undefined
            }
            imageRenderer={MarkdownImage}
            strikethroughFrom={strikethroughFrom}
            strikethroughLabel={options.voiceSpeechNotSpokenLabel}
          >
            {displayText}
          </MessageResponse>
        </div>
      );
    }
    case "image": {
      const ic = content as ImageContent;
      // Prefer inline base64 `data` over a `file://` `uri` (which the webview
      // cannot load); convert local file URIs through the asset scheme.
      const src = resolveImageContentSrc(ic);
      if (!src) {
        return null;
      }
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
      const isWarning = sn.notificationType === "warning";
      const isCompaction = sn.notificationType === "compaction";
      const notificationAction = resolveNotificationAction(sn.action, options);
      return (
        <div
          key={`notification-${index}`}
          className={cn(
            "rounded-md border p-2 text-xs",
            isError
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : isWarning
                ? "border-warning/40 bg-warning/10 text-warning"
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
                variant="alert"
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
  actionsAlwaysVisible = false,
  animateEntry = true,
  contentOverride,
  contentContext,
  actionMessageId = message.id,
  feedbackSessionId,
  sessionFeedbackSurvey,
  sessionFeedbackSurveyMeasurementOnly = false,
  fragmentRole,
  onRetryMessage,
  onEditMessage,
  onJumpToResponseStart,
  onForkFromMessage,
  showJumpToResponseStartHint,
  onJumpToResponseStartHintClose,
  onJumpToResponseStartHintDismiss,
  onSendMcpAppMessage,
  onMcpAppAutoScroll,
  onRunShellCommand,
  onEditProject,
  onChangeFolder,
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
  const renderingContext = contentContext ?? content;
  const { handleContentClick, pathNotice } = useArtifactLinkHandler();
  const persona = useAgentStore((state) =>
    message.metadata?.personaId
      ? state.getPersonaById(message.metadata.personaId)
      : undefined,
  );
  const { isCopied: isCopyConfirmed, copyToClipboard } = useCopyToClipboard();
  const hasPersonaAvatar = Boolean(persona?.avatar);
  const catalogEntries = useProviderCatalogStore((state) => state.entries);
  const feedbackSurveysEnabled = useProfileCapability("feedbackSurveys");
  const responseRatingEnabled = useRuntimeConfigStore(
    (state) => state.config.feedback?.responseRatingEnabled === true,
  );
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
  const resolveProviderErrorNotice = useMemo(() => {
    if (role !== "assistant") {
      return undefined;
    }
    return (text: string) => {
      const kind = detectProviderErrorNotice(text);
      return kind ? t(`message.providerError.${kind}`) : null;
    };
  }, [role, t]);
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

  const isUser = role === "user";
  const messageAttachments =
    message.metadata?.attachments ?? EMPTY_MESSAGE_ATTACHMENTS;
  const attachmentPreviewItems = useMemo(
    () =>
      isUser ? buildAttachmentPreviewItems(messageAttachments, content) : [],
    [isUser, messageAttachments, content],
  );
  const attachedImageContentIndexes = useMemo(
    () => collectAttachedImageContentIndexes(attachmentPreviewItems),
    [attachmentPreviewItems],
  );
  const visibleContent = useMemo(
    () =>
      attachedImageContentIndexes.size === 0
        ? content
        : content.filter(
            (block, index) =>
              block.type !== "image" || !attachedImageContentIndexes.has(index),
          ),
    [attachedImageContentIndexes, content],
  );
  const messageChips = message.metadata?.chips ?? [];

  // Skip empty user bubbles (all blocks filtered as assistant-only).
  if (role === "user" && content.length === 0) return null;

  const textContent = content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const renderedContent = visibleContent;
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
              voiceSpeechSpeakingLabel: t("message.voiceSpeechSpeakingLabel"),
              voiceSpeechSpokenLabel: t("message.voiceSpeechSpokenLabel"),
              voiceSpeechInterruptedLabel: t(
                "message.voiceSpeechInterruptedLabel",
              ),
              voiceSpeechNotSpokenLabel: t("message.voiceSpeechNotSpokenLabel"),
              voiceSpeechFailedLabel: t("message.voiceSpeechFailedLabel"),
              contentBlocks: renderingContext,
              onEditProject,
              onChangeFolder,
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
    !isUser && (message.metadata?.personaId || hasPersonaAvatar),
  );
  const isFragmentMiddleOrEnd =
    fragmentRole === "middle" || fragmentRole === "end";
  const showLeadingAssistantChrome =
    !fragmentRole || fragmentRole === "start" || fragmentRole === "single";
  const canHostMessageActions =
    !fragmentRole || fragmentRole === "end" || fragmentRole === "single";
  const showMessageActions = !isStreaming && canHostMessageActions;
  // Reserve the action tray while the terminal assistant row is still
  // streaming so completion does not add pb-9 and nudge a bottom-pinned
  // transcript upward.
  const shouldReserveMessageActionSpace =
    showMessageActions || (!isUser && isStreaming && canHostMessageActions);
  const messageActionsArePersistentlyVisible =
    actionsAlwaysVisible || isCopyConfirmed;
  const responseFeedback =
    canHostMessageActions &&
    feedbackSurveysEnabled &&
    responseRatingEnabled &&
    feedbackSessionId &&
    isResponseFeedbackEligible({
      message,
      content,
      isStreaming: Boolean(isStreaming),
    })
      ? {
          sessionId: feedbackSessionId,
          messageId: actionMessageId,
        }
      : undefined;
  const outerSpacingClassName =
    fragmentRole === "start"
      ? "pt-1 pb-0"
      : fragmentRole === "middle"
        ? "py-0"
        : fragmentRole === "end"
          ? "pt-0 pb-1"
          : "py-1";
  const showAssistantIdentity = Boolean(
    !isUser &&
      showLeadingAssistantChrome &&
      !showPersonaGutterAvatar &&
      (assistantDisplayName || hasPersonaAvatar || assistantProviderIcon),
  );
  const isSteeredMessage = isUser && message.metadata?.delivery === "steer";
  const isBerdctlCrossSessionMessage =
    isUser && message.metadata?.origin === "berdctl_cross_session";
  const berdSenderLabel = isBerdctlCrossSessionMessage
    ? message.metadata?.berdSenderLabel
    : undefined;
  const timestamp = (
    <span
      data-role="message-timestamp"
      className={cn(
        "shrink-0 whitespace-nowrap text-[13px] leading-relaxed text-muted-foreground",
        isUser ? "pl-1 pr-2" : "pl-2 pr-1",
      )}
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
        animateEntry &&
          "animate-in fade-in duration-200 motion-reduce:animate-none",
        isUser ? "ml-auto flex-row-reverse gap-3" : "flex-row gap-3",
      )}
      data-role={isUser ? "user-message" : "assistant-message"}
      data-message-fragment-role={fragmentRole}
      {...rowRootAttributes}
    >
      {showPersonaGutterAvatar && showLeadingAssistantChrome ? (
        <div
          className="mt-0.5 flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md"
          data-role="assistant-persona-avatar"
        >
          {assistantDisplayName ? (
            <span className="sr-only">{assistantDisplayName}</span>
          ) : null}
          <AvatarVisual
            avatar={persona?.avatar}
            className="h-full w-full object-contain"
            fallback={
              <div className="flex size-full items-center justify-center bg-muted/40">
                <IconRobot size={16} className="text-muted-foreground" />
              </div>
            }
          />
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
          shouldReserveMessageActionSpace && "pb-9",
          isUser
            ? "max-w-[var(--chat-user-message-max-width)] items-end"
            : "w-full items-start",
        )}
      >
        {showAssistantIdentity ? (
          <div className="mb-0.5 flex items-center gap-1 text-xs">
            {hasPersonaAvatar ? (
              <AvatarVisual
                avatar={persona?.avatar}
                className="h-5 w-5 rounded-full object-cover"
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
          {isBerdctlCrossSessionMessage || isSteeredMessage ? (
            <div className="mb-1 flex flex-col items-start gap-0.5 text-xs font-normal leading-4 text-muted-foreground">
              {isBerdctlCrossSessionMessage ? (
                <span
                  data-role="berdctl-cross-session-message-label"
                  className="leading-4"
                >
                  {berdSenderLabel
                    ? t("message.berdctlCrossSessionNamedLabel", {
                        sender: berdSenderLabel,
                      })
                    : t("message.berdctlCrossSessionLabel")}
                </span>
              ) : null}
              {isSteeredMessage ? (
                <span data-role="steer-message-label" className="leading-4">
                  {t("message.steerLabel")}
                </span>
              ) : null}
            </div>
          ) : null}
          {isUser && messageChips.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {messageChips.map((chip) => (
                <MessageMetadataChip
                  key={`${chip.type}-${chip.id ?? chip.label}`}
                  chip={chip}
                />
              ))}
            </div>
          )}
          {attachmentPreviewItems.length > 0 && (
            <MessageAttachmentGrid items={attachmentPreviewItems} />
          )}
          {groupContentSections(renderedContent).map((section, sectionIdx) => {
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
            if (isUser && block.type === "text") {
              if (!block.text.trim()) return null;
              return couldOverflowUserMessagePreview(block.text) ? (
                <UserMessageClamp
                  key={`${message.id}-${section.key}`}
                  text={block.text}
                  stateKey={section.key}
                />
              ) : (
                <LinkifiedText
                  key={`${message.id}-${section.key}`}
                  text={block.text}
                />
              );
            }
            return (
              <div key={`${message.id}-${section.key}`}>
                {renderContentBlock(
                  block,
                  sectionIdx,
                  {
                    defaultImageAlt: t("message.defaultImageAlt"),
                    redactedThinking: t("message.redactedThinking"),
                    voiceSpeechSpeakingLabel: t(
                      "message.voiceSpeechSpeakingLabel",
                    ),
                    voiceSpeechSpokenLabel: t("message.voiceSpeechSpokenLabel"),
                    voiceSpeechInterruptedLabel: t(
                      "message.voiceSpeechInterruptedLabel",
                    ),
                    voiceSpeechNotSpokenLabel: t(
                      "message.voiceSpeechNotSpokenLabel",
                    ),
                    voiceSpeechFailedLabel: t("message.voiceSpeechFailedLabel"),
                    contentBlocks: renderingContext,
                    onSendMcpAppMessage,
                    onMcpAppAutoScroll,
                    onRunShellCommand,
                    runItCodeRenderers,
                    stateKey: section.key,
                    resolveProviderErrorNotice,
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

        {feedbackSessionId &&
        sessionFeedbackSurvey &&
        (!fragmentRole ||
          fragmentRole === "single" ||
          fragmentRole === "end") ? (
          <SessionFeedbackSurvey
            sessionId={feedbackSessionId}
            survey={sessionFeedbackSurvey}
            measurementOnly={sessionFeedbackSurveyMeasurementOnly}
          />
        ) : null}

        {showMessageActions ? (
          <div
            data-role="message-actions"
            data-copy-confirmed={isCopyConfirmed ? "true" : "false"}
            className={cn(
              "absolute bottom-0 transition-opacity duration-150 ease-out",
              "opacity-0 pointer-events-none",
              !messageActionsArePersistentlyVisible &&
                "group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto",
              messageActionsArePersistentlyVisible &&
                "opacity-100 pointer-events-auto",
              isUser ? "right-0" : "-left-1.5",
            )}
          >
            <MessageBubbleActions
              isUser={isUser}
              messageId={actionMessageId}
              timestamp={timestamp}
              textContent={actionTextContent}
              copied={isCopyConfirmed}
              onCopy={() => copyToClipboard(actionTextContent)}
              onRetryMessage={onRetryMessage}
              onEditMessage={onEditMessage}
              onJumpToResponseStart={
                !isUser && !isStreaming ? onJumpToResponseStart : undefined
              }
              onForkFromMessage={!isStreaming ? onForkFromMessage : undefined}
              responseFeedback={responseFeedback}
              showJumpToResponseStartHint={
                !isUser && !isStreaming ? showJumpToResponseStartHint : false
              }
              onJumpToResponseStartHintClose={onJumpToResponseStartHintClose}
              onJumpToResponseStartHintDismiss={
                onJumpToResponseStartHintDismiss
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  );
});
