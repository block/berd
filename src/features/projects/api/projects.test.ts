import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectArtifactMetadata } from "../artifact/types";
import type { ProjectInfo } from "./projects";

const mocks = vi.hoisted(() => ({
  sourcesList: vi.fn(),
  sourcesCreate: vi.fn(),
  sourcesUpdate: vi.fn(),
  sourcesDelete: vi.fn(),
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

function artifactMetadata(
  overrides: Partial<ProjectArtifactMetadata> = {},
): ProjectArtifactMetadata {
  return {
    seed: 9876,
    color: "olive",
    mood: "serene",
    moodIntensity: 0.5,
    contentMode: "cubeStatic",
    ...overrides,
  };
}

function projectInfo(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "launch",
    path: "/tmp/projects/launch.md",
    name: "Launch",
    description: "",
    prompt: "Ship it",
    icon: "tabler:folder-code",
    color: "olive",
    workingDirs: ["/tmp/launch"],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
    artifact: artifactMetadata(),
    ...overrides,
  };
}

describe("projects API artifact metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClient.mockResolvedValue({
      goose: {
        GooseUnstableSourcesList: mocks.sourcesList,
        GooseUnstableSourcesCreate: mocks.sourcesCreate,
        GooseUnstableSourcesUpdate: mocks.sourcesUpdate,
        GooseUnstableSourcesDelete: mocks.sourcesDelete,
      },
    });
  });

  it("stores artifact metadata when creating a project", async () => {
    mocks.sourcesList.mockResolvedValue({ sources: [] });
    mocks.sourcesCreate.mockImplementation(async (request) => ({
      source: source(request.properties),
    }));

    const { createProject } = await import("./projects");
    const { createProjectArtifactMetadata } = await import(
      "../artifact/deriveProjectArtifactState"
    );

    const project = await createProject(
      "Launch",
      "",
      "Ship it",
      "tabler:folder-code",
      "olive",
      ["/tmp/launch"],
      false,
    );

    const createRequest = mocks.sourcesCreate.mock.calls[0]?.[0];
    expect(createRequest.properties.artifact).toMatchObject({
      seed: expect.any(Number),
      color: "olive",
      mood: expect.any(String),
      moodIntensity: expect.any(Number),
      contentMode: expect.any(String),
    });
    expect(createRequest.properties.artifact.seed).toBe(
      createProjectArtifactMetadata({
        projectId: "launch",
        name: "Launch",
        prompt: "Ship it",
        color: "olive",
        workingDirs: ["/tmp/launch"],
      }).seed,
    );
    expect(project.artifact).toEqual(createRequest.properties.artifact);
  });

  it("preserves an existing artifact seed while saving a new project color", async () => {
    const existingArtifact = artifactMetadata();
    mocks.sourcesUpdate.mockImplementation(async (request) => ({
      source: source(request.properties),
    }));

    const { updateProject } = await import("./projects");

    const project = await updateProject(
      projectInfo({ artifact: existingArtifact }),
      { color: "peach" },
    );

    const updateRequest = mocks.sourcesUpdate.mock.calls[0]?.[0];
    expect(updateRequest.properties.artifact).toEqual({
      ...existingArtifact,
      color: "peach",
    });
    expect(project.artifact).toEqual(updateRequest.properties.artifact);
  });

  it("recomputes existing artifact identity when renaming a project", async () => {
    const existingArtifact = artifactMetadata();
    mocks.sourcesUpdate.mockImplementation(async (request) => ({
      source: source(request.properties),
    }));

    const { updateProject } = await import("./projects");
    const { createProjectArtifactMetadata } = await import(
      "../artifact/deriveProjectArtifactState"
    );

    await updateProject(projectInfo({ artifact: existingArtifact }), {
      name: "Launch Platform",
    });

    const updateRequest = mocks.sourcesUpdate.mock.calls[0]?.[0];
    expect(updateRequest.properties.artifact).toEqual(
      createProjectArtifactMetadata({
        projectId: "launch",
        name: "Launch Platform",
        prompt: "Ship it",
        color: "olive",
        workingDirs: ["/tmp/launch"],
      }),
    );
    expect(updateRequest.properties.artifact.seed).not.toBe(
      existingArtifact.seed,
    );
  });

  it("preserves existing artifact identity when only prompt changes", async () => {
    const existingArtifact = artifactMetadata();
    mocks.sourcesUpdate.mockImplementation(async (request) => ({
      source: source(request.properties),
    }));

    const { updateProject } = await import("./projects");

    await updateProject(projectInfo({ artifact: existingArtifact }), {
      prompt: "Ship it with a longer project prompt",
    });

    const updateRequest = mocks.sourcesUpdate.mock.calls[0]?.[0];
    expect(updateRequest.properties.artifact).toEqual(existingArtifact);
  });
});
