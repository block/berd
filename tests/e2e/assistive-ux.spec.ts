import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/tauri-mock";

const ASSISTIVE_UX_STORAGE_KEY = "goose:assistive-ux";
const CHANGE_SOUND_MOMENT_ID = "notifications.changeSound";

async function waitForAppShell(page: Page) {
  await expect(page.getByTestId("nav-settings")).toBeVisible({
    timeout: 10_000,
  });
}

async function readAssistiveUxState(page: Page) {
  return page.evaluate((storageKey) => {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  }, ASSISTIVE_UX_STORAGE_KEY);
}

test.describe("Assistive UX", () => {
  test("keeps assistive UX state in localStorage across app reloads", async ({
    tauriMocked: page,
  }) => {
    await page.goto("/");
    await waitForAppShell(page);

    await page.evaluate(
      ({ storageKey, momentId }) => {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify({
            version: 1,
            moments: {
              [momentId]: {
                type: "discover",
                shownCount: 2,
                lastShownAt: "2026-06-08T00:00:00.000Z",
              },
            },
          }),
        );
      },
      {
        storageKey: ASSISTIVE_UX_STORAGE_KEY,
        momentId: CHANGE_SOUND_MOMENT_ID,
      },
    );

    await page.reload();
    await waitForAppShell(page);

    await expect
      .poll(async () => {
        const state = await readAssistiveUxState(page);
        return state?.moments?.[CHANGE_SOUND_MOMENT_ID]?.shownCount;
      })
      .toBe(2);
  });

  test("retires notification sound guidance when notification settings change", async ({
    tauriMocked: page,
  }) => {
    await page.goto("/");
    await waitForAppShell(page);

    await page.evaluate((storageKey) => {
      window.localStorage.removeItem(storageKey);
    }, ASSISTIVE_UX_STORAGE_KEY);

    await page.getByTestId("nav-settings").click();
    await expect(
      page.getByRole("navigation", { name: /settings/i }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Notifications" }).click();

    await page.getByRole("switch", { name: "Enable notifications" }).click();

    await expect
      .poll(async () => {
        const state = await readAssistiveUxState(page);
        return state?.moments?.[CHANGE_SOUND_MOMENT_ID]?.retiredReason;
      })
      .toBe("settingsChanged");
  });
});
