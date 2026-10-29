import { test as base, expect, type Page } from "@playwright/test";

import { buildInitScript } from "./fixtures/tauri-mock";

const test = base.extend<{ settings: Page }>({
  settings: async ({ page }, use) => {
    await page.addInitScript({
      content: buildInitScript({ enabledExperiments: ["voice-conversation"] }),
    });
    await page.addInitScript(() => {
      if (localStorage.getItem("goose:voice-input-backend") === null) {
        localStorage.setItem("goose:voice-input-backend", "openai");
      }
      if (localStorage.getItem("goose:voice-output-backend") === null) {
        localStorage.setItem("goose:voice-output-backend", "openai");
      }
    });
    await use(page);
  },
});

test.use({ screenshot: "off", trace: "off", video: "off" });

async function saveEndpoint(
  page: Page,
  kind: "stt" | "tts",
  label: string,
  url: string,
) {
  const input = page.getByLabel(label);
  await input.fill(url);
  await page
    .getByTestId(`openai-${kind}-endpoint-settings`)
    .getByRole("button", { name: "Save" })
    .click();
  await expect(input).toHaveValue(url);
}

test("keeps STT and TTS URLs independent across settings reloads", async ({
  settings: page,
}) => {
  await page.goto("/");
  await page.locator("[data-sidebar-nav-id=settings]").click();
  await page.locator("[data-sidebar-nav-id=settings-voice]").click();

  const stt = page.getByLabel("Speech-to-text endpoint URL");
  const tts = page.getByLabel("Text-to-speech endpoint URL");
  await expect(stt).toHaveAttribute(
    "placeholder",
    "wss://api.openai.com/v1/realtime?intent=transcription",
  );
  await expect(tts).toHaveAttribute(
    "placeholder",
    "https://api.openai.com/v1/audio/speech",
  );
  await saveEndpoint(
    page,
    "stt",
    "Speech-to-text endpoint URL",
    "ws://127.0.0.1:18870/v1/realtime?intent=transcription",
  );
  await saveEndpoint(
    page,
    "tts",
    "Text-to-speech endpoint URL",
    "http://127.0.0.1:18870/v1/audio/speech",
  );

  await page.goto("/");
  await page.locator("[data-sidebar-nav-id=settings]").click();
  await page.locator("[data-sidebar-nav-id=settings-voice]").click();
  await expect(page.getByLabel("Speech-to-text endpoint URL")).toHaveValue(
    "ws://127.0.0.1:18870/v1/realtime?intent=transcription",
  );
  await expect(page.getByLabel("Text-to-speech endpoint URL")).toHaveValue(
    "http://127.0.0.1:18870/v1/audio/speech",
  );

  await saveEndpoint(page, "stt", "Speech-to-text endpoint URL", "");
  await page.goto("/");
  await page.locator("[data-sidebar-nav-id=settings]").click();
  await page.locator("[data-sidebar-nav-id=settings-voice]").click();
  await expect(page.getByLabel("Speech-to-text endpoint URL")).toHaveValue("");
  await expect(page.getByLabel("Text-to-speech endpoint URL")).toHaveValue(
    "http://127.0.0.1:18870/v1/audio/speech",
  );
});
