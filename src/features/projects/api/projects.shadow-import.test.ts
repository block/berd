import { beforeEach, expect, it, vi } from "vitest";
import type { ProjectInfo } from "./projects";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listSources: vi.fn(),
  deleteSource: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: vi.fn(async () => ({
    goose: {
      GooseUnstableSourcesList: mocks.listSources,
      GooseUnstableSourcesDelete: mocks.deleteSource,
    },
  })),
}));

beforeEach(() => {
  vi.resetModules();
  mocks.invoke.mockReset();
  mocks.listSources.mockReset();
  mocks.deleteSource.mockReset();
  mocks.listSources.mockResolvedValue({ sources: [] });
  mocks.deleteSource.mockResolvedValue(undefined);
});

it("forces a rescan when a Goose mutation completes during a shadow scan", async () => {
  let finishFirstScan: (() => void) | undefined;
  mocks.invoke
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirstScan = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const { deleteProject, listProjects } = await import("./projects");

  await listProjects();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  await deleteProject({ path: "/tmp/projects/launch.md" } as ProjectInfo);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);

  finishFirstScan?.();
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
  expect(mocks.invoke).toHaveBeenNthCalledWith(
    2,
    "shadow_import_legacy_projects",
  );
});
