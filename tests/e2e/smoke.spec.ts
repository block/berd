import { expect, test } from "./fixtures/tauri-mock";

test.describe("Smoke tests", () => {
  test("app loads and shows the provider setup home screen", async ({
    tauriMocked: page,
  }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", {
        name: "Choose an AI provider to start chatting",
      }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("home screen shows provider setup action", async ({
    tauriMocked: page,
  }) => {
    await page.goto("/");

    await expect(
      page.getByRole("button", { name: "Open AI providers" }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("home screen shows chat controls", async ({ tauriMocked: page }) => {
    await page.goto("/");

    await expect(page.getByText("GPT-4.1")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("No project")).toBeVisible();
    await expect(page.getByText("Jump to session")).toBeVisible();
  });
});
