import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Persona } from "@/shared/types/agents";

const mockGooseSourcesList = vi.fn();
const mockGooseSourcesCreate = vi.fn();
const mockGooseSourcesUpdate = vi.fn();
const mockGooseSourcesDelete = vi.fn();
const mockGooseSourcesExport = vi.fn();
const mockGooseSourcesImport = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({
    goose: {
      GooseSourcesList: (...args: unknown[]) => mockGooseSourcesList(...args),
      GooseSourcesCreate: (...args: unknown[]) =>
        mockGooseSourcesCreate(...args),
      GooseSourcesUpdate: (...args: unknown[]) =>
        mockGooseSourcesUpdate(...args),
      GooseSourcesDelete: (...args: unknown[]) =>
        mockGooseSourcesDelete(...args),
      GooseSourcesExport: (...args: unknown[]) =>
        mockGooseSourcesExport(...args),
      GooseSourcesImport: (...args: unknown[]) =>
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
    vi.clearAllMocks();
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
      provider: "openai",
      model: "gpt-4.1",
    });

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith({
      type: "agent",
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      global: true,
      properties: {
        provider: "openai",
        model: "gpt-4.1",
        avatar: "https://example.test/scout.png",
      },
    });
    expect(result.displayName).toBe("Scout");
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
      global: true,
      properties: {},
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
      description: "",
      content: "Research carefully.",
      properties: {
        provider: null,
        model: null,
        avatar: null,
        color: "blue",
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

  it("exports personas through ACP source export", async () => {
    mockGooseSourcesExport.mockResolvedValue({
      json: '{"type":"agent"}',
      filename: "scout.agent.json",
    });

    const { exportPersona } = await import("../agents");
    const result = await exportPersona(agentSource.path);

    expect(mockGooseSourcesList).not.toHaveBeenCalled();
    expect(mockGooseSourcesExport).toHaveBeenCalledWith({
      type: "agent",
      path: agentSource.path,
    });
    expect(result).toEqual({
      json: '{"type":"agent"}',
      filename: "scout.agent.json",
    });
  });

  it("imports legacy persona JSON through ACP source create", async () => {
    mockGooseSourcesCreate.mockResolvedValue({ source: agentSource });

    const { importPersonas } = await import("../agents");
    const raw = JSON.stringify({
      version: 1,
      displayName: "Scout",
      systemPrompt: "Research carefully.",
      provider: "openai",
      model: "gpt-4.1",
      avatar: { type: "url", value: "https://example.test/scout.png" },
    });

    const result = await importPersonas(raw, "scout.persona.json");

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith({
      type: "agent",
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      global: true,
      properties: {
        provider: "openai",
        model: "gpt-4.1",
        avatar: "https://example.test/scout.png",
      },
    });
    expect(mockGooseSourcesImport).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
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
      global: true,
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
      global: true,
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
      global: true,
    });
    expect(mockGooseSourcesCreate).not.toHaveBeenCalled();
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
});
