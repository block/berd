import { describe, expect, it, vi } from "vitest";
import {
  applyAutomationBuilderDelta,
  asStreamResponse,
  buildAutomationApprovalRequest,
  buildAutomationBuilderUserMessageRequest,
  buildAutomationRevisionRequest,
  buildAutomationPreferencePrompt,
  buildCreateAutomationTileRequest,
  buildTileApprovalAcknowledgementRequest,
  findAutomationDraftState,
} from "./automationBuilder";
import type { Message, ToolRequestContent } from "@/shared/types/messages";

vi.stubGlobal("crypto", {
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
});

describe("automation builder api helpers", () => {
  it("builds regular chat requests with hidden automation-only instructions and no space", () => {
    const request =
      buildAutomationBuilderUserMessageRequest("send daily sales");
    const hiddenPrompt =
      request.messages[0].messageContents[0].text?.text ?? "";

    expect(request.chatContext).toMatchObject({
      source: "SOURCE_REGULAR_CHAT",
    });
    expect(request.profileConfig).toEqual({
      userProfile: {
        preferredModel: {
          name: "goose-claude-4-6-opus",
          provider: 1,
        },
      },
    });
    expect(request.chatContext).not.toHaveProperty("space");
    expect(request.messages).toEqual([
      expect.objectContaining({
        hidden: true,
        messageContents: [
          expect.objectContaining({
            type: "MESSAGE_TYPE_TEXT",
            text: expect.objectContaining({
              text: expect.stringContaining(
                "The user came from the Create Automation UI.",
              ),
            }),
          }),
        ],
      }),
      {
        messageContents: [
          {
            type: "MESSAGE_TYPE_TEXT",
            text: { text: "send daily sales" },
          },
        ],
      },
    ]);
    expect(hiddenPrompt).toContain("The user's current local time is");
    expect(hiddenPrompt).toContain(
      "When the user does not specify a time of day for the schedule",
    );
  });

  it("builds local-time schedule default guidance into the hidden prompt", () => {
    const now = new Date("2026-05-21T16:30:00Z");
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const localTime = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    }).format(now);
    const prompt = buildAutomationPreferencePrompt(now);

    expect(prompt).toContain(
      `The user's current local time is ${localTime} in time zone ${timeZone}.`,
    );
    expect(prompt).toContain(
      `default the schedule's hour and minute to this current local time (${localTime})`,
    );
  });

  it("builds approval responses for the automation create tool path", () => {
    expect(buildAutomationApprovalRequest("session-1", "tool-1")).toMatchObject(
      {
        sessionId: "session-1",
        messages: [
          {
            messageContents: [
              {
                type: "MESSAGE_TYPE_TOOL_RESPONSE",
                toolResponse: {
                  id: "tool-1",
                  status: "success",
                  results: [
                    {
                      text: {
                        text: "User accepted the automation, so it MUST be saved using tile__create_automation.",
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    );
  });

  it("builds tile acknowledgement responses for direct create-tile previews", () => {
    expect(
      buildTileApprovalAcknowledgementRequest("session-1", "tool-1"),
    ).toMatchObject({
      sessionId: "session-1",
      messages: [
        {
          messageContents: [
            {
              type: "MESSAGE_TYPE_TOOL_RESPONSE",
              toolResponse: {
                id: "tool-1",
                status: "success",
                results: [
                  {
                    text: {
                      text: "User accepted the tile, so it MUST be saved using tile__persist_tile.",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
  });

  it("builds revision responses for drafts that are not accepted yet", () => {
    expect(
      buildAutomationRevisionRequest(
        "session-1",
        "tool-1",
        "Actually make it 1 PM.",
      ),
    ).toMatchObject({
      sessionId: "session-1",
      messages: [
        {
          messageContents: [
            {
              type: "MESSAGE_TYPE_TOOL_RESPONSE",
              toolResponse: {
                id: "tool-1",
                status: "success",
                results: [
                  {
                    text: {
                      text: expect.stringContaining(
                        "User did not accept the automation draft yet.",
                      ),
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
  });

  it("normalizes stream snapshots and deltas", () => {
    const messages = asStreamResponse({
      get_messages_response: {
        status: "CHAT_SESSION_STATUS_IDLE",
        messages: [
          {
            id: "message-1",
            role: "ROLE_ASSISTANT",
            created: "1714568400000",
            content: [
              {
                type: "MESSAGE_TYPE_TEXT",
                text: { text: "hello" },
              },
            ],
          },
        ],
      },
    });
    const delta = asStreamResponse({
      delta_message_content: {
        streaming_message_id: "message-2",
        message_content: {
          type: "MESSAGE_TYPE_TEXT",
          text: { text: "stream" },
        },
      },
    });

    expect(messages?.type).toBe("messages");
    expect(
      messages?.type === "messages" && messages.response.messages[0],
    ).toMatchObject({
      id: "message-1",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    });
    expect(delta?.type).toBe("delta");
    expect(delta?.type === "delta" && delta.delta.streamingMessageId).toBe(
      "message-2",
    );
  });

  it("merges historical tool responses into matching requests and preserves payloads", () => {
    const response = asStreamResponse({
      get_messages_response: {
        status: "CHAT_SESSION_STATUS_IDLE",
        messages: [
          {
            id: "message-1",
            role: "ROLE_ASSISTANT",
            created: "1714568400000",
            content: [
              {
                type: "MESSAGE_TYPE_TOOL_REQUEST",
                tool_request: {
                  id: "tool-1",
                  status: "success",
                  value: {
                    name: "linear__search",
                    arguments: JSON.stringify({ query: "revenue" }),
                  },
                },
              },
            ],
          },
          {
            id: "message-2",
            role: "ROLE_ASSISTANT",
            created: "1714568401000",
            content: [
              {
                type: "MESSAGE_TYPE_TOOL_RESPONSE",
                tool_response: {
                  id: "tool-1",
                  status: "success",
                  extension_name: "linear",
                  results: [
                    { text: { text: "Found 2 issues." } },
                    {
                      structured_content: {
                        issues: [{ identifier: "ENG-1" }],
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    });

    expect(response?.type).toBe("messages");
    if (response?.type !== "messages") return;

    expect(response.response.messages).toHaveLength(1);
    expect(response.response.messages[0].content).toMatchObject([
      {
        type: "toolRequest",
        id: "tool-1",
        name: "linear__search",
        status: "completed",
        arguments: { query: "revenue" },
      },
      {
        type: "toolResponse",
        id: "tool-1",
        name: "linear",
        result: "Found 2 issues.",
        structuredContent: {
          id: "tool-1",
          status: "success",
          extensionName: "linear",
          results: [
            { text: { text: "Found 2 issues." } },
            { structuredContent: { issues: [{ identifier: "ENG-1" }] } },
          ],
        },
      },
    ]);
  });

  it("appends streaming text deltas into one assistant message", () => {
    const first = applyAutomationBuilderDelta([], {
      streamingMessageId: "stream-1",
      messageContent: {
        type: "MESSAGE_TYPE_TEXT",
        text: { text: "hel" },
      },
    });
    const second = applyAutomationBuilderDelta(first, {
      streamingMessageId: "stream-1",
      messageContent: {
        type: "MESSAGE_TYPE_TEXT",
        text: { text: "lo" },
      },
      isFinal: true,
    });

    expect(second).toHaveLength(1);
    expect(second[0].content).toEqual([{ type: "text", text: "hello" }]);
    expect(second[0].metadata?.completionStatus).toBe("completed");
  });

  it("ignores repeated delta starts and invalid delta payloads", () => {
    expect(
      asStreamResponse({
        delta_message_content: {
          streaming_message_id: "",
          message_content: {
            type: "MESSAGE_TYPE_TEXT",
            text: { text: "hello" },
          },
        },
      }),
    ).toBeNull();

    const first = applyAutomationBuilderDelta([], {
      streamingMessageId: "stream-1",
      messageContent: {
        type: "MESSAGE_TYPE_TEXT",
        text: { text: "hello" },
      },
      isStart: true,
    });
    const repeated = applyAutomationBuilderDelta(first, {
      streamingMessageId: "stream-1",
      messageContent: {
        type: "MESSAGE_TYPE_TEXT",
        text: { text: "hello" },
      },
      isStart: true,
    });

    expect(repeated[0].content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("drops unknown kgoose content instead of rendering raw proto JSON", () => {
    const response = asStreamResponse({
      get_messages_response: {
        status: "CHAT_SESSION_STATUS_IDLE",
        messages: [
          {
            id: "message-1",
            role: "ROLE_ASSISTANT",
            content: [{ type: "MESSAGE_TYPE_UNKNOWN", unknown: true }],
          },
        ],
      },
    });

    expect(response?.type).toBe("messages");
    expect(response?.type === "messages" && response.response.messages).toEqual(
      [],
    );
  });

  it("maps redacted thinking before generic thinking content", () => {
    const response = asStreamResponse({
      get_messages_response: {
        status: "CHAT_SESSION_STATUS_IDLE",
        messages: [
          {
            id: "message-1",
            role: "ROLE_ASSISTANT",
            content: [
              {
                type: "MESSAGE_TYPE_REDACTED_THINKING",
                redacted_thinking: { data: "redacted" },
              },
            ],
          },
        ],
      },
    });

    expect(response?.type).toBe("messages");
    expect(
      response?.type === "messages" && response.response.messages[0].content,
    ).toEqual([{ type: "redactedThinking" }]);
  });

  it("accepts automation-rendered summary previews and blocks dashboard tiles", () => {
    const messages: Message[] = [
      {
        id: "assistant-1",
        role: "assistant",
        created: 1,
        content: [
          {
            type: "toolRequest",
            id: "tool-automation",
            name: "tile__render_tile",
            toolName: "tile__render_tile",
            arguments: {
              renderType: "automation",
              tileType: "summary",
              title: "Daily sales digest",
              schedule: "0 9 * * *",
            },
            status: "pending",
          },
        ],
      },
    ];

    const state = findAutomationDraftState(messages);

    expect(state.draft).toMatchObject({
      toolRequestId: "tool-automation",
      creationMode: "createTile",
      title: "Daily sales digest",
    });
    if (!state.draft) return;
    expect(buildCreateAutomationTileRequest(state.draft)).toMatchObject({
      type: 4,
      title: "Daily sales digest",
      schedule: "0 9 * * *",
    });
    expect(buildCreateAutomationTileRequest(state.draft)).not.toHaveProperty(
      "subscriptionFilters",
    );
    expect(buildCreateAutomationTileRequest(state.draft)).not.toHaveProperty(
      "subscribedLabels",
    );

    const toolRequest = messages[0].content[0] as ToolRequestContent;
    const blocked = findAutomationDraftState([
      {
        ...messages[0],
        content: [
          {
            ...toolRequest,
            arguments: {
              renderType: "tile",
              tileType: "summary",
              title: "Not an automation",
            },
          },
        ],
      },
    ]);
    expect(blocked.draft).toBeNull();
    expect(blocked.blockedToolRequest).toContain("not an automation");
  });

  it("preserves summary tile type for automation-rendered previews", () => {
    const baseMessage: Message = {
      id: "assistant-1",
      role: "assistant",
      created: 1,
      content: [
        {
          type: "toolRequest",
          id: "tool-automation",
          name: "tile__render_tile",
          toolName: "tile__render_tile",
          arguments: {
            renderType: "automation",
            tileType: "summary",
            title: "Daily Linear Digest",
            schedule: "0 9 * * 1-5",
            instructions: [
              "Call tile__render_tile with render_type='automation', tile_type='summary', title='Daily Linear Digest', summary showing bold counts, details listing all issues grouped by state, and schedule '0 9 * * 1-5'.",
            ],
          },
          status: "pending",
        },
      ],
    };

    const state = findAutomationDraftState([baseMessage]);

    expect(state.draft).not.toBeNull();
    if (!state.draft) return;
    expect(state.draft).toMatchObject({
      title: "Daily Linear Digest",
      schedule: "0 9 * * 1-5",
      instructions: [
        "Call tile__render_tile with render_type='automation', tile_type='summary', title='Daily Linear Digest', summary showing bold counts, details listing all issues grouped by state, and schedule '0 9 * * 1-5'.",
      ],
    });
    expect(buildCreateAutomationTileRequest(state.draft)).toMatchObject({
      type: 4,
      title: "Daily Linear Digest",
      schedule: "0 9 * * 1-5",
    });

    const toolRequest = baseMessage.content[0] as ToolRequestContent;
    expect(
      findAutomationDraftState([
        {
          ...baseMessage,
          content: [
            {
              ...toolRequest,
              arguments: {
                ...toolRequest.arguments,
                renderType: "tile",
              },
            },
          ],
        },
      ]).draft,
    ).toBeNull();
  });

  it("accepts numeric and enum summary types and rejects unsupported automation types", () => {
    const baseMessage: Message = {
      id: "assistant-1",
      role: "assistant",
      created: 1,
      content: [
        {
          type: "toolRequest",
          id: "tool-automation",
          name: "tile__render_tile",
          toolName: "tile__render_tile",
          arguments: {
            renderType: "automation",
            tileType: 4,
            title: "Numeric automation",
            instructions: ["Run it"],
          },
          status: "pending",
        },
      ],
    };

    expect(findAutomationDraftState([baseMessage]).draft).toMatchObject({
      title: "Numeric automation",
    });
    const numericDraft = findAutomationDraftState([baseMessage]).draft;
    if (!numericDraft) return;
    expect(buildCreateAutomationTileRequest(numericDraft)).toMatchObject({
      type: 4,
    });

    const toolRequest = baseMessage.content[0] as ToolRequestContent;
    expect(
      findAutomationDraftState([
        {
          ...baseMessage,
          content: [
            {
              ...toolRequest,
              arguments: {
                renderType: "automation",
                tileType: "TILE_TYPE_AUTOMATION",
              },
            },
          ],
        },
      ]).draft,
    ).toBeNull();
    expect(
      findAutomationDraftState([
        {
          ...baseMessage,
          content: [
            {
              ...toolRequest,
              arguments: {
                renderType: "automation",
                tileType: "builderbot_automation",
              },
            },
          ],
        },
      ]).draft,
    ).toBeNull();
  });

  it("marks automation created only after successful create tool response", () => {
    const state = findAutomationDraftState([
      {
        id: "assistant-1",
        role: "assistant",
        created: 1,
        content: [
          {
            type: "toolRequest",
            id: "preview-tool",
            name: "tile__preview_automation",
            toolName: "tile__preview_automation",
            arguments: {
              title: "Daily sales digest",
              instructions: ["Send a digest."],
            },
            status: "pending",
          },
          {
            type: "toolResponse",
            id: "preview-tool",
            name: "tool response",
            result:
              "User accepted the automation, so it MUST be saved using tile__create_automation.",
            isError: false,
          },
          {
            type: "toolRequest",
            id: "create-tool",
            name: "tile__create_automation",
            toolName: "tile__create_automation",
            arguments: {},
            status: "pending",
          },
          {
            type: "toolResponse",
            id: "create-tool",
            name: "tool response",
            result: JSON.stringify({ automation_id: "automation-1" }),
            isError: false,
          },
        ],
      },
    ]);

    expect(state).toMatchObject({
      createRequested: true,
      created: true,
      createdAutomationId: "automation-1",
    });
    expect(state.draft).toMatchObject({
      toolRequestId: "preview-tool",
      creationMode: "approveTool",
    });
  });
});
