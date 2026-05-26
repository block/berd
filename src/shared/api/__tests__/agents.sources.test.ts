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
  });

  it("createPersonaSource returns the entry the backend assigns", async () => {
    mockGooseSourcesCreate.mockResolvedValueOnce({ source: draftEntry });

    const out = await createPersonaSource({
      type: "agent",
      name: "Untitled agent",
      description: "Draft",
      content: "Draft in progress.",
      global: true,
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

  it("promotePersonaSource updates the draft in place and removes draft metadata", async () => {
    const promoted = {
      ...draftEntry,
      name: "Snark",
      properties: {},
    };
    mockGooseSourcesList
      .mockResolvedValueOnce({ sources: [draftEntry] })
      .mockResolvedValueOnce({ sources: [promoted] });
    mockGooseSourcesUpdate.mockResolvedValueOnce({ source: promoted });

    const out = await promotePersonaSource(draftEntry.path, {
      name: "Snark",
      properties: {},
    });

    expect(out.path).toBe(draftEntry.path);
    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith({
      type: "agent",
      path: draftEntry.path,
      name: "Snark",
      description: "Draft",
      content: "Draft in progress.",
      properties: {},
    });
    expect(mockGooseSourcesCreate).not.toHaveBeenCalled();
    expect(mockGooseSourcesDelete).not.toHaveBeenCalled();
  });

  it("promotePersonaSource does not delete another draft with the same name", async () => {
    const liveDraft = {
      ...draftEntry,
      path: "/Users/x/.agents/agents/other-live-draft.md",
      name: "Snark",
      properties: { draft: true, builderSessionId: "other" },
    };
    const promoted = {
      ...draftEntry,
      name: "Snark",
      properties: {},
    };
    mockGooseSourcesList
      .mockResolvedValueOnce({ sources: [draftEntry] })
      .mockResolvedValueOnce({ sources: [liveDraft, promoted] });
    mockGooseSourcesUpdate.mockResolvedValueOnce({ source: promoted });

    await promotePersonaSource(draftEntry.path, {
      name: "Snark",
      properties: {},
    });

    expect(mockGooseSourcesDelete).not.toHaveBeenCalled();
  });

  it("listPersonaSources returns the array, draft entries included", async () => {
    mockGooseSourcesList.mockResolvedValueOnce({ sources: [draftEntry] });

    const out = await listPersonaSources();

    expect(out).toEqual([draftEntry]);
  });
});
