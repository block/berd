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
    __NOTIFY_E2E__: {
      shown: Array<{ body?: string; sessionId?: string; sound?: unknown }>;
      focused: boolean;
      blurListeners: number;
    };
    __GOOSE_E2E__: {
      emitTauriEvent: (event: string, payload: unknown) => void;
      holdPrompt: (sessionId: string) => void;
      releasePrompt: (sessionId: string) => void;
    };
  }
}

/**
 * Wraps the mocked Tauri invoke to capture notification commands and answer
 * the window-focus seed query deterministically.
 */
function notificationCaptureScript(options: { initialFocused: boolean }) {
  return `
    (() => {
      window.__NOTIFY_E2E__ = {
        shown: [],
        focused: ${options.initialFocused},
        blurListeners: 0,
      };
      const original = window.__TAURI_INTERNALS__.invoke.bind(
        window.__TAURI_INTERNALS__,
      );
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        if (cmd === "show_completion_notification") {
          window.__NOTIFY_E2E__.shown.push(args ?? {});
          return Promise.resolve(null);
        }
        if (cmd === "should_suppress_completion_notification") {
          return Promise.resolve(false);
        }
        if (cmd === "plugin:window|is_focused") {
          return Promise.resolve(window.__NOTIFY_E2E__.focused);
        }
        if (cmd === "plugin:event|listen" && args?.event === "tauri://blur") {
          window.__NOTIFY_E2E__.blurListeners += 1;
        }
        return original(cmd, args);
      };
    })();
  `;
}

const test = base.extend<{
  notifyPage: Page;
  initialFocused: boolean;
  notificationPrefs: Record<string, unknown> | null;
}>({
  initialFocused: [true, { option: true }],
  notificationPrefs: [null, { option: true }],
  notifyPage: async ({ page, initialFocused, notificationPrefs }, use) => {
    await page.addInitScript({
      content: buildInitScript({
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
    await page.addInitScript({
      content: notificationCaptureScript({ initialFocused }),
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
    .poll(() => page.evaluate(() => window.__NOTIFY_E2E__.blurListeners))
    .toBeGreaterThan(0);
}

async function sendPromptFromHome(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: "Start a conversation" });
  await input.fill(text);
  await input.press("Enter");
}

function shownNotifications(page: Page) {
  return page.evaluate(() => window.__NOTIFY_E2E__.shown);
}

test.describe("completion notification delivery (simulated Tauri)", () => {
  test.describe("window starts backgrounded (seeded focus state)", () => {
    test.use({ initialFocused: false });

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
      window.__GOOSE_E2E__.emitTauriEvent("tauri://blur", null);
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
    await sendPromptFromHome(page, "watching this one");

    // Give delivery routing time to (incorrectly) fire if it were going to.
    await page.waitForTimeout(1500);
    await expect(page.getByText(/finished$/)).toHaveCount(0);
    expect(await shownNotifications(page)).toHaveLength(0);
  });

  test.describe("notifications disabled", () => {
    test.use({
      initialFocused: false,
      notificationPrefs: { enabled: false },
    });

    test("delivers nothing even for a background completion", async ({
      notifyPage: page,
    }) => {
      await page.goto("/");
      await waitForHome(page);
      await sendPromptFromHome(page, "disabled background");

      await page.waitForTimeout(1500);
      expect(await shownNotifications(page)).toHaveLength(0);
      await expect(page.getByText(/finished$/)).toHaveCount(0);
    });
  });
});
