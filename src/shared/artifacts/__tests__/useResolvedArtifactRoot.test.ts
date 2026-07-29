import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_ROOT_CHANGED_EVENT,
  resolveArtifactRootPath,
} from "../sessionArtifactLocation";
import { useResolvedArtifactRoot } from "../useResolvedArtifactRoot";

vi.mock("../sessionArtifactLocation", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../sessionArtifactLocation")>();
  return {
    ...original,
    resolveArtifactRootPath: vi.fn(),
  };
});

const mockResolve = vi.mocked(resolveArtifactRootPath);

describe("useResolvedArtifactRoot", () => {
  beforeEach(() => {
    mockResolve.mockReset();
  });

  it("returns the resolved absolute root, not the stored preference", async () => {
    // The discriminating case for the auto-open scope gate: the preference
    // may be stored as `~/goose artifacts`, but artifact locations arrive as
    // absolute paths. The hook must surface the resolved form or the
    // containment comparison is dead code.
    mockResolve.mockResolvedValue("/Users/dev/goose artifacts");

    const { result } = renderHook(() => useResolvedArtifactRoot());

    expect(result.current).toBeNull();
    await waitFor(() => {
      expect(result.current).toBe("/Users/dev/goose artifacts");
    });
  });

  it("re-resolves when the artifact root preference changes", async () => {
    mockResolve.mockResolvedValueOnce("/Users/dev/goose artifacts");
    const { result } = renderHook(() => useResolvedArtifactRoot());
    await waitFor(() => {
      expect(result.current).toBe("/Users/dev/goose artifacts");
    });

    mockResolve.mockResolvedValueOnce("/Users/dev/my docs");
    act(() => {
      window.dispatchEvent(new Event(ARTIFACT_ROOT_CHANGED_EVENT));
    });

    await waitFor(() => {
      expect(result.current).toBe("/Users/dev/my docs");
    });
  });

  it("keeps the previous root when a re-resolve fails", async () => {
    mockResolve.mockResolvedValueOnce("/Users/dev/goose artifacts");
    const { result } = renderHook(() => useResolvedArtifactRoot());
    await waitFor(() => {
      expect(result.current).toBe("/Users/dev/goose artifacts");
    });

    mockResolve.mockRejectedValueOnce(new Error("ipc down"));
    act(() => {
      window.dispatchEvent(new Event(ARTIFACT_ROOT_CHANGED_EVENT));
    });

    // A transient resolve failure must not flip consumers into "no root".
    await waitFor(() => {
      expect(mockResolve).toHaveBeenCalledTimes(2);
    });
    expect(result.current).toBe("/Users/dev/goose artifacts");
  });
});
