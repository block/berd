import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectArtifactMetadata } from "../artifact/types";

const mocks = vi.hoisted(() => ({
  extMethod: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: () => mocks.getClient(),
}));

function source(properties: Record<string, unknown>) {
  return {
    type: "project",
    name: "launch",
    description: "",
    content: "Ship it",
    path: "/tmp/projects/launch.md",
    global: true,
    properties,
  };
}

describe("projects API artifact metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClient.mockResolvedValue({
      extMethod: mocks.extMethod,
    });
  });

  it("stores artifact metadata when creating a project", async () => {
    mocks.extMethod.mockImplementation(async (method, request) => {
      if (method === "_goose/sources/list") {
        return { sources: [] };
      }
      if (method === "_goose/sources/create") {
        return { source: source(request.properties) };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const { createProject } = await import("./projects");

    const project = await createProject(
      "Launch",
      "",
      "Ship it",
      "tabler:folder-code",
      "olive",
      null,
      null,
      ["/tmp/launch"],
      false,
    );

    const createRequest = mocks.extMethod.mock.calls[1]?.[1];
    expect(createRequest.properties.artifact).toMatchObject({
      seed: expect.any(Number),
      color: "olive",
      mood: expect.any(String),
      moodIntensity: expect.any(Number),
      contentMode: expect.any(String),
    });
    expect(project.artifact).toEqual(createRequest.properties.artifact);
  });

  it("preserves an existing artifact seed while saving a new project color", async () => {
    const existingArtifact: ProjectArtifactMetadata = {
      seed: 9876,
      color: "olive",
      mood: "serene",
      moodIntensity: 0.5,
      contentMode: "cubeStatic",
    };
    mocks.extMethod.mockImplementation(async (method, request) => {
      if (method === "_goose/sources/update") {
        return { source: source(request.properties) };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const { updateProject } = await import("./projects");

    const project = await updateProject(
      {
        id: "launch",
        path: "/tmp/projects/launch.md",
        name: "Launch",
        description: "",
        prompt: "Ship it",
        icon: "tabler:folder-code",
        color: "olive",
        preferredProvider: null,
        preferredModel: null,
        workingDirs: ["/tmp/launch"],
        useWorktrees: false,
        order: 0,
        archivedAt: null,
        artifact: existingArtifact,
      },
      { color: "peach" },
    );

    const updateRequest = mocks.extMethod.mock.calls[0]?.[1];
    expect(updateRequest.properties.artifact).toEqual({
      ...existingArtifact,
      color: "peach",
    });
    expect(project.artifact).toEqual(updateRequest.properties.artifact);
  });
});
