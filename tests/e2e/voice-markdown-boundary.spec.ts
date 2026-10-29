import { test as base, expect, type Page } from "@playwright/test";

import { buildInitScript } from "./fixtures/tauri-mock";

type SpeechBoundaryWindow = Window & {
  __SPEECH_BOUNDARY__: { prepared: string[]; appended: string[] };
  __FINISH_VOICE_PROMPT__: () => void;
  __TAURI_INTERNALS__: {
    invoke: (
      command: string,
      args?: { request?: { text: string }; text?: string },
    ) => Promise<unknown>;
  };
};

const SESSION_ID = "voice-session";
const ASSISTANT_MESSAGE_ID = "assistant-message";
const SPOKEN_TEXT =
  String.raw`See [the page](<https://example.com/a(b> 'Read (first') for the next steps. Use \[brackets](not a link) now. Call ` +
  "`callbacks[index](result)` next.\n\n    callbacks[index](result)\n\n1. Read:\n    [guide](https://example.com/guide)\n\nSee [docs](\n    https://example.com/private/path\n) now.\n\n> Code:\n>\n>     callbacks[index](result)\n\nSee the manual:\n    [manual](https://example.com/manual) now.\n\nUse ` when needed, then see [help](https://example.com/help).";

const test = base.extend<{ voice: Page }>({
  voice: async ({ page }, use) => {
    await page.addInitScript({
      content: buildInitScript({
        sessions: [
          {
            sessionId: SESSION_ID,
            title: "Voice playback",
            providerId: "openai",
            modelId: "gpt-4.1",
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
    await page.addInitScript(() => {
      localStorage.setItem("goose:voice-output-backend", "pocket");
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        const request = JSON.parse(String(data));
        if (request.method === "session/load") {
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({
                  jsonrpc: "2.0",
                  id: request.id,
                  result: {
                    configOptions: [
                      {
                        id: "provider",
                        name: "Provider",
                        type: "select",
                        currentValue: "openai",
                        options: [{ value: "openai", name: "OpenAI" }],
                      },
                      {
                        id: "model",
                        name: "Model",
                        category: "model",
                        type: "select",
                        currentValue: "gpt-4.1",
                        options: [{ value: "gpt-4.1", name: "GPT-4.1" }],
                      },
                    ],
                  },
                }),
              }),
            ),
          );
          return;
        }
        if (request.method === "session/prompt") {
          (window as SpeechBoundaryWindow).__FINISH_VOICE_PROMPT__ = () => {
            this.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({
                  jsonrpc: "2.0",
                  id: request.id,
                  result: { stopReason: "end_turn" },
                }),
              }),
            );
          };
          return;
        }
        send.call(this, data);
      };
      const internals = (window as SpeechBoundaryWindow).__TAURI_INTERNALS__;
      const invoke = internals.invoke.bind(internals);
      const speech = { prepared: [] as string[], appended: [] as string[] };
      (window as SpeechBoundaryWindow).__SPEECH_BOUNDARY__ = speech;
      internals.invoke = (cmd, args) => {
        if (cmd === "register_voice_renderer_instance")
          return Promise.resolve(1);
        if (cmd === "prepare_native_voice_assistant_speech") {
          speech.prepared.push(args?.request?.text ?? "");
          return Promise.resolve({ outcome: "admitted", speechId: 7 });
        }
        if (cmd === "start_pocket_voice_stream") return Promise.resolve(true);
        if (cmd === "append_pocket_voice_stream") {
          speech.appended.push(args?.text ?? "");
          return Promise.resolve(null);
        }
        if (
          cmd === "flush_pocket_voice_stream" ||
          cmd === "finish_pocket_voice_stream"
        )
          return Promise.resolve(null);
        return invoke(cmd, args);
      };
    });
    await use(page);
  },
});

test("build sends link labels to native speech and preserves the rendered link", async ({
  voice: page,
}) => {
  await page.goto("/");
  await page.getByText("Voice playback", { exact: true }).click();
  await page.getByTestId("chat-composer").fill("Read the docs");
  await page.getByTestId("chat-composer").press("Enter");
  await page.waitForFunction(
    () =>
      typeof (window as SpeechBoundaryWindow).__FINISH_VOICE_PROMPT__ ===
      "function",
  );

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
        ownerWindowLabel: "main",
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
            text: text.slice(0, text.indexOf(">")),
          },
        },
      });
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      harness.emitAcpNotification({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: {
            type: "text",
            text: text.slice(text.indexOf(">"), text.indexOf("private/path")),
          },
        },
      });
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      harness.emitAcpNotification({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: {
            type: "text",
            text: text.slice(text.indexOf("private/path")),
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

  // A tool flush is not completion. The ambiguous suffix must remain pending.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as SpeechBoundaryWindow).__SPEECH_BOUNDARY__.appended.join(""),
      ),
    )
    .toContain("Use ");
  expect(
    await page.evaluate(() =>
      (window as SpeechBoundaryWindow).__SPEECH_BOUNDARY__.appended.join(""),
    ),
  ).not.toContain("when needed");
  await page.evaluate(() => {
    (window as SpeechBoundaryWindow).__FINISH_VOICE_PROMPT__();
  });

  await expect(
    page.getByRole("link", { name: "the page", exact: true }),
  ).toHaveAttribute("href", "https://example.com/a(b");
  await expect(
    page.getByText("for the next steps.", { exact: false }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as SpeechBoundaryWindow).__SPEECH_BOUNDARY__.appended.join(""),
      ),
    )
    .toBe(
      String.raw`See the page for the next steps. Use \[brackets](not a link) now. Call ` +
        "`callbacks[index](result)` next.\n\n    callbacks[index](result)\n\n1. Read:\n    guide\n\nSee docs now.\n\n> Code:\n>\n>     callbacks[index](result)\n\nSee the manual:\n    manual now.\n\nUse ` when needed, then see help.",
    );
  await expect(
    page.getByRole("link", { name: "docs", exact: true }),
  ).toHaveAttribute("href", "https://example.com/private/path");
  await expect(
    page.getByRole("link", { name: "manual", exact: true }),
  ).toHaveAttribute("href", "https://example.com/manual");
  const prepared = await page.evaluate(
    () => (window as SpeechBoundaryWindow).__SPEECH_BOUNDARY__.prepared,
  );
  expect(prepared.length).toBe(1);
  expect(prepared[0]).toMatch(/^See the page/);
  expect(prepared[0]).not.toContain("https://");
  await expect(
    page.getByText("Use [brackets](not a link) now.", { exact: false }),
  ).toBeVisible();
});
