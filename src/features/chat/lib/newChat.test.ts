import { describe, expect, it } from "vitest";
import type { Message } from "@/shared/types/messages";
import { findExistingDraft } from "./newChat";
import type { ChatSession } from "../stores/chatSessionStore";

function makeSession(
  id: string,
  overrides: Partial<ChatSession> = {},
): ChatSession {
  return {
    id,
    title: "New chat",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    messageCount: 0,
    ...overrides,
  };
}

describe("findExistingDraft", () => {
  it("reuses a matching project draft with content", () => {
    const draft = makeSession("alpha-draft", {
      projectId: "alpha",
      executionTarget: { harnessId: "goose" },
    });

    expect(
      findExistingDraft({
        sessions: [draft],
        activeSessionId: null,
        draftsBySession: { "alpha-draft": "alpha draft" },
        messagesBySession: {},
        request: {
          title: "New chat",
          projectId: "alpha",
        },
      }),
    ).toEqual(draft);
  });

  it("does not reuse a matching project draft when draft reuse is disabled", () => {
    const draft = makeSession("alpha-draft", {
      projectId: "alpha",
      executionTarget: { harnessId: "goose" },
    });

    expect(
      findExistingDraft({
        sessions: [draft],
        activeSessionId: null,
        draftsBySession: { "alpha-draft": "alpha draft" },
        messagesBySession: {},
        request: {
          title: "New chat",
          projectId: "alpha",
        },
        allowDraftReuse: false,
      }),
    ).toBeUndefined();
  });

  it("does not reuse a draft from a different project", () => {
    const draft = makeSession("alpha-draft", {
      projectId: "alpha",
      executionTarget: { harnessId: "goose" },
    });

    expect(
      findExistingDraft({
        sessions: [draft],
        activeSessionId: null,
        draftsBySession: { "alpha-draft": "alpha draft" },
        messagesBySession: {},
        request: {
          title: "New Chat",
          projectId: "beta",
        },
      }),
    ).toBeUndefined();
  });

  it("does not reuse a draft with a different requested provider or model", () => {
    const draft = makeSession("alpha-draft", {
      projectId: "alpha",
      executionTarget: {
        harnessId: "goose",
        modelProviderId: "databricks_v2",
        modelId: "default-model",
        modelName: "Default model",
      },
    });

    expect(
      findExistingDraft({
        sessions: [draft],
        activeSessionId: null,
        draftsBySession: { "alpha-draft": "alpha draft" },
        messagesBySession: {},
        request: {
          title: "New Chat",
          projectId: "alpha",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "databricks_v2",
            modelId: "specific-model",
            modelName: "Specific model",
          },
        },
      }),
    ).toBeUndefined();

    expect(
      findExistingDraft({
        sessions: [draft],
        activeSessionId: null,
        draftsBySession: { "alpha-draft": "alpha draft" },
        messagesBySession: {},
        request: {
          title: "New Chat",
          projectId: "alpha",
          executionTarget: {
            harnessId: "goose",
            modelProviderId: "other-provider",
            modelId: "default-model",
            modelName: "Default model",
          },
        },
      }),
    ).toBeUndefined();
  });

  it("matches requested reasoning effort before reusing a draft", () => {
    const draft = makeSession("alpha-draft", {
      projectId: "alpha",
      executionTarget: { harnessId: "goose" },
      reasoningEffort: {
        configId: "thinking_effort",
        currentValue: "high",
        options: [
          { id: "low", name: "low" },
          { id: "high", name: "high" },
        ],
      },
    });

    expect(
      findExistingDraft({
        sessions: [draft],
        activeSessionId: null,
        draftsBySession: { "alpha-draft": "alpha draft" },
        messagesBySession: {},
        request: {
          title: "New Chat",
          projectId: "alpha",
          executionTarget: { harnessId: "goose" },
          reasoningEffortValue: "high",
        },
      }),
    ).toEqual(draft);

    expect(
      findExistingDraft({
        sessions: [draft],
        activeSessionId: null,
        draftsBySession: { "alpha-draft": "alpha draft" },
        messagesBySession: {},
        request: {
          title: "New Chat",
          projectId: "alpha",
          executionTarget: { harnessId: "goose" },
          reasoningEffortValue: "low",
        },
      }),
    ).toBeUndefined();
  });

  it("reuses a matching empty draft with a terminal", () => {
    const draft = makeSession("alpha-draft", {
      projectId: "alpha",
      executionTarget: { harnessId: "goose" },
    });

    expect(
      findExistingDraft({
        sessions: [draft],
        activeSessionId: null,
        draftsBySession: {},
        messagesBySession: {},
        sessionIdsWithTerminals: new Set(["alpha-draft"]),
        request: {
          title: "New Chat",
          projectId: "alpha",
        },
      }),
    ).toEqual(draft);
  });

  it("reuses a promoted empty draft with a terminal on its client id", () => {
    const draft = makeSession("backend-session", {
      clientSessionId: "client-session",
      projectId: "alpha",
      executionTarget: { harnessId: "goose" },
    });

    expect(
      findExistingDraft({
        sessions: [draft],
        activeSessionId: null,
        draftsBySession: {},
        messagesBySession: {},
        sessionIdsWithTerminals: new Set(["client-session"]),
        request: {
          title: "New Chat",
          projectId: "alpha",
        },
      }),
    ).toEqual(draft);
  });

  it("does not reuse an abandoned empty draft", () => {
    const draft = makeSession("alpha-draft", {
      projectId: "alpha",
      executionTarget: { harnessId: "goose" },
    });

    expect(
      findExistingDraft({
        sessions: [draft],
        activeSessionId: null,
        draftsBySession: {},
        messagesBySession: {},
        request: {
          title: "New Chat",
          projectId: "alpha",
        },
      }),
    ).toBeUndefined();
  });

  it("reuses the active empty draft without content", () => {
    const draft = makeSession("alpha-draft", {
      projectId: "alpha",
      executionTarget: { harnessId: "goose" },
    });

    expect(
      findExistingDraft({
        sessions: [draft],
        activeSessionId: "alpha-draft",
        draftsBySession: {},
        messagesBySession: {},
        request: {
          title: "New Chat",
          projectId: "alpha",
        },
      }),
    ).toEqual(draft);
  });

  it("does not reuse the active empty draft for a different project", () => {
    const draft = makeSession("alpha-draft", {
      projectId: "alpha",
      executionTarget: { harnessId: "goose" },
    });

    expect(
      findExistingDraft({
        sessions: [draft],
        activeSessionId: "alpha-draft",
        draftsBySession: {},
        messagesBySession: {},
        request: {
          title: "New Chat",
          projectId: "beta",
        },
      }),
    ).toBeUndefined();
  });

  it("does not reuse a draft whose remote host differs from the request", () => {
    const localDraft = makeSession("local-draft", {
      projectId: "alpha",
      executionTarget: { harnessId: "goose" },
    });
    const remoteDraft = makeSession("remote-draft", {
      projectId: "alpha",
      executionTarget: { harnessId: "goose" },
      remoteHost: "devbox",
    });

    expect(
      findExistingDraft({
        sessions: [localDraft, remoteDraft],
        activeSessionId: null,
        draftsBySession: {
          "local-draft": "draft text",
          "remote-draft": "draft text",
        },
        messagesBySession: {},
        request: {
          title: "New Chat",
          projectId: "alpha",
          remoteHost: "otherbox",
        },
      }),
    ).toBeUndefined();

    expect(
      findExistingDraft({
        sessions: [localDraft, remoteDraft],
        activeSessionId: null,
        draftsBySession: {
          "local-draft": "draft text",
          "remote-draft": "draft text",
        },
        messagesBySession: {},
        request: {
          title: "New Chat",
          projectId: "alpha",
          remoteHost: "devbox",
        },
      }),
    ).toEqual(remoteDraft);
  });

  it("treats an absent remote host as local on both sides", () => {
    const localDraft = makeSession("local-draft", {
      projectId: "alpha",
      executionTarget: { harnessId: "goose" },
    });
    const remoteDraft = makeSession("remote-draft", {
      projectId: "alpha",
      executionTarget: { harnessId: "goose" },
      remoteHost: "devbox",
    });

    expect(
      findExistingDraft({
        sessions: [remoteDraft, localDraft],
        activeSessionId: null,
        draftsBySession: {
          "local-draft": "draft text",
          "remote-draft": "draft text",
        },
        messagesBySession: {},
        request: {
          title: "New Chat",
          projectId: "alpha",
        },
      }),
    ).toEqual(localDraft);

    expect(
      findExistingDraft({
        sessions: [localDraft],
        activeSessionId: null,
        draftsBySession: { "local-draft": "draft text" },
        messagesBySession: {},
        request: {
          title: "New Chat",
          projectId: "alpha",
          remoteHost: "",
        },
      }),
    ).toEqual(localDraft);
  });

  it("does not reuse a session with local messages even if messageCount is 0", () => {
    const session = makeSession("alpha-session", {
      projectId: "alpha",
      executionTarget: { harnessId: "goose" },
      messageCount: 0,
    });

    expect(
      findExistingDraft({
        sessions: [session],
        activeSessionId: "alpha-session",
        draftsBySession: {},
        messagesBySession: {
          "alpha-session": [
            {
              id: "msg-1",
              role: "user",
              created: 1,
              content: [{ type: "text", text: "hello" }],
            } satisfies Message,
          ],
        },
        request: {
          title: "New Chat",
          projectId: "alpha",
        },
      }),
    ).toBeUndefined();
  });
});
