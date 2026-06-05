import { expect, test } from "./fixtures/tauri-mock";

test.describe("keyboard pane navigation", () => {
  test("opens pane jump badges and focuses sidebar/main regions", async ({
    tauriMocked: page,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "goose:experimental-features",
        JSON.stringify({
          version: 2,
          experiments: {
            "pane-jump-navigation": {
              enabled: true,
            },
          },
        }),
      );
    });
    await page.goto("/");
    await expect(
      page.getByRole("textbox", { name: "Start a conversation" }),
    ).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press("Control+;");

    await expect(page.getByTestId("pane-jump-overlay")).toBeVisible();
    await expect(page.getByText("s sidebar")).toBeVisible();
    await expect(page.getByText("m main content")).toBeVisible();

    await page.keyboard.press("s");
    await expect
      .poll(() =>
        page.evaluate(() => Boolean(document.activeElement?.closest("nav"))),
      )
      .toBe(true);

    await page.keyboard.press("Control+;");
    await page.keyboard.press("l");
    await expect
      .poll(() =>
        page.evaluate(() => Boolean(document.activeElement?.closest("main"))),
      )
      .toBe(true);
    await expect(page.getByTestId("pane-jump-overlay")).toBeHidden();
  });
});
