import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCreatePersonaNavigation } from "../useCreatePersonaNavigation";

describe("useCreatePersonaNavigation", () => {
  it("starts a new builder session through the injected callback", () => {
    const onStartAgentBuilderSession = vi.fn();
    const { result } = renderHook(() =>
      useCreatePersonaNavigation(onStartAgentBuilderSession),
    );

    result.current();

    expect(onStartAgentBuilderSession).toHaveBeenCalledWith({});
  });
});
