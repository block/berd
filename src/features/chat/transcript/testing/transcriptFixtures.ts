import type {
  ChatAttachmentDraft,
  Message,
  MessageAttachment,
  MessageContent,
  MessageRole,
  ToolCallStatus,
} from "@/shared/types/messages";

export const TRANSCRIPT_FIXTURE_VERSION = "2026-06-04.v1";
export const TRANSCRIPT_FIXTURE_BASE_TIME = Date.UTC(2026, 5, 4, 14, 0, 0);

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const TRANSPARENT_PNG_DATA =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ax6pTQAAAAASUVORK5CYII=";

export type TranscriptFixtureName =
  | "long-10k"
  | "huge-assistant-output"
  | "tool-chain-storm"
  | "mcp-dynamic-rows"
  | "dynamic-media-code"
  | "composer-growth-session-switch"
  | "pr928-fragment-tail"
  | "streaming-scrollback-long-markdown"
  | "visual-spacing-date-footer"
  | "visual-spacing-fragmented-assistant"
  | "visual-spacing-rich-blocks";

export type TranscriptRendererMode = "legacy" | "virtual";

export type TranscriptHarnessOperation =
  | {
      kind: "restore";
      atMs: number;
      sessionId: string;
      scrollPosition: "tail" | "top" | "middle";
    }
  | {
      kind: "scroll";
      atMs: number;
      direction: "up" | "down";
      pixels: number;
      expectedAnchor: "bottom" | "row";
    }
  | {
      kind: "prependMessages";
      atMs: number;
      sessionId: string;
      count: number;
      anchorMessageId: string;
    }
  | {
      kind: "appendStreamingText";
      atMs: number;
      sessionId: string;
      messageId: string;
      chunks: readonly string[];
      chunkIntervalMs: number;
    }
  | {
      kind: "startStreamingText";
      atMs: number;
      sessionId: string;
      messageId: string;
      chunks: readonly string[];
      chunkIntervalMs: number;
      streamId?: string;
    }
  | {
      kind: "waitForStreamingText";
      atMs: number;
      streamId?: string;
    }
  | {
      kind: "finishStreamingText";
      atMs: number;
      sessionId: string;
      messageId: string;
      streamId?: string;
    }
  | {
      kind: "stopStreamingText";
      atMs: number;
      sessionId: string;
      messageId: string;
      streamId?: string;
    }
  | {
      kind: "resizeMcpApp";
      atMs: number;
      sessionId: string;
      messageId: string;
      blockId: string;
      heights: readonly number[];
    }
  | {
      kind: "imageLoad";
      atMs: number;
      sessionId: string;
      messageId: string;
      blockIndex: number;
      height: number;
    }
  | {
      kind: "codeHighlightComplete";
      atMs: number;
      sessionId: string;
      messageId: string;
      blockIndex: number;
      heightDelta: number;
    }
  | {
      kind: "composerResize";
      atMs: number;
      height: number;
      attachments: readonly ChatAttachmentDraft[];
      queuedMessage: string | null;
    }
  | {
      kind: "toggleSurface";
      atMs: number;
      surface: "right-rail" | "terminal" | "compact-width" | "dark-mode";
      enabled: boolean;
    }
  | {
      kind: "controlledScrollTarget";
      atMs: number;
      sessionId: string;
      messageId: string;
      waitForVisible?: boolean;
    }
  | {
      kind: "scrollToRowOffset";
      atMs: number;
      sessionId: string;
      messageId: string;
      offsetPx: number;
      expectedAnchor: "row";
    }
  | {
      kind: "changeRowRevision";
      atMs: number;
      sessionId: string;
      messageId: string;
      nextHeightRevision: string;
      nextRenderRevision?: string;
    }
  | {
      kind: "splitMessageRows";
      atMs: number;
      sessionId: string;
      messageId: string;
      fragments: readonly TranscriptFixtureFragmentRow[];
    }
  | {
      kind: "promoteStreamingTail";
      atMs: number;
      sessionId: string;
      messageId: string;
      completedFragment: TranscriptFixtureFragmentRow;
      nextTail: TranscriptFixtureFragmentRow;
    }
  | {
      kind: "switchSession";
      atMs: number;
      fromSessionId: string;
      toSessionId: string;
      pendingAsyncWork: readonly string[];
    }
  | {
      kind: "mcpFocus" | "mcpOverlay";
      atMs: number;
      messageId: string;
      active?: boolean;
      sourceId?: string;
      nowMs?: number;
    }
  | {
      kind:
        | "mcpHostWork"
        | "mcpNestedToolWork"
        | "mcpRecentMessage"
        | "mcpRecentResize";
      atMs: number;
      messageId: string;
      active?: boolean;
      sourceId?: string;
      nowMs?: number;
      ttlMs?: number;
    }
  | {
      kind: "mcpClearProtections";
      atMs: number;
    };

export interface TranscriptFixtureFragmentRow {
  idSuffix: string;
  height: number;
  heightRevision: string;
  renderRevision?: string;
  anchorPriority?: "stable" | "streaming" | "none";
  text?: string;
}

export interface TranscriptFixtureSession {
  sessionId: string;
  title: string;
  messages: readonly Message[];
  streamingMessageId?: string | null;
}

export interface TranscriptFixtureExpectations {
  logicalMessageCount: number;
  minLogicalRows: number;
  maxInitialMountedRows: number;
  maxProtectedRows: number;
  dynamicRowCount: number;
  toolCallCount: number;
  mcpAppCount: number;
  imageCount: number;
  codeFenceLineCount: number;
}

export interface TranscriptFixture {
  version: typeof TRANSCRIPT_FIXTURE_VERSION;
  name: TranscriptFixtureName;
  description: string;
  activeSessionId: string;
  sessions: readonly TranscriptFixtureSession[];
  operations: readonly TranscriptHarnessOperation[];
  expectations: TranscriptFixtureExpectations;
}

type ValidationMessageMetadata = Message["metadata"] & {
  validationAnchorPriority?: "stable" | "streaming" | "none";
  validationHeightRevision?: string;
  validationRenderRevision?: string;
  validationRowHeight?: number;
  validationRowIdSuffix?: string;
};

export interface LongTranscriptOptions {
  messageCount?: number;
}

export interface HugeAssistantOutputOptions {
  codeLineCount?: number;
}

export interface ToolChainStormOptions {
  messageCount?: number;
  toolsPerMessage?: number;
}

function numericId(index: number, width = 5): string {
  return String(index).padStart(width, "0");
}

function textMessage(
  id: string,
  role: MessageRole,
  created: number,
  text: string,
  metadata?: Message["metadata"],
): Message {
  return {
    id,
    role,
    created,
    content: [{ type: "text", text }],
    metadata: metadata ?? { userVisible: true },
  };
}

function messageAttachment(index: number): MessageAttachment {
  return {
    type: "file",
    name: `fixture-${numericId(index, 4)}.ts`,
    path: `/fixture/workspace/src/fixture-${numericId(index, 4)}.ts`,
    mimeType: "text/typescript",
  };
}

function deterministicShortText(index: number, role: MessageRole): string {
  const topic = [
    "projection cache",
    "scroll anchor",
    "measurement token",
    "MCP resize",
    "footer geometry",
    "fragment tail",
  ][index % 6];
  const cadence = index % 2 === 0 ? "request" : "reply";
  return `${cadence} ${numericId(index)} ${role} validates ${topic} with stable row identity.`;
}

function buildLongMessages(messageCount: number): Message[] {
  return Array.from({ length: messageCount }, (_, index) => {
    const role: MessageRole = index % 2 === 0 ? "user" : "assistant";
    const created =
      TRANSCRIPT_FIXTURE_BASE_TIME +
      Math.floor(index / 360) * DAY_MS +
      (index % 360) * 4 * MINUTE_MS;
    const metadata: Message["metadata"] = {
      userVisible: true,
      agentVisible: true,
      ...(index % 250 === 0 ? { attachments: [messageAttachment(index)] } : {}),
      ...(index % 333 === 0
        ? { chips: [{ label: "validation", type: "skill" }] }
        : {}),
    };

    return textMessage(
      `long-${numericId(index)}`,
      role,
      created,
      deterministicShortText(index, role),
      metadata,
    );
  });
}

function buildHugeMarkdown(codeLineCount: number): string {
  const codeLines = Array.from(
    { length: codeLineCount },
    (_, index) =>
      `  const row${numericId(index, 4)} = measure("${numericId(index, 4)}", ${index});`,
  );

  return [
    "# Virtual transcript stress response",
    "",
    "This response combines headings, lists, tables, long prose, and a large TypeScript code fence.",
    "",
    "## Requirements",
    "",
    "- preserve bottom follow",
    "- keep detached anchors stable",
    "- avoid remounting stateful rows",
    "- split completed fragments from the mutable tail",
    "",
    "| scenario | expected |",
    "| --- | --- |",
    "| huge answer | fragment rows |",
    "| code fence | stable highlighted layout |",
    "",
    "```ts",
    ...codeLines,
    "```",
    "",
    "The mutable tail should be the only changing fragment during streaming.",
  ].join("\n");
}

function buildToolContent(
  messageIndex: number,
  toolsPerMessage: number,
): MessageContent[] {
  const content: MessageContent[] = [
    {
      type: "reasoning",
      text: `Reasoning block for tool-chain assistant message ${numericId(messageIndex, 4)}.`,
    },
  ];

  for (let toolIndex = 0; toolIndex < toolsPerMessage; toolIndex += 1) {
    const toolId = `tool-${numericId(messageIndex, 4)}-${numericId(toolIndex, 2)}`;
    const status: ToolCallStatus =
      toolIndex === toolsPerMessage - 1 && messageIndex % 5 === 0
        ? "in_progress"
        : "completed";
    content.push({
      type: "toolRequest",
      id: toolId,
      name: `fixture.search.${numericId(toolIndex, 2)}`,
      toolName: "search",
      extensionName: "fixture",
      arguments: {
        query: `row ${messageIndex} tool ${toolIndex}`,
        limit: 20 + (toolIndex % 5),
      },
      status,
      chainSummary: {
        summary: `Tool chain ${numericId(messageIndex, 4)}`,
        count: toolsPerMessage,
      },
    });
    content.push({
      type: "toolResponse",
      id: toolId,
      name: `fixture.search.${numericId(toolIndex, 2)}`,
      result: `result ${numericId(messageIndex, 4)}.${numericId(toolIndex, 2)}`,
      isError: messageIndex % 17 === 0 && toolIndex === 1,
    });
  }

  content.push({
    type: "text",
    text: `Assistant summarized ${toolsPerMessage} tool calls for row ${numericId(messageIndex, 4)}.`,
  });

  return content;
}

function buildMcpAppContent(index: number): MessageContent[] {
  const blockId = `mcp-block-${numericId(index, 3)}`;
  const toolCallId = `mcp-tool-${numericId(index, 3)}`;

  return [
    {
      type: "toolRequest",
      id: toolCallId,
      name: "fixture.open_dashboard",
      toolName: "open_dashboard",
      extensionName: "fixture-mcp",
      arguments: { panel: index % 4, resize: true },
      status: "completed",
    },
    {
      type: "toolResponse",
      id: toolCallId,
      name: "fixture.open_dashboard",
      result: "opened",
      isError: false,
    },
    {
      type: "mcpApp",
      id: blockId,
      payload: {
        sessionId: "fixture-mcp-session",
        toolCallId,
        toolCallTitle: `Dashboard ${index}`,
        source: "toolCallUpdateMeta",
        tool: {
          name: "fixture__open_dashboard",
          extensionName: "fixture-mcp",
          resourceUri: `ui://fixture/dashboard/${index}`,
        },
        resource: {
          result: {
            contents: [
              {
                uri: `ui://fixture/dashboard/${index}`,
                mimeType: "text/html;profile=mcp-app",
                text: `<section data-fixture-dashboard="${index}">Dashboard ${index}</section>`,
              },
            ],
          },
        },
      },
    },
  ];
}

function buildImageBlock(index: number): MessageContent {
  return {
    type: "image",
    data: TRANSPARENT_PNG_DATA,
    mimeType: "image/png",
    uri: `fixture://image/${numericId(index, 3)}.png`,
  };
}

function buildLong10kFixture(
  options: LongTranscriptOptions = {},
): TranscriptFixture {
  const messageCount = options.messageCount ?? 10_000;
  const sessionId = "fixture-long-10k";
  const messages = buildLongMessages(messageCount);

  return {
    version: TRANSCRIPT_FIXTURE_VERSION,
    name: "long-10k",
    description:
      "Alternating 10,000-message transcript with date separators, attachments, and skill chips.",
    activeSessionId: sessionId,
    sessions: [{ sessionId, title: "Long 10k transcript", messages }],
    operations: [
      { kind: "restore", atMs: 0, sessionId, scrollPosition: "tail" },
      {
        kind: "scroll",
        atMs: 400,
        direction: "up",
        pixels: 18_000,
        expectedAnchor: "row",
      },
      {
        kind: "prependMessages",
        atMs: 900,
        sessionId,
        count: 120,
        anchorMessageId: "long-000720",
      },
      {
        kind: "controlledScrollTarget",
        atMs: 1_400,
        sessionId,
        messageId: "long-009500",
      },
      {
        kind: "scroll",
        atMs: 1_900,
        direction: "down",
        pixels: 24_000,
        expectedAnchor: "bottom",
      },
    ],
    expectations: {
      logicalMessageCount: messageCount,
      minLogicalRows: messageCount + Math.ceil(messageCount / 360),
      maxInitialMountedRows: 140,
      maxProtectedRows: 32,
      dynamicRowCount: 0,
      toolCallCount: 0,
      mcpAppCount: 0,
      imageCount: 0,
      codeFenceLineCount: 0,
    },
  };
}

function buildHugeAssistantOutputFixture(
  options: HugeAssistantOutputOptions = {},
): TranscriptFixture {
  const codeLineCount = options.codeLineCount ?? 5_000;
  const sessionId = "fixture-huge-output";
  const assistantId = "huge-assistant-0001";
  const messages: Message[] = [
    textMessage(
      "huge-user-0000",
      "user",
      TRANSCRIPT_FIXTURE_BASE_TIME,
      "Produce a very large implementation summary with code.",
    ),
    textMessage(
      assistantId,
      "assistant",
      TRANSCRIPT_FIXTURE_BASE_TIME + MINUTE_MS,
      buildHugeMarkdown(codeLineCount),
      {
        userVisible: true,
        agentVisible: true,
        completionStatus: "inProgress",
      },
    ),
  ];

  return {
    version: TRANSCRIPT_FIXTURE_VERSION,
    name: "huge-assistant-output",
    description:
      "One assistant row with a multi-thousand-line markdown/code payload and streaming tail chunks.",
    activeSessionId: sessionId,
    sessions: [
      {
        sessionId,
        title: "Huge assistant output",
        messages,
        streamingMessageId: assistantId,
      },
    ],
    operations: [
      { kind: "restore", atMs: 0, sessionId, scrollPosition: "tail" },
      {
        kind: "appendStreamingText",
        atMs: 250,
        sessionId,
        messageId: assistantId,
        chunks: [
          "\n\nStreaming tail 1: complete fragment stays stable.",
          "\nStreaming tail 2: only mutable tail changes.",
          "\nStreaming tail 3: final code fence measurement is isolated.",
        ],
        chunkIntervalMs: 16,
      },
      {
        kind: "scroll",
        atMs: 700,
        direction: "up",
        pixels: 4_800,
        expectedAnchor: "row",
      },
    ],
    expectations: {
      logicalMessageCount: messages.length,
      minLogicalRows: 80,
      maxInitialMountedRows: 140,
      maxProtectedRows: 32,
      dynamicRowCount: 1,
      toolCallCount: 0,
      mcpAppCount: 0,
      imageCount: 0,
      codeFenceLineCount: codeLineCount,
    },
  };
}

function buildToolChainStormFixture(
  options: ToolChainStormOptions = {},
): TranscriptFixture {
  const messageCount = options.messageCount ?? 320;
  const toolsPerMessage = options.toolsPerMessage ?? 8;
  const sessionId = "fixture-tool-chain-storm";
  const messages = Array.from({ length: messageCount }, (_, index): Message => {
    const created = TRANSCRIPT_FIXTURE_BASE_TIME + index * 2 * MINUTE_MS;

    return {
      id: `tool-chain-${numericId(index, 4)}`,
      role: "assistant",
      created,
      content: buildToolContent(index, toolsPerMessage),
      metadata: {
        userVisible: true,
        agentVisible: true,
        completionStatus: index % 5 === 0 ? "inProgress" : "completed",
      },
    };
  });

  return {
    version: TRANSCRIPT_FIXTURE_VERSION,
    name: "tool-chain-storm",
    description:
      "Hundreds of assistant messages with repeated tool request/response chains and reasoning state.",
    activeSessionId: sessionId,
    sessions: [{ sessionId, title: "Tool chain storm", messages }],
    operations: [
      { kind: "restore", atMs: 0, sessionId, scrollPosition: "tail" },
      {
        kind: "scroll",
        atMs: 300,
        direction: "up",
        pixels: 9_000,
        expectedAnchor: "row",
      },
      {
        kind: "appendStreamingText",
        atMs: 700,
        sessionId,
        messageId: "tool-chain-0000",
        chunks: ["\nTool timer tick.", "\nTool final output."],
        chunkIntervalMs: 50,
      },
    ],
    expectations: {
      logicalMessageCount: messages.length,
      minLogicalRows: messages.length,
      maxInitialMountedRows: 120,
      maxProtectedRows: 48,
      dynamicRowCount: Math.ceil(messageCount / 5),
      toolCallCount: messageCount * toolsPerMessage,
      mcpAppCount: 0,
      imageCount: 0,
      codeFenceLineCount: 0,
    },
  };
}

function buildMcpDynamicRowsFixture(): TranscriptFixture {
  const sessionId = "fixture-mcp-dynamic";
  const messages = Array.from(
    { length: 36 },
    (_, index): Message => ({
      id: `mcp-message-${numericId(index, 3)}`,
      role: "assistant",
      created: TRANSCRIPT_FIXTURE_BASE_TIME + index * 5 * MINUTE_MS,
      content: buildMcpAppContent(index),
      metadata: { userVisible: true, agentVisible: true },
    }),
  );

  return {
    version: TRANSCRIPT_FIXTURE_VERSION,
    name: "mcp-dynamic-rows",
    description:
      "MCP-like app rows with host payloads and scripted iframe resize events.",
    activeSessionId: sessionId,
    sessions: [{ sessionId, title: "MCP dynamic rows", messages }],
    operations: [
      { kind: "restore", atMs: 0, sessionId, scrollPosition: "tail" },
      {
        kind: "resizeMcpApp",
        atMs: 220,
        sessionId,
        messageId: "mcp-message-030",
        blockId: "mcp-block-030",
        heights: [180, 420, 260, 512],
      },
      {
        kind: "scroll",
        atMs: 600,
        direction: "up",
        pixels: 3_400,
        expectedAnchor: "row",
      },
      {
        kind: "resizeMcpApp",
        atMs: 900,
        sessionId,
        messageId: "mcp-message-012",
        blockId: "mcp-block-012",
        heights: [220, 640],
      },
    ],
    expectations: {
      logicalMessageCount: messages.length,
      minLogicalRows: messages.length,
      maxInitialMountedRows: 90,
      maxProtectedRows: 40,
      dynamicRowCount: messages.length,
      toolCallCount: messages.length,
      mcpAppCount: messages.length,
      imageCount: 0,
      codeFenceLineCount: 0,
    },
  };
}

function buildDynamicMediaCodeFixture(): TranscriptFixture {
  const sessionId = "fixture-dynamic-media-code";
  const codeLineCount = 420;
  const code = Array.from(
    { length: codeLineCount },
    (_, index) => `const mediaRow${numericId(index, 3)} = ${index};`,
  ).join("\n");
  const messages: Message[] = [
    textMessage(
      "media-user-000",
      "user",
      TRANSCRIPT_FIXTURE_BASE_TIME,
      "Show image-heavy and code-heavy output.",
    ),
    {
      id: "media-assistant-001",
      role: "assistant",
      created: TRANSCRIPT_FIXTURE_BASE_TIME + MINUTE_MS,
      content: [
        {
          type: "text",
          text: [
            "The first image should reserve layout before load.",
            "",
            "```ts",
            code,
            "```",
          ].join("\n"),
        },
        buildImageBlock(1),
        {
          type: "text",
          text: "The second image loads above the detached anchor.",
        },
        buildImageBlock(2),
      ],
      metadata: { userVisible: true, agentVisible: true },
    },
    textMessage(
      "media-user-002",
      "user",
      TRANSCRIPT_FIXTURE_BASE_TIME + 2 * MINUTE_MS,
      "Keep scrolling stable while async media settles.",
    ),
  ];

  return {
    version: TRANSCRIPT_FIXTURE_VERSION,
    name: "dynamic-media-code",
    description:
      "Image blocks and long code fences with delayed load/highlight operations.",
    activeSessionId: sessionId,
    sessions: [{ sessionId, title: "Dynamic media and code", messages }],
    operations: [
      { kind: "restore", atMs: 0, sessionId, scrollPosition: "tail" },
      {
        kind: "scroll",
        atMs: 200,
        direction: "up",
        pixels: 1_200,
        expectedAnchor: "row",
      },
      {
        kind: "imageLoad",
        atMs: 420,
        sessionId,
        messageId: "media-assistant-001",
        blockIndex: 1,
        height: 360,
      },
      {
        kind: "codeHighlightComplete",
        atMs: 520,
        sessionId,
        messageId: "media-assistant-001",
        blockIndex: 0,
        heightDelta: 128,
      },
      {
        kind: "imageLoad",
        atMs: 780,
        sessionId,
        messageId: "media-assistant-001",
        blockIndex: 3,
        height: 520,
      },
    ],
    expectations: {
      logicalMessageCount: messages.length,
      minLogicalRows: 8,
      maxInitialMountedRows: 80,
      maxProtectedRows: 24,
      dynamicRowCount: 2,
      toolCallCount: 0,
      mcpAppCount: 0,
      imageCount: 2,
      codeFenceLineCount: codeLineCount,
    },
  };
}

function buildComposerGrowthSessionSwitchFixture(): TranscriptFixture {
  const primarySessionId = "fixture-composer-primary";
  const secondarySessionId = "fixture-composer-secondary";
  const primaryMessages = buildLongMessages(240).map((message) => ({
    ...message,
    id: message.id.replace("long-", "primary-"),
  }));
  const secondaryMessages = buildLongMessages(120).map((message) => ({
    ...message,
    id: message.id.replace("long-", "secondary-"),
  }));
  const attachments: ChatAttachmentDraft[] = [
    {
      id: "composer-image-001",
      kind: "image",
      name: "layout-before.png",
      mimeType: "image/png",
      base64: TRANSPARENT_PNG_DATA,
      previewUrl: "fixture://composer/layout-before.png",
    },
    {
      id: "composer-file-001",
      kind: "file",
      name: "notes.md",
      path: "/fixture/notes.md",
      mimeType: "text/markdown",
    },
  ];

  return {
    version: TRANSCRIPT_FIXTURE_VERSION,
    name: "composer-growth-session-switch",
    description:
      "Footer/composer growth, rail/terminal width changes, queued message state, and session switch with pending async work.",
    activeSessionId: primarySessionId,
    sessions: [
      {
        sessionId: primarySessionId,
        title: "Composer primary session",
        messages: primaryMessages,
        streamingMessageId: "primary-00239",
      },
      {
        sessionId: secondarySessionId,
        title: "Composer secondary session",
        messages: secondaryMessages,
      },
    ],
    operations: [
      {
        kind: "restore",
        atMs: 0,
        sessionId: primarySessionId,
        scrollPosition: "tail",
      },
      {
        kind: "composerResize",
        atMs: 180,
        height: 96,
        attachments: [],
        queuedMessage: null,
      },
      {
        kind: "composerResize",
        atMs: 320,
        height: 184,
        attachments,
        queuedMessage: "queued validation prompt",
      },
      {
        kind: "toggleSurface",
        atMs: 460,
        surface: "right-rail",
        enabled: true,
      },
      {
        kind: "toggleSurface",
        atMs: 580,
        surface: "terminal",
        enabled: true,
      },
      {
        kind: "appendStreamingText",
        atMs: 650,
        sessionId: primarySessionId,
        messageId: "primary-00239",
        chunks: ["\nprimary stream chunk before switch"],
        chunkIntervalMs: 16,
      },
      {
        kind: "switchSession",
        atMs: 720,
        fromSessionId: primarySessionId,
        toSessionId: secondarySessionId,
        pendingAsyncWork: [
          "measurement:primary-00239",
          "mcp-auto-scroll:primary-00239",
          "fragment-worker:primary-00239",
        ],
      },
      {
        kind: "restore",
        atMs: 820,
        sessionId: secondarySessionId,
        scrollPosition: "tail",
      },
      {
        kind: "toggleSurface",
        atMs: 960,
        surface: "compact-width",
        enabled: true,
      },
      {
        kind: "toggleSurface",
        atMs: 1_100,
        surface: "dark-mode",
        enabled: true,
      },
    ],
    expectations: {
      logicalMessageCount: primaryMessages.length + secondaryMessages.length,
      minLogicalRows: primaryMessages.length + secondaryMessages.length + 2,
      maxInitialMountedRows: 140,
      maxProtectedRows: 40,
      dynamicRowCount: 6,
      toolCallCount: 0,
      mcpAppCount: 0,
      imageCount: 0,
      codeFenceLineCount: 0,
    },
  };
}

function validationMetadata(
  metadata: ValidationMessageMetadata,
): Message["metadata"] {
  return metadata as Message["metadata"];
}

function pr928TallText(label: string, lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) => {
    const line = `${label} production-height line ${numericId(index, 3)} keeps the real renderer scrollable.`;
    return index > 0 && index % 10 === 0 ? `\n${line}` : line;
  }).join("\n");
}

function buildPr928FragmentTailFixture(): TranscriptFixture {
  const sessionId = "fixture-pr928-fragment-tail";
  const messages: Message[] = [
    textMessage(
      "pr928-intro",
      "assistant",
      TRANSCRIPT_FIXTURE_BASE_TIME,
      "Intro row before PR 928 browser proof cases.",
      validationMetadata({
        userVisible: true,
        agentVisible: true,
        validationRowHeight: 100,
        validationHeightRevision: "intro:stable",
      }),
    ),
    textMessage(
      "pr928-same-id",
      "assistant",
      TRANSCRIPT_FIXTURE_BASE_TIME + MINUTE_MS,
      pr928TallText("same-id stale revision", 48),
      validationMetadata({
        userVisible: true,
        agentVisible: true,
        validationRowHeight: 700,
        validationHeightRevision: "same-id:old",
      }),
    ),
    textMessage(
      "pr928-whole",
      "assistant",
      TRANSCRIPT_FIXTURE_BASE_TIME + 2 * MINUTE_MS,
      pr928TallText("whole-row split", 72),
      validationMetadata({
        userVisible: true,
        agentVisible: true,
        validationRowHeight: 1_000,
        validationHeightRevision: "whole:old",
      }),
    ),
    textMessage(
      "pr928-tail",
      "assistant",
      TRANSCRIPT_FIXTURE_BASE_TIME + 3 * MINUTE_MS,
      pr928TallText("streaming tail promotion", 72),
      validationMetadata({
        userVisible: true,
        agentVisible: true,
        completionStatus: "inProgress",
        validationAnchorPriority: "streaming",
        validationRowHeight: 1_000,
        validationRowIdSuffix: "stream-tail",
        validationHeightRevision: "tail:old",
      }),
    ),
    textMessage(
      "pr928-after",
      "user",
      TRANSCRIPT_FIXTURE_BASE_TIME + 4 * MINUTE_MS,
      pr928TallText("after row", 28),
      validationMetadata({
        userVisible: true,
        agentVisible: true,
        validationRowHeight: 500,
        validationHeightRevision: "after:stable",
      }),
    ),
  ];

  return {
    version: TRANSCRIPT_FIXTURE_VERSION,
    name: "pr928-fragment-tail",
    description:
      "PR #928 stale same-id revision, whole-row split, and streaming-tail promotion proof fixture.",
    activeSessionId: sessionId,
    sessions: [
      {
        sessionId,
        title: "PR 928 fragment and tail proof",
        messages,
        streamingMessageId: "pr928-tail",
      },
    ],
    operations: [
      { kind: "restore", atMs: 0, sessionId, scrollPosition: "top" },
      {
        kind: "scrollToRowOffset",
        atMs: 120,
        sessionId,
        messageId: "pr928-same-id",
        offsetPx: 120,
        expectedAnchor: "row",
      },
      {
        kind: "changeRowRevision",
        atMs: 220,
        sessionId,
        messageId: "pr928-same-id",
        nextHeightRevision: "same-id:new",
      },
      {
        kind: "scrollToRowOffset",
        atMs: 340,
        sessionId,
        messageId: "pr928-whole",
        offsetPx: 150,
        expectedAnchor: "row",
      },
      {
        kind: "splitMessageRows",
        atMs: 460,
        sessionId,
        messageId: "pr928-whole",
        fragments: [
          {
            idSuffix: "block-0",
            height: 300,
            heightRevision: "whole:block-0",
            text: "Completed fragment block 0.",
          },
          {
            idSuffix: "block-1",
            height: 300,
            heightRevision: "whole:block-1",
            text: "Completed fragment block 1.",
          },
          {
            idSuffix: "block-2",
            height: 400,
            heightRevision: "whole:block-2",
            text: "Completed fragment block 2.",
          },
        ],
      },
      {
        kind: "scrollToRowOffset",
        atMs: 580,
        sessionId,
        messageId: "pr928-tail",
        offsetPx: 150,
        expectedAnchor: "row",
      },
      {
        kind: "promoteStreamingTail",
        atMs: 700,
        sessionId,
        messageId: "pr928-tail",
        completedFragment: {
          idSuffix: "stream-block-0",
          height: 300,
          heightRevision: "tail:block-0",
          anchorPriority: "stable",
          text: "Promoted completed streaming fragment.",
        },
        nextTail: {
          idSuffix: "stream-tail",
          height: 700,
          heightRevision: "tail:new",
          anchorPriority: "streaming",
          text: "New mutable streaming tail.",
        },
      },
    ],
    expectations: {
      logicalMessageCount: messages.length,
      minLogicalRows: 7,
      maxInitialMountedRows: 80,
      maxProtectedRows: 8,
      dynamicRowCount: 3,
      toolCallCount: 0,
      mcpAppCount: 0,
      imageCount: 0,
      codeFenceLineCount: 0,
    },
  };
}

function streamingScrollbackLine(index: number): string {
  const section = Math.floor(index / 12) + 1;
  const markers = [
    "keeps the same response scrollback surface during token delivery",
    "keeps completed stream blocks stable while the tail changes",
    "keeps detached users away from bottom-follow during active growth",
    "keeps the viewport covered by mounted virtual rows",
  ];
  if (index % 12 === 0) {
    return `## Investigation section ${section}`;
  }
  if (index % 12 === 6) {
    return "";
  }
  return `Streaming scrollback paragraph ${numericId(index, 3)} ${markers[index % markers.length]}.`;
}

function streamingScrollbackText(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) =>
    streamingScrollbackLine(index),
  ).join("\n");
}

function streamingScrollbackChunks(
  chunkCount: number,
  linesPerChunk: number,
): string[] {
  return Array.from({ length: chunkCount }, (_, chunkIndex) => {
    const startIndex = 160 + chunkIndex * linesPerChunk;
    return [
      "",
      ...Array.from({ length: linesPerChunk }, (_, lineIndex) =>
        streamingScrollbackLine(startIndex + lineIndex),
      ),
    ].join("\n");
  });
}

function buildStreamingScrollbackLongMarkdownFixture(): TranscriptFixture {
  const sessionId = "fixture-streaming-scrollback";
  const assistantId = "streaming-scrollback-assistant";
  const chunks = streamingScrollbackChunks(30, 6);
  const messages: Message[] = [
    textMessage(
      "streaming-scrollback-user",
      "user",
      TRANSCRIPT_FIXTURE_BASE_TIME,
      "Stream a long markdown response while I scroll back through it.",
    ),
    textMessage(
      assistantId,
      "assistant",
      TRANSCRIPT_FIXTURE_BASE_TIME + MINUTE_MS,
      streamingScrollbackText(132),
      {
        userVisible: true,
        agentVisible: true,
        completionStatus: "inProgress",
      },
    ),
  ];

  return {
    version: TRANSCRIPT_FIXTURE_VERSION,
    name: "streaming-scrollback-long-markdown",
    description:
      "Active long markdown stream for scrollback blank-viewport regression proof.",
    activeSessionId: sessionId,
    sessions: [
      {
        sessionId,
        title: "Streaming scrollback long markdown",
        messages,
        streamingMessageId: assistantId,
      },
    ],
    operations: [
      { kind: "restore", atMs: 0, sessionId, scrollPosition: "tail" },
      {
        kind: "startStreamingText",
        atMs: 100,
        sessionId,
        messageId: assistantId,
        chunks,
        chunkIntervalMs: 80,
        streamId: "scrollback-proof",
      },
      {
        kind: "waitForStreamingText",
        atMs: 2_000,
        streamId: "scrollback-proof",
      },
    ],
    expectations: {
      logicalMessageCount: messages.length,
      minLogicalRows: 5,
      maxInitialMountedRows: 80,
      maxProtectedRows: 32,
      dynamicRowCount: 1,
      toolCallCount: 0,
      mcpAppCount: 0,
      imageCount: 0,
      codeFenceLineCount: 0,
    },
  };
}

function buildVisualSpacingDateFooterFixture(): TranscriptFixture {
  const sessionId = "fixture-visual-spacing-date-footer";
  const messages: Message[] = [
    textMessage(
      "spacing-day1-user",
      "user",
      TRANSCRIPT_FIXTURE_BASE_TIME - DAY_MS,
      "Legacy and virtual should agree on the first day user gutter.",
    ),
    textMessage(
      "spacing-day1-assistant",
      "assistant",
      TRANSCRIPT_FIXTURE_BASE_TIME - DAY_MS + MINUTE_MS,
      "First day assistant response establishes the transcript rhythm.",
    ),
    textMessage(
      "spacing-day2-user",
      "user",
      TRANSCRIPT_FIXTURE_BASE_TIME,
      "The second day starts here and should not gain extra separator spacing.",
    ),
    textMessage(
      "spacing-day2-assistant",
      "assistant",
      TRANSCRIPT_FIXTURE_BASE_TIME + MINUTE_MS,
      "Assistant bubble after the date separator should keep the same top offset.",
    ),
    textMessage(
      "spacing-tail-user",
      "user",
      TRANSCRIPT_FIXTURE_BASE_TIME + 2 * MINUTE_MS,
      "Keep the last assistant action row clear of the docked composer.",
    ),
    textMessage(
      "spacing-tail-assistant",
      "assistant",
      TRANSCRIPT_FIXTURE_BASE_TIME + 3 * MINUTE_MS,
      "Tail response with visible copy and timestamp geometry near the footer.",
    ),
  ];

  return {
    version: TRANSCRIPT_FIXTURE_VERSION,
    name: "visual-spacing-date-footer",
    description:
      "Small transcript for date separator, gutter, bubble width, and footer/action clearance parity.",
    activeSessionId: sessionId,
    sessions: [{ sessionId, title: "Visual spacing date/footer", messages }],
    operations: [
      { kind: "restore", atMs: 0, sessionId, scrollPosition: "tail" },
      {
        kind: "composerResize",
        atMs: 80,
        height: 184,
        attachments: [],
        queuedMessage: "queued visual parity prompt",
      },
      {
        kind: "toggleSurface",
        atMs: 160,
        surface: "right-rail",
        enabled: true,
      },
      {
        kind: "toggleSurface",
        atMs: 240,
        surface: "terminal",
        enabled: true,
      },
    ],
    expectations: {
      logicalMessageCount: messages.length,
      minLogicalRows: messages.length + 2,
      maxInitialMountedRows: 40,
      maxProtectedRows: 0,
      dynamicRowCount: 1,
      toolCallCount: 0,
      mcpAppCount: 0,
      imageCount: 0,
      codeFenceLineCount: 0,
    },
  };
}

function visualSpacingLongPlainText(lineCount: number): string {
  return Array.from(
    { length: lineCount },
    (_, index) =>
      `Fragment parity line ${numericId(index, 3)} keeps one assistant answer visually continuous.`,
  ).join("\n");
}

function buildVisualSpacingFragmentedAssistantFixture(): TranscriptFixture {
  const sessionId = "fixture-visual-spacing-fragmented-assistant";
  const messages: Message[] = [
    textMessage(
      "spacing-fragment-user",
      "user",
      TRANSCRIPT_FIXTURE_BASE_TIME,
      "Write a long plain-text answer without code fences.",
    ),
    textMessage(
      "spacing-fragment-assistant",
      "assistant",
      TRANSCRIPT_FIXTURE_BASE_TIME + MINUTE_MS,
      visualSpacingLongPlainText(132),
      {
        userVisible: true,
        agentVisible: true,
        personaName: "Spacing Agent",
      },
    ),
  ];

  return {
    version: TRANSCRIPT_FIXTURE_VERSION,
    name: "visual-spacing-fragmented-assistant",
    description:
      "Plain assistant output long enough to fragment in virtual mode while legacy renders one message.",
    activeSessionId: sessionId,
    sessions: [{ sessionId, title: "Visual spacing fragments", messages }],
    operations: [
      { kind: "restore", atMs: 0, sessionId, scrollPosition: "top" },
    ],
    expectations: {
      logicalMessageCount: messages.length,
      minLogicalRows: 4,
      maxInitialMountedRows: 40,
      maxProtectedRows: 0,
      dynamicRowCount: 0,
      toolCallCount: 0,
      mcpAppCount: 0,
      imageCount: 0,
      codeFenceLineCount: 0,
    },
  };
}

function buildVisualSpacingRichBlocksFixture(): TranscriptFixture {
  const sessionId = "fixture-visual-spacing-rich-blocks";
  const toolCallId = "spacing-rich-tool";
  const messages: Message[] = [
    textMessage(
      "spacing-rich-user",
      "user",
      TRANSCRIPT_FIXTURE_BASE_TIME,
      "Show reasoning, tools, MCP UI, code, and an image in one response.",
    ),
    {
      id: "spacing-rich-assistant",
      role: "assistant",
      created: TRANSCRIPT_FIXTURE_BASE_TIME + MINUTE_MS,
      content: [
        {
          type: "reasoning",
          text: "Reasoning block should keep the same left edge as other assistant blocks.",
        },
        {
          type: "toolRequest",
          id: toolCallId,
          name: "fixture.inspect_layout",
          toolName: "inspect_layout",
          extensionName: "fixture",
          arguments: { target: "spacing" },
          status: "completed",
          chainSummary: { summary: "Inspect layout", count: 1 },
        },
        {
          type: "toolResponse",
          id: toolCallId,
          name: "fixture.inspect_layout",
          result: "layout inspected",
          isError: false,
        },
        {
          type: "text",
          text: [
            "The code block should align with the assistant content column.",
            "",
            "```ts",
            "const spacing = measureTranscriptRow();",
            "expect(spacing.left).toBeCloseTo(reference.left);",
            "```",
          ].join("\n"),
        },
        buildImageBlock(7),
        {
          type: "mcpApp",
          id: "spacing-rich-mcp",
          payload: {
            sessionId: "spacing-rich-mcp-session",
            toolCallId,
            toolCallTitle: "Layout Inspector",
            source: "toolCallUpdateMeta",
            tool: {
              name: "fixture__inspect_layout",
              extensionName: "fixture",
              resourceUri: "ui://fixture/layout-inspector",
            },
            resource: {
              result: {
                contents: [
                  {
                    uri: "ui://fixture/layout-inspector",
                    mimeType: "text/html;profile=mcp-app",
                    text: "<section>Layout Inspector</section>",
                  },
                ],
              },
            },
          },
        },
      ],
      metadata: { userVisible: true, agentVisible: true },
    },
  ];

  return {
    version: TRANSCRIPT_FIXTURE_VERSION,
    name: "visual-spacing-rich-blocks",
    description:
      "Assistant content block mix for code, reasoning, tool, MCP, and image offset parity.",
    activeSessionId: sessionId,
    sessions: [{ sessionId, title: "Visual spacing rich blocks", messages }],
    operations: [
      { kind: "restore", atMs: 0, sessionId, scrollPosition: "top" },
    ],
    expectations: {
      logicalMessageCount: messages.length,
      minLogicalRows: 2,
      maxInitialMountedRows: 40,
      maxProtectedRows: 1,
      dynamicRowCount: 2,
      toolCallCount: 1,
      mcpAppCount: 1,
      imageCount: 1,
      codeFenceLineCount: 2,
    },
  };
}

export function buildTranscriptFixture(
  name: TranscriptFixtureName,
  options: LongTranscriptOptions &
    HugeAssistantOutputOptions &
    ToolChainStormOptions = {},
): TranscriptFixture {
  switch (name) {
    case "long-10k":
      return buildLong10kFixture(options);
    case "huge-assistant-output":
      return buildHugeAssistantOutputFixture(options);
    case "tool-chain-storm":
      return buildToolChainStormFixture(options);
    case "mcp-dynamic-rows":
      return buildMcpDynamicRowsFixture();
    case "dynamic-media-code":
      return buildDynamicMediaCodeFixture();
    case "composer-growth-session-switch":
      return buildComposerGrowthSessionSwitchFixture();
    case "pr928-fragment-tail":
      return buildPr928FragmentTailFixture();
    case "streaming-scrollback-long-markdown":
      return buildStreamingScrollbackLongMarkdownFixture();
    case "visual-spacing-date-footer":
      return buildVisualSpacingDateFooterFixture();
    case "visual-spacing-fragmented-assistant":
      return buildVisualSpacingFragmentedAssistantFixture();
    case "visual-spacing-rich-blocks":
      return buildVisualSpacingRichBlocksFixture();
  }
}

export function buildTranscriptVirtualizationFixtures(): Record<
  TranscriptFixtureName,
  TranscriptFixture
> {
  return {
    "long-10k": buildTranscriptFixture("long-10k"),
    "huge-assistant-output": buildTranscriptFixture("huge-assistant-output"),
    "tool-chain-storm": buildTranscriptFixture("tool-chain-storm"),
    "mcp-dynamic-rows": buildTranscriptFixture("mcp-dynamic-rows"),
    "dynamic-media-code": buildTranscriptFixture("dynamic-media-code"),
    "composer-growth-session-switch": buildTranscriptFixture(
      "composer-growth-session-switch",
    ),
    "pr928-fragment-tail": buildTranscriptFixture("pr928-fragment-tail"),
    "streaming-scrollback-long-markdown": buildTranscriptFixture(
      "streaming-scrollback-long-markdown",
    ),
    "visual-spacing-date-footer": buildTranscriptFixture(
      "visual-spacing-date-footer",
    ),
    "visual-spacing-fragmented-assistant": buildTranscriptFixture(
      "visual-spacing-fragmented-assistant",
    ),
    "visual-spacing-rich-blocks": buildTranscriptFixture(
      "visual-spacing-rich-blocks",
    ),
  };
}

export function fixtureDigest(fixture: TranscriptFixture): string {
  const json = JSON.stringify(fixture);
  let hash = 0x811c9dc5;

  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}
