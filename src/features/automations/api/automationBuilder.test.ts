import { describe, expect, it, vi } from "vitest";
import {
  applyAutomationBuilderDelta,
  asStreamResponse,
  buildAutomationApprovalRequest,
  buildAutomationBuilderUserMessageRequest,
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
              text: "The user came from the Create Automation UI. Only create an automation; dashboard tiles and builderbot automations are not supported in this app. For previews, use tile__render_tile with render_type='automation' and tile_type='summary'. Before calling render_tile, always call tile__describe_tile('summary') FIRST and shape the data argument to that schema exactly. render_type='automation' does not change the summary schema: data must be exactly { title: string, summary: string, details: string }, with details as a markdown string. Do not use any other tile_type. Do not set space_id or spaceId; external systems persist the accepted summary preview as an automation outside the dashboard. The automation instructions you generate must end with a step that explicitly says to call tile__render_tile with render_type='automation', tile_type='summary', schema-valid summary data, and schedule.",
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
