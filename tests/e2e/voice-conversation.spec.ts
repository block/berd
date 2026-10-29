import { test as base, expect, type Page } from "@playwright/test";

import { buildInitScript } from "./fixtures/tauri-mock";

base.use({ screenshot: "off", video: "off", trace: "off" });

const SESSION_ID = "voice-session";
const ASSISTANT_MESSAGE_ID = "assistant-message";
const SPOKEN_TEXT = "This playback-confirmed reply should be visible.";

const test = base.extend<{ voice: Page }>({
  voice: async ({ page }, use) => {
    await page.addInitScript({
      content: buildInitScript({
        sessions: [
          {
            sessionId: SESSION_ID,
            title: "Voice playback",
            messageCount: 1,
          },
        ],
        voiceConversationStatus: {
          available: true,
          unavailableReason: null,
          lifecycle: "stopped",
          sessionId: null,
          ownerWindowLabel: null,
          revision: 1,
        },
        enabledExperiments: ["voice-conversation"],
      }),
    });
    await use(page);
  },
});

test("queues assistant text through native playback", async ({
  voice: page,
}) => {
  await page.goto("/");
  await page.getByText("Voice playback", { exact: true }).click();

  await page.evaluate(
    async ({ sessionId, messageId, text }) => {
      const harness = (
        window as typeof window & {
          __GOOSE_E2E__: {
            emitAcpNotification: (params: unknown) => void;
            emitTauriEvent: (event: string, payload: unknown) => void;
          };
        }
      ).__GOOSE_E2E__;
      harness.emitTauriEvent("voice-conversation:event", {
        type: "startup",
        sessionId,
        ownerWindowLabel: "voice-e2e-owner",
        line: "Voice conversation ready",
        revision: 2,
      });
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      harness.emitAcpNotification({
        sessionId,
        update: {
          sessionUpdate: "session_info_update",
          _meta: {
            goose: {
              activeRunId: "voice-e2e-run",
            },
          },
        },
      });
      harness.emitAcpNotification({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: {
            type: "text",
            text,
          },
        },
      });
      harness.emitAcpNotification({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "voice-e2e-tool",
          title: "read_file",
          rawInput: { path: "/tmp/voice-e2e.txt" },
        },
      });
    },
    {
      sessionId: SESSION_ID,
      messageId: ASSISTANT_MESSAGE_ID,
      text: SPOKEN_TEXT,
    },
  );

  await expect(page.getByText(SPOKEN_TEXT)).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as typeof window & {
            __GOOSE_E2E__: {
              pocketVoiceSpokenTexts: () => string[];
            };
          }
        ).__GOOSE_E2E__.pocketVoiceSpokenTexts(),
      ),
    )
    .toEqual([SPOKEN_TEXT]);
});

// These exercise the rendered controller and ACP adapter, not native recognition
// or a real model. Prompt completion is held so pause/final races are deterministic.
type AcpRequest = {
  method: string;
  params?: {
    prompt?: { text?: string; annotations?: { audience?: string[] } }[];
    _meta?: { goose?: { voiceUtteranceId?: string } };
  };
};
type VoiceHarness = {
  emitTauriEvent: (event: string, payload: unknown) => void;
  emitAcpNotification: (params: unknown) => void;
  acpRequests: () => AcpRequest[];
  completeAcpPrompts: () => void;
  pocketVoiceSpokenTexts: () => string[];
  pocketVoiceStreamIds: () => string[];
};

async function nativeEvent(page: Page, payload: object) {
  await page.evaluate(
    (payload) => {
      const harness = (
        window as typeof window & { __GOOSE_E2E__: VoiceHarness }
      ).__GOOSE_E2E__;
      harness.emitTauriEvent("voice-conversation:event", payload);
    },
    { sessionId: SESSION_ID, revision: 2, ...payload },
  );
}

async function requests(page: Page) {
  return page.evaluate(() =>
    (window as typeof window & { __GOOSE_E2E__: VoiceHarness }).__GOOSE_E2E__
      .acpRequests()
      .filter((request) =>
        ["session/prompt", "_goose/unstable/session/steer"].includes(
          request.method,
        ),
      ),
  );
}

async function spoken(page: Page) {
  return page.evaluate(() =>
    (
      window as typeof window & { __GOOSE_E2E__: VoiceHarness }
    ).__GOOSE_E2E__.pocketVoiceSpokenTexts(),
  );
}

async function completePrompts(page: Page) {
  await page.evaluate(() =>
    (
      window as typeof window & { __GOOSE_E2E__: VoiceHarness }
    ).__GOOSE_E2E__.completeAcpPrompts(),
  );
}

async function assistantOutput(page: Page, text: string, runId: string) {
  await page.evaluate(
    ({ text, runId, sessionId }) => {
      const harness = (
        window as typeof window & { __GOOSE_E2E__: VoiceHarness }
      ).__GOOSE_E2E__;
      harness.emitAcpNotification({
        sessionId,
        update: {
          sessionUpdate: "session_info_update",
          _meta: { goose: { activeRunId: runId } },
        },
      });
      harness.emitAcpNotification({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: `message-${runId}`,
          content: { type: "text", text },
        },
      });
      // A tool boundary flushes the speech sentence without completing the run.
      harness.emitAcpNotification({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: `tool-${runId}`,
          title: "read_file",
          rawInput: { path: "/tmp/voice-e2e.txt" },
        },
      });
    },
    { text, runId, sessionId: SESSION_ID },
  );
}

const utterance = {
  lifecycleId: "early-delivery-lifecycle",
  id: "utterance-1",
  text: "Set the temperature to 10 degrees.",
};

base.describe("early voice delivery", () => {
  base.beforeEach(async ({ page }) => {
    await page.addInitScript({
      content: buildInitScript({
        holdAcpPrompts: true,
        sessions: [
          {
            sessionId: SESSION_ID,
            title: "Early voice",
            messageCount: 1,
            providerId: "openai",
            modelId: "gpt-4.1",
          },
        ],
        voiceConversationStatus: {
          available: true,
          unavailableReason: null,
          lifecycle: "stopped",
          sessionId: null,
          ownerWindowLabel: null,
          revision: 1,
        },
        enabledExperiments: ["voice-conversation"],
      }),
    });
    await page.goto("/");
    await page.getByText("Early voice", { exact: true }).click();
    await expect(page.getByRole("textbox").first()).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await nativeEvent(page, {
      type: "startup",
      ownerWindowLabel: "main",
      line: "Ready",
    });
    await assistantOutput(page, "The reply being interrupted.", "prior-run");
    await expect
      .poll(() => spoken(page))
      .toEqual(["The reply being interrupted."]);
    await nativeEvent(page, { type: "activity", activity: "user-speaking" });
    await page.evaluate(() => {
      const harness = (
        window as typeof window & { __GOOSE_E2E__: VoiceHarness }
      ).__GOOSE_E2E__;
      harness.emitTauriEvent("pocket-voice:stream-event", {
        streamId: harness.pocketVoiceStreamIds()[0],
        state: "interrupted",
        error: null,
        delivery: { segments: [] },
      });
    });
    await page.evaluate((sessionId) => {
      (
        window as typeof window & { __GOOSE_E2E__: VoiceHarness }
      ).__GOOSE_E2E__.emitAcpNotification({
        sessionId,
        update: {
          sessionUpdate: "session_info_update",
          _meta: { goose: { activeRunId: null } },
        },
      });
    }, SESSION_ID);
    await nativeEvent(page, { type: "interimUser", ...utterance });
    await nativeEvent(page, { type: "activity", activity: "user-idle" });
    await expect.poll(() => requests(page)).toHaveLength(1);
    const early = (await requests(page))[0];
    expect(early.method).toBe("session/prompt");
    expect(
      early.params?.prompt?.find((block) => block.text === utterance.text),
    ).toMatchObject({ annotations: { audience: ["assistant"] } });
    await expect(page.getByText(utterance.text, { exact: true })).toHaveCount(
      0,
    );
  });

  base(
    "unchanged final is visible once and releases withheld assistant speech",
    async ({ page }) => {
      const answer = "The unchanged provisional answer can now be spoken.";
      await assistantOutput(page, answer, "early-run");
      await expect
        .poll(() => spoken(page))
        .toEqual(["The reply being interrupted."]);
      await nativeEvent(page, {
        type: "user",
        ...utterance,
        deliveryAttempts: 0,
      });
      await expect.poll(() => requests(page)).toHaveLength(2);
      expect((await requests(page))[1].method).toBe(
        "_goose/unstable/session/steer",
      );
      expect(
        (await requests(page))[1].params?.prompt?.find(
          (block) => block.text === utterance.text,
        )?.annotations,
      ).toBeUndefined();
      await expect(page.getByText(utterance.text, { exact: true })).toHaveCount(
        1,
      );
      await expect
        .poll(() => spoken(page))
        .toEqual(["The reply being interrupted.", answer]);
      await nativeEvent(page, {
        type: "user",
        ...utterance,
        deliveryAttempts: 0,
      });
      await completePrompts(page);
      await expect(page.getByText(utterance.text, { exact: true })).toHaveCount(
        1,
      );
      expect(await requests(page)).toHaveLength(2);
      expect(await spoken(page)).toEqual([
        "The reply being interrupted.",
        answer,
      ]);
    },
  );

  base(
    "changed final never speaks the old answer, including late old output",
    async ({ page }) => {
      const oldAnswer =
        "This obsolete provisional answer must never be spoken.";
      const finalText = "Set the temperature to -10 degrees.";
      await assistantOutput(page, oldAnswer, "obsolete-run");
      await nativeEvent(page, { type: "microphoneMute", muted: true });
      await nativeEvent(page, {
        type: "user",
        ...utterance,
        text: finalText,
        deliveryAttempts: 0,
      });
      await assistantOutput(
        page,
        " Late obsolete output must also stay unspoken.",
        "obsolete-run",
      );
      expect(await requests(page)).toHaveLength(1);
      expect(await spoken(page)).toEqual(["The reply being interrupted."]);
      await completePrompts(page);
      await expect.poll(() => requests(page)).toHaveLength(2);
      expect((await requests(page))[1].method).toBe("session/prompt");
      await expect(page.getByText(finalText, { exact: true })).toHaveCount(1);
      await expect(page.getByText(utterance.text, { exact: true })).toHaveCount(
        0,
      );
      const correctedAnswer =
        "Only the corrected final answer should be spoken.";
      await assistantOutput(page, correctedAnswer, "corrected-run");
      await completePrompts(page);
      await expect
        .poll(() => spoken(page))
        .toEqual(["The reply being interrupted.", correctedAnswer]);
    },
  );

  base(
    "recognition ending without a final discards speculative speech and permits the next utterance",
    async ({ page }) => {
      await assistantOutput(
        page,
        "An abandoned answer must remain unspoken.",
        "abandoned-run",
      );
      await nativeEvent(page, { type: "recognitionPending", pending: false });
      await completePrompts(page);
      await nativeEvent(page, {
        type: "interimUser",
        ...utterance,
        id: "utterance-2",
        text: "The next utterance.",
      });
      await expect.poll(() => requests(page)).toHaveLength(2);
      expect(await spoken(page)).toEqual(["The reply being interrupted."]);
      await expect(page.getByText(utterance.text, { exact: true })).toHaveCount(
        0,
      );
      await nativeEvent(page, { type: "cleanShutdown" });
      await completePrompts(page);
      expect(await spoken(page)).toEqual(["The reply being interrupted."]);
    },
  );
});
