import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MessageBubble } from "../MessageBubble";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import type { Message } from "@/shared/types/messages";

const appRendererProps = vi.hoisted(() => vi.fn());

vi.mock("@mcp-ui/client", () => ({
  UI_EXTENSION_CONFIG: { mimeTypes: ["text/html;profile=mcp-app"] },
  AppRenderer: (props: {
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: unknown;
  }) => {
    appRendererProps(props);
    return (
      <div data-testid="mock-app-renderer">
        {props.toolName ?? "app-renderer"}
      </div>
    );
  },
}));

vi.mock("@/shared/api/gooseServeHost", () => ({
  getGooseServeHostInfo: vi.fn().mockResolvedValue({
    httpBaseUrl: "http://127.0.0.1:4242",
    secretKey: "test-secret",
  }),
}));

vi.mock("@/shared/theme/ThemeProvider", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  openUrl: vi.fn(),
}));

function assistantMessage(
  content: Message["content"],
  overrides: Partial<Message> = {},
): Message {
  return {
    id: "a1",
    role: "assistant",
    created: Date.now(),
    content,
    ...overrides,
  };
}

describe("MessageBubble MCP app rendering", () => {
  beforeEach(() => {
    useAgentStore.setState({ personas: [] });
    appRendererProps.mockClear();
  });

  it("passes hidden tool context when only the MCP app is visible", async () => {
    const toolRequest: Message["content"][number] = {
      type: "toolRequest",
      id: "tool-1",
      name: "weather: open app",
      arguments: { city: "Oakland" },
      status: "completed",
    };
    const toolResponse: Message["content"][number] = {
      type: "toolResponse",
      id: "tool-1",
      name: "weather: open app",
      result: "sunny",
      structuredContent: { temperature: 72 },
      isError: false,
    };
    const mcpApp: Message["content"][number] = {
      type: "mcpApp",
      id: "tool-1",
      payload: {
        sessionId: "acp-session",
        toolCallId: "tool-1",
        toolCallTitle: "weather: open app",
        source: "toolCallUpdateMeta",
        tool: {
          name: "weather__open_app",
          extensionName: "weather",
          resourceUri: "ui://weather/app",
        },
        resource: {
          result: {
            contents: [
              {
                uri: "ui://weather/app",
                mimeType: "text/html",
                text: "<div>Hello</div>",
              },
            ],
          },
        },
      },
    };
    const msg = assistantMessage([toolRequest, toolResponse, mcpApp]);

    render(
      <MessageBubble
        message={msg}
        contentOverride={[mcpApp]}
        contentContext={msg.content}
      />,
    );

    await waitFor(() => {
      const props = appRendererProps.mock.calls.at(-1)?.[0];
      expect(props?.toolInput).toEqual({ city: "Oakland" });
      expect(props?.toolResult).toMatchObject({
        content: [{ type: "text", text: "sunny" }],
        structuredContent: { temperature: 72 },
        isError: false,
      });
    });
    expect(screen.queryByText("weather: open app")).not.toBeInTheDocument();
  });

  it("renders MCP App blocks", async () => {
    const msg = assistantMessage([
      {
        type: "toolRequest",
        id: "tool-1",
        name: "weather: open app",
        arguments: {},
        status: "completed",
      },
      {
        type: "toolResponse",
        id: "tool-1",
        name: "weather: open app",
        result: "done",
        isError: false,
      },
      {
        type: "mcpApp",
        id: "tool-1",
        payload: {
          sessionId: "acp-session",
          toolCallId: "tool-1",
          toolCallTitle: "weather: open app",
          source: "toolCallUpdateMeta",
          tool: {
            name: "weather__open_app",
            extensionName: "weather",
            resourceUri: "ui://weather/app",
          },
          resource: {
            result: {
              contents: [
                {
                  uri: "ui://weather/app",
                  mimeType: "text/html",
                  text: "<div>Hello</div>",
                },
              ],
            },
          },
        },
      },
    ]);

    render(<MessageBubble message={msg} />);

    expect(screen.getByTestId("mcp-app-view")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("mock-app-renderer")).toHaveTextContent(
        "weather__open_app",
      );
    });
  });
});
