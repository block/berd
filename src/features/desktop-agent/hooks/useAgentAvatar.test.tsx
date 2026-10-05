import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { useAgentAvatar } from "@/features/desktop-agent/hooks/useAgentAvatar";
import { listPersonas } from "@/shared/api/agents";
import { getCachedAvatarForRef } from "@/shared/api/avatars";
import type { Persona } from "@/shared/types/agents";

vi.mock("@/shared/api/agents", () => ({ listPersonas: vi.fn() }));
vi.mock("@/shared/api/avatars", () => ({
  getCachedAvatarForRef: vi.fn(),
  cachedAssetToMedia: vi.fn(),
}));
const berdy: Persona = {
  id: "/home/me/.agents/agents/berdy.md",
  displayName: "Berdy",
  avatar: "app-avatar:gloopies-22",
  systemPrompt: "",
  isBuiltin: true,
  writable: false,
  sourceProperties: { metadata: { berdBundled: true } },
};
beforeEach(() => {
  vi.mocked(listPersonas).mockResolvedValue([berdy]);
  vi.mocked(getCachedAvatarForRef).mockResolvedValue(null);
});
it("default and positively identified Berdy qualify; unrelated fallback does not", async () => {
  const { result, rerender } = renderHook(({ id }) => useAgentAvatar(id), {
    initialProps: { id: null as string | null },
  });
  expect(result.current.isBerdy).toBe(true);
  rerender({ id: berdy.id });
  await waitFor(() => expect(result.current.isBerdy).toBe(true));
  rerender({ id: "unrelated" });
  expect(result.current.isBerdy).toBe(false);
  await waitFor(() => expect(listPersonas).toHaveBeenCalledTimes(2));
  expect(result.current.isBerdy).toBe(false);
});
it("fetch failures and lookalike avatars never classify another agent as Berdy", async () => {
  vi.mocked(listPersonas).mockResolvedValue([{ ...berdy, id: "/other.md" }]);
  const { result } = renderHook(() => useAgentAvatar("/other.md"));
  await waitFor(() => expect(getCachedAvatarForRef).toHaveBeenCalled());
  expect(result.current.isBerdy).toBe(false);
});
