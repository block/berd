import { test as base, expect, type Page } from "@playwright/test";

import { buildInitScript } from "./fixtures/tauri-mock";

const SEED_SESSIONS = [
  {
    sessionId: "session-auth",
    title: "Refactor auth flow",
    messageCount: 8,
    updatedAt: "2026-06-16T18:00:00.000Z",
  },
  {
    sessionId: "session-ci",
    title: "Triage flaky CI",
    messageCount: 4,
    updatedAt: "2026-06-16T15:00:00.000Z",
  },
  {
    sessionId: "session-docs",
    title: "Write release notes",
    messageCount: 2,
    updatedAt: "2026-06-15T09:00:00.000Z",
  },
];

const test = base.extend<{ seeded: Page }>({
  seeded: async ({ page }, use) => {
    await page.addInitScript({
      content: buildInitScript({ sessions: SEED_SESSIONS }),
    });
    await use(page);
  },
});

function sessionHistoryCard(page: Page, title: string) {
  return page
    .getByTestId("session-history-scroll")
    .locator("[data-session-card]")
    .filter({ hasText: title });
}

async function openSessionHistory(page: Page) {
  await page.goto("/");
  const historyNav = page.getByRole("button", { name: "Session history" });
  await expect(historyNav).toBeVisible({ timeout: 10_000 });
  await historyNav.click();
  await expect(sessionHistoryCard(page, "Refactor auth flow")).toBeVisible({
    timeout: 10_000,
  });
}

test("fork a session from the history card menu", async ({ seeded: page }) => {
  await openSessionHistory(page);

  // The meatball only appears on hover; hover the card, then open the menu.
  const card = sessionHistoryCard(page, "Refactor auth flow");
  await card.hover();
  await page
    .getByRole("button", { name: "Options for Refactor auth flow" })
    .click();

  const duplicateItem = page.getByRole("menuitem", { name: "Duplicate" });
  await expect(duplicateItem).toBeVisible();

  await duplicateItem.click();

  // Success toast confirms the fork.
  await expect(page.getByText("Duplicated Refactor auth flow")).toBeVisible({
    timeout: 10_000,
  });

  // The fork is now selected; the copy appears in the sidebar recents.
  const sidebar = page.getByRole("navigation", { name: "Main navigation" });
  const copiedChat = sidebar
    .locator("[data-sidebar-chat-row]")
    .filter({ hasText: "Refactor auth flow (copy)" });
  await expect(copiedChat).toBeVisible({ timeout: 10_000 });
});
