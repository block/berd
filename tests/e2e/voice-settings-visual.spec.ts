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

test("Siri picker uses catalog labels and alphabetical order", async ({
  page,
}) => {
  await page.addInitScript({
    content: buildInitScript({
      enabledExperiments: ["voice-conversation"],
      siriVoiceStatus: {
        supported: true,
        availableLanguages: ["en-US"],
        selectedVoice: { name: "en-US-F", language: "en-US" },
        selectedVoiceInstalled: true,
        playbackSpeed: 1,
        voices: [
          {
            name: "en-US-F",
            displayName: "Zack",
            language: "en-US",
            sizeBytes: 1,
            installed: true,
          },
          {
            name: "en-US-G",
            displayName: "Evan",
            language: "en-US",
            sizeBytes: 1,
            installed: false,
          },
        ],
      },
    }),
  });
  await page.addInitScript(() => {
    localStorage.setItem("goose:voice-conversation-mode", "chained");
    localStorage.setItem("goose:voice-input-backend", "macos");
    localStorage.setItem("goose:voice-output-backend", "siri");
  });
  await openVoiceSettings(page);
  await page.getByRole("button", { name: "Choose a voice: Zack" }).click();
  await expect(
    page.getByRole("button", { name: "Download Evan" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Preview Zack" }),
  ).toBeVisible();
  const rows = page.locator('[data-testid^="siri-voice-"]');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute(
    "data-testid",
    "siri-voice-en-us-g|en-us",
  );
  await expect(rows.nth(1)).toHaveAttribute(
    "data-testid",
    "siri-voice-en-us-f|en-us",
  );
  await expect(page.getByText("en-US-F", { exact: true })).toHaveCount(0);
  await expect(page.getByText("en-US-G", { exact: true })).toHaveCount(0);
});

test("captures consistent voice controls for each backend", async ({
  settings: page,
}, testInfo) => {
  await page.addInitScript(() => {
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
  await testInfo.attach("voice-settings-apple", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });

  const outputBackend = page.getByRole("combobox", {
    name: "Text to speech (TTS)",
  });
  await outputBackend.click();
  await page.getByRole("option", { name: "Pocket TTS Local" }).click();
  await expect(
    page.getByRole("button", { name: /^Choose a voice:/ }),
  ).toBeVisible();
  await testInfo.attach("voice-settings-pocket", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });

  await outputBackend.click();
  await page.getByRole("option", { name: "OpenAI TTS Cloud" }).click();
  await expect(
    page.getByRole("button", { name: "Choose a voice: Marin (default)" }),
  ).toBeVisible();
  await testInfo.attach("voice-settings-openai-tts", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
});
