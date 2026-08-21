import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Persona } from "@/shared/types/agents";

const mockGooseSourcesList = vi.fn();
const mockGooseSourcesCreate = vi.fn();
const mockGooseSourcesUpdate = vi.fn();
const mockGooseSourcesDelete = vi.fn();
const mockGooseSourcesExport = vi.fn();
const mockGooseSourcesImport = vi.fn();
const appAvatarRef = "app-avatar:gloopy-1";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({
    goose: {
      GooseUnstableSourcesList: (...args: unknown[]) =>
        mockGooseSourcesList(...args),
      GooseUnstableSourcesCreate: (...args: unknown[]) =>
        mockGooseSourcesCreate(...args),
      GooseUnstableSourcesUpdate: (...args: unknown[]) =>
        mockGooseSourcesUpdate(...args),
      GooseUnstableSourcesDelete: (...args: unknown[]) =>
        mockGooseSourcesDelete(...args),
      GooseUnstableSourcesExport: (...args: unknown[]) =>
        mockGooseSourcesExport(...args),
      GooseUnstableSourcesImport: (...args: unknown[]) =>
        mockGooseSourcesImport(...args),
    },
  }),
}));

const mockedInvoke = vi.mocked(invoke);

const agentSource = {
  type: "agent",
  name: "Scout",
  description: "Agent",
  content: "Research carefully.",
  path: "/Users/test/.agents/agents/scout.md",
  global: true,
  writable: true,
  properties: {
    provider: "openai",
    model: "gpt-4.1",
    avatar: "https://example.test/scout.png",
  },
} as const;

const loadedPersona: Persona = {
  id: agentSource.path,
  displayName: "Scout",
  avatar: "https://example.test/scout.png",
  systemPrompt: "Research carefully.",
  provider: "openai",
  model: "gpt-4.1",
  isBuiltin: false,
  writable: true,
  sourceDescription: "Agent",
  sourceProperties: {
    provider: "openai",
    model: "gpt-4.1",
    avatar: "https://example.test/scout.png",
  },
};

describe("agents API", () => {
  beforeEach(() => {
    mockGooseSourcesList.mockReset();
    mockGooseSourcesCreate.mockReset();
    mockGooseSourcesUpdate.mockReset();
    mockGooseSourcesDelete.mockReset();
    mockGooseSourcesExport.mockReset();
    mockGooseSourcesImport.mockReset();
    mockedInvoke.mockReset();
  });

  it("requests repair of a bundled agent", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    const { repairBundledAgent } = await import("../agents");

    await repairBundledAgent("berdy.md");

    expect(mockedInvoke).toHaveBeenCalledWith("repair_bundled_agent", {
      fileName: "berdy.md",
    });
  });

  it("lists personas through ACP agent sources", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        agentSource,
        {
          type: "skill",
          name: "ignored",
          description: "",
          content: "",
          path: "/tmp/ignored",
          global: true,
        },
      ],
    });

    const { listPersonas } = await import("../agents");
    const result = await listPersonas();

    expect(mockGooseSourcesList).toHaveBeenCalledWith({ type: "agent" });
    expect(result).toEqual([
      {
        id: agentSource.path,
        displayName: "Scout",
        avatar: "https://example.test/scout.png",
        systemPrompt: "Research carefully.",
        provider: "openai",
        model: "gpt-4.1",
        isBuiltin: false,
        writable: true,
        sourceDescription: "Agent",
        sourceProperties: {
          provider: "openai",
          model: "gpt-4.1",
          avatar: "https://example.test/scout.png",
        },
      },
    ]);
  });

  it("drops unsafe avatar properties from listed personas", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          properties: {
            avatar: "data:image/png;base64,aWNvbg==",
          },
        },
      ],
    });

    const { listPersonas } = await import("../agents");
    const result = await listPersonas();

    expect(result[0].avatar).toBeNull();
  });

  it("preserves app avatar refs from listed personas", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          properties: {
            avatar: appAvatarRef,
          },
        },
      ],
    });

    const { listPersonas } = await import("../agents");
    const result = await listPersonas();

    expect(result[0].avatar).toBe(appAvatarRef);
  });

  it("does not hydrate listed personas that already have a display name", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [agentSource],
    });

    const { listPersonas } = await import("../agents");
    await listPersonas();

    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("hydrates writable listed personas from markdown frontmatter", async () => {
    const sourcePath = "/Users/test/.agents/agents/blueprint-boi.md";
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          path: sourcePath,
          name: "blueprint-boi",
          description: "Architect.",
          content: "Fallback prompt.",
          properties: {
            avatar: appAvatarRef,
          },
        },
      ],
    });
    mockedInvoke.mockResolvedValue({
      fileName: "blueprint-boi.md",
      fileContents:
        "---\nname: blueprint-boi\ndisplay_name: Blueprint Bandit\ndescription: Plans carefully.\nmodel: goose:goose-claude-fable-5\navatar: app-avatar:gloopies-14\ngood_for: practical plans\nvibes: thoughtful, precise\n---\n\nPlan before building.\n",
    });

    const { listPersonas } = await import("../agents");
    const result = await listPersonas();

    expect(mockedInvoke).toHaveBeenCalledWith("read_agent_source_file", {
      sourcePath,
    });
    expect(result[0]).toMatchObject({
      id: sourcePath,
      displayName: "Blueprint Bandit",
      sourceDescription: "Plans carefully.",
      systemPrompt: "Plan before building.",
      provider: "goose",
      model: "goose-claude-fable-5",
      avatar: "app-avatar:gloopies-14",
    });
  });

  it("keeps listed persona metadata when markdown hydration fails", async () => {
    const sourcePath = "/Users/test/.agents/agents/blueprint-boi.md";
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          path: sourcePath,
          name: "blueprint-boi",
        },
      ],
    });
    mockedInvoke.mockRejectedValue(new Error("read failed"));

    const { listPersonas } = await import("../agents");
    const result = await listPersonas();

    expect(result[0].displayName).toBe("blueprint-boi");
  });

  it("does not hydrate read-only listed agent sources", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [{ ...agentSource, writable: false }],
    });

    const { listPersonas } = await import("../agents");
    await listPersonas();

    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("marks read-only agent sources as built in personas", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [{ ...agentSource, writable: false }],
    });

    const { listPersonas } = await import("../agents");
    const result = await listPersonas();

    expect(result[0]).toEqual(
      expect.objectContaining({
        isBuiltin: true,
        writable: false,
      }),
    );
  });

  it("defaults omitted writable to read-only", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [{ ...agentSource, writable: undefined }],
    });

    const { listPersonas } = await import("../agents");
    const result = await listPersonas();

    expect(result[0]).toEqual(
      expect.objectContaining({
        isBuiltin: true,
        writable: false,
      }),
    );
  });

  it("creates personas through ACP source create", async () => {
    mockGooseSourcesCreate.mockResolvedValue({ source: agentSource });

    const { createPersona } = await import("../agents");
    const result = await createPersona({
      displayName: "Scout",
      avatar: "https://example.test/scout.png",
      systemPrompt: "Research carefully.",
      provider: "goose",
      modelProviderId: "openai",
      model: "gpt-4.1",
    });

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith({
      type: "agent",
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      target: { scope: "global" },
      properties: {
        draft: false,
        provider: "goose",
        modelProviderId: "openai",

        model: "gpt-4.1",
        avatar: "https://example.test/scout.png",
      },
    });
    expect(result.displayName).toBe("Scout");
    expect(result.avatar).toBe("https://example.test/scout.png");
  });

  it("uses a real description when creating a persona", async () => {
    mockGooseSourcesCreate.mockResolvedValue({ source: agentSource });

    const { createPersona } = await import("../agents");
    await createPersona({
      displayName: "Scout",
      systemPrompt: "Research carefully.",
      description: "Finds the source you actually need.",
    });

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Finds the source you actually need.",
      }),
    );
  });

  it.each([
    undefined,
    "",
    "   ",
    "Agent",
    "agent",
    "Draft",
    "  draft  ",
  ])("falls back to the placeholder description when creating with %j", async (description) => {
    mockGooseSourcesCreate.mockResolvedValue({ source: agentSource });

    const { createPersona } = await import("../agents");
    await createPersona({
      displayName: "Scout",
      systemPrompt: "Research carefully.",
      description,
    });

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Agent" }),
    );
  });

  it("does not store unsupported avatar values on create", async () => {
    mockGooseSourcesCreate.mockResolvedValue({ source: agentSource });

    const { createPersona } = await import("../agents");
    await createPersona({
      displayName: "Scout",
      avatar: "data:image/png;base64,aWNvbg==",
      systemPrompt: "Research carefully.",
    });

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith({
      type: "agent",
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      target: { scope: "global" },
      properties: { draft: false },
    });
  });

  it("stores app avatar refs on create", async () => {
    mockGooseSourcesCreate.mockResolvedValue({
      source: {
        ...agentSource,
        properties: {
          ...agentSource.properties,
          avatar: appAvatarRef,
        },
      },
    });

    const { createPersona } = await import("../agents");
    await createPersona({
      displayName: "Scout",
      avatar: appAvatarRef,
      systemPrompt: "Research carefully.",
    });

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith({
      type: "agent",
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      target: { scope: "global" },
      properties: {
        draft: false,
        avatar: appAvatarRef,
      },
    });
  });

  it("updates personas by merging modeled fields with unknown properties", async () => {
    mockGooseSourcesUpdate.mockResolvedValue({
      source: {
        ...agentSource,
        name: "Scout Prime",
        content: "Updated prompt.",
      },
    });

    const { updatePersona } = await import("../agents");
    await updatePersona(
      {
        ...loadedPersona,
        sourceProperties: {
          provider: "openai",
          model: "gpt-4.1",
          avatar: "https://example.test/scout.png",
          color: "blue",
        },
      },
      {
        displayName: "Scout Prime",
        systemPrompt: "Updated prompt.",
        provider: "anthropic",
      },
    );

    expect(mockGooseSourcesList).not.toHaveBeenCalled();
    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith({
      type: "agent",
      path: agentSource.path,
      name: "Scout Prime",
      description: "Agent",
      content: "Updated prompt.",
      properties: {
        provider: "anthropic",
        model: "gpt-4.1",
        avatar: "https://example.test/scout.png",
        color: "blue",
      },
    });
  });

  it("uses a new real description when updating a persona", async () => {
    mockGooseSourcesUpdate.mockResolvedValue({ source: agentSource });

    const { updatePersona } = await import("../agents");
    await updatePersona(loadedPersona, {
      description: "Finds the source you actually need.",
    });

    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Finds the source you actually need.",
      }),
    );
  });

  it("keeps the persona's existing real description when the update omits it", async () => {
    mockGooseSourcesUpdate.mockResolvedValue({ source: agentSource });

    const { updatePersona } = await import("../agents");
    await updatePersona(
      {
        ...loadedPersona,
        sourceDescription: "Finds the source you actually need.",
      },
      { systemPrompt: "Updated prompt." },
    );

    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Finds the source you actually need.",
      }),
    );
  });

  it.each([
    "",
    "   ",
    "Agent",
    "agent",
    "Draft",
    "  draft  ",
  ])("falls back to the placeholder description when the update explicitly clears it with %j", async (description) => {
    mockGooseSourcesUpdate.mockResolvedValue({ source: agentSource });

    const { updatePersona } = await import("../agents");
    // Same behavior as create: explicitly passing a cleared/placeholder
    // value is a real edit, not "leave it alone" — it does not fall back
    // to whatever the persona already had.
    await updatePersona(
      {
        ...loadedPersona,
        sourceDescription: "Finds the source you actually need.",
      },
      { description },
    );

    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Agent" }),
    );
  });

  it("falls back to the placeholder description when the persona never had a real one and the update omits it", async () => {
    mockGooseSourcesUpdate.mockResolvedValue({ source: agentSource });

    const { updatePersona } = await import("../agents");
    await updatePersona(
      { ...loadedPersona, sourceDescription: "Draft" },
      { systemPrompt: "Updated prompt." },
    );

    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Agent" }),
    );
  });

  it("clears modeled properties while preserving unknown source properties", async () => {
    mockGooseSourcesUpdate.mockResolvedValue({
      source: {
        ...agentSource,
        properties: {
          provider: null,
          model: null,
          avatar: null,
          color: "blue",
        },
      },
    });

    const { updatePersona } = await import("../agents");
    await updatePersona(
      {
        ...loadedPersona,
        sourceDescription: "",
        sourceProperties: {
          provider: "openai",
          model: "gpt-4.1",
          avatar: "data:image/png;base64,aWNvbg==",
          color: "blue",
        },
      },
      {
        avatar: null,
        provider: null,
        model: null,
      },
    );

    expect(mockGooseSourcesList).not.toHaveBeenCalled();
    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith({
      type: "agent",
      path: agentSource.path,
      name: "Scout",
      // The persona's existing sourceDescription is an empty string here,
      // which was never a real, user-authored description to begin with,
      // so it falls back to the placeholder rather than being sent through
      // verbatim.
      description: "Agent",
      content: "Research carefully.",
      properties: {
        provider: null,
        model: null,
        avatar: null,
        color: "blue",
      },
    });
  });

  it("stores app avatar refs on update", async () => {
    mockGooseSourcesUpdate.mockResolvedValue({
      source: {
        ...agentSource,
        properties: {
          ...agentSource.properties,
          avatar: appAvatarRef,
        },
      },
    });

    const { updatePersona } = await import("../agents");
    await updatePersona(loadedPersona, {
      avatar: appAvatarRef,
    });

    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith({
      type: "agent",
      path: agentSource.path,
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      properties: {
        provider: "openai",
        model: "gpt-4.1",
        avatar: appAvatarRef,
      },
    });
  });

  it("preserves unsupported existing avatar values on unrelated update", async () => {
    mockGooseSourcesUpdate.mockResolvedValue({
      source: {
        ...agentSource,
        properties: {
          ...agentSource.properties,
          avatar: "data:image/png;base64,aWNvbg==",
        },
      },
    });

    const { updatePersona } = await import("../agents");
    await updatePersona(
      {
        ...loadedPersona,
        sourceProperties: {
          ...loadedPersona.sourceProperties,
          avatar: "data:image/png;base64,aWNvbg==",
        },
      },
      {
        provider: "anthropic",
      },
    );

    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith({
      type: "agent",
      path: agentSource.path,
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      properties: {
        provider: "anthropic",
        model: "gpt-4.1",
        avatar: "data:image/png;base64,aWNvbg==",
      },
    });
  });

  it("migrates only target properties from the freshest source", async () => {
    const latestSource = {
      ...agentSource,
      name: "Scout Renamed",
      content: "New instructions.",
      properties: {
        ...agentSource.properties,
        color: "green",
      },
    };
    mockGooseSourcesList.mockResolvedValue({ sources: [latestSource] });
    mockGooseSourcesUpdate.mockResolvedValue({
      source: {
        ...latestSource,
        properties: {
          ...latestSource.properties,
          provider: "goose",
          modelProviderId: "databricks_v2",
          model: "goose-gpt-5-5",
        },
      },
    });

    const { migratePersonaTargetIfUnchanged } = await import("../agents");
    await migratePersonaTargetIfUnchanged(
      {
        id: agentSource.path,
        provider: "openai",
        model: "gpt-4.1",
      },
      {
        provider: "goose",
        modelProviderId: "databricks_v2",
        model: "goose-gpt-5-5",
      },
    );

    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith({
      type: "agent",
      path: agentSource.path,
      name: "Scout Renamed",
      description: "Agent",
      content: "New instructions.",
      properties: {
        provider: "goose",
        modelProviderId: "databricks_v2",
        model: "goose-gpt-5-5",
        avatar: "https://example.test/scout.png",
        color: "green",
      },
    });
  });

  it("skips target migration when the target changed after inspection", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          properties: {
            ...agentSource.properties,
            provider: "anthropic",
            model: "claude-new",
          },
        },
      ],
    });

    const { migratePersonaTargetIfUnchanged } = await import("../agents");
    const result = await migratePersonaTargetIfUnchanged(
      {
        id: agentSource.path,
        provider: "openai",
        model: "gpt-4.1",
      },
      {
        provider: "goose",
        modelProviderId: "databricks_v2",
        model: "goose-gpt-5-5",
      },
    );

    expect(result).toBeNull();
    expect(mockGooseSourcesUpdate).not.toHaveBeenCalled();
  });

  it("updates persona sources from the exact markdown file when listing omits them", async () => {
    const sourcePath = "/Users/test/.agents/agents/untitled-agent-1.md";
    mockGooseSourcesList.mockResolvedValue({ sources: [] });
    mockedInvoke.mockResolvedValue({
      fileName: "untitled-agent-1.md",
      fileContents:
        "---\nname: Constructive Critic\ndescription: Challenges assumptions.\ndraft: true\nbuilderSessionId: sess-1\n---\n\nPush back constructively.",
    });
    mockGooseSourcesUpdate.mockResolvedValue({
      source: {
        ...agentSource,
        path: sourcePath,
        name: "Constructive Critic",
        description: "Challenges assumptions.",
        content: "Push back with examples.",
        properties: {
          draft: true,
          builderSessionId: "sess-1",
          model: "gpt-4.1",
        },
      },
    });

    const { updatePersonaSource } = await import("../agents");
    await updatePersonaSource(sourcePath, {
      content: "Push back with examples.",
      properties: { model: "gpt-4.1" },
    });

    expect(mockedInvoke).toHaveBeenCalledWith("read_agent_source_file", {
      sourcePath,
    });
    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith({
      type: "agent",
      path: sourcePath,
      name: "Constructive Critic",
      description: "Challenges assumptions.",
      content: "Push back with examples.",
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        model: "gpt-4.1",
      },
    });
  });

  it("clears unsupported requested avatar values on update", async () => {
    mockGooseSourcesUpdate.mockResolvedValue({
      source: {
        ...agentSource,
        properties: {
          ...agentSource.properties,
          avatar: null,
        },
      },
    });

    const { updatePersona } = await import("../agents");
    await updatePersona(loadedPersona, {
      avatar: "javascript:alert(1)",
    });

    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith({
      type: "agent",
      path: agentSource.path,
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      properties: {
        provider: "openai",
        model: "gpt-4.1",
        avatar: null,
      },
    });
  });

  it("deletes personas through ACP source delete", async () => {
    const { deletePersona } = await import("../agents");
    await deletePersona(agentSource.path);

    expect(mockGooseSourcesList).not.toHaveBeenCalled();
    expect(mockGooseSourcesDelete).toHaveBeenCalledWith({
      type: "agent",
      path: agentSource.path,
    });
  });

  it("exports personas as Sprout-compatible persona markdown", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [agentSource],
    });

    const { exportPersona } = await import("../agents");
    const result = await exportPersona(agentSource.path);

    expect(mockGooseSourcesList).toHaveBeenCalledWith({ type: "agent" });
    expect(mockGooseSourcesExport).not.toHaveBeenCalled();
    expect(result).toEqual({
      // agentSource's description ("Agent") is the API-required placeholder
      // used when there's no real, user-authored description, not something
      // a user wrote on purpose, so export substitutes a real fallback
      // rather than writing "Agent" into the exported file's frontmatter.
      contents:
        "---\nname: scout\ndisplay_name: Scout\ndescription: Imported Goose agent\nmodel: openai:gpt-4.1\navatar: https://example.test/scout.png\n---\n\nResearch carefully.\n",
      filename: "scout.persona.md",
      mimeType: "text/markdown",
    });
  });

  it("uses the agent display name for portable markdown filenames", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          name: "Research Helper",
          path: "/Users/test/.agents/agents/old-file-name.md",
          properties: {
            ...agentSource.properties,
            sprout: { name: "old-sprout-name" },
          },
        },
      ],
    });

    const { exportPersona } = await import("../agents");
    const result = await exportPersona(
      "/Users/test/.agents/agents/old-file-name.md",
    );

    expect(result.filename).toBe("research-helper.persona.md");
    expect(result.contents).toContain("display_name: Research Helper");
  });

  it("exports app avatar refs in persona markdown", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          properties: {
            ...agentSource.properties,
            avatar: appAvatarRef,
          },
        },
      ],
    });

    const { exportPersona } = await import("../agents");
    const result = await exportPersona(agentSource.path);

    expect(result.contents).toContain(`avatar: ${appAvatarRef}\n`);
  });

  it("drops unsafe avatar values from persona markdown exports", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          properties: {
            ...agentSource.properties,
            avatar: "data:image/png;base64,aWNvbg==",
          },
        },
      ],
    });

    const { exportPersona } = await import("../agents");
    const result = await exportPersona(agentSource.path);

    expect(result.contents).not.toContain("avatar:");
  });

  it("exports preserved Sprout frontmatter from imported persona markdown", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          path: "/Users/test/.agents/agents/scout.persona.md",
          properties: {
            ...agentSource.properties,
            sprout: {
              frontmatter: {
                subscribe: ["#agents"],
                tags: ["research", "support"],
                tools: {
                  web: true,
                },
              },
            },
          },
        },
      ],
    });

    const { exportPersona } = await import("../agents");
    const result = await exportPersona(
      "/Users/test/.agents/agents/scout.persona.md",
    );

    expect(result).toEqual({
      // Same placeholder-description substitution as above.
      contents:
        '---\nname: scout\ndisplay_name: Scout\ndescription: Imported Goose agent\nmodel: openai:gpt-4.1\navatar: https://example.test/scout.png\nsubscribe:\n  - "#agents"\ntags:\n  - research\n  - support\ntools:\n  web: true\n---\n\nResearch carefully.\n',
      filename: "scout.persona.md",
      mimeType: "text/markdown",
    });
  });

  it("ignores legacy trait metadata in persona markdown previews", async () => {
    const { previewPersonaImport } = await import("../agents");

    expect(
      previewPersonaImport(
        `---\nname: builder\ndisplay_name: Builder\ndescription: Builds useful things.\ngood_for: making what you need\nvibes: hands-on, resourceful\n---\n\nBuild carefully.`,
        "builder.md",
      ),
    ).toMatchObject({
      displayName: "Builder",
      description: "Builds useful things.",
      systemPrompt: "Build carefully.",
    });
  });

  it("ignores legacy trait metadata in native agent previews", async () => {
    const { previewPersonaImport } = await import("../agents");
    const preview = previewPersonaImport(
      JSON.stringify({
        type: "agent",
        name: "Scout",
        description: "Finds the answer you need.",
        content: "Private detailed instructions.",
        properties: {
          good_for: "finding answers",
          vibes: "curious, thorough",
        },
      }),
      "scout.agent.json",
    );

    expect(preview).toMatchObject({
      description: "Finds the answer you need.",
    });
  });

  it("uses a short import-preview fallback instead of exposing instructions", async () => {
    const { previewPersonaImport } = await import("../agents");
    const preview = previewPersonaImport(
      "---\nname: scout\ndescription: Agent\n---\n\nPrivate detailed instructions.",
      "scout.md",
    );

    expect(preview.description).toBeUndefined();
  });

  it("ignores legacy trait metadata in import previews", async () => {
    const { previewPersonaImport } = await import("../agents");
    const preview = previewPersonaImport(
      "---\nname: builder\ndescription: Agent\ngood_for: building\nvibes: calm\n---\n\nBuild carefully.",
      "builder.md",
    );

    expect(preview).not.toHaveProperty("goodFor");
    expect(preview).not.toHaveProperty("vibes");
  });

  it("does not expose remote avatar URLs in pre-consent previews", async () => {
    const { previewPersonaImport } = await import("../agents");
    const remoteAvatar = "https://attacker.example/track.png";

    const markdown = previewPersonaImport(
      `---\nname: scout\ndisplay_name: Scout\navatar: ${remoteAvatar}\n---\n\nResearch carefully.`,
      "scout.md",
    );
    const legacyJson = previewPersonaImport(
      JSON.stringify({
        version: 1,
        displayName: "Scout",
        systemPrompt: "Research carefully.",
        avatar: { type: "url", value: remoteAvatar },
      }),
      "scout.json",
    );

    expect(markdown.avatar).toBeUndefined();
    expect(legacyJson.avatar).toBeUndefined();
  });

  it("imports legacy persona JSON through ACP source create", async () => {
    mockGooseSourcesCreate.mockResolvedValue({ source: agentSource });

    const { importPersonas } = await import("../agents");
    const raw = JSON.stringify({
      version: 1,
      displayName: "Scout",
      systemPrompt: "Research carefully.",
      description: "Finds relevant evidence.",
      provider: "openai",
      model: "gpt-4.1",
      avatar: { type: "url", value: "https://example.test/scout.png" },
    });

    const result = await importPersonas(raw, "scout.persona.json");

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith({
      type: "agent",
      name: "Scout",
      description: "Finds relevant evidence.",
      content: "Research carefully.",
      target: { scope: "global" },
      properties: {
        provider: "openai",
        model: "gpt-4.1",
        avatar: "https://example.test/scout.png",
      },
    });
    expect(mockGooseSourcesImport).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  it("imports Sprout persona markdown through ACP source create", async () => {
    mockGooseSourcesCreate.mockResolvedValue({ source: agentSource });

    const { importPersonas } = await import("../agents");
    const raw = `---
name: scout
display_name: "Scout"
description: "Agent"
model: "openai:gpt-4.1"
avatar: "https://example.test/scout.png"
subscribe:
  - "#agents"
tags: [research, support]
tools:
  web: true
---

Research carefully.
`;

    const result = await importPersonas(raw, "scout.persona.md");

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith({
      type: "agent",
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      target: { scope: "global" },
      properties: {
        provider: "goose",
        modelProviderId: "openai",
        model: "gpt-4.1",
        avatar: "https://example.test/scout.png",
        sprout: {
          name: "scout",
          frontmatter: {
            subscribe: ["#agents"],
            tags: ["research", "support"],
            tools: {
              web: true,
            },
          },
        },
      },
    });
    expect(mockGooseSourcesImport).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  it("imports app avatar refs from Sprout persona markdown", async () => {
    mockGooseSourcesCreate.mockResolvedValue({ source: agentSource });

    const { importPersonas } = await import("../agents");
    const raw = `---
name: scout
display_name: "Scout"
avatar: "${appAvatarRef}"
---

Research carefully.
`;

    await importPersonas(raw, "scout.persona.md");

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith({
      type: "agent",
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      target: { scope: "global" },
      properties: {
        avatar: appAvatarRef,
        sprout: {
          name: "scout",
        },
      },
    });
  });

  it("imports browser-renamed duplicate persona markdown downloads", async () => {
    mockGooseSourcesCreate.mockResolvedValue({ source: agentSource });

    const { importPersonas } = await import("../agents");
    const raw = `---
name: scout
display_name: "Scout"
---

Research carefully.
`;

    await importPersonas(raw, "scout.persona (1).md");

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith({
      type: "agent",
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      target: { scope: "global" },
      properties: {
        sprout: {
          name: "scout",
        },
      },
    });
    expect(mockGooseSourcesImport).not.toHaveBeenCalled();
  });

  it("imports app avatar refs from legacy persona JSON", async () => {
    mockGooseSourcesCreate.mockResolvedValue({ source: agentSource });

    const { importPersonas } = await import("../agents");
    const raw = JSON.stringify({
      version: 1,
      displayName: "Scout",
      systemPrompt: "Research carefully.",
      avatar: appAvatarRef,
    });

    await importPersonas(raw, "scout.persona.json");

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith({
      type: "agent",
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      target: { scope: "global" },
      properties: {
        avatar: appAvatarRef,
      },
    });
  });

  it("preserves model ids with colons when importing persona markdown", async () => {
    mockGooseSourcesCreate.mockResolvedValue({ source: agentSource });

    const { importPersonas } = await import("../agents");
    const raw = `---
name: scout
model: bedrock:anthropic.claude:v1
---

Research carefully.
`;

    await importPersonas(raw, "scout.persona.md");

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: {
          provider: "goose",
          modelProviderId: "bedrock",
          model: "anthropic.claude:v1",
          sprout: {
            name: "scout",
          },
        },
      }),
    );
  });

  it("keeps agent harness prefixes separate from model providers", async () => {
    mockGooseSourcesCreate.mockResolvedValue({ source: agentSource });

    const { importPersonas } = await import("../agents");
    const raw = `---
name: scout
model: codex:gpt-5.6
---

Research carefully.
`;

    await importPersonas(raw, "scout.persona.md");

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          provider: "codex-acp",
          modelProviderId: null,
          model: "gpt-5.6",
        }),
      }),
    );
  });

  it("imports legacy Sprout avatarUrl JSON through ACP source create", async () => {
    mockGooseSourcesCreate.mockResolvedValue({ source: agentSource });

    const { importPersonas } = await import("../agents");
    const raw = JSON.stringify({
      version: 1,
      displayName: "Scout",
      systemPrompt: "Research carefully.",
      avatarUrl: "https://example.test/scout.png",
    });

    await importPersonas(raw, "scout.persona.json");

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith({
      type: "agent",
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      target: { scope: "global" },
      properties: {
        avatar: "https://example.test/scout.png",
      },
    });
  });

  it("drops local and unknown legacy avatar shapes without warnings", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGooseSourcesCreate.mockResolvedValue({ source: agentSource });

    const { importPersonas } = await import("../agents");
    const raw = JSON.stringify({
      version: 1,
      displayName: "Scout",
      systemPrompt: "Research carefully.",
      avatar: { type: "local", value: "scout.png" },
    });

    await importPersonas(raw, "scout.persona.json");

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith({
      type: "agent",
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      target: { scope: "global" },
      properties: {},
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("drops data URLs and unknown legacy avatar URL wrappers", async () => {
    mockGooseSourcesCreate.mockResolvedValue({ source: agentSource });

    const { importPersonas } = await import("../agents");
    const raw = JSON.stringify({
      version: 1,
      displayName: "Scout",
      systemPrompt: "Research carefully.",
      avatar: { type: "image", value: "https://example.test/scout.png" },
    });

    await importPersonas(raw, "scout.persona.json");

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith({
      type: "agent",
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      target: { scope: "global" },
      properties: {},
    });
  });

  it("imports native agent JSON through ACP source import", async () => {
    mockGooseSourcesImport.mockResolvedValue({ sources: [agentSource] });

    const { importPersonas } = await import("../agents");
    const raw = JSON.stringify({
      version: 1,
      type: "agent",
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
    });

    await importPersonas(raw, "scout.agent.json");

    expect(mockGooseSourcesImport).toHaveBeenCalledWith({
      data: raw,
      target: { scope: "global" },
    });
    expect(mockGooseSourcesCreate).not.toHaveBeenCalled();
  });

  it("drops legacy trait metadata from native agent imports", async () => {
    mockGooseSourcesImport.mockResolvedValue({ sources: [agentSource] });
    const { importPersonas } = await import("../agents");
    await importPersonas(
      JSON.stringify({
        version: 1,
        type: "agent",
        name: "Scout",
        description: "Agent",
        content: "Research carefully.",
        properties: {
          good_for: "finding answers",
          vibes: "curious, thorough",
          color: "blue",
        },
        metadata: {
          frontmatter: {
            good_for: "stale purpose",
            vibes: "stale tone",
            tags: ["research"],
          },
        },
      }),
      "scout.agent.json",
    );

    const importRequest = mockGooseSourcesImport.mock.calls[0]?.[0] as {
      data: string;
    };
    expect(JSON.parse(importRequest.data)).toMatchObject({
      properties: { color: "blue" },
      metadata: { frontmatter: { tags: ["research"] } },
    });
  });

  it("preserves native agent JSON app avatar refs when ACP import omits them", async () => {
    const importedSource = {
      ...agentSource,
      path: "/Users/test/.agents/agents/scout-imported.md",
      properties: {
        color: "blue",
      },
    };
    const updatedSource = {
      ...importedSource,
      properties: {
        color: "blue",
        avatar: appAvatarRef,
      },
    };
    mockGooseSourcesImport.mockResolvedValue({ sources: [importedSource] });
    mockGooseSourcesUpdate.mockResolvedValue({ source: updatedSource });

    const { importPersonas } = await import("../agents");
    const raw = JSON.stringify({
      version: 1,
      type: "agent",
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      properties: {
        color: "blue",
        avatar: appAvatarRef,
      },
    });

    const [persona] = await importPersonas(raw, "scout.agent.json");
    const importRequest = mockGooseSourcesImport.mock.calls[0]?.[0] as {
      data: string;
    };

    expect(JSON.parse(importRequest.data)).toMatchObject({
      properties: {
        color: "blue",
        avatar: appAvatarRef,
      },
    });
    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith({
      type: "agent",
      path: importedSource.path,
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      properties: {
        color: "blue",
        avatar: appAvatarRef,
      },
    });
    expect(persona.avatar).toBe(appAvatarRef);
    expect(persona.sourceProperties?.avatar).toBe(appAvatarRef);
  });

  it("keeps native agent JSON imports successful when avatar repair fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const importedSource = {
      ...agentSource,
      path: "/Users/test/.agents/agents/scout-imported.md",
      properties: {
        color: "blue",
      },
    };
    mockGooseSourcesImport.mockResolvedValue({ sources: [importedSource] });
    mockGooseSourcesUpdate.mockRejectedValue(new Error("update failed"));

    const { importPersonas } = await import("../agents");
    const raw = JSON.stringify({
      version: 1,
      type: "agent",
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      properties: {
        avatar: appAvatarRef,
      },
    });

    const [persona] = await importPersonas(raw, "scout.agent.json");

    expect(persona.avatar).toBe(appAvatarRef);
    expect(persona.sourceProperties).toEqual({
      color: "blue",
      avatar: appAvatarRef,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to preserve imported agent avatar:",
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it("strips unsafe native agent JSON avatar values before ACP import", async () => {
    mockGooseSourcesImport.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          properties: {
            color: "blue",
          },
        },
      ],
    });

    const { importPersonas } = await import("../agents");
    const raw = JSON.stringify({
      version: 1,
      type: "agent",
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      avatar: "file:///tmp/scout.png",
      properties: {
        color: "blue",
        avatar: "data:image/png;base64,aWNvbg==",
      },
      metadata: {
        avatar: "javascript:alert(1)",
        tone: "direct",
      },
    });

    const [persona] = await importPersonas(raw, "scout.agent.json");
    const importRequest = mockGooseSourcesImport.mock.calls[0]?.[0] as {
      data: string;
    };
    const importedPayload = JSON.parse(importRequest.data);

    expect(importedPayload.avatar).toBeUndefined();
    expect(importedPayload.properties).toEqual({ color: "blue" });
    expect(importedPayload.metadata).toEqual({ tone: "direct" });
    expect(mockGooseSourcesUpdate).not.toHaveBeenCalled();
    expect(persona.avatar).toBeNull();
  });

  it("rejects malformed persona imports with friendly errors", async () => {
    const { importPersonas } = await import("../agents");

    await expect(importPersonas("{", "broken.persona.json")).rejects.toThrow(
      "Invalid persona JSON",
    );
  });

  it("validates legacy persona import fields before importing", async () => {
    const { importPersonas } = await import("../agents");
    const raw = JSON.stringify({
      version: 2,
      displayName: "Scout",
      systemPrompt: "Research carefully.",
    });

    await expect(importPersonas(raw, "scout.persona.json")).rejects.toThrow(
      "Unsupported persona format version 2",
    );
    expect(mockGooseSourcesCreate).not.toHaveBeenCalled();
    expect(mockGooseSourcesImport).not.toHaveBeenCalled();
  });

  it("validates malformed legacy content loaded from a .json file", async () => {
    const { importPersonas } = await import("../agents");

    await expect(importPersonas("{}", "broken.json")).rejects.toThrow(
      "Unsupported persona format version undefined",
    );
    expect(mockGooseSourcesCreate).not.toHaveBeenCalled();
    expect(mockGooseSourcesImport).not.toHaveBeenCalled();
  });

  it("keeps native import file reads on the Tauri command", async () => {
    mockedInvoke.mockResolvedValue({
      fileContents: "{}",
      fileName: "scout.agent.json",
    });

    const { readImportPersonaFile } = await import("../agents");
    const result = await readImportPersonaFile("/tmp/scout.agent.json");

    expect(mockedInvoke).toHaveBeenCalledWith("read_import_persona_file", {
      sourcePath: "/tmp/scout.agent.json",
    });
    expect(result).toEqual({
      fileContents: "{}",
      fileName: "scout.agent.json",
    });
  });

  it("reads and maps native agent source markdown files", async () => {
    mockedInvoke.mockResolvedValue({
      fileContents:
        "---\nname: Constructive Critic\ndescription: Challenges assumptions.\nbuilderSessionId: sess-1\ndraft: true\nprovider: openai\nmodel: gpt-5\n---\n\nPush back constructively.\n",
      fileName: "constructive-critic.md",
    });

    const { readAgentSourceFile } = await import("../agents");
    const result = await readAgentSourceFile(
      "/Users/test/.agents/agents/constructive-critic.md",
      {
        ...agentSource,
        name: "Untitled agent",
        properties: { draft: true, builderSessionId: "sess-1" },
      },
    );

    expect(mockedInvoke).toHaveBeenCalledWith("read_agent_source_file", {
      sourcePath: "/Users/test/.agents/agents/constructive-critic.md",
    });
    expect(result).toMatchObject({
      type: "agent",
      path: "/Users/test/.agents/agents/constructive-critic.md",
      name: "Constructive Critic",
      description: "Challenges assumptions.",
      content: "Push back constructively.",
      properties: {
        builderSessionId: "sess-1",
        draft: true,
        provider: "openai",
        model: "gpt-5",
      },
    });
  });
});
