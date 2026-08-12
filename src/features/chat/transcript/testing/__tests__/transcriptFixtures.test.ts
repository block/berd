import { describe, expect, it } from "vitest";
import {
  buildTranscriptFixture,
  buildTranscriptVirtualizationFixtures,
  fixtureDigest,
  type TranscriptHarnessOperation,
} from "../transcriptFixtures";
import type { MessageContent } from "@/shared/types/messages";

function countBlocks(
  content: readonly MessageContent[],
  type: MessageContent["type"],
): number {
  return content.filter((block) => block.type === type).length;
}

function operationKinds(
  operations: readonly TranscriptHarnessOperation[],
): Set<TranscriptHarnessOperation["kind"]> {
  return new Set(operations.map((operation) => operation.kind));
}

function hasOperationKind<K extends TranscriptHarnessOperation["kind"]>(
  operation: TranscriptHarnessOperation,
  kind: K,
): operation is Extract<TranscriptHarnessOperation, { kind: K }> {
  return operation.kind === kind;
}

describe("transcript virtualization fixtures", () => {
  it("builds every required scenario deterministically", () => {
    const first = buildTranscriptVirtualizationFixtures();
    const second = buildTranscriptVirtualizationFixtures();

    expect(Object.keys(first).sort()).toEqual([
      "composer-growth-session-switch",
      "dynamic-media-code",
      "huge-assistant-output",
      "long-10k",
      "mcp-dynamic-rows",
      "pr928-fragment-tail",
      "streaming-scrollback-long-markdown",
      "tool-chain-storm",
      "visual-spacing-date-footer",
      "visual-spacing-fragmented-assistant",
      "visual-spacing-rich-blocks",
    ]);

    for (const name of Object.keys(first) as Array<keyof typeof first>) {
      expect(first[name]).toEqual(second[name]);
      expect(fixtureDigest(first[name])).toBe(fixtureDigest(second[name]));
      expect(() => JSON.stringify(first[name])).not.toThrow();
    }
  });

  it("creates the 10k restore and prepend fixture", () => {
    const fixture = buildTranscriptFixture("long-10k");
    const session = fixture.sessions[0];

    expect(session.messages).toHaveLength(10_000);
    expect(session.messages[0].id).toBe("long-00000");
    expect(session.messages.at(-1)?.id).toBe("long-09999");
    expect(fixture.expectations.minLogicalRows).toBeGreaterThan(10_000);
    expect(operationKinds(fixture.operations)).toEqual(
      new Set([
        "restore",
        "scroll",
        "prependMessages",
        "controlledScrollTarget",
      ]),
    );
  });

  it("creates a huge assistant output fixture with a multi-thousand-line code fence", () => {
    const fixture = buildTranscriptFixture("huge-assistant-output");
    const session = fixture.sessions[0];
    const assistant = session.messages[1];
    const text = assistant.content[0];

    if (text.type !== "text") {
      throw new Error("expected first assistant block to be text");
    }

    expect(text.text.split("\n")).toHaveLength(
      fixture.expectations.codeFenceLineCount + 20,
    );
    expect(fixture.expectations.codeFenceLineCount).toBe(5_000);
    expect(session.streamingMessageId).toBe(assistant.id);
    expect(operationKinds(fixture.operations)).toContain("appendStreamingText");
  });

  it("creates tool-chain rows with paired request and response blocks", () => {
    const fixture = buildTranscriptFixture("tool-chain-storm");
    const session = fixture.sessions[0];
    const firstMessage = session.messages[0];

    expect(session.messages).toHaveLength(320);
    expect(countBlocks(firstMessage.content, "toolRequest")).toBe(8);
    expect(countBlocks(firstMessage.content, "toolResponse")).toBe(8);
    expect(countBlocks(firstMessage.content, "reasoning")).toBe(1);
    expect(fixture.expectations.toolCallCount).toBe(2_560);
    expect(fixture.expectations.dynamicRowCount).toBeGreaterThan(0);
  });

  it("creates MCP-like dynamic rows and resize operations", () => {
    const fixture = buildTranscriptFixture("mcp-dynamic-rows");
    const session = fixture.sessions[0];
    const mcpMessages = session.messages.filter((message) =>
      message.content.some((block) => block.type === "mcpApp"),
    );
    const resizeOperations = fixture.operations.filter((operation) =>
      hasOperationKind(operation, "resizeMcpApp"),
    );

    expect(mcpMessages).toHaveLength(36);
    expect(fixture.expectations.mcpAppCount).toBe(36);
    expect(resizeOperations).toHaveLength(2);
    expect(resizeOperations[0].heights).toEqual([180, 420, 260, 512]);
  });

  it("creates dynamic image/code and composer/session-switch operations", () => {
    const mediaFixture = buildTranscriptFixture("dynamic-media-code");
    const composerFixture = buildTranscriptFixture(
      "composer-growth-session-switch",
    );

    expect(mediaFixture.expectations.imageCount).toBe(2);
    expect(operationKinds(mediaFixture.operations)).toEqual(
      new Set(["restore", "scroll", "imageLoad", "codeHighlightComplete"]),
    );

    expect(composerFixture.sessions).toHaveLength(2);
    expect(operationKinds(composerFixture.operations)).toEqual(
      new Set([
        "restore",
        "composerResize",
        "toggleSurface",
        "appendStreamingText",
        "switchSession",
      ]),
    );
    expect(
      composerFixture.operations.some(
        (operation) => operation.kind === "switchSession",
      ),
    ).toBe(true);
  });

  it("creates PR 928 fragment/tail topology proof operations", () => {
    const fixture = buildTranscriptFixture("pr928-fragment-tail");

    expect(fixture.sessions[0].messages.map((message) => message.id)).toEqual([
      "pr928-intro",
      "pr928-same-id",
      "pr928-whole",
      "pr928-tail",
      "pr928-after",
    ]);
    expect(operationKinds(fixture.operations)).toEqual(
      new Set([
        "restore",
        "scrollToRowOffset",
        "changeRowRevision",
        "splitMessageRows",
        "promoteStreamingTail",
      ]),
    );
    expect(
      fixture.operations.filter((operation) =>
        hasOperationKind(operation, "scrollToRowOffset"),
      ),
    ).toHaveLength(3);
    expect(
      fixture.operations.some((operation) =>
        hasOperationKind(operation, "splitMessageRows"),
      ),
    ).toBe(true);
    expect(
      fixture.operations.some((operation) =>
        hasOperationKind(operation, "promoteStreamingTail"),
      ),
    ).toBe(true);
  });

  it("creates an active streaming scrollback fixture with non-blocking chunks", () => {
    const fixture = buildTranscriptFixture(
      "streaming-scrollback-long-markdown",
    );
    const session = fixture.sessions[0];
    const assistant = session.messages[1];
    const text = assistant.content[0];
    const startOperation = fixture.operations.find((operation) =>
      hasOperationKind(operation, "startStreamingText"),
    );

    if (text.type !== "text") {
      throw new Error("expected first assistant block to be text");
    }

    expect(session.streamingMessageId).toBe("streaming-scrollback-assistant");
    expect(assistant.id).toBe(session.streamingMessageId);
    expect(assistant.metadata?.completionStatus).toBe("inProgress");
    expect(text.text).not.toContain("```");
    expect(text.text.split("\n").length).toBeGreaterThanOrEqual(120);
    expect(operationKinds(fixture.operations)).toEqual(
      new Set(["restore", "startStreamingText", "waitForStreamingText"]),
    );
    expect(startOperation).toBeDefined();
    if (startOperation?.kind === "startStreamingText") {
      expect(startOperation.chunks.length).toBeGreaterThanOrEqual(12);
      expect(startOperation.chunkIntervalMs).toBeGreaterThanOrEqual(50);
    }
  });

  it("supports smaller deterministic fixtures for local debugging", () => {
    const fixture = buildTranscriptFixture("long-10k", { messageCount: 12 });

    expect(fixture.sessions[0].messages).toHaveLength(12);
    expect(fixture.expectations.logicalMessageCount).toBe(12);
    expect(fixtureDigest(fixture)).toBe(
      fixtureDigest(buildTranscriptFixture("long-10k", { messageCount: 12 })),
    );
  });
});
