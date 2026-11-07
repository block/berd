/**
 * Behavioral coverage for completion-notification delivery routing.
 *
 * These tests run against the browser Tauri IPC mock (tests/e2e/fixtures/
 * tauri-mock.ts): "native delivery" is observed as a captured
 * `show_completion_notification` invoke, NOT as a real OS notification.
 * Verifying the actual native notification surface requires a real Tauri
 * runtime and is out of scope for this suite.
 */
import { test as base, expect, type Page } from "@playwright/test";
import { buildInitScript } from "./fixtures/tauri-mock";

declare global {
  interface Window {
    __GOOSE_E2E__: {
      emitTauriEvent: (event: string, payload: unknown) => void;
      getWindowFocused: () => boolean;
      setWindowFocused: (focused: boolean) => void;
      shownCompletionNotifications: () => Array<{
        body?: string;
        sessionId?: string;
        sound?: unknown;
      }>;
      tauriEventListenerCount: (event: string) => number;
      completedPromptSessionIds: () => string[];
      holdPrompt: (sessionId: string) => void;
      releasePrompt: (sessionId: string) => void;
    };
  }
}

const test = base.extend<{
  notifyPage: Page;
  windowFocused: boolean | undefined;
  notificationPrefs: Record<string, unknown> | null;
}>({
  windowFocused: [undefined, { option: true }],
  notificationPrefs: [null, { option: true }],
  notifyPage: async ({ page, windowFocused, notificationPrefs }, use) => {
    await page.addInitScript({
      content: buildInitScript({
        ...(windowFocused === undefined ? {} : { windowFocused }),
        // The default inventory configures only "claude" while the mocked
        // _goose/defaults/read reports "openai", which trips the
        // provider-setup-required home and disables the composer. Supply a
        // configured openai entry so prompts can actually be sent.
        providerInventory: [
          {
            providerId: "openai",
            providerName: "OpenAI",
            description: "OpenAI provider",
            defaultModel: "gpt-4.1",
            configured: true,
            providerType: "Preferred",
            category: "model",
            configKeys: [],
            setupSteps: [],
            supportsRefresh: true,
            refreshing: false,
            lastUpdatedAt: null,
            lastRefreshAttemptAt: null,
            lastRefreshError: null,
            stale: false,
            modelSelectionHint: null,
            models: [
              {
                id: "gpt-4.1",
                name: "GPT-4.1",
                family: "GPT",
                recommended: true,
              },
            ],
          },
        ],
      }),
    });
    if (notificationPrefs) {
      await page.addInitScript(
        (prefs) =>
          window.localStorage.setItem(
            "goose:notifications",
            JSON.stringify(prefs),
          ),
        notificationPrefs,
      );
    }
    await use(page);
  },
});

async function waitForHome(page: Page) {
  await expect(page.getByText("Jump to session")).toBeVisible({
    timeout: 10_000,
  });
}

/** Wait until the hook's focus listener is registered so a blur event lands. */
async function waitForFocusListener(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__GOOSE_E2E__.tauriEventListenerCount("tauri://blur"),
      ),
    )
    .toBeGreaterThan(0);
}

async function sendPromptFromHome(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: "Start a conversation" });
  await input.fill(text);
  await input.press("Enter");
}

/** Require a delivered end_turn and the renderer leaving its running state. */
async function completePrompt(page: Page, text: string) {
  await page.evaluate(() => window.__GOOSE_E2E__.holdPrompt("*"));
  await sendPromptFromHome(page, text);
  const stop = page.getByRole("button", {
    name: "Stop generation",
    exact: true,
  });
  await expect(stop).toBeVisible();
  await page.evaluate(() => window.__GOOSE_E2E__.releasePrompt("*"));
  await expect
    .poll(
      () =>
        page.evaluate(() => window.__GOOSE_E2E__.completedPromptSessionIds()),
      { message: "mocked turn delivered its end_turn completion" },
    )
    .toHaveLength(1);
  await expect(stop).toHaveCount(0);
}

function shownNotifications(page: Page) {
  return page.evaluate(() =>
    window.__GOOSE_E2E__.shownCompletionNotifications(),
  );
}

function queryMockedWindowFocus(page: Page) {
  return page.evaluate(() =>
    (
      window.__TAURI_INTERNALS__ as {
        invoke: (command: string, args?: unknown) => Promise<boolean>;
      }
    ).invoke("plugin:window|is_focused", { label: "main" }),
  );
}

test.describe("completion notification delivery (simulated Tauri)", () => {
  test("shared Tauri mock reports focused by default", async ({
    notifyPage: page,
  }) => {
    await page.goto("/");

    await expect.poll(() => queryMockedWindowFocus(page)).toBe(true);
    expect(
      await page.evaluate(() => window.__GOOSE_E2E__.getWindowFocused()),
    ).toBe(true);
  });

  test("shared Tauri mock can switch focus to false", async ({
    notifyPage: page,
  }) => {
    await page.goto("/");
    await waitForHome(page);
    await waitForFocusListener(page);

    await page.evaluate(() => window.__GOOSE_E2E__.setWindowFocused(false));

    await expect.poll(() => queryMockedWindowFocus(page)).toBe(false);
    expect(
      await page.evaluate(() => window.__GOOSE_E2E__.getWindowFocused()),
    ).toBe(false);
  });
  test.describe("window starts backgrounded (seeded focus state)", () => {
    test.use({ windowFocused: false });

    test("routes a completion to native delivery exactly once with session metadata", async ({
      notifyPage: page,
    }) => {
      await page.goto("/");
      await waitForHome(page);
      await sendPromptFromHome(page, "finish in background");

      await expect.poll(() => shownNotifications(page)).toHaveLength(1);
      const [shown] = await shownNotifications(page);
      expect(shown.body).toBe("finish in background finished");
      expect(typeof shown.sessionId).toBe("string");
      expect(shown.sessionId?.length).toBeGreaterThan(0);

      // No in-app toast on the native path, and no duplicate native call.
      await page.waitForTimeout(500);
      await expect(page.getByText(/finished$/)).toHaveCount(0);
      expect(await shownNotifications(page)).toHaveLength(1);
    });
  });

  test("blur event before completion routes to native delivery", async ({
    notifyPage: page,
  }) => {
    await page.goto("/");
    await waitForHome(page);
    await waitForFocusListener(page);
    await page.evaluate(() => {
      window.__GOOSE_E2E__.holdPrompt("*");
    });
    await sendPromptFromHome(page, "background me");
    await page.evaluate(() => {
      window.__GOOSE_E2E__.setWindowFocused(false);
      window.__GOOSE_E2E__.releasePrompt("*");
    });

    await expect.poll(() => shownNotifications(page)).toHaveLength(1);
    await expect(page.getByText(/finished$/)).toHaveCount(0);
  });

  test("focused window viewing another surface shows the in-app toast instead", async ({
    notifyPage: page,
  }) => {
    await page.goto("/");
    await waitForHome(page);
    await page.evaluate(() => {
      window.__GOOSE_E2E__.holdPrompt("*");
    });
    await sendPromptFromHome(page, "long running turn");
    // Leave the session view while the turn is still running.
    await page.getByTestId("nav-home").click();
    await waitForHome(page);
    await page.evaluate(() => {
      window.__GOOSE_E2E__.releasePrompt("*");
    });

    await expect(page.getByText("long running turn finished")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "View", exact: true }),
    ).toBeVisible();
    expect(await shownNotifications(page)).toHaveLength(0);
  });

  test("completion in the actively viewed focused session is suppressed on both channels", async ({
    notifyPage: page,
  }) => {
    await page.goto("/");
    await waitForHome(page);
    await completePrompt(page, "watching this one");

    // After proven completion, allow delayed delivery routing to fire if broken.
    await page.waitForTimeout(1500);
    await expect(page.getByText(/finished$/)).toHaveCount(0);
    expect(await shownNotifications(page)).toHaveLength(0);
  });

  test.describe("notifications disabled", () => {
    test.use({
      windowFocused: false,
      notificationPrefs: { enabled: false },
    });

    test("delivers nothing even for a background completion", async ({
      notifyPage: page,
    }) => {
      await page.goto("/");
      await waitForHome(page);
      await completePrompt(page, "disabled background");

      await page.waitForTimeout(1500);
      expect(await shownNotifications(page)).toHaveLength(0);
      await expect(page.getByText(/finished$/)).toHaveCount(0);
    });
  });
});
