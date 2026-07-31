import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceNameRequest } from "@/features/chat/lib/firstWorkspaceSend";
import { useWorkspaceNameRequestQueue } from "./useWorkspaceNameRequestQueue";

function request(label: string): WorkspaceNameRequest {
  return {
    workspaces: [
      {
        id: label,
        path: label,
        kind: "repository",
        source: "selected",
        usedByAgent: false,
        startupMode: "branch",
      },
    ],
    submit: vi.fn(),
    cancel: vi.fn(),
  };
}

describe("useWorkspaceNameRequestQueue", () => {
  it("presents concurrent requests in order without overwriting either callback", () => {
    const first = request("first");
    const second = request("second");
    const { result } = renderHook(() => useWorkspaceNameRequestQueue());

    act(() => {
      result.current.enqueueWorkspaceNameRequest(first);
      result.current.enqueueWorkspaceNameRequest(second);
    });
    expect(result.current.workspaceNameRequest).toBe(first);

    act(() => result.current.submitWorkspaceNameRequest("feature-one"));
    expect(first.submit).toHaveBeenCalledWith("feature-one");
    expect(second.submit).not.toHaveBeenCalled();
    expect(result.current.workspaceNameRequest).toBe(second);

    act(() => result.current.cancelWorkspaceNameRequest());
    expect(second.cancel).toHaveBeenCalledOnce();
    expect(result.current.workspaceNameRequest).toBeNull();
  });
});
