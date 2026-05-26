import {
  test,
  expect,
  navigateToAgents,
  buildInitScript,
} from "./fixtures/tauri-mock";
import type { Page } from "@playwright/test";

async function listAgentSources(page: Page) {
  return page.evaluate(() => {
    const e2eWindow = window as typeof window & {
      __GOOSE_E2E__?: {
        listAgentSources: () => Array<{
          name: string;
          path: string;
          content: string;
          properties?: Record<string, unknown>;
        }>;
      };
    };
    return e2eWindow.__GOOSE_E2E__?.listAgentSources() ?? [];
  });
}

test.describe("Agents view", () => {
  test("navigates to agents view from sidebar", async ({
    tauriMocked: page,
  }) => {
    await navigateToAgents(page);

    await expect(page.getByLabel("Agent: Code Reviewer")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New Agent", exact: true }),
    ).toBeVisible();
  });

  test("displays agent cards from mock data", async ({ tauriMocked: page }) => {
    await navigateToAgents(page);

    await expect(page.getByLabel("Agent: Solo")).toBeVisible();
    await expect(page.getByLabel("Agent: Scout")).toBeVisible();
    await expect(page.getByLabel("Agent: Code Reviewer")).toBeVisible();
  });

  test("does not show source badges on agent cards", async ({
    tauriMocked: page,
  }) => {
    await navigateToAgents(page);

    const soloCard = page.getByLabel("Agent: Solo");
    await expect(soloCard.getByText("Built-in")).not.toBeVisible();

    const reviewerCard = page.getByLabel("Agent: Code Reviewer");
    await expect(reviewerCard.getByText("Built-in")).not.toBeVisible();
  });

  test("shows create new agent button", async ({ tauriMocked: page }) => {
    await navigateToAgents(page);
    await expect(
      page.getByRole("button", { name: "New Agent", exact: true }),
    ).toBeVisible();
  });

  test("opens agent builder via New Agent button", async ({
    tauriMocked: page,
  }) => {
    await navigateToAgents(page);
    await page
      .getByRole("button", { name: "New Agent", exact: true })
      .first()
      .click();

    await expect(page.getByTestId("agent-builder-rail")).toBeVisible();
    await expect(page.getByTestId("chat-composer")).toBeVisible();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("opens agent builder via top-bar action", async ({
    tauriMocked: page,
  }) => {
    await navigateToAgents(page);
    await page
      .getByRole("button", { name: "New Agent", exact: true })
      .first()
      .click();
    await expect(page.getByTestId("agent-builder-rail")).toBeVisible();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("agent builder chat and rail edits update the draft source", async ({
    tauriMocked: page,
  }) => {
    await navigateToAgents(page);
    await page
      .getByRole("button", { name: "New Agent", exact: true })
      .first()
      .click();

    await expect(page.getByTestId("agent-builder-rail")).toBeVisible();
    await page
      .getByTestId("chat-composer")
      .fill("make me a snarky code reviewer");
    await page.getByTestId("chat-composer").press("Enter");
    await expect(page.getByLabel("Name")).toHaveValue("Snarky Code Reviewer", {
      timeout: 5000,
    });

    await page.getByLabel("Name").fill("Code Reviewer Pro");
    await expect
      .poll(async () => listAgentSources(page))
      .toContainEqual(
        expect.objectContaining({
          name: "Code Reviewer Pro",
          properties: expect.objectContaining({ draft: true }),
        }),
      );
  });

  test("discard removes an unchanged draft source", async ({
    tauriMocked: page,
  }) => {
    await navigateToAgents(page);
    await page
      .getByRole("button", { name: "New Agent", exact: true })
      .first()
      .click();

    await expect(page.getByTestId("agent-builder-rail")).toBeVisible();
    await page.getByRole("button", { name: "Discard" }).click();
    await expect
      .poll(async () => listAgentSources(page))
      .not.toContainEqual(
        expect.objectContaining({
          properties: expect.objectContaining({ draft: true }),
        }),
      );
  });

  test("clicking a custom agent card opens details with edit actions", async ({
    tauriMocked: page,
  }) => {
    await navigateToAgents(page);
    await page.getByLabel("Agent: Code Reviewer").click();

    await expect(
      page.getByRole("button", { name: "Back to agents" }),
    ).toBeVisible();
    await expect(
      page.locator("h1", { hasText: "Code Reviewer" }),
    ).toBeVisible();
    await expect(page.getByText(/^Source$/)).toBeVisible();
    await expect(page.getByText("File-backed")).toBeVisible();
    await expect(page.getByText(/^Provider$/)).toBeVisible();
    await expect(page.getByText("claude-sonnet-4-20250514")).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
  });

  test("built-in agent opens read-only details with Duplicate button", async ({
    tauriMocked: page,
  }) => {
    await navigateToAgents(page);
    await page.getByLabel("Agent: Solo").click();

    await expect(
      page.getByRole("button", { name: "Back to agents" }),
    ).toBeVisible();
    await expect(page.locator("h1", { hasText: "Solo" })).toBeVisible();
    await expect(page.getByText(/^Source$/)).toBeVisible();
    await expect(page.getByText("Built-in")).toBeVisible();
    await expect(page.getByRole("button", { name: /Duplicate/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit" })).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create" }),
    ).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save Changes" }),
    ).not.toBeVisible();
  });

  test("custom agent card dropdown menu shows correct items", async ({
    tauriMocked: page,
  }) => {
    await navigateToAgents(page);

    const card = page.getByLabel("Agent: Code Reviewer");
    await card.getByLabel("Agent options").click();

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Edit" })).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Duplicate" }),
    ).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Export" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  });

  test("Edit on a custom agent opens the builder rail bound to that agent", async ({
    tauriMocked: page,
  }) => {
    await navigateToAgents(page);

    const card = page.getByLabel("Agent: Code Reviewer");
    await card.getByLabel("Agent options").click();
    await page.getByRole("menuitem", { name: "Edit" }).click();

    await expect(page.getByTestId("agent-builder-rail")).toBeVisible();
    await expect(page.getByLabel("Name")).toHaveValue("Code Reviewer");
    await page.getByLabel("Name").fill("Code Reviewer Pro");
    await expect
      .poll(async () => listAgentSources(page))
      .toContainEqual(expect.objectContaining({ name: "Code Reviewer Pro" }));
  });

  test("reloading with real draft content keeps the draft source", async ({
    tauriMocked: page,
  }) => {
    await navigateToAgents(page);
    await page
      .getByRole("button", { name: "New Agent", exact: true })
      .first()
      .click();
    await expect(page.getByTestId("agent-builder-rail")).toBeVisible();

    await page.getByLabel("Name").fill("Persisted");
    await expect
      .poll(async () => listAgentSources(page))
      .toContainEqual(expect.objectContaining({ name: "Persisted" }));

    await page.reload();
    await expect
      .poll(async () => listAgentSources(page))
      .toContainEqual(
        expect.objectContaining({
          name: "Persisted",
          properties: expect.objectContaining({ draft: true }),
        }),
      );
  });

  test("built-in agent dropdown menu does not show Edit or Delete", async ({
    tauriMocked: page,
  }) => {
    await navigateToAgents(page);

    const card = page.getByLabel("Agent: Solo");
    await card.getByLabel("Agent options").click();

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Edit" }),
    ).not.toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Duplicate" }),
    ).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Export" })).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "Delete" }),
    ).not.toBeVisible();
  });

  test("Delete triggers confirmation dialog", async ({ tauriMocked: page }) => {
    await navigateToAgents(page);

    const card = page.getByLabel("Agent: Code Reviewer");
    await card.getByLabel("Agent options").click();
    await page.getByRole("menuitem", { name: "Delete" }).click();

    await expect(
      page.getByText('Delete "Code Reviewer" permanently?'),
    ).toBeVisible();
    await expect(
      page.getByText(
        "This agent and its configuration will be permanently removed.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
  });

  test("Cancel in delete confirmation closes dialog", async ({
    tauriMocked: page,
  }) => {
    await navigateToAgents(page);

    const card = page.getByLabel("Agent: Code Reviewer");
    await card.getByLabel("Agent options").click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(
      page.getByText('Delete "Code Reviewer" permanently?'),
    ).toBeVisible();

    const confirmDialog = page.locator(".max-w-sm", {
      has: page.getByText('Delete "Code Reviewer" permanently?'),
    });
    await confirmDialog.getByRole("button", { name: "Cancel" }).click();

    await expect(
      page.getByText('Delete "Code Reviewer" permanently?'),
    ).not.toBeVisible();
    await expect(page.getByLabel("Agent: Code Reviewer")).toBeVisible();
  });

  test("empty agent state shows only create button", async ({
    tauriMocked: page,
  }) => {
    await page.addInitScript({
      content: buildInitScript({ personas: [], skills: [] }),
    });
    await navigateToAgents(page);

    await expect(
      page.getByRole("button", { name: "New Agent", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel(/^Agent: /)).not.toBeVisible();
  });
});
