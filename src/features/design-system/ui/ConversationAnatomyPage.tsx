import type { ReactNode } from "react";
import { IconBook, IconFile, IconFolder } from "@tabler/icons-react";
import {
  BrainIcon,
  FileText,
  FolderClosed,
  Sparkles,
  User,
} from "lucide-react";

import { ChatInput } from "@/features/chat/ui/ChatInput";
import { ChatInputAttachments } from "@/features/chat/ui/ChatInputAttachments";
import { ChatInputSelectionChips } from "@/features/chat/ui/ChatInputSelectionChips";
import { ChatLoadingSkeleton } from "@/features/chat/ui/ChatLoadingSkeleton";
import { ConversationEmptyAvatar } from "@/features/chat/ui/ConversationEmptyAvatar";
import { McpAppView } from "@/features/chat/ui/McpAppView";
import { MessageBubble } from "@/features/chat/ui/MessageBubble";
import { MessageBubbleActions } from "@/features/chat/ui/MessageBubbleActions";
import { ToolCallAdapter } from "@/features/chat/ui/ToolCallAdapter";
import {
  ToolChainCards,
  type ToolChainItem,
} from "@/features/chat/ui/ToolChainCards";
import { ComposerChip } from "@/features/chat/ui/ComposerChip";
import { ContextRing } from "@/features/chat/ui/ContextRing";
import type {
  ChatAttachmentDraft,
  Message,
  ToolCallStatus,
} from "@/shared/types/messages";
import type { Persona } from "@/shared/types/agents";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/shared/ui/ai-elements/reasoning";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Progress } from "@/shared/ui/progress";

const BASE_TIME = Date.UTC(2026, 5, 19, 10, 0, 0);
const SAMPLE_IMAGE_DATA_URI =
  "data:image/svg+xml,%3Csvg%20width%3D%22320%22%20height%3D%22200%22%20viewBox%3D%220%200%20320%20200%22%20fill%3D%22none%22%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%3E%3Crect%20width%3D%22320%22%20height%3D%22200%22%20rx%3D%2216%22%20fill%3D%22%23F0F0F0%22/%3E%3Ccircle%20cx%3D%2280%22%20cy%3D%2272%22%20r%3D%2230%22%20fill%3D%22%23D6D6D6%22/%3E%3Cpath%20d%3D%22M32%20160L116%20106L168%20142L214%2096L288%20160H32Z%22%20fill%3D%22%23C4C4C4%22/%3E%3C/svg%3E";
const SAMPLE_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ax6pTQAAAAASUVORK5CYII=";

const samplePersona: Persona = {
  id: "gloopy",
  displayName: "Gloopy",
  avatar: null,
  systemPrompt: "You are a helpful agent.",
  provider: "goose",
  model: "gpt-4.1",
  isBuiltin: true,
  writable: false,
};

const sampleSkill = {
  id: "skill-1",
  name: "code-review",
  description: "Review changed files before a PR.",
  sourceLabel: "Skill",
};

const sampleFileAttachment: ChatAttachmentDraft = {
  id: "draft-file",
  kind: "file",
  name: "ConversationAnatomyPage.tsx",
  path: "/Users/morganm/Development/goose-internal/src/features/chat/ui/ConversationAnatomyPage.tsx",
  mimeType: "text/typescript",
};

const sampleDirectoryAttachment: ChatAttachmentDraft = {
  id: "draft-directory",
  kind: "directory",
  name: "src/features/chat",
  path: "/Users/morganm/Development/goose-internal/src/features/chat",
};

const sampleImageAttachment: ChatAttachmentDraft = {
  id: "draft-image",
  kind: "image",
  name: "conversation-screenshot.png",
  path: "/Users/morganm/Desktop/conversation-screenshot.png",
  mimeType: "image/png",
  base64: SAMPLE_IMAGE_BASE64,
  previewUrl: SAMPLE_IMAGE_DATA_URI,
};

function message(
  id: string,
  role: Message["role"],
  content: Message["content"],
  metadata?: Message["metadata"],
): Message {
  return {
    id,
    role,
    created: BASE_TIME,
    content,
    metadata,
  };
}

function noopSend() {
  return true;
}

function PreviewCard({
  title,
  when,
  children,
}: {
  title: string;
  when: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-background p-4">
      <div className="mb-4 flex flex-col gap-1">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground">Shows up {when}</p>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function StatePreview({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="rounded-md border border-border bg-card p-4">
        {children}
      </div>
    </div>
  );
}

function InlinePreview({ children }: { children: ReactNode }) {
  return <div className="max-w-3xl">{children}</div>;
}

const userBasicMessage = message("user-basic", "user", [
  {
    type: "text",
    text: "Can you summarize what changed in this branch?",
  },
]);

const userRichMessage = message(
  "user-rich",
  "user",
  [
    {
      type: "text",
      text: "Use this screenshot and the changed file as context.",
    },
  ],
  {
    chips: [
      { type: "skill", label: "code-review" },
      { type: "extension", label: "developer" },
    ],
    attachments: [
      {
        type: "file",
        name: "ConversationAnatomyPage.tsx",
        path: "/Users/morganm/Development/goose-internal/src/features/chat/ui/ConversationAnatomyPage.tsx",
      },
      {
        type: "directory",
        name: "src/features/chat",
        path: "/Users/morganm/Development/goose-internal/src/features/chat",
      },
    ],
  },
);

const userSteerMessage = message(
  "user-steer",
  "user",
  [
    {
      type: "text",
      text: "Actually, focus only on the conversation UI components.",
    },
  ],
  { delivery: "steer" },
);

const assistantBasicMessage = message(
  "assistant-basic",
  "assistant",
  [
    {
      type: "text",
      text: "This branch adds a design-system page for looking at the conversation UI as individual reusable pieces.",
    },
  ],
  { providerId: "goose" },
);

const assistantMarkdownMessage = message("assistant-markdown", "assistant", [
  {
    type: "text",
    text: "Here are the main pieces:\n\n- User message bubble\n- Assistant response text\n- Tool calls and results\n- Composer attachments\n\n```bash\njust check\n```",
  },
]);

const assistantImageMessage = message("assistant-image", "assistant", [
  {
    type: "image",
    uri: SAMPLE_IMAGE_DATA_URI,
    data: SAMPLE_IMAGE_BASE64,
    mimeType: "image/png",
  },
]);

const systemInfoMessage = message("system-info", "system", [
  {
    type: "systemNotification",
    notificationType: "info",
    text: "Project folder changed for this session.",
  },
]);

const systemWarningMessage = message("system-warning", "system", [
  {
    type: "systemNotification",
    notificationType: "warning",
    text: "The session is reconnecting. Some updates may be delayed.",
  },
]);

const systemErrorMessage = message("system-error", "system", [
  {
    type: "systemNotification",
    notificationType: "error",
    text: "Could not access this project folder.",
    action: { type: "openContextPanel" },
  },
]);

const systemCompactionMessage = message("system-compaction", "system", [
  {
    type: "systemNotification",
    notificationType: "compaction",
    text: "Conversation compacted",
  },
]);

function ToolStatusPreview({ status }: { status: ToolCallStatus }) {
  const isRunning = status === "in_progress";
  const isError = status === "failed";
  const isStopped = status === "stopped";

  return (
    <ToolCallAdapter
      name={
        isRunning
          ? "shell · just check"
          : isError
            ? "read file src/features/chat/MissingFile.tsx"
            : isStopped
              ? "shell · pnpm test --watch"
              : "read file src/features/chat/ui/MessageBubble.tsx"
      }
      arguments={
        isRunning
          ? { command: "just check" }
          : isError
            ? { path: "src/features/chat/MissingFile.tsx" }
            : isStopped
              ? { command: "pnpm test --watch" }
              : { path: "src/features/chat/ui/MessageBubble.tsx" }
      }
      status={status}
      startedAt={isRunning ? Date.now() - 7000 : undefined}
      result={
        isError
          ? "No such file or directory"
          : status === "completed"
            ? "Read 748 lines from MessageBubble.tsx."
            : undefined
      }
      isError={isError}
      open={status === "completed" || isError}
      locations={
        status === "completed"
          ? [
              {
                path: "src/features/chat/ui/MessageBubble.tsx",
                line: 1,
              },
            ]
          : undefined
      }
    />
  );
}

const groupedToolChain: ToolChainItem[] = [
  {
    key: "chain-read",
    request: {
      type: "toolRequest",
      id: "chain-read",
      name: "read file src/features/chat/ui/MessageBubble.tsx",
      arguments: { path: "src/features/chat/ui/MessageBubble.tsx" },
      status: "completed",
    },
    response: {
      type: "toolResponse",
      id: "chain-read",
      name: "read file src/features/chat/ui/MessageBubble.tsx",
      result: "Loaded the message renderer.",
      isError: false,
    },
  },
  {
    key: "chain-search",
    request: {
      type: "toolRequest",
      id: "chain-search",
      name: "search conversation components",
      arguments: { query: "MessageBubble ToolCallAdapter ChatInput" },
      status: "completed",
    },
    response: {
      type: "toolResponse",
      id: "chain-search",
      name: "search conversation components",
      result: "Found 12 matching files.",
      isError: false,
    },
  },
  {
    key: "chain-write",
    request: {
      type: "toolRequest",
      id: "chain-write",
      name: "edit file ConversationAnatomyPage.tsx",
      arguments: {
        path: "src/features/design-system/ui/ConversationAnatomyPage.tsx",
      },
      status: "completed",
    },
    response: {
      type: "toolResponse",
      id: "chain-write",
      name: "edit file ConversationAnatomyPage.tsx",
      result: "Updated the page.",
      isError: false,
    },
  },
];

const runningToolChain: ToolChainItem[] = [
  {
    key: "running-read",
    request: {
      type: "toolRequest",
      id: "running-read",
      name: "read file DesignSystemView.tsx",
      arguments: { path: "src/features/design-system/ui/DesignSystemView.tsx" },
      status: "completed",
    },
    response: {
      type: "toolResponse",
      id: "running-read",
      name: "read file DesignSystemView.tsx",
      result: "Loaded the design-system view.",
      isError: false,
    },
  },
  {
    key: "running-check",
    request: {
      type: "toolRequest",
      id: "running-check",
      name: "shell · just check",
      arguments: { command: "just check" },
      status: "in_progress",
      startedAt: Date.now() - 4000,
    },
  },
];

function MentionMenuPreview({
  state,
}: {
  state: "agents" | "files" | "skills" | "empty";
}) {
  const isFiles = state === "files";
  const isSkills = state === "skills";
  const isEmpty = state === "empty";

  return (
    <div className="w-72 rounded-md bg-popover p-2 text-popover-foreground shadow-popover">
      <div className="flex gap-1 pb-2">
        <Badge variant={!isFiles && !isSkills ? "secondary" : "outline"}>
          Agents @
        </Badge>
        <Badge variant={isFiles ? "secondary" : "outline"}>Files @</Badge>
        <Badge variant={isSkills ? "secondary" : "outline"}>Skills /</Badge>
      </div>
      <div className="space-y-0.5">
        {isEmpty ? (
          <div className="px-2 py-2 text-sm text-muted-foreground">
            No matches
          </div>
        ) : isFiles ? (
          <>
            <MentionRow
              icon={<IconFile className="size-4" />}
              title="MessageBubble.tsx"
              subtitle="src/features/chat/ui"
              active
            />
            <MentionRow
              icon={<IconFolder className="size-4" />}
              title="chat"
              subtitle="src/features"
            />
          </>
        ) : isSkills ? (
          <>
            <MentionRow
              icon={<IconBook className="size-4" />}
              title="code-review"
              subtitle="Review changed files before a PR"
              active
            />
            <MentionRow
              icon={<IconBook className="size-4" />}
              title="frontend-design"
              subtitle="Build polished frontend UI"
            />
          </>
        ) : (
          <>
            <MentionRow
              icon={<Sparkles className="size-4" />}
              title="Gloopy"
              subtitle="goose / gpt-4.1"
              active
            />
            <MentionRow
              icon={<User className="size-4" />}
              title="System Designer"
              subtitle="claude / sonnet"
            />
          </>
        )}
      </div>
    </div>
  );
}

function MentionRow({
  icon,
  title,
  subtitle,
  active = false,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  active?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2.5 rounded-md px-2 py-2 text-left ${
        active ? "bg-accent text-foreground" : "text-foreground"
      }`}
    >
      <div className="flex size-7 shrink-0 items-center justify-center">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-normal">{title}</div>
        <div className="truncate text-xs text-muted-foreground/60">
          {subtitle}
        </div>
      </div>
    </div>
  );
}

function QueuedPillPreview() {
  return (
    <div
      data-slot="queued-message"
      className="flex items-center gap-2 rounded-full bg-surface-chat-responding-pill-bg px-3 py-1.5 text-surface-chat-responding-pill-fg shadow-[var(--shadow-chat)]"
    >
      <span className="flex-1 truncate text-xs opacity-75">
        Queued: Also compare it against the previous design.
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="h-5 rounded-full px-2 text-current opacity-75 hover:bg-surface-chat-responding-pill-fg/15 hover:text-current hover:opacity-100"
      >
        Steer
      </Button>
    </div>
  );
}

function ComponentGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 xl:grid-cols-2">{children}</div>;
}

export function ConversationAnatomyPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-normal tracking-tight text-foreground">
          Conversation anatomy
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Visual catalog of the conversation UI pieces and their common states.
        </p>
      </div>

      <ComponentGrid>
        <PreviewCard
          title="MessageBubble · user"
          when="after the user sends a message."
        >
          <StatePreview label="Default">
            <InlinePreview>
              <MessageBubble message={userBasicMessage} animateEntry={false} />
            </InlinePreview>
          </StatePreview>
          <StatePreview label="With chips and attachments">
            <InlinePreview>
              <MessageBubble message={userRichMessage} animateEntry={false} />
            </InlinePreview>
          </StatePreview>
          <StatePreview label="Steering an active run">
            <InlinePreview>
              <MessageBubble message={userSteerMessage} animateEntry={false} />
            </InlinePreview>
          </StatePreview>
        </PreviewCard>

        <PreviewCard
          title="MessageBubble · assistant"
          when="when the agent replies with text or markdown."
        >
          <StatePreview label="Plain response">
            <InlinePreview>
              <MessageBubble
                message={assistantBasicMessage}
                animateEntry={false}
              />
            </InlinePreview>
          </StatePreview>
          <StatePreview label="Markdown and code">
            <InlinePreview>
              <MessageBubble
                message={assistantMarkdownMessage}
                animateEntry={false}
              />
            </InlinePreview>
          </StatePreview>
          <StatePreview label="Streaming tail">
            <InlinePreview>
              <MessageBubble
                message={assistantBasicMessage}
                isStreaming
                animateEntry={false}
              />
            </InlinePreview>
          </StatePreview>
        </PreviewCard>

        <PreviewCard
          title="ClickableImage"
          when="when an image appears in a message."
        >
          <StatePreview label="Assistant image">
            <InlinePreview>
              <MessageBubble
                message={assistantImageMessage}
                animateEntry={false}
              />
            </InlinePreview>
          </StatePreview>
        </PreviewCard>

        <PreviewCard
          title="MessageBubbleActions"
          when="on hover/focus for message copy, retry, edit, and timestamp actions."
        >
          <StatePreview label="Assistant actions">
            <MessageBubbleActions
              isUser={false}
              messageId="assistant-actions"
              timestamp={
                <span className="px-1 text-[13px] text-muted-foreground">
                  10:04 AM
                </span>
              }
              textContent="This can be copied."
              copied={false}
              onCopy={() => {}}
              onRetryMessage={() => {}}
            />
          </StatePreview>
          <StatePreview label="User actions, copied">
            <MessageBubbleActions
              isUser
              messageId="user-actions"
              timestamp={
                <span className="px-1 text-[13px] text-muted-foreground">
                  10:05 AM
                </span>
              }
              textContent="This was copied."
              copied
              onCopy={() => {}}
              onEditMessage={() => {}}
            />
          </StatePreview>
        </PreviewCard>
      </ComponentGrid>

      <ComponentGrid>
        <PreviewCard
          title="Reasoning"
          when="when the model sends thinking or reasoning content."
        >
          <StatePreview label="Collapsed">
            <Reasoning
              defaultOpen={false}
              stateKey="catalog-reasoning-collapsed"
            >
              <ReasoningTrigger />
              <ReasoningContent>
                I need to inspect the changed files, identify the conversation
                pieces, and group them visually.
              </ReasoningContent>
            </Reasoning>
          </StatePreview>
          <StatePreview label="Expanded">
            <Reasoning open stateKey="catalog-reasoning-open">
              <ReasoningTrigger />
              <ReasoningContent>
                I need to inspect the changed files, identify the conversation
                pieces, and group them visually.
              </ReasoningContent>
            </Reasoning>
          </StatePreview>
          <StatePreview label="Streaming">
            <Reasoning isStreaming open stateKey="catalog-reasoning-streaming">
              <ReasoningTrigger />
              <ReasoningContent>
                Checking the transcript components and grouping the examples by
                what the user actually sees.
              </ReasoningContent>
            </Reasoning>
          </StatePreview>
          <StatePreview label="Redacted thinking">
            <div className="text-xs italic text-muted-foreground">
              (thinking redacted)
            </div>
          </StatePreview>
        </PreviewCard>

        <PreviewCard
          title="ToolCallAdapter"
          when="when the agent runs one tool or command."
        >
          <StatePreview label="Pending">
            <ToolStatusPreview status="pending" />
          </StatePreview>
          <StatePreview label="Running">
            <ToolStatusPreview status="in_progress" />
          </StatePreview>
          <StatePreview label="Completed with file output">
            <ToolStatusPreview status="completed" />
          </StatePreview>
          <StatePreview label="Failed">
            <ToolStatusPreview status="failed" />
          </StatePreview>
          <StatePreview label="Stopped">
            <ToolStatusPreview status="stopped" />
          </StatePreview>
        </PreviewCard>

        <PreviewCard
          title="ToolChainCards"
          when="when multiple tool calls are grouped into one agent work sequence."
        >
          <StatePreview label="Collapsed complete chain">
            <ToolChainCards
              chainId="catalog-collapsed-chain"
              toolItems={groupedToolChain}
              externalChainExpanded={false}
            />
          </StatePreview>
          <StatePreview label="Expanded complete chain">
            <ToolChainCards
              chainId="catalog-expanded-chain"
              toolItems={groupedToolChain}
              externalChainExpanded
            />
          </StatePreview>
          <StatePreview label="Running chain">
            <ToolChainCards
              chainId="catalog-running-chain"
              toolItems={runningToolChain}
              externalChainExpanded
            />
          </StatePreview>
        </PreviewCard>

        <PreviewCard
          title="McpAppView"
          when="when a tool returns an embedded MCP app resource."
        >
          <StatePreview label="Fallback/error">
            <McpAppView
              payload={{
                sessionId: "catalog-session",
                toolCallId: "catalog-mcp",
                toolCallTitle: "Preview MCP app",
                source: "toolCallUpdateMeta",
                tool: {
                  name: "preview_app",
                  extensionName: "demo",
                  resourceUri: "ui://demo/preview",
                },
                resource: {
                  result: null,
                  readError: "The embedded app resource could not be loaded.",
                },
              }}
            />
          </StatePreview>
        </PreviewCard>
      </ComponentGrid>

      <ComponentGrid>
        <PreviewCard
          title="System notification"
          when="when the renderer needs to show local session status."
        >
          <StatePreview label="Info">
            <MessageBubble message={systemInfoMessage} animateEntry={false} />
          </StatePreview>
          <StatePreview label="Warning">
            <MessageBubble
              message={systemWarningMessage}
              animateEntry={false}
            />
          </StatePreview>
          <StatePreview label="Error with action">
            <MessageBubble
              message={systemErrorMessage}
              animateEntry={false}
              onOpenContextPanel={() => {}}
            />
          </StatePreview>
          <StatePreview label="Compaction complete">
            <MessageBubble
              message={systemCompactionMessage}
              animateEntry={false}
            />
          </StatePreview>
        </PreviewCard>

        <PreviewCard
          title="ChatInputAttachments"
          when="when files, folders, or images are attached before sending."
        >
          <StatePreview label="Image, file, and folder drafts">
            <ChatInputAttachments
              attachments={[
                sampleImageAttachment,
                sampleFileAttachment,
                sampleDirectoryAttachment,
              ]}
              onRemove={() => {}}
            />
          </StatePreview>
        </PreviewCard>

        <PreviewCard
          title="ChatInputSelectionChips"
          when="when a persona or skill is selected for the next message."
        >
          <StatePreview label="Persona and skill chips">
            <ChatInputSelectionChips
              persona={samplePersona}
              skills={[sampleSkill]}
              onRemovePersona={() => {}}
              onRemoveSkill={() => {}}
            />
          </StatePreview>
          <StatePreview label="Standalone chip tones">
            <div className="flex flex-wrap gap-2">
              <ComposerChip
                tone="file"
                label="File"
                leading={<FileText className="size-3.5" />}
                removeLabel="Remove file"
                onRemove={() => {}}
              />
              <ComposerChip
                tone="agent"
                label="Agent"
                leading={<Sparkles className="size-3.5" />}
                removeLabel="Remove agent"
                onRemove={() => {}}
              />
              <ComposerChip
                tone="skill"
                label="Skill"
                leading={<BrainIcon className="size-3.5" />}
                removeLabel="Remove skill"
                onRemove={() => {}}
              />
              <ComposerChip
                tone="automation"
                label="Automation"
                leading={<FolderClosed className="size-3.5" />}
                removeLabel="Remove automation"
                onRemove={() => {}}
              />
            </div>
          </StatePreview>
        </PreviewCard>

        <PreviewCard
          title="Mention autocomplete"
          when="when the user types @ or / in the composer."
        >
          <StatePreview label="Agents">
            <MentionMenuPreview state="agents" />
          </StatePreview>
          <StatePreview label="Files">
            <MentionMenuPreview state="files" />
          </StatePreview>
          <StatePreview label="Skills">
            <MentionMenuPreview state="skills" />
          </StatePreview>
          <StatePreview label="Empty">
            <MentionMenuPreview state="empty" />
          </StatePreview>
        </PreviewCard>
      </ComponentGrid>

      <ComponentGrid>
        <PreviewCard
          title="ChatInput"
          when="at the bottom of an editable conversation."
        >
          <StatePreview label="Empty composer">
            <ChatInput
              composerActions={{ onSend: noopSend }}
              controls={{ autoFocus: false, voice: false }}
              surface="bare"
            />
          </StatePreview>
          <StatePreview label="Draft with selected skill">
            <ChatInput
              composerActions={{ onSend: noopSend }}
              initialValue="Redesign the tool cards to make the hierarchy clearer."
              selectedSkills={[sampleSkill]}
              onSkillsChange={() => {}}
              controls={{ autoFocus: false, voice: false }}
              surface="bare"
            />
          </StatePreview>
          <StatePreview label="Streaming with queued message">
            <ChatInput
              composerActions={{
                onSend: noopSend,
                onStop: () => {},
                isStreaming: true,
                canSteerQueuedMessage: true,
                onSteerQueuedMessage: () => true,
                queuedMessage: {
                  text: "Also compare it against the previous design.",
                  persona: { kind: "inherit" },
                },
                onDismissQueue: () => {},
              }}
              controls={{ autoFocus: false, voice: false }}
              surface="bare"
            />
          </StatePreview>
        </PreviewCard>

        <PreviewCard
          title="Queued message pill"
          when="when a second message is waiting while the agent is still running."
        >
          <StatePreview label="Queued">
            <QueuedPillPreview />
          </StatePreview>
        </PreviewCard>

        <PreviewCard
          title="ContextRing"
          when="when context usage is available in the composer toolbar."
        >
          <StatePreview label="Low, medium, and high usage">
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2 text-sm">
                <ContextRing tokens={12_000} limit={200_000} size={18} />
                <span>Low</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <ContextRing tokens={96_000} limit={200_000} size={18} />
                <span>Medium</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <ContextRing tokens={184_000} limit={200_000} size={18} />
                <span>High</span>
              </div>
            </div>
          </StatePreview>
          <StatePreview label="Popover contents">
            <div className="w-60 rounded-md bg-popover p-3 text-popover-foreground shadow-popover">
              <div className="mb-2 text-sm font-semibold">Context window</div>
              <Progress className="h-1.5 bg-muted" value={72} />
              <div className="mt-2 flex justify-between gap-3 text-xs text-foreground">
                <span>144K / 200K tokens</span>
                <span>72%</span>
              </div>
            </div>
          </StatePreview>
        </PreviewCard>

        <PreviewCard
          title="Conversation loading and empty states"
          when="before the transcript has messages."
        >
          <StatePreview label="Loading conversation">
            <div className="h-96 overflow-hidden rounded-md bg-background">
              <ChatLoadingSkeleton />
            </div>
          </StatePreview>
          <StatePreview label="Empty conversation">
            <div className="flex min-h-80 flex-col items-center justify-center px-6">
              <div className="pb-4">
                <ConversationEmptyAvatar persona={samplePersona} />
              </div>
              <p className="text-sm font-normal text-foreground">
                Start a conversation
              </p>
            </div>
          </StatePreview>
        </PreviewCard>
      </ComponentGrid>
    </div>
  );
}
