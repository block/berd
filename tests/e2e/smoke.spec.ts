import { expect, test } from "./fixtures/tauri-mock";

test.describe("Smoke tests", () => {
  test("app loads and shows home screen", async ({ tauriMocked: page }) => {
    await page.goto("/");

    await expect(page.getByText("Welcome to Goose for Block")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("home screen shows onboarding actions", async ({
    tauriMocked: page,
  }) => {
    await page.goto("/");

    await expect(page.getByRole("button", { name: "New project" })).toBeVisible(
      { timeout: 10_000 },
    );
    await expect(
      page.getByRole("button", { name: "Build agent" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Explore skills" }),
    ).toBeVisible();
  });

  test("home screen shows chat controls", async ({ tauriMocked: page }) => {
    await page.goto("/");

    await expect(page.getByText("GPT-4.1")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("No project")).toBeVisible();
    await expect(page.getByText("Jump to session")).toBeVisible();
  });
});
