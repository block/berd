import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHomeDir: vi.fn(),
  pathExists: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  recordMeHistory: vi.fn(),
  loadMeFile: vi.fn(),
  createMeFile: vi.fn(),
  publishMeFile: vi.fn(),
  listTopics: vi.fn(),
  createTopic: vi.fn(),
}));

vi.mock("@/shared/api/system", () => ({
  getHomeDir: mocks.getHomeDir,
  pathExists: mocks.pathExists,
  readTextFile: mocks.readTextFile,
  writeTextFile: mocks.writeTextFile,
  recordMeHistory: mocks.recordMeHistory,
}));
vi.mock("../meFile", () => ({
  loadMeFile: mocks.loadMeFile,
  createMeFile: mocks.createMeFile,
}));
vi.mock("../mePublish", () => ({ publishMeFile: mocks.publishMeFile }));
vi.mock("../meTopics", () => ({
  listTopics: mocks.listTopics,
  createTopic: mocks.createTopic,
}));

import {
  applyMemoryEntry,
  deleteAddedEntry,
  listAddedEntries,
} from "../meMemoryWrites";
import type { MemoryProposal } from "../meProposals";

const HOME = "/home/u";
const RECENT = `${HOME}/.me/proposals/recent.jsonl`;
const DISMISSED = `${HOME}/.me/proposals/dismissed.jsonl`;

function candidate(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id: "cand-1",
    ts: 1_700_000_000,
    content: "Kids' soccer is Mondays.",
    topic: "Home",
    agent: "noticer",
    sessionId: "sess-1",
    ...overrides,
  };
}

/** Files the fake filesystem knows about. */
let files: Record<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  files = {};
  mocks.getHomeDir.mockResolvedValue(HOME);
  mocks.pathExists.mockImplementation(async (path: string) => path in files);
  mocks.readTextFile.mockImplementation(async (path: string) => ({
    contents: files[path] ?? "",
  }));
  mocks.writeTextFile.mockImplementation(async (path: string, next: string) => {
    files[path] = next;
  });
  mocks.recordMeHistory.mockResolvedValue(true);
  mocks.publishMeFile.mockResolvedValue(undefined);
  mocks.listTopics.mockResolvedValue([]);
});

describe("applyMemoryEntry", () => {
  it("writes into a matching topic and logs it as recently added", async () => {
    const topicPath = `${HOME}/.me/topics/home.md`;
    files[topicPath] = "# Home\n\n- Existing.\n";
    mocks.listTopics.mockResolvedValue([
      {
        fileName: "home.md",
        label: "Home",
        path: topicPath,
        contents: files[topicPath],
      },
    ]);

    const entry = await applyMemoryEntry(candidate());

    expect(files[topicPath]).toContain("- Kids' soccer is Mondays.");
    expect(files[topicPath]).toContain("- Existing.");
    expect(entry?.topic).toBe("Home");
    expect(entry?.path).toBe(topicPath);
    // Attribution names the agent that surfaced it, and the record carries
    // the entry so the history says what was added.
    expect(mocks.recordMeHistory).toHaveBeenCalledWith(
      topicPath,
      "agent:noticer",
      "Kids' soccer is Mondays.",
    );
    expect(files[RECENT]).toContain("Kids' soccer is Mondays.");
  });

  it("creates a topic when the name is one of the broad areas", async () => {
    const created = `${HOME}/.me/topics/travel.md`;
    mocks.createTopic.mockResolvedValue({
      fileName: "travel.md",
      label: "Travel",
      path: created,
      contents: "# Travel\n",
    });

    const entry = await applyMemoryEntry(
      candidate({ topic: "Travel", content: "Prefers aisle seats." }),
    );

    expect(mocks.createTopic).toHaveBeenCalledWith("Travel");
    expect(entry?.topic).toBe("Travel");
  });

  it("falls back to the spine for an out-of-vocabulary topic", async () => {
    const spine = `${HOME}/.me/me.md`;
    files[spine] = "# Me\n\n## Preferences\n\n- Keep answers brief.\n";
    mocks.loadMeFile.mockResolvedValue({
      status: "present",
      path: spine,
      contents: files[spine],
      displayPath: "~/.me/me.md",
      legacy: false,
    });

    // A drifting model shouldn't be able to mint "Soccer" as a topic.
    const entry = await applyMemoryEntry(candidate({ topic: "Soccer" }));

    expect(mocks.createTopic).not.toHaveBeenCalled();
    expect(entry?.topic).toBeNull();
    expect(files[spine]).toContain("- Kids' soccer is Mondays.");
    // Spine writes re-publish, so other tools see the change.
    expect(mocks.publishMeFile).toHaveBeenCalled();
  });

  it("seeds the spine when there is no memory file yet", async () => {
    const spine = `${HOME}/.me/me.md`;
    mocks.loadMeFile.mockResolvedValue({
      status: "missing",
      path: spine,
      displayPath: "~/.me/me.md",
      legacy: false,
    });
    mocks.createMeFile.mockImplementation(async () => {
      files[spine] = "# Me\n\n## Preferences\n";
      return {
        status: "present" as const,
        path: spine,
        contents: files[spine],
        displayPath: "~/.me/me.md",
        legacy: false,
      };
    });

    const entry = await applyMemoryEntry(candidate({ topic: null }));

    expect(mocks.createMeFile).toHaveBeenCalled();
    expect(entry).not.toBeNull();
    expect(files[spine]).toContain("- Kids' soccer is Mondays.");
  });
});

describe("deleteAddedEntry", () => {
  it("removes the bullet, tombstones it, and clears the card", async () => {
    const topicPath = `${HOME}/.me/topics/home.md`;
    files[topicPath] = "# Home\n\n- Kids' soccer is Mondays.\n- Keep this.\n";
    files[RECENT] = `${JSON.stringify({
      id: "cand-1",
      // Within the review window, or listAddedEntries ages it out.
      ts: Math.floor(Date.now() / 1000) - 60,
      content: "Kids' soccer is Mondays.",
      topic: "Home",
      path: topicPath,
      agent: "noticer",
      sessionId: "sess-1",
    })}\n`;

    const [entry] = await listAddedEntries();
    await deleteAddedEntry(entry);

    expect(files[topicPath]).not.toContain("Kids' soccer is Mondays.");
    expect(files[topicPath]).toContain("- Keep this.");
    // Removals are their own operation, not an edit, so a deleted entry
    // coming back is visible in the history.
    expect(mocks.recordMeHistory).toHaveBeenCalledWith(
      topicPath,
      "delete",
      "Kids' soccer is Mondays.",
    );
    // Tombstoned so nothing re-adds it.
    expect(files[DISMISSED]).toContain("Kids' soccer is Mondays.");
    expect(await listAddedEntries()).toHaveLength(0);
  });
});

describe("listAddedEntries", () => {
  it("drops entries older than the review window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const fresh = {
      id: "a",
      ts: now - 60,
      content: "Fresh.",
      topic: null,
      path: "/p",
    };
    const stale = {
      id: "b",
      ts: now - 30 * 24 * 60 * 60,
      content: "Ancient.",
      topic: null,
      path: "/p",
    };
    files[RECENT] = `${JSON.stringify(fresh)}\n${JSON.stringify(stale)}\n`;

    const entries = await listAddedEntries();

    expect(entries.map((entry) => entry.content)).toEqual(["Fresh."]);
  });
});
