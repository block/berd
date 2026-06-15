import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ChatInput } from "./chatInputTestUtils";
import type { ChatSkillDraft } from "../../types";

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

const CODE_REVIEW_SKILL = {
  id: "global:/skills/code-review",
  name: "code-review",
  description: "Reviews code",
  sourceLabel: "Personal",
};

describe("ChatInput skill mentions", () => {
  beforeEach(() => {
    localStorage.clear();
    mockListSkills.mockClear();
    mockListSkills.mockResolvedValue([]);
    lastVoiceDictationOptions = null;
    mockVoiceDictation.isStarting.mockReset();
    mockVoiceDictation.isStarting.mockReturnValue(false);
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

  it("shows skills in slash results, removes the command text, and creates a skill chip", async () => {
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

    expect(input).toHaveValue("");
    expect(screen.getByText("code-review")).toBeInTheDocument();
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

    expect(input).toHaveValue("https://example.com/path");
    expect(screen.getByText("code-review")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows and dismisses Agent Tools availability tips", async () => {
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

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    await user.type(screen.getByRole("textbox"), "send this to slack");

    expect(
      await screen.findByText("Slack is available through sq agent tools"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dismiss tip" }));

    expect(
      screen.queryByText("Slack is available through sq agent tools"),
    ).not.toBeInTheDocument();
  });

  it("turns off Agent Tools availability tips from the composer", async () => {
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

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    await user.type(screen.getByRole("textbox"), "send this to slack");
    await user.click(await screen.findByRole("button", { name: "Turn off" }));

    expect(localStorage.getItem("goose:agent-tools-tips-enabled")).toBe(
      "false",
    );
    expect(
      screen.queryByText("Slack is available through sq agent tools"),
    ).not.toBeInTheDocument();
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

    expect(onSend).toHaveBeenCalledWith(
      "check this diff",
      undefined,
      undefined,
      {
        assistantPrompt: "Use these skills for this request: code-review.",
        chips: [{ label: "code-review", type: "skill" }],
        displayText: "check this diff",
      },
    );
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

    expect(onSend).toHaveBeenCalledWith(
      "check this diff",
      undefined,
      undefined,
      {
        assistantPrompt: "Use these skills for this request: code-review.",
        chips: [{ label: "code-review", type: "skill" }],
        displayText: "check this diff",
      },
    );

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

    expect(onSend).toHaveBeenCalledWith(
      "check this diff",
      undefined,
      undefined,
      {
        assistantPrompt: "Use these skills for this request: code-review.",
        chips: [{ label: "code-review", type: "skill" }],
        displayText: "check this diff",
      },
    );
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

    expect(onSend).toHaveBeenCalledWith(
      "triage this PR",
      undefined,
      undefined,
      {
        assistantPrompt: "Use these skills for this request: github:github.",
        chips: [{ label: "github:github", type: "skill" }],
        displayText: "triage this PR",
      },
    );
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

    expect(onSend).toHaveBeenCalledWith(
      "check this diff",
      undefined,
      undefined,
      {
        assistantPrompt: "Use these skills for this request: code-review.",
        chips: [{ label: "code-review", type: "skill" }],
        displayText: "check this diff",
      },
    );
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

    expect(onSend).toHaveBeenCalledWith("/compact", undefined, undefined);
  });
});
