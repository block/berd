import { test as base, expect, type Page } from "@playwright/test";

import { buildInitScript } from "./fixtures/tauri-mock";

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
}, testInfo) => {
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
  await testInfo.attach("playback-confirmed-text-status", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});
