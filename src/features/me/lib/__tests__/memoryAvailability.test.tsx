import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { showMemoryProposalToast } from "../memoryProposalToast";
import { isMemorySupported } from "../memoryAvailability";
import { loadMeFile } from "../meFile";
import { listTopics, createTopic } from "../meTopics";
import { getMePreamble } from "../mePreamble";
import { listProposals } from "../meProposals";
import { readMemoryPolicy, writeMemoryPolicy } from "../memoryPolicyFile";
import { useMemoryProposals } from "../../hooks/useMemoryProposals";
import { useMemoryProposalsPending } from "../../hooks/useMemoryProposalsPending";
import * as system from "@/shared/api/system";

const { invoke, toast } = vi.hoisted(() => ({
  invoke: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("memory build availability", () => {
  it.each([
    undefined,
    "",
    "0",
    "true",
    "1",
  ])("accepts only the derived value 1 (%s)", (value) => {
    vi.stubEnv("VITE_MEMORY_SUPPORTED", value);
    expect(isMemorySupported()).toBe(value === "1");
  });

  it("does not read home, stale enabled policy, proposals, or snapshots", async () => {
    vi.stubEnv("VITE_MEMORY_SUPPORTED", "0");
    invoke.mockResolvedValue({ enabled: true });
    expect(await readMemoryPolicy()).toBeNull();
    expect(await writeMemoryPolicy(true)).toBe(false);
    expect(await listProposals()).toEqual([]);
    await expect(loadMeFile()).rejects.toThrow("unavailable");
    await expect(listTopics()).rejects.toThrow("unavailable");
    await expect(createTopic("Fixture")).rejects.toThrow("unavailable");
    expect(await getMePreamble()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects every shared memory API before invoking native commands", async () => {
    vi.stubEnv("VITE_MEMORY_SUPPORTED", "0");
    const calls = [
      () => system.initializeMemoryStore(),
      () => system.readMemoryTextFile("/fixture/.me/me.md"),
      () => system.listMemoryDocuments(),
      () => system.readMemoryRecallSnapshot(),
      () =>
        system.saveReviewedMemoryDocument("/fixture/.me/me.md", "# Me", null),
      () => system.readMemoryPolicy(),
      () => system.writeMemoryPolicy(true),
      () => system.exportMemoryMarkdown("/fixture/.me/me.md"),
      () => system.importMemoryMarkdown(),
      () => system.createTextFile("/fixture/.me/me.md", "# Me"),
      () => system.isMemoryContentApproved("/fixture/.me/me.md", "# Me"),
      () => system.writeTextFile("/fixture/.me/me.md", "# Me"),
      () => system.appendMemoryProposals([]),
      () => system.approveMemoryProposal("fixture", "Preference", null),
      () => system.resolveMemoryProposal("fixture"),
    ];
    for (const call of calls)
      await expect(call()).rejects.toThrow("unavailable");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not show unsupported proposal toasts", () => {
    vi.stubEnv("VITE_MEMORY_SUPPORTED", "0");
    const action = vi.fn();
    showMemoryProposalToast({
      proposal: {
        id: "fixture",
        ts: 0,
        content: "Preference",
        topic: null,
        agent: null,
        sessionId: null,
      },
      title: "Memory",
      destination: "General",
      reviewLabel: "Review",
      declineLabel: "Decline",
      onReview: action,
      onDecline: action,
      renderActions: action,
    });
    expect(toast).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it("registers no polling or focus listeners and callbacks issue no IPC", async () => {
    vi.stubEnv("VITE_MEMORY_SUPPORTED", "0");
    vi.useFakeTimers();
    const interval = vi.spyOn(globalThis, "setInterval");
    const listener = vi.spyOn(window, "addEventListener");
    const hook = renderHook(() => ({
      proposals: useMemoryProposals(),
      count: useMemoryProposalsPending(),
    }));
    expect(interval).not.toHaveBeenCalled();
    expect(listener.mock.calls.filter(([event]) => event === "focus")).toEqual(
      [],
    );
    const proposal = {
      id: "fixture",
      ts: 0,
      content: "Preference",
      topic: null,
      agent: null,
      sessionId: null,
    };
    await act(async () => {
      await hook.result.current.proposals.refresh();
      await hook.result.current.proposals.approve(proposal);
      await hook.result.current.proposals.decline(proposal);
      vi.advanceTimersByTime(60_000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(hook.result.current.count).toBe(0);
    expect(hook.result.current.proposals.proposals).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
    hook.unmount();
  });
});
