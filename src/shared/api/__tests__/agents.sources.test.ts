import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGooseSourcesCreate = vi.fn();
const mockGooseSourcesList = vi.fn();
const mockGooseSourcesUpdate = vi.fn();
const mockGooseSourcesDelete = vi.fn();

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({
    goose: {
      GooseUnstableSourcesCreate: mockGooseSourcesCreate,
      GooseUnstableSourcesList: mockGooseSourcesList,
      GooseUnstableSourcesUpdate: mockGooseSourcesUpdate,
      GooseUnstableSourcesDelete: mockGooseSourcesDelete,
    },
  }),
}));

import {
  createPersonaSource,
  deletePersonaSource,
  listPersonaSources,
  promotePersonaSource,
  updatePersonaSource,
} from "@/shared/api/agents";

const draftEntry = {
  type: "agent",
  path: "/Users/x/.agents/agents/draft-abc.md",
  name: "Untitled agent",
  description: "Draft",
  content: "Draft in progress.",
  properties: { draft: true, builderSessionId: "abc" },
  writable: true,
};

describe("persona source helpers", () => {
  beforeEach(() => {
    mockGooseSourcesCreate.mockReset();
    mockGooseSourcesList.mockReset();
    mockGooseSourcesUpdate.mockReset();
    mockGooseSourcesDelete.mockReset();
    vi.restoreAllMocks();
  });

  it("createPersonaSource returns the entry the backend assigns", async () => {
    mockGooseSourcesCreate.mockResolvedValueOnce({ source: draftEntry });

    const out = await createPersonaSource({
      type: "agent",
      name: "Untitled agent",
      description: "Draft",
      content: "Draft in progress.",
      target: { scope: "global" },
      properties: { draft: true, builderSessionId: "abc" },
    });

    expect(out).toEqual(draftEntry);
    expect(mockGooseSourcesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Untitled agent",
        properties: expect.objectContaining({ draft: true }),
      }),
    );
  });

  it("updatePersonaSource sends a full merged source update", async () => {
    mockGooseSourcesList.mockResolvedValueOnce({ sources: [draftEntry] });
    mockGooseSourcesUpdate.mockResolvedValueOnce({
      source: { ...draftEntry, name: "Snark" },
    });

    const out = await updatePersonaSource(draftEntry.path, { name: "Snark" });

    expect(out.name).toBe("Snark");
    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith({
      type: "agent",
      path: draftEntry.path,
      name: "Snark",
      description: "Draft",
      content: "Draft in progress.",
      properties: { draft: true, builderSessionId: "abc" },
    });
  });

  it("updatePersonaSource merges property patches with existing properties", async () => {
    mockGooseSourcesList.mockResolvedValueOnce({
      sources: [
        {
          ...draftEntry,
          properties: {
            draft: true,
            builderSessionId: "abc",
            provider: "openai",
          },
        },
      ],
    });
    mockGooseSourcesUpdate.mockResolvedValueOnce({
      source: {
        ...draftEntry,
        properties: {
          draft: true,
          builderSessionId: "abc",
          provider: "openai",
          model: "gpt-5",
        },
      },
    });

    await updatePersonaSource(draftEntry.path, {
      properties: { model: "gpt-5" },
    });

    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: {
          draft: true,
          builderSessionId: "abc",
          provider: "openai",
          model: "gpt-5",
        },
      }),
    );
  });

  it("deletePersonaSource removes by path", async () => {
    mockGooseSourcesDelete.mockResolvedValueOnce(undefined);

    await deletePersonaSource(draftEntry.path);

    expect(mockGooseSourcesDelete).toHaveBeenCalledWith({
      type: "agent",
      path: draftEntry.path,
    });
  });

  it("promotePersonaSource creates a final source and deletes the original draft", async () => {
    const promotionPatch = {
      name: "Snark",
      description: "Sharper reviews.",
      content: "Be snarky.",
      properties: {
        draft: true,
        builderSessionId: "abc",
        provider: "openai",
      },
    };
    const promoted = {
      ...draftEntry,
      path: "/Users/x/.agents/agents/snark.md",
      name: promotionPatch.name,
      description: promotionPatch.description,
      content: promotionPatch.content,
      properties: { provider: "openai", model: "gpt-5" },
    };
    mockGooseSourcesList.mockResolvedValueOnce({
      sources: [
        {
          ...draftEntry,
          properties: {
            draft: true,
            builderSessionId: "abc",
            model: "gpt-5",
          },
        },
      ],
    });
    mockGooseSourcesCreate.mockResolvedValueOnce({ source: promoted });
    mockGooseSourcesDelete.mockResolvedValueOnce(undefined);

    const out = await promotePersonaSource(draftEntry.path, promotionPatch);

    expect(out).toEqual(promoted);
    expect(out.path).toBe("/Users/x/.agents/agents/snark.md");
    expect(mockGooseSourcesCreate).toHaveBeenCalledWith({
      type: "agent",
      name: promotionPatch.name,
      description: promotionPatch.description,
      content: promotionPatch.content,
      target: { scope: "global" },
      properties: { provider: "openai", model: "gpt-5" },
    });
    expect(mockGooseSourcesDelete).toHaveBeenCalledWith({
      type: "agent",
      path: draftEntry.path,
    });
    expect(mockGooseSourcesUpdate).not.toHaveBeenCalled();
  });

  it("promotePersonaSource does not delete the draft when final source creation fails", async () => {
    mockGooseSourcesList.mockResolvedValueOnce({ sources: [draftEntry] });
    mockGooseSourcesCreate.mockRejectedValueOnce(new Error("create failed"));

    await expect(
      promotePersonaSource(draftEntry.path, {
        name: "Snark",
        properties: {},
      }),
    ).rejects.toThrow("create failed");

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith({
      type: "agent",
      name: "Snark",
      description: "Draft",
      content: "Draft in progress.",
      target: { scope: "global" },
      properties: {},
    });
    expect(mockGooseSourcesUpdate).not.toHaveBeenCalled();
    expect(mockGooseSourcesDelete).not.toHaveBeenCalled();
  });

  it("promotePersonaSource returns the promoted source when draft cleanup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const promoted = {
      ...draftEntry,
      path: "/Users/x/.agents/agents/snark.md",
      name: "Snark",
      properties: {},
    };
    mockGooseSourcesList.mockResolvedValueOnce({ sources: [draftEntry] });
    mockGooseSourcesCreate.mockResolvedValueOnce({ source: promoted });
    mockGooseSourcesDelete.mockRejectedValueOnce(new Error("delete failed"));

    await expect(
      promotePersonaSource(draftEntry.path, {
        name: "Snark",
        properties: {},
      }),
    ).resolves.toEqual(promoted);

    expect(mockGooseSourcesDelete).toHaveBeenCalledWith({
      type: "agent",
      path: draftEntry.path,
    });
    expect(warn).toHaveBeenCalledWith(
      "Failed to delete promoted agent draft:",
      expect.any(Error),
    );
  });

  it("promotePersonaSource does not delete when create returns the original path", async () => {
    const promoted = {
      ...draftEntry,
      name: "Snark",
      properties: {},
    };
    mockGooseSourcesList.mockResolvedValueOnce({ sources: [draftEntry] });
    mockGooseSourcesCreate.mockResolvedValueOnce({ source: promoted });

    await expect(
      promotePersonaSource(draftEntry.path, {
        name: "Snark",
        properties: {},
      }),
    ).resolves.toEqual(promoted);

    expect(mockGooseSourcesDelete).not.toHaveBeenCalled();
  });

  it("listPersonaSources returns the array, draft entries included", async () => {
    mockGooseSourcesList.mockResolvedValueOnce({ sources: [draftEntry] });

    const out = await listPersonaSources();

    expect(out).toEqual([draftEntry]);
  });
});
