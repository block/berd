import { test as base, expect, type Page } from "@playwright/test";

import { buildInitScript } from "./fixtures/tauri-mock";

const test = base.extend<{ settings: Page }>({
  settings: async ({ page }, use) => {
    await page.addInitScript({
      content: buildInitScript({
        enabledExperiments: ["voice-conversation"],
      }),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await use(page);
  },
});

async function openVoiceSettings(page: Page) {
  await page.goto("/");
  await page.locator("[data-sidebar-nav-id=settings]").click();
  await page.locator("[data-sidebar-nav-id=settings-voice]").click();
  await expect(
    page.getByRole("heading", { name: "Voice", exact: true }),
  ).toBeVisible();
}

test("captures consistent voice controls for each backend", async ({
  settings: page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("goose:voice-conversation-mode", "chained");
    localStorage.setItem("goose:voice-input-backend", "macos");
    localStorage.setItem("goose:voice-output-backend", "siri");
  });
  await openVoiceSettings(page);
  await expect(
    page.locator('[role="combobox"]').filter({ hasText: "Apple STT" }),
  ).toBeVisible();
  await expect(
    page.locator('[role="combobox"]').filter({ hasText: "Apple TTS" }),
  ).toBeVisible();
  await page.getByRole("heading", { name: "Voice", exact: true }).hover();
  await page.screenshot({
    path: "/tmp/voice-settings-apple-after.png",
    fullPage: true,
  });

  const outputBackend = page.getByRole("combobox", {
    name: "Text to speech (TTS)",
  });
  await outputBackend.click();
  await page.getByRole("option", { name: "Pocket TTS" }).click();
  await expect(
    page.getByRole("button", { name: /^Choose a voice:/ }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/voice-settings-pocket-after.png",
    fullPage: true,
  });

  await outputBackend.click();
  await page.getByRole("option", { name: "OpenAI TTS" }).click();
  await expect(
    page.getByRole("button", { name: "Choose a voice: Marin (default)" }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/voice-settings-openai-tts-after.png",
    fullPage: true,
  });

  await page.getByText("Expert & Spokesperson", { exact: true }).click();
  await expect(page.getByText("OpenAI API key")).toBeVisible();
  await expect(page.getByText("Realtime model")).toBeHidden();
  await page.getByRole("heading", { name: "Voice", exact: true }).hover();
  await page.screenshot({
    path: "/tmp/voice-settings-es-after.png",
    fullPage: true,
  });
});
