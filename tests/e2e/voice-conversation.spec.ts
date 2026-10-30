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
    sessionId?: string;
    modeId?: string;
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

for (const scenario of ["complete", "stalled", "mode-rejected"] as const) {
  base.describe(`isolated early voice (${scenario})`, () => {
    base.beforeEach(async ({ page }) => {
      await page.addInitScript({
        content: buildInitScript({
          holdAcpPrompts: true,
          privateVoiceDraftScenario: scenario,
          sessions: [
            {
              sessionId: SESSION_ID,
              title: "Early voice",
              messageCount: 1,
              providerId: "openai",
              modelId: "gpt-4.1",
              workingDir: "/workspace",
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
    });

    if (scenario === "complete")
      base(
        "early delivery toggle persists and gates only private preparation",
        async ({ page }) => {
          const openSettings = async () => {
            await page.locator("[data-sidebar-nav-id=settings]").click();
            await page.locator("[data-sidebar-nav-id=settings-voice]").click();
          };
          const openChat = async () => {
            await page
              .getByTestId("sidebar-primary-nav-panel")
              .getByRole("button", { name: "Back", exact: true })
              .click();
            await page
              .getByRole("button", { name: "Early voice", exact: true })
              .click();
            await expect(page.getByRole("textbox").first()).toBeVisible();
          };
          const toggle = page.getByRole("switch", {
            name: "Early delivery (experimental)",
            exact: true,
          });
          const allRequests = () =>
            page.evaluate(() =>
              (
                window as typeof window & { __GOOSE_E2E__: VoiceHarness }
              ).__GOOSE_E2E__.acpRequests(),
            );
          const hiddenSessions = async () =>
            (await allRequests()).filter(
              (r) =>
                r.method === "session/new" && r.params?._meta?.hidden === true,
            );

          await openSettings();
          await expect(toggle).toBeChecked();
          await toggle.uncheck();
          await expect(toggle).not.toBeChecked();
          await openChat();
          await page.goto("/");
          await page.reload();
          await openSettings();
          await expect(toggle).not.toBeChecked();
          await openChat();
          await nativeEvent(page, {
            type: "startup",
            ownerWindowLabel: "main",
            line: "Ready",
          });
          await nativeEvent(page, { type: "interimUser", ...utterance });
          // Drain renderer work before asserting that the disabled interim was ignored.
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              ),
          );
          expect(await hiddenSessions()).toHaveLength(0);
          expect(await requests(page)).toHaveLength(0);
          await nativeEvent(page, {
            type: "user",
            ...utterance,
            deliveryAttempts: 0,
          });
          await expect.poll(() => requests(page)).toHaveLength(1);
          const final = (await requests(page))[0];
          expect(final.method).toBe("session/prompt");
          expect(final.params?.sessionId).toBe(SESSION_ID);
          expect(final.params?.prompt).toContainEqual({
            type: "text",
            text: utterance.text,
          });
          expect(await hiddenSessions()).toHaveLength(0);
          await expect(
            page.getByText(utterance.text, { exact: true }),
          ).toHaveCount(1);
          await completePrompts(page);

          await openSettings();
          await toggle.check();
          await expect(toggle).toBeChecked();
          await openChat();
          await nativeEvent(page, {
            type: "interimUser",
            ...utterance,
            id: "utterance-reenabled",
          });
          await expect.poll(hiddenSessions).toHaveLength(1);
          await expect
            .poll(async () =>
              (await allRequests()).filter(
                (r) => r.method === "session/set_mode",
              ),
            )
            .toHaveLength(1);
          const mode = (await allRequests()).find(
            (r) => r.method === "session/set_mode",
          );
          expect(mode?.params?.sessionId).not.toBe(SESSION_ID);
          expect(mode?.params?.modeId).toBe("chat");
          const creationWire = await allRequests();
          expect(
            creationWire.filter((r) => r.method === "session/fork"),
          ).toHaveLength(0);
          const created = creationWire.filter(
            (r) =>
              r.method === "session/new" && r.params?._meta?.hidden === true,
          );
          expect(created).toHaveLength(1);
          expect(created[0].params?.cwd).toBe("/workspace");
          expect(created[0].params?._meta).toMatchObject({
            hidden: true,
            provider: "openai",
          });
          expect(creationWire).toContainEqual(
            expect.objectContaining({
              method: "session/set_config_option",
              params: expect.objectContaining({
                sessionId: mode?.params?.sessionId,
                configId: "model",
                value: "gpt-4.1",
              }),
            }),
          );

          await expect
            .poll(async () =>
              (await requests(page)).filter(
                (r) => r.params?.sessionId === mode?.params?.sessionId,
              ),
            )
            .toHaveLength(1);
          expect(
            (await requests(page)).filter(
              (r) => r.params?.sessionId === SESSION_ID,
            ),
          ).toHaveLength(1);
          await nativeEvent(page, {
            type: "recognitionPending",
            pending: false,
          });
        },
      );

    for (const busy of [false, true])
      base(
        `final has sole tool authority, bounded delivery and later utterance (busy: ${busy})`,
        async ({ page }) => {
          if (busy)
            await assistantOutput(
              page,
              "An unrelated running answer.",
              "unrelated-run",
            );
          await nativeEvent(page, {
            type: "activity",
            activity: "user-speaking",
          });
          await nativeEvent(page, { type: "interimUser", ...utterance });
          const allRequests = () =>
            page.evaluate(() =>
              (
                window as typeof window & { __GOOSE_E2E__: VoiceHarness }
              ).__GOOSE_E2E__.acpRequests(),
            );
          await expect
            .poll(async () =>
              (await allRequests()).filter(
                (r) => r.method === "session/set_mode",
              ),
            )
            .toHaveLength(1);
          const mode = (await allRequests()).find(
            (r) => r.method === "session/set_mode",
          );
          const privateId = mode?.params?.sessionId;
          if (!privateId) throw new Error("Missing hidden private session");
          expect(privateId).not.toBe(SESSION_ID);
          expect(mode?.params?.modeId).toBe("chat");
          const creationWire = await allRequests();
          expect(
            creationWire.filter((r) => r.method === "session/fork"),
          ).toHaveLength(0);
          const created = creationWire.filter(
            (r) =>
              r.method === "session/new" && r.params?._meta?.hidden === true,
          );
          expect(created).toHaveLength(1);
          expect(created[0].params?.cwd).toBe("/workspace");
          expect(created[0].params?._meta).toMatchObject({
            hidden: true,
            provider: "openai",
          });
          expect(creationWire).toContainEqual(
            expect.objectContaining({
              method: "session/set_config_option",
              params: expect.objectContaining({
                sessionId: mode?.params?.sessionId,
                configId: "model",
                value: "gpt-4.1",
              }),
            }),
          );

          if (scenario !== "mode-rejected") {
            await expect.poll(() => requests(page)).toHaveLength(1);
            expect((await requests(page))[0].params?.sessionId).toBe(privateId);
            const wire = await allRequests();
            expect(
              wire.findIndex((r) => r.method === "session/set_mode"),
            ).toBeLessThan(
              wire.findIndex((r) => r.method === "session/prompt"),
            );
          } else expect(await requests(page)).toHaveLength(0);
          await expect(
            page.getByText(utterance.text, { exact: true }),
          ).toHaveCount(0);
          await expect(
            page.getByText("PRIVATE DRAFT:", { exact: false }),
          ).toHaveCount(0);
          const finalText = busy
            ? utterance.text
            : "Set the temperature to -10 degrees.";
          // The private draft has started while speaking. The final arrives
          // before VAD idle, and remains the sole authoritative user turn.
          const started = Date.now();
          await nativeEvent(page, {
            type: "user",
            ...utterance,
            text: finalText,
            deliveryAttempts: 0,
          });
          const mainRequests = async () =>
            (await requests(page)).filter(
              (r) => r.params?.sessionId === SESSION_ID,
            );
          await expect
            .poll(mainRequests, { timeout: 1800, intervals: [20, 50] })
            .toHaveLength(1);
          expect(Date.now() - started).toBeLessThan(1800);
          await nativeEvent(page, {
            type: "activity",
            activity: "user-idle",
          });
          const final = (await mainRequests())[0];
          expect(final.method).toBe(
            busy ? "_goose/unstable/session/steer" : "session/prompt",
          );
          expect(
            final.params?.prompt?.find((b) => b.text === finalText)
              ?.annotations,
          ).toBeUndefined();
          const context =
            final.params?.prompt
              ?.filter((b) => b.annotations?.audience?.includes("assistant"))
              .map((b) => b.text)
              .join("\n") ?? "";
          if (scenario === "complete") {
            expect(context).toContain("PRIVATE DRAFT");
            expect(context).toContain("perform any requested actions normally");
          } else expect(context).not.toContain("PRIVATE DRAFT");
          expect(context).not.toContain("do not repeat");
          await expect(page.getByText(finalText, { exact: true })).toHaveCount(
            1,
          );
          await nativeEvent(page, {
            type: "user",
            ...utterance,
            text: finalText,
            deliveryAttempts: 0,
          });
          expect(await mainRequests()).toHaveLength(1);
          const cancellations = (await allRequests()).filter(
            (r) => r.method === "session/cancel",
          );
          if (scenario !== "mode-rejected")
            expect(cancellations.length).toBeGreaterThan(0);
          expect(
            cancellations.every((r) => r.params?.sessionId === privateId),
          ).toBe(true);
          // Late private output is fenced even after bounded cancellation/cleanup.
          await page.evaluate(
            (sessionId) =>
              (
                window as typeof window & { __GOOSE_E2E__: VoiceHarness }
              ).__GOOSE_E2E__.emitAcpNotification({
                sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "LATE PRIVATE OUTPUT" },
                },
              }),
            privateId,
          );
          await expect(
            page.getByText("LATE PRIVATE OUTPUT", { exact: false }),
          ).toHaveCount(0);
          expect(
            (await spoken(page)).every((text) => !text.includes("PRIVATE")),
          ).toBe(true);
          if (!busy)
            await assistantOutput(
              page,
              "The final action has been performed.",
              "final-run",
            );
          await nativeEvent(page, {
            type: "user",
            ...utterance,
            id: "utterance-2",
            text: "Now report the result.",
            deliveryAttempts: 0,
          });
          await expect.poll(mainRequests).toHaveLength(2);
          expect((await mainRequests())[1].method).toBe(
            "_goose/unstable/session/steer",
          );
          await completePrompts(page);
        },
      );

    base(
      "recognition ending without final permits another private utterance",
      async ({ page }) => {
        await nativeEvent(page, { type: "interimUser", ...utterance });
        const hiddenSessions = () =>
          page.evaluate(() =>
            (
              window as typeof window & { __GOOSE_E2E__: VoiceHarness }
            ).__GOOSE_E2E__
              .acpRequests()
              .filter(
                (r) =>
                  r.method === "session/new" &&
                  r.params?._meta?.hidden === true,
              ),
          );
        await expect.poll(hiddenSessions).toHaveLength(1);
        await nativeEvent(page, { type: "recognitionPending", pending: false });
        await nativeEvent(page, {
          type: "interimUser",
          ...utterance,
          id: "utterance-2",
        });
        await expect.poll(hiddenSessions).toHaveLength(2);
        expect(
          (await requests(page)).every(
            (r) => r.params?.sessionId !== SESSION_ID,
          ),
        ).toBe(true);
      },
    );
  });
}
