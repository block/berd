import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillInfo } from "@/features/skills/api/skills";
import { emitSkillsChanged } from "@/features/skills/lib/skillsEvents";
import type { WidgetInstance } from "./types";
import { SkillPinWidget } from "./SkillPinWidget";
import {
  listHomeWidgetSkills,
  useInvalidateHomeWidgetSkillsOnChange,
} from "./skillQueryKey";

const state = vi.hoisted(() => ({ skills: [] as SkillInfo[] }));

vi.mock("./skillQueryKey", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./skillQueryKey")>();
  return {
    ...actual,
    listHomeWidgetSkills: vi.fn(() => Promise.resolve(state.skills)),
  };
});

function skill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    id: "global:/Users/tulsi/.agents/skills/agent-browser/SKILL.md",
    name: "agent-browser",
    description: "Debug web apps in a browser",
    instructions: "",
    path: "/Users/tulsi/.agents/skills/agent-browser/SKILL.md",
    fileLocation: "/Users/tulsi/.agents/skills/agent-browser/SKILL.md",
    sourceKind: "global",
    sourceLabel: "Personal",
    projectLinks: [],
    readonly: false,
    legacyPinIds: [],
    color: null,
    ...overrides,
  };
}

function instance(skillId: string): WidgetInstance {
  return {
    id: "skill-pin-1",
    type: "skillPin",
    x: 20,
    y: 30,
    z: 1,
    state: { skillId },
  };
}

function renderPin(
  skillId: string,
  onOpenSkill = vi.fn(),
  onTagSkillInComposer?: (skill: SkillInfo) => void,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function SkillQueryInvalidationEvents() {
    useInvalidateHomeWidgetSkillsOnChange();
    return null;
  }
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <SkillQueryInvalidationEvents />
        {children}
      </QueryClientProvider>
    );
  }

  return {
    onOpenSkill,
    ...render(
      <SkillPinWidget
        instance={instance(skillId)}
        onUpdateState={vi.fn()}
        onOpenSkill={onOpenSkill}
        onTagSkillInComposer={onTagSkillInComposer}
      />,
      { wrapper: Wrapper },
    ),
  };
}

describe("SkillPinWidget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.skills = [skill()];
  });

  it("resolves persisted skill pins with directory-style ids", async () => {
    const { onOpenSkill } = renderPin(
      "global:/Users/tulsi/.agents/skills/agent-browser",
    );

    const button = await screen.findByRole("button", {
      name: "Start chat with agent-browser",
    });
    fireEvent.click(button);

    expect(screen.getByText("agent-browser")).toBeVisible();
    expect(screen.queryByText("Skill unavailable")).toBeNull();
    expect(onOpenSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: "agent-browser" }),
    );
  });

  it("resolves a legacy bundled-skill pin to its migrated Berd app skill", async () => {
    state.skills = [
      skill({
        id: "app:/Users/tulsi/Library/Application Support/xyz.block.berd/skills/agent-builder",
        name: "agent-builder",
        path: "/Users/tulsi/Library/Application Support/xyz.block.berd/skills/agent-builder",
        fileLocation:
          "/Users/tulsi/Library/Application Support/xyz.block.berd/skills/agent-builder/SKILL.md",
        sourceKind: "app",
        sourceLabel: "Berd app",
        readonly: true,
        legacyPinIds: ["global:/Users/tulsi/.agents/skills/agent-builder"],
      }),
    ];
    const { onOpenSkill } = renderPin(
      "global:/Users/tulsi/.agents/skills/agent-builder",
    );

    const button = await screen.findByRole("button", {
      name: "Start chat with agent-builder",
    });
    fireEvent.click(button);

    expect(onOpenSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "agent-builder",
        sourceKind: "app",
        sourceLabel: "Berd app",
      }),
    );
  });

  it("falls back to persisted skill path data when the skills list misses", async () => {
    state.skills = [];
    const { onOpenSkill } = renderPin(
      "global:/Users/tulsi/.agents/skills/agent-browser",
    );

    const button = await screen.findByRole("button", {
      name: "Start chat with agent-browser",
    });
    fireEvent.click(button);

    expect(screen.getByText("agent-browser")).toBeVisible();
    expect(screen.queryByText("Skill unavailable")).toBeNull();
    expect(onOpenSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "global:/Users/tulsi/.agents/skills/agent-browser",
        name: "agent-browser",
        sourceLabel: "Personal",
      }),
    );
  });

  it("tags the skill in the composer instead of opening the skill directly when requested", async () => {
    const onOpenSkill = vi.fn();
    const onTagSkillInComposer = vi.fn();
    renderPin(
      "global:/Users/tulsi/.agents/skills/agent-browser",
      onOpenSkill,
      onTagSkillInComposer,
    );

    const button = await screen.findByRole("button", {
      name: "Start chat with agent-browser",
    });
    fireEvent.click(button);

    expect(onTagSkillInComposer).toHaveBeenCalledWith(
      expect.objectContaining({ name: "agent-browser" }),
    );
    expect(onOpenSkill).not.toHaveBeenCalled();
  });

  it("refreshes the shared skill query when skills change", async () => {
    renderPin("global:/Users/tulsi/.agents/skills/agent-browser");

    expect(await screen.findByText("agent-browser")).toBeVisible();

    state.skills = [
      skill({
        name: "agent-browser-updated",
      }),
    ];
    emitSkillsChanged();

    await waitFor(() => {
      expect(listHomeWidgetSkills).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText("agent-browser-updated")).toBeVisible();
  });
});
