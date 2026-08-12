import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  shareInFlight,
  type ShareInFlightOptions,
} from "@/shared/lib/shareInFlight";
import type { SkillInfo } from "./skills";
import { fetchBerdAppSkills, fetchSkillsList } from "./skillsQuery";

const listAgentFileSkills =
  vi.fn<(...args: unknown[]) => Promise<SkillInfo[]>>();
const listBerdAppSkillsInvoke = vi.fn<() => Promise<SkillInfo[]>>();
// Mirror production: the real listBerdAppSkills is a shareInFlight wrapper
// around the IPC invoke, so the `fresh` contract is exercised against the
// same shared-slot semantics. Recreated per test so an unsettled slot can't
// leak across tests.
let listBerdAppSkills = shareInFlight(() => listBerdAppSkillsInvoke());
const listGooseSourceSkills =
  vi.fn<(...args: unknown[]) => Promise<SkillInfo[]>>();
const listSkills = vi.fn<(...args: unknown[]) => Promise<SkillInfo[]>>();

vi.mock("./skills", () => ({
  listAgentFileSkills: (...args: unknown[]) => listAgentFileSkills(...args),
  listBerdAppSkills: (options?: ShareInFlightOptions) =>
    listBerdAppSkills(options),
  listGooseSourceSkills: (...args: unknown[]) => listGooseSourceSkills(...args),
  listSkills: (...args: unknown[]) => listSkills(...args),
}));

// An external agent id routes through the single-key agent-skill-files leg,
// keeping these tests focused on the fresh-vs-dedup behavior of one query.
vi.mock("@/features/chat/lib/skillProviderCapabilities", () => ({
  getSkillProviderCapabilities: () => ({
    supportsSkillDiscovery: true,
    supportsSkillMentions: true,
    discoveryMode: "agent-skill-files",
    activationStyle: "standard",
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function skill(name: string): SkillInfo {
  return {
    id: name,
    name,
    description: "",
    instructions: "",
    path: `/skills/${name}`,
    fileLocation: `/skills/${name}/SKILL.md`,
    sourceKind: "project",
    sourceLabel: "Project",
    projectLinks: [],
    readonly: false,
    color: null,
  };
}

const PROVIDER = { providerId: "external-agent" };

describe("fetchSkillsList", () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) so a leftover mockReturnValueOnce from
    // one test can't leak into the next test's queue.
    vi.resetAllMocks();
    listBerdAppSkills = shareInFlight(() => listBerdAppSkillsInvoke());
  });

  it("gives a fresh read post-change data instead of deduping onto an in-flight mount fetch", async () => {
    const queryClient = new QueryClient();
    const beforeChange = deferred<SkillInfo[]>();
    const afterChange = deferred<SkillInfo[]>();
    listAgentFileSkills
      .mockReturnValueOnce(beforeChange.promise)
      .mockReturnValueOnce(afterChange.promise);

    // Mount-burst read starts and stays in flight with the pre-change list.
    const mountPromise = fetchSkillsList(queryClient, ["/w"], PROVIDER);
    // A skills-changed event lands while that read is still in flight.
    const freshPromise = fetchSkillsList(queryClient, ["/w"], {
      ...PROVIDER,
      fresh: true,
    });

    // The pre-change response arriving late must not win over the fresh read.
    afterChange.resolve([skill("after")]);
    beforeChange.resolve([skill("before")]);

    await expect(freshPromise).resolves.toEqual([skill("after")]);
    // The fresh read issued its own fetch rather than reusing the mount one.
    expect(listAgentFileSkills).toHaveBeenCalledTimes(2);
    // The cancelled mount read rejects; swallow it to avoid an unhandled reject.
    await mountPromise.catch(() => {});
  });

  it("keeps fresh on the provider-less fallback so listSkills reaches the shared app-skills invoke", async () => {
    listSkills.mockResolvedValueOnce([skill("after")]);

    const result = await fetchSkillsList(undefined, ["/w"], {
      ...PROVIDER,
      fresh: true,
    });

    expect(listSkills).toHaveBeenCalledWith(
      ["/w"],
      expect.objectContaining({ fresh: true }),
    );
    expect(result).toEqual([skill("after")]);
  });

  it("dedupes concurrent non-fresh reads onto a single in-flight fetch", async () => {
    const queryClient = new QueryClient();
    const inFlight = deferred<SkillInfo[]>();
    listAgentFileSkills.mockReturnValueOnce(inFlight.promise);

    const first = fetchSkillsList(queryClient, ["/w"], PROVIDER);
    const second = fetchSkillsList(queryClient, ["/w"], PROVIDER);
    inFlight.resolve([skill("only")]);

    await expect(first).resolves.toEqual([skill("only")]);
    await expect(second).resolves.toEqual([skill("only")]);
    expect(listAgentFileSkills).toHaveBeenCalledTimes(1);
  });
});

describe("fetchBerdAppSkills", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    listBerdAppSkills = shareInFlight(() => listBerdAppSkillsInvoke());
  });

  it("threads fresh into the shared invoke instead of reusing the pre-cancel request", async () => {
    const queryClient = new QueryClient();
    const beforeChange = deferred<SkillInfo[]>();
    const afterChange = deferred<SkillInfo[]>();
    listBerdAppSkillsInvoke
      .mockReturnValueOnce(beforeChange.promise)
      .mockReturnValueOnce(afterChange.promise);

    // Mount-burst read starts and stays in flight with the pre-change list.
    // The fresh call below cancels it; pre-attach the rejection handler so the
    // CancelledError is not flagged unhandled while the test awaits the
    // second invoke across macrotasks.
    const mountSettled = fetchBerdAppSkills(queryClient).catch(() => {});
    const freshPromise = fetchBerdAppSkills(queryClient, { fresh: true });

    // While the first invoke is unsettled the shared slot still points at it;
    // `cancelQueries` discards the query-layer promise but does not abort that
    // invoke, so only the threaded flag makes the fresh queryFn start a second
    // invoke instead of being handed the pre-cancel one. The deferreds stay
    // pending here on purpose — settling them first would clear the slot and
    // mask the reuse.
    await vi.waitFor(() =>
      expect(listBerdAppSkillsInvoke).toHaveBeenCalledTimes(2),
    );

    afterChange.resolve([skill("after")]);
    beforeChange.resolve([skill("before")]);

    await expect(freshPromise).resolves.toEqual([skill("after")]);
    await mountSettled;
  });
});
