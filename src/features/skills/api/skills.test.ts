import { beforeEach, describe, expect, it, vi } from "vitest";
import { SKILLS_CHANGED_EVENT } from "../lib/skillsEvents";

const mockGooseSourcesList = vi.fn();
const mockGooseSourcesCreate = vi.fn();
const mockGooseSourcesDelete = vi.fn();
const mockGooseSourcesUpdate = vi.fn();
const mockGooseSourcesImport = vi.fn();
const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({
    goose: {
      GooseUnstableSourcesList: (...args: unknown[]) =>
        mockGooseSourcesList(...args),
      GooseUnstableSourcesCreate: (...args: unknown[]) =>
        mockGooseSourcesCreate(...args),
      GooseUnstableSourcesDelete: (...args: unknown[]) =>
        mockGooseSourcesDelete(...args),
      GooseUnstableSourcesUpdate: (...args: unknown[]) =>
        mockGooseSourcesUpdate(...args),
      GooseUnstableSourcesImport: (...args: unknown[]) =>
        mockGooseSourcesImport(...args),
    },
  }),
}));

describe("createSkill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("returns the created global skill mapped to SkillInfo", async () => {
    mockGooseSourcesCreate.mockResolvedValue({
      source: {
        type: "skill",
        name: "test-writer",
        description: "Writes tests",
        content: "Write tests",
        path: "/Users/test/.agents/skills/test-writer",
        global: true,
        properties: { color: "blue" },
      },
    });

    const { createSkill } = await import("./skills");
    const skill = await createSkill(
      "test-writer",
      "Writes tests",
      "Write tests",
      "blue",
    );

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith({
      type: "skill",
      name: "test-writer",
      description: "Writes tests",
      content: "Write tests",
      target: { scope: "global" },
      properties: { color: "blue" },
    });
    expect(skill).toMatchObject({
      id: "global:/Users/test/.agents/skills/test-writer",
      name: "test-writer",
      description: "Writes tests",
      instructions: "Write tests",
      path: "/Users/test/.agents/skills/test-writer",
      sourceKind: "global",
      sourceLabel: "Personal",
      projectLinks: [],
      readonly: false,
      color: "blue",
    });
  });

  it("targets the project scope and maps a project skill", async () => {
    mockGooseSourcesCreate.mockResolvedValue({
      source: {
        type: "skill",
        name: "test-writer",
        description: "Writes tests",
        content: "Write tests",
        path: "/tmp/alpha/.agents/skills/test-writer",
        global: false,
        properties: { color: "blue" },
      },
    });

    const { createSkill } = await import("./skills");
    const skill = await createSkill(
      "test-writer",
      "Writes tests",
      "Write tests",
      "blue",
      { projectId: "alpha-project" },
    );

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { scope: "projectId", projectId: "alpha-project" },
      }),
    );
    expect(skill).toMatchObject({
      id: "project:/tmp/alpha/.agents/skills/test-writer",
      sourceKind: "project",
      sourceLabel: "alpha",
      projectLinks: [
        {
          id: "/tmp/alpha",
          name: "alpha",
          workingDir: "/tmp/alpha",
        },
      ],
    });
  });
});

describe("isProjectSkillId", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("recognizes project-scoped skill ids", async () => {
    const { isProjectSkillId } = await import("./skills");

    expect(isProjectSkillId("project:/tmp/alpha/.agents/skills/test")).toBe(
      true,
    );
    expect(isProjectSkillId("global:/Users/test/.agents/skills/test")).toBe(
      false,
    );
    expect(isProjectSkillId("builtin:test")).toBe(false);
  });
});

describe("skill mutation events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("emits the skills changed event after a successful create", async () => {
    mockGooseSourcesCreate.mockResolvedValue({
      source: {
        type: "skill",
        name: "test-writer",
        description: "Writes tests",
        content: "Write tests",
        path: "/Users/test/.agents/skills/test-writer",
        global: true,
      },
    });
    const listener = vi.fn();
    window.addEventListener(SKILLS_CHANGED_EVENT, listener);

    try {
      const { createSkill } = await import("./skills");
      await createSkill("test-writer", "Writes tests", "Write tests", "blue");

      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(SKILLS_CHANGED_EVENT, listener);
    }
  });

  it("emits the skills changed event after successful update, delete, and import", async () => {
    mockGooseSourcesUpdate.mockResolvedValue({
      source: {
        type: "skill",
        name: "test-writer",
        description: "Writes tests",
        content: "Write tests",
        path: "/Users/test/.agents/skills/test-writer",
        global: true,
      },
    });
    mockGooseSourcesDelete.mockResolvedValue({});
    mockGooseSourcesImport.mockResolvedValue({
      sources: [
        {
          type: "skill",
          name: "imported",
          description: "Imported skill",
          content: "Imported instructions",
          path: "/Users/test/.agents/skills/imported",
          global: true,
        },
      ],
    });
    const listener = vi.fn();
    window.addEventListener(SKILLS_CHANGED_EVENT, listener);

    try {
      const { deleteSkill, importSkills, updateSkill } = await import(
        "./skills"
      );
      await updateSkill(
        "/Users/test/.agents/skills/test-writer",
        "test-writer",
        "Writes tests",
        "Write tests",
        "blue",
      );
      await deleteSkill("/Users/test/.agents/skills/test-writer");
      await importSkills([123, 125], "IMPORTED.SKILL.JSON");

      expect(listener).toHaveBeenCalledTimes(3);
    } finally {
      window.removeEventListener(SKILLS_CHANGED_EVENT, listener);
    }
  });

  it("does not emit the skills changed event when a mutation fails", async () => {
    mockGooseSourcesCreate.mockRejectedValue(new Error("permission denied"));
    const listener = vi.fn();
    window.addEventListener(SKILLS_CHANGED_EVENT, listener);

    try {
      const { createSkill } = await import("./skills");
      await expect(
        createSkill("test-writer", "Writes tests", "Write tests", "blue"),
      ).rejects.toThrow("permission denied");

      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(SKILLS_CHANGED_EVENT, listener);
    }
  });
});

describe("listSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockInvoke.mockResolvedValue({ skills: [] });
  });

  it("aggregates project skill listings and recognizes .agents skill paths", async () => {
    mockGooseSourcesList
      .mockResolvedValueOnce({
        sources: [
          {
            type: "skill",
            name: "code-review",
            description: "Reviews code",
            content: "Review carefully",
            path: "/Users/test/.agents/skills/code-review",
            global: true,
          },
        ],
      })
      .mockResolvedValueOnce({ sources: [] })
      .mockResolvedValueOnce({
        sources: [
          {
            type: "skill",
            name: "code-review",
            description: "Reviews code",
            content: "Review carefully",
            path: "/Users/test/.agents/skills/code-review",
            global: true,
          },
          {
            type: "skill",
            name: "test-writer",
            description: "Writes tests",
            content: "Write tests",
            path: "/tmp/alpha/.agents/skills/test-writer",
            global: false,
          },
        ],
      });

    const { listSkills } = await import("./skills");
    const skills = await listSkills(["/tmp/alpha", "/tmp/alpha"]);

    expect(mockGooseSourcesList).toHaveBeenNthCalledWith(1, {
      type: "skill",
    });
    expect(mockGooseSourcesList).toHaveBeenNthCalledWith(2, {
      type: "builtinSkill",
    });
    expect(mockGooseSourcesList).toHaveBeenNthCalledWith(3, {
      type: "skill",
      projectDir: "/tmp/alpha",
    });
    expect(skills.filter((skill) => skill.name === "code-review")).toHaveLength(
      1,
    );
    expect(skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "test-writer",
          sourceKind: "project",
          sourceLabel: "alpha",
          readonly: false,
          projectLinks: expect.arrayContaining([
            expect.objectContaining({
              id: "/tmp/alpha",
              name: "alpha",
              workingDir: "/tmp/alpha",
            }),
          ]),
        }),
      ]),
    );
  });

  it("recognizes legacy .goose project skill paths", async () => {
    mockGooseSourcesList
      .mockResolvedValueOnce({ sources: [] })
      .mockResolvedValueOnce({ sources: [] })
      .mockResolvedValueOnce({
        sources: [
          {
            type: "skill",
            name: "legacy-writer",
            description: "Legacy project skill",
            content: "Legacy instructions",
            path: "/tmp/beta/.goose/skills/legacy-writer",
            global: false,
          },
        ],
      });

    const { listSkills } = await import("./skills");
    const skills = await listSkills(["/tmp/beta"]);

    expect(skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "legacy-writer",
          sourceKind: "project",
          sourceLabel: "beta",
          readonly: false,
          projectLinks: expect.arrayContaining([
            expect.objectContaining({
              id: "/tmp/beta",
              name: "beta",
              workingDir: "/tmp/beta",
            }),
          ]),
        }),
      ]),
    );
  });

  it("keeps available skills when a project skill listing fails", async () => {
    mockGooseSourcesList
      .mockResolvedValueOnce({
        sources: [
          {
            type: "skill",
            name: "code-review",
            description: "Reviews code",
            content: "Review carefully",
            path: "/Users/test/.agents/skills/code-review",
            global: true,
          },
        ],
      })
      .mockResolvedValueOnce({ sources: [] })
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce({
        sources: [
          {
            type: "skill",
            name: "test-writer",
            description: "Writes tests",
            content: "Write tests",
            path: "/tmp/beta/.agents/skills/test-writer",
            global: false,
          },
        ],
      });

    const { listSkills } = await import("./skills");
    const skills = await listSkills(["/tmp/alpha", "/tmp/beta"]);

    expect(mockGooseSourcesList).toHaveBeenCalledTimes(4);
    expect(skills.map((skill) => skill.name)).toEqual([
      "code-review",
      "test-writer",
    ]);
  });

  it("dedupes identical project skills from managed worktrees", async () => {
    mockGooseSourcesList
      .mockResolvedValueOnce({ sources: [] })
      .mockResolvedValueOnce({ sources: [] })
      .mockResolvedValueOnce({
        sources: [
          {
            type: "skill",
            name: "test-writer",
            description: "Writes tests",
            content: "Write tests",
            path: "/Users/test/goose2/.agents/skills/test-writer",
            global: false,
            properties: { projectDir: "/Users/test/goose2" },
          },
        ],
      })
      .mockResolvedValueOnce({
        sources: [
          {
            type: "skill",
            name: "test-writer",
            description: "Writes tests",
            content: "Write tests",
            path: "/Users/test/goose2-worktrees/feature/.agents/skills/test-writer",
            global: false,
            properties: { projectDir: "/Users/test/goose2-worktrees/feature" },
          },
        ],
      });

    const { listSkills } = await import("./skills");
    const skills = await listSkills([
      "/Users/test/goose2",
      "/Users/test/goose2-worktrees/feature",
    ]);

    expect(skills.map((skill) => skill.name)).toEqual(["test-writer"]);
    expect(skills[0]).toMatchObject({
      id: "project:/Users/test/goose2/.agents/skills/test-writer",
      projectLinks: [
        {
          id: "/Users/test/goose2",
          name: "goose2",
          workingDir: "/Users/test/goose2",
        },
        {
          id: "/Users/test/goose2-worktrees/feature",
          name: "feature",
          workingDir: "/Users/test/goose2-worktrees/feature",
        },
      ],
    });
  });

  it("keeps divergent worktree skill copies separate", async () => {
    mockGooseSourcesList
      .mockResolvedValueOnce({ sources: [] })
      .mockResolvedValueOnce({ sources: [] })
      .mockResolvedValueOnce({
        sources: [
          {
            type: "skill",
            name: "test-writer",
            description: "Writes tests",
            content: "Write tests",
            path: "/Users/test/goose2/.agents/skills/test-writer",
            global: false,
          },
        ],
      })
      .mockResolvedValueOnce({
        sources: [
          {
            type: "skill",
            name: "test-writer",
            description: "Writes tests",
            content: "Write different tests",
            path: "/Users/test/goose2-worktrees/feature/.agents/skills/test-writer",
            global: false,
          },
        ],
      });

    const { listSkills } = await import("./skills");
    const skills = await listSkills([
      "/Users/test/goose2",
      "/Users/test/goose2-worktrees/feature",
    ]);

    expect(skills.map((skill) => skill.instructions)).toEqual([
      "Write tests",
      "Write different tests",
    ]);
  });

  it("keeps filesystem skills when built-in skill listing fails", async () => {
    mockGooseSourcesList
      .mockResolvedValueOnce({
        sources: [
          {
            type: "skill",
            name: "code-review",
            description: "Reviews code",
            content: "Review carefully",
            path: "/Users/test/.agents/skills/code-review",
            global: true,
          },
        ],
      })
      .mockRejectedValueOnce(new Error("unknown source type"))
      .mockResolvedValueOnce({
        sources: [
          {
            type: "skill",
            name: "test-writer",
            description: "Writes tests",
            content: "Write tests",
            path: "/tmp/alpha/.agents/skills/test-writer",
            global: false,
          },
        ],
      });

    const { listSkills } = await import("./skills");
    const skills = await listSkills(["/tmp/alpha"]);

    expect(mockGooseSourcesList).toHaveBeenNthCalledWith(1, {
      type: "skill",
    });
    expect(mockGooseSourcesList).toHaveBeenNthCalledWith(2, {
      type: "builtinSkill",
    });
    expect(mockGooseSourcesList).toHaveBeenNthCalledWith(3, {
      type: "skill",
      projectDir: "/tmp/alpha",
    });
    expect(skills.map((skill) => skill.name)).toEqual([
      "code-review",
      "test-writer",
    ]);
  });

  it("merges Berd app skills into Goose skill discovery", async () => {
    window.__TAURI_INTERNALS__ = {};
    mockInvoke.mockResolvedValueOnce({
      skills: [
        {
          name: "goose-help",
          description: "Help with Berd",
          content: "Use Berd help",
          path: "/Users/test/Library/Application Support/xyz.block.berd/skills/goose-help",
          fileLocation:
            "/Users/test/Library/Application Support/xyz.block.berd/skills/goose-help/SKILL.md",
          sourceKind: "app",
          sourceLabel: "Berd app",
        },
      ],
    });
    mockGooseSourcesList
      .mockResolvedValueOnce({ sources: [] })
      .mockResolvedValueOnce({ sources: [] });

    const { listSkills } = await import("./skills");
    const skills = await listSkills();

    expect(mockInvoke).toHaveBeenCalledWith("list_berd_app_skills");
    expect(skills).toEqual([
      expect.objectContaining({
        id: "app:/Users/test/Library/Application Support/xyz.block.berd/skills/goose-help",
        name: "goose-help",
        sourceKind: "app",
        sourceLabel: "Berd app",
        readonly: true,
      }),
    ]);
    delete window.__TAURI_INTERNALS__;
  });

  it("orders Personal skills before same-named Berd app skills", async () => {
    window.__TAURI_INTERNALS__ = {};
    mockInvoke.mockResolvedValueOnce({
      skills: [
        {
          name: "agent-builder",
          description: "Berd app builder",
          content: "Use the app builder",
          path: "/Users/test/Library/Application Support/xyz.block.berd/skills/agent-builder",
          fileLocation:
            "/Users/test/Library/Application Support/xyz.block.berd/skills/agent-builder/SKILL.md",
          sourceKind: "app",
          sourceLabel: "Berd app",
        },
      ],
    });
    mockGooseSourcesList
      .mockResolvedValueOnce({
        sources: [
          {
            type: "skill",
            name: "agent-builder",
            description: "Personal builder",
            content: "Use my builder",
            path: "/Users/test/.agents/skills/agent-builder",
            global: true,
          },
        ],
      })
      .mockResolvedValueOnce({ sources: [] });

    const { listSkills } = await import("./skills");
    const skills = await listSkills();

    expect(skills.map((skill) => skill.sourceKind)).toEqual(["global", "app"]);
    delete window.__TAURI_INTERNALS__;
  });

  it("threads fresh past a pending app-skill invoke so the listing observes post-change data", async () => {
    window.__TAURI_INTERNALS__ = {};
    const appSkillResponse = (name: string) => ({
      skills: [
        {
          name,
          description: "",
          content: "",
          path: `/app/skills/${name}`,
          fileLocation: `/app/skills/${name}/SKILL.md`,
          sourceKind: "app",
          sourceLabel: "Berd app",
        },
      ],
    });
    let resolveBeforeChange!: (value: unknown) => void;
    let resolveAfterChange!: (value: unknown) => void;
    mockInvoke
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveBeforeChange = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveAfterChange = resolve;
        }),
      );
    mockGooseSourcesList.mockResolvedValue({ sources: [] });

    const { listBerdAppSkills, listSkills } = await import("./skills");

    // A pre-change app-skill request is still in flight when the fresh
    // listing starts; without threading `fresh` into the shared invoke the
    // listing would join it and resolve with pre-change data.
    const pending = listBerdAppSkills();
    const refreshed = listSkills([], { fresh: true });

    resolveAfterChange(appSkillResponse("after-skill"));
    resolveBeforeChange(appSkillResponse("before-skill"));

    expect((await refreshed).map((skill) => skill.name)).toEqual([
      "after-skill",
    ]);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    await pending;
    delete window.__TAURI_INTERNALS__;
  });

  it("fetches and maps built-in skills without filesystem project/global metadata", async () => {
    mockGooseSourcesList
      .mockResolvedValueOnce({
        sources: [
          {
            type: "skill",
            name: "personal-review",
            description: "Reviews personal code",
            content: "Review local changes",
            path: "/Users/test/.agents/skills/personal-review",
            global: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        sources: [
          {
            type: "builtinSkill",
            name: "goose-doc-guide",
            description: "Goose documentation guide",
            content: "Use Goose docs",
            path: "builtin://skills/goose-doc-guide",
            global: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        sources: [
          {
            type: "skill",
            name: "project-helper",
            description: "Helps project work",
            content: "Use project context",
            path: "/tmp/alpha/.agents/skills/project-helper",
            global: false,
          },
        ],
      });

    const { listSkills } = await import("./skills");
    const skills = await listSkills(["/tmp/alpha"]);

    expect(mockGooseSourcesList).toHaveBeenNthCalledWith(1, {
      type: "skill",
    });
    expect(mockGooseSourcesList).toHaveBeenNthCalledWith(2, {
      type: "builtinSkill",
    });
    expect(mockGooseSourcesList).toHaveBeenNthCalledWith(3, {
      type: "skill",
      projectDir: "/tmp/alpha",
    });
    expect(skills.map((skill) => skill.name)).toEqual([
      "personal-review",
      "goose-doc-guide",
      "project-helper",
    ]);
    expect(skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "builtin:goose-doc-guide",
          name: "goose-doc-guide",
          path: "builtin://skills/goose-doc-guide",
          fileLocation: "builtin://skills/goose-doc-guide",
          sourceKind: "builtin",
          sourceLabel: "Built in",
          readonly: true,
          projectLinks: [],
        }),
      ]),
    );
  });
});
