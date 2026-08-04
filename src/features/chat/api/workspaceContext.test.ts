import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadWorkspaceInstructionFiles } from "./workspaceContext";
import type { WorkspaceInstructionFile } from "./workspaceContext";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

// The paths under test are already absolute, so home dir resolution never runs.
vi.mock("@/shared/api/system", () => ({
  getHomeDir: vi.fn(async () => "/Users/test"),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function instructionFile(content: string): WorkspaceInstructionFile {
  return { path: "/w/AGENTS.md", workspacePaths: ["/w"], content };
}

function respondWith(files: WorkspaceInstructionFile[]) {
  return { instructionFiles: files };
}

describe("loadWorkspaceInstructionFiles", () => {
  beforeEach(() => {
    invoke.mockReset();
    window.__TAURI_INTERNALS__ = {} as typeof window.__TAURI_INTERNALS__;
  });

  it("re-reads instructions on a later load instead of serving a settled cache entry", async () => {
    const queryClient = new QueryClient();
    invoke
      .mockResolvedValueOnce(respondWith([instructionFile("old")]))
      .mockResolvedValueOnce(respondWith([instructionFile("new")]));

    const first = await loadWorkspaceInstructionFiles(["/w"], { queryClient });
    expect(first).toEqual([instructionFile("old")]);

    // The on-disk file changed and nothing invalidates the cache; the next
    // prompt-composition load must read it fresh rather than reuse the settled
    // entry that would inject superseded instructions.
    const second = await loadWorkspaceInstructionFiles(["/w"], { queryClient });
    expect(second).toEqual([instructionFile("new")]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight request across a navigation's simultaneous loads", async () => {
    const queryClient = new QueryClient();
    const inFlight = deferred<{
      instructionFiles: WorkspaceInstructionFile[];
    }>();
    invoke.mockReturnValueOnce(inFlight.promise);

    const first = loadWorkspaceInstructionFiles(["/w"], { queryClient });
    const second = loadWorkspaceInstructionFiles(["/w"], { queryClient });
    inFlight.resolve(respondWith([instructionFile("shared")]));

    await expect(first).resolves.toEqual([instructionFile("shared")]);
    await expect(second).resolves.toEqual([instructionFile("shared")]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
