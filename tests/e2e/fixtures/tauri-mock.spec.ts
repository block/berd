import { test, expect } from "@playwright/test";
import { buildInitScript } from "./tauri-mock";

test("shared mock preserves held ACP completion, focus and voice controls", async ({
  page,
}) => {
  await page.addInitScript({
    content: buildInitScript({ holdAcpPrompts: true }),
  });
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const harness = window.__GOOSE_E2E__ as typeof window.__GOOSE_E2E__ & {
      acpRequests: () => Array<{ id: number; method: string }>;
      completeAcpPrompts: () => void;
      pocketVoiceStreamIds: () => number[];
      pocketVoiceSpokenTexts: () => string[];
    };
    const internals = window.__TAURI_INTERNALS__ as {
      invoke: (command: string, args?: unknown) => Promise<unknown>;
    };
    const socket = new WebSocket("ws://mock-goose");
    await new Promise<void>((resolve) => {
      socket.addEventListener("open", () => resolve(), { once: true });
    });
    const delivered: unknown[] = [];
    socket.addEventListener("message", (event) => {
      delivered.push(JSON.parse(String(event.data)));
    });
    const initialCompletions = harness.completedPromptSessionIds().length;
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 98765,
        method: "session/prompt",
        params: { sessionId: "fixture-held-session", prompt: [] },
      }),
    );
    const requestObserved = harness
      .acpRequests()
      .some((request) => request.id === 98765);
    const beforeRelease = {
      delivered: delivered.length,
      completions: harness.completedPromptSessionIds().length,
    };
    harness.completeAcpPrompts();
    const afterRelease = [...harness.completedPromptSessionIds()];
    harness.completeAcpPrompts();
    const afterSecondRelease = [...harness.completedPromptSessionIds()];
    const initiallyFocused = await internals.invoke("plugin:window|is_focused");
    harness.setWindowFocused(false);
    const finallyFocused = await internals.invoke("plugin:window|is_focused");
    await internals.invoke("start_pocket_voice_stream", { streamId: 345 });
    await internals.invoke("append_pocket_voice_stream", {
      streamId: 345,
      text: "Retained voice stream",
    });
    await internals.invoke("finish_pocket_voice_stream", { streamId: 345 });
    socket.close();
    return {
      requestObserved,
      initialCompletions,
      beforeRelease,
      delivered,
      afterRelease,
      afterSecondRelease,
      initiallyFocused,
      finallyFocused,
      streamIds: harness.pocketVoiceStreamIds(),
      spokenTexts: harness.pocketVoiceSpokenTexts(),
    };
  });

  expect(result.requestObserved).toBe(true);
  expect(result.beforeRelease).toEqual({
    delivered: 0,
    completions: result.initialCompletions,
  });
  expect(result.delivered).toContainEqual({
    jsonrpc: "2.0",
    id: 98765,
    result: { stopReason: "end_turn" },
  });
  expect(result.afterRelease).toHaveLength(result.initialCompletions + 1);
  expect(result.afterRelease.at(-1)).toBe("fixture-held-session");
  expect(result.afterSecondRelease).toEqual(result.afterRelease);
  expect(result.initiallyFocused).toBe(true);
  expect(result.finallyFocused).toBe(false);
  expect(result.streamIds).toContain(345);
  expect(result.spokenTexts).toContain("Retained voice stream");
});
