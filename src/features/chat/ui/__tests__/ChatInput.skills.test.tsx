import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ChatInput } from "./chatInputTestUtils";
import { OPEN_SETTINGS_EVENT } from "@/features/settings/lib/settingsEvents";
import type { ChatSkillDraft } from "../../types";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
} from "@/shared/runtime-config/schema";

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

const mockVoiceDictation = {
  isEnabled: true,
  isRecording: false,
  isTranscribing: false,
  isStarting: vi.fn(() => false),
  stopRecording: vi.fn(),
  toggleRecording: vi.fn(),
};
let lastVoiceDictationOptions: {
  onAutoSubmit?: (text: string) => boolean | Promise<boolean>;
} | null = null;

vi.mock("../../hooks/useVoiceDictation", () => ({
  useAnyVoiceDictationActive: () => false,
  useVoiceDictation: (options: {
    onAutoSubmit?: (text: string) => boolean | Promise<boolean>;
  }) => {
    lastVoiceDictationOptions = options;
    return mockVoiceDictation;
  },
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: new Set(["goose", "claude-acp", "codex-acp"]),
    agentReadiness: new Map([
      ["goose", "ready"],
      ["claude-acp", "ready"],
      ["codex-acp", "ready"],
    ]),
    loading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/shared/api/system", () => ({
  getHomeDir: vi.fn().mockResolvedValue("/Users/wesb"),
  searchFilesForMentions: vi.fn().mockResolvedValue([]),
}));

type SkillMentionFixture = {
  id: string;
  name: string;
  description: string;
  sourceLabel: string;
};
const mockListSkills = vi.fn<
  (projectDirs?: string[]) => Promise<SkillMentionFixture[]>
>(async () => []);
vi.mock("@/features/skills/api/skills", () => ({
  listSkills: (projectDirs?: string[]) => mockListSkills(projectDirs),
}));

type ConnectionFixture = {
  name: string;
  expiresAtEpochS?: number;
  previouslyConnected?: boolean;
};
const mockListConnections = vi.fn<
  () => Promise<{ connections: ConnectionFixture[] }>
>(async () => ({ connections: [] }));
vi.mock("@/features/connections/api/connections", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/connections/api/connections")
    >();
  return {
    ...actual,
    listConnections: () => mockListConnections(),
  };
});

const CODE_REVIEW_SKILL = {
  id: "global:/skills/code-review",
  name: "code-review",
  description: "Reviews code",
  sourceLabel: "Personal",
};

function setReadyRuntimeConfig(config: RuntimeConfig = DEFAULT_RUNTIME_CONFIG) {
  useRuntimeConfigStore.setState({
    loaded: true,
    result: {
      status: "ready",
      source: "fakeEndpoint",
      config,
    },
    config,
  });
}

describe("ChatInput skill mentions", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_AGENT_TOOLS", "1");
    vi.stubEnv("VITE_MANAGED_CONNECTIONS", "1");
    localStorage.clear();
    mockListSkills.mockClear();
    mockListSkills.mockResolvedValue([]);
    mockListConnections.mockClear();
    mockListConnections.mockResolvedValue({ connections: [] });
    lastVoiceDictationOptions = null;
    mockVoiceDictation.isStarting.mockReset();
    mockVoiceDictation.isStarting.mockReturnValue(false);
    setReadyRuntimeConfig({
      ...DEFAULT_RUNTIME_CONFIG,
      kgoose: { baseUrl: "https://kgoose.example.test" },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not show skills in @mention results", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([CODE_REVIEW_SKILL]);

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "@code");

    expect(screen.getByRole("tab", { name: "Agents" })).toHaveAttribute(
      "data-state",
      "active",
    );
    expect(
      screen.queryByRole("option", { name: /code-review/i }),
    ).not.toBeInTheDocument();
  });

  it("shows skills in slash results, preserves the command text, and creates a skill chip", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([CODE_REVIEW_SKILL]);

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "/code");

    expect(await screen.findByText("Skills")).toBeInTheDocument();

    await user.click(
      await screen.findByRole("option", { name: /code-review/i }),
    );

    expect(input).toHaveValue("/code-review ");
    expect(screen.getByText("code-review")).toBeInTheDocument();
  });

  it("pressing Tab accepts the highlighted skill suggestion", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([CODE_REVIEW_SKILL]);

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "/code");

    expect(
      await screen.findByRole("option", { name: /code-review/i }),
    ).toBeInTheDocument();

    await user.keyboard("{Tab}");

    expect(input).toHaveValue("/code-review ");
    expect(input).toHaveFocus();
    expect(screen.getByText("code-review")).toBeInTheDocument();
  });

  it("preserves slash command text when selecting a skill later in the prompt", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([CODE_REVIEW_SKILL]);

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "do a /code");

    await user.click(
      await screen.findByRole("option", { name: /code-review/i }),
    );

    expect(input).toHaveValue("do a /code-review ");
    expect(screen.getByText("code-review")).toBeInTheDocument();
  });

  it("dedupes slash skill results by skill name", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([
      CODE_REVIEW_SKILL,
      {
        id: "project:/repo/.agents/skills/code-review",
        name: "code-review",
        description: "Reviews code",
        sourceLabel: "Goose2",
      },
    ]);

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "/code");

    const options = await screen.findAllByRole("option", {
      name: /code-review/i,
    });
    expect(options).toHaveLength(1);

    await user.keyboard("{Enter}");

    expect(input).toHaveValue("/code-review ");
    expect(screen.getByText("code-review")).toBeInTheDocument();
  });

  it("selects skill name matches before earlier description matches", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([
      {
        id: "global:/skills/release-notes",
        name: "release-notes",
        description: "write code status summaries",
        sourceLabel: "Personal",
      },
      {
        id: "global:/skills/code-review",
        name: "code-review",
        description: "reviews diffs",
        sourceLabel: "Personal",
      },
    ]);

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "/code");

    const options = await screen.findAllByRole("option");
    expect(options[0]).toHaveTextContent("code-review");

    await user.keyboard("{Enter}");

    expect(input).toHaveValue("/code-review ");
    expect(screen.getByText("code-review")).toBeInTheDocument();
    expect(screen.queryByText("release-notes")).not.toBeInTheDocument();
  });

  it("does not show all skills for an empty slash later in the prompt", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([CODE_REVIEW_SKILL]);

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "please use /");

    expect(input).toHaveValue("please use /");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /code-review/i }),
    ).not.toBeInTheDocument();
  });

  it("shows skills for slash queries later in the prompt", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([CODE_REVIEW_SKILL]);

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "please use /code");

    expect(input).toHaveValue("please use /code");
    expect(
      await screen.findByRole("option", { name: /code-review/i }),
    ).toBeInTheDocument();
  });

  it("keeps the skill chip selected without reopening references when typing a URL", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([CODE_REVIEW_SKILL]);

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "/code");
    await user.click(
      await screen.findByRole("option", { name: /code-review/i }),
    );

    await user.type(input, "https://example.com/path");

    expect(input).toHaveValue("/code-review https://example.com/path");
    expect(screen.getByText("code-review")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows and dismisses connected Agent Tools availability tips", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([
      {
        id: "global:/skills/sq-agent-tools",
        name: "sq-agent-tools",
        description:
          "Use to interact with Block's internal tools via sq agent-tools",
        sourceLabel: "Personal",
      },
    ]);
    mockListConnections.mockResolvedValue({
      connections: [{ name: "slack" }],
    });

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "send this to slack");

    expect(await screen.findByText("Slack is connected")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dismiss tip" }));

    expect(screen.queryByText("Slack is connected")).not.toBeInTheDocument();
  });

  it("auto-dismisses connected Agent Tools availability tips without disabling them", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([
      {
        id: "global:/skills/sq-agent-tools",
        name: "sq-agent-tools",
        description:
          "Use to interact with Block's internal tools via sq agent-tools",
        sourceLabel: "Personal",
      },
    ]);
    mockListConnections.mockResolvedValue({
      connections: [{ name: "slack" }],
    });

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "send this to slack");

    expect(await screen.findByText("Slack is connected")).toBeInTheDocument();

    await waitFor(
      () => {
        expect(
          screen.queryByText("Slack is connected"),
        ).not.toBeInTheDocument();
      },
      { timeout: 6_000 },
    );

    await user.type(input, " slack");
    expect(screen.queryByText("Slack is connected")).not.toBeInTheDocument();
    expect(localStorage.getItem("goose:agent-tools-tips-enabled")).not.toBe(
      "false",
    );
  }, 8_000);

  it("auto-disables Agent Tools availability tips after repeated dismissals", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([
      {
        id: "global:/skills/sq-agent-tools",
        name: "sq-agent-tools",
        description:
          "Use to interact with Block's internal tools via sq agent-tools",
        sourceLabel: "Personal",
      },
    ]);
    mockListConnections.mockResolvedValue({
      connections: [{ name: "slack" }, { name: "gmail" }],
    });

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");

    await user.type(input, "send this to slack");
    expect(await screen.findByText("Slack is connected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss tip" }));

    await user.clear(input);
    await user.type(input, "email this summary");
    expect(await screen.findByText("Gmail is connected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss tip" }));

    await user.clear(input);
    await user.type(input, "send this to linear");
    expect(
      await screen.findByText("Linear is disconnected"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss tip" }));

    expect(localStorage.getItem("goose:agent-tools-tips-enabled")).toBe(
      "false",
    );
  });

  it("uses the latest matching Agent Tool when multiple tools are in the composer", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([
      {
        id: "global:/skills/sq-agent-tools",
        name: "sq-agent-tools",
        description:
          "Use to interact with Block's internal tools via sq agent-tools",
        sourceLabel: "Personal",
      },
    ]);
    mockListConnections.mockResolvedValue({
      connections: [{ name: "slack" }],
    });

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "slack");
    expect(await screen.findByText("Slack is connected")).toBeInTheDocument();

    await user.type(input, " asana");

    expect(
      await screen.findByText("Asana is disconnected"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Slack is connected")).not.toBeInTheDocument();

    await user.type(input, " slack");
    expect(screen.queryByText("Slack is connected")).not.toBeInTheDocument();
  });

  it("shows the latest matching Agent Tool while text is typed", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([
      {
        id: "global:/skills/sq-agent-tools",
        name: "sq-agent-tools",
        description:
          "Use to interact with Block's internal tools via sq agent-tools",
        sourceLabel: "Personal",
      },
    ]);
    mockListConnections.mockResolvedValue({
      connections: [{ name: "slack" }],
    });

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    await user.type(screen.getByRole("textbox"), "linear slack");

    expect(await screen.findByText("Slack is connected")).toBeInTheDocument();
    expect(
      screen.queryByText("Linear is disconnected"),
    ).not.toBeInTheDocument();
  });

  it("aggregates disconnected Agent Tools when text is pasted", async () => {
    mockListSkills.mockResolvedValue([
      {
        id: "global:/skills/sq-agent-tools",
        name: "sq-agent-tools",
        description:
          "Use to interact with Block's internal tools via sq agent-tools",
        sourceLabel: "Personal",
      },
    ]);
    mockListConnections.mockResolvedValue({
      connections: [{ name: "slack" }],
    });

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    fireEvent.paste(input, {
      clipboardData: {
        getData: () => "slack linear asana",
        items: [],
      },
    });
    fireEvent.change(input, { target: { value: "slack linear asana" } });

    expect(
      await screen.findByText("Linear and Asana are disconnected"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Slack is connected")).not.toBeInTheDocument();
  });

  it("opens company-managed connection settings when a matching Agent Tool is disconnected", async () => {
    const user = userEvent.setup();
    const openSettingsListener = vi.fn();
    window.addEventListener(OPEN_SETTINGS_EVENT, openSettingsListener);
    mockListSkills.mockResolvedValue([
      {
        id: "global:/skills/sq-agent-tools",
        name: "sq-agent-tools",
        description:
          "Use to interact with Block's internal tools via sq agent-tools",
        sourceLabel: "Personal",
      },
    ]);
    mockListConnections.mockResolvedValue({ connections: [] });

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    await user.type(screen.getByRole("textbox"), "send this to linear");

    expect(
      await screen.findByText("Linear is disconnected"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(openSettingsListener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: {
          section: "connections",
        },
      }),
    );
    expect(screen.queryByRole("button", { name: "Turn off" })).toBeNull();

    window.removeEventListener(OPEN_SETTINGS_EVENT, openSettingsListener);
  });

  it("opens company-managed connection settings when a matching Agent Tool is expired", async () => {
    const user = userEvent.setup();
    const openSettingsListener = vi.fn();
    window.addEventListener(OPEN_SETTINGS_EVENT, openSettingsListener);
    mockListSkills.mockResolvedValue([
      {
        id: "global:/skills/sq-agent-tools",
        name: "sq-agent-tools",
        description:
          "Use to interact with Block's internal tools via sq agent-tools",
        sourceLabel: "Personal",
      },
    ]);
    mockListConnections.mockResolvedValue({
      connections: [
        {
          name: "linear",
          expiresAtEpochS: Math.floor(Date.now() / 1000) - 60,
          previouslyConnected: true,
        },
      ],
    });

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    await user.type(screen.getByRole("textbox"), "send this to linear");

    expect(
      await screen.findByText("Linear is disconnected"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(openSettingsListener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: {
          section: "connections",
        },
      }),
    );

    window.removeEventListener(OPEN_SETTINGS_EVENT, openSettingsListener);
  });

  it("does not load Agent Tools connection status when kgoose connections are disabled", async () => {
    const user = userEvent.setup();
    const openSettingsListener = vi.fn();
    window.addEventListener(OPEN_SETTINGS_EVENT, openSettingsListener);
    setReadyRuntimeConfig({
      ...DEFAULT_RUNTIME_CONFIG,
      featureToggles: { kgooseConnections: false },
    });
    mockListSkills.mockResolvedValue([
      {
        id: "global:/skills/sq-agent-tools",
        name: "sq-agent-tools",
        description:
          "Use to interact with Block's internal tools via sq agent-tools",
        sourceLabel: "Personal",
      },
    ]);

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    await user.type(screen.getByRole("textbox"), "send this to linear");
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockListConnections).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(openSettingsListener).not.toHaveBeenCalled();

    window.removeEventListener(OPEN_SETTINGS_EVENT, openSettingsListener);
  });

  it("does not show Agent Tools availability tips while connection status is loading", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([
      {
        id: "global:/skills/sq-agent-tools",
        name: "sq-agent-tools",
        description:
          "Use to interact with Block's internal tools via sq agent-tools",
        sourceLabel: "Personal",
      },
    ]);
    mockListConnections.mockReturnValue(new Promise(() => undefined));

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    await user.type(screen.getByRole("textbox"), "send this to slack");

    await waitFor(() => {
      expect(mockListConnections).toHaveBeenCalled();
    });

    expect(screen.queryByText(/Slack/)).not.toBeInTheDocument();
  });

  it("shows expiring Agent Tools availability tips as connected for now", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([
      {
        id: "global:/skills/sq-agent-tools",
        name: "sq-agent-tools",
        description:
          "Use to interact with Block's internal tools via sq agent-tools",
        sourceLabel: "Personal",
      },
    ]);
    mockListConnections.mockResolvedValue({
      connections: [
        {
          name: "linear",
          expiresAtEpochS: Math.floor(Date.now() / 1000) + 60,
        },
      ],
    });

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    await user.type(screen.getByRole("textbox"), "send this to linear");

    expect(await screen.findByText("Linear is connected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("expands selected skill chips before sending", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();

    render(
      <ChatInput
        onSend={onSend}
        selectedSkills={[
          {
            id: "global:/skills/code-review",
            name: "code-review",
            description: "Reviews code",
            sourceLabel: "Personal",
          },
        ]}
        onSkillsChange={vi.fn()}
      />,
    );

    await user.type(screen.getByRole("textbox"), "check this diff");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("check this diff", null, undefined, {
      assistantPrompt: "Use these skills for this request: code-review.",
      chips: [{ label: "code-review", type: "skill" }],
      displayText: "check this diff",
    });
  });

  it("clears selected skill chips when the session controller clears the draft during send", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();

    function ControlledProjectChatInput() {
      const [draft, setDraft] = useState("");
      const [skills, setSkills] = useState<ChatSkillDraft[]>([
        CODE_REVIEW_SKILL,
      ]);

      return (
        <ChatInput
          initialValue={draft}
          onDraftChange={setDraft}
          selectedSkills={skills}
          onSkillsChange={setSkills}
          onSend={async (...args) => {
            onSend(...args);
            setDraft("");
            return true;
          }}
        />
      );
    }

    render(<ControlledProjectChatInput />);

    expect(screen.getByText("code-review")).toBeInTheDocument();

    const input = screen.getByRole("textbox");
    await user.type(input, "check this diff");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("check this diff", null, undefined, {
      assistantPrompt: "Use these skills for this request: code-review.",
      chips: [{ label: "code-review", type: "skill" }],
      displayText: "check this diff",
    });

    await waitFor(() => {
      expect(screen.queryByText("code-review")).not.toBeInTheDocument();
    });
    expect(input).toHaveValue("");
  });

  it("expands direct slash skill commands before sending", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([
      {
        id: "global:/skills/code-review",
        name: "code-review",
        description: "Reviews code",
        sourceLabel: "Personal",
      },
    ]);

    render(<ChatInput onSend={onSend} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "/code-review check this diff");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("check this diff", null, undefined, {
      assistantPrompt: "Use these skills for this request: code-review.",
      chips: [{ label: "code-review", type: "skill" }],
      displayText: "check this diff",
    });
  });

  it("expands colon-qualified slash skill commands before sending", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([
      {
        id: "global:/skills/github",
        name: "github:github",
        description: "Works with GitHub",
        sourceLabel: "Personal",
      },
    ]);

    render(<ChatInput onSend={onSend} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "/github:github triage this PR");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("triage this PR", null, undefined, {
      assistantPrompt: "Use these skills for this request: github:github.",
      chips: [{ label: "github:github", type: "skill" }],
      displayText: "triage this PR",
    });
  });

  it("expands selected skill chips for voice auto-submit", async () => {
    const onSend = vi.fn();
    const onSkillsChange = vi.fn();

    render(
      <ChatInput
        onSend={onSend}
        selectedSkills={[
          {
            id: "global:/skills/code-review",
            name: "code-review",
            description: "Reviews code",
            sourceLabel: "Personal",
          },
        ]}
        onSkillsChange={onSkillsChange}
      />,
    );

    await act(async () => {
      const accepted =
        await lastVoiceDictationOptions?.onAutoSubmit?.("check this diff");
      expect(accepted).toBe(true);
    });

    expect(onSend).toHaveBeenCalledWith("check this diff", null, undefined, {
      assistantPrompt: "Use these skills for this request: code-review.",
      chips: [{ label: "code-review", type: "skill" }],
      displayText: "check this diff",
    });
    expect(onSkillsChange).toHaveBeenCalledWith([]);
  });

  it("does not expand reserved slash commands as skills", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([
      {
        id: "global:/skills/compact",
        name: "compact",
        description: "A compacting skill",
        sourceLabel: "Personal",
      },
    ]);

    render(<ChatInput onSend={onSend} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "/compact");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("/compact", null, undefined);
  });
});
