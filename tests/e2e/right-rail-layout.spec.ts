import { test as base, expect, type Page } from "@playwright/test";

import { buildInitScript } from "./fixtures/tauri-mock";

const SESSION_ID = "right-rail-layout-session";

const test = base.extend<{ seeded: Page }>({
  seeded: async ({ page }, use) => {
    await page.addInitScript({
      content: buildInitScript({
        sessions: [
          {
            sessionId: SESSION_ID,
            title: "Right rail layout",
            messageCount: 1,
          },
        ],
      }),
    });
    await use(page);
  },
});

test.describe("Right rail layout", () => {
  test("keeps the tab header pinned while the active tab body scrolls", async ({
    seeded: page,
  }) => {
    await page.setViewportSize({ width: 1200, height: 500 });
    await page.goto("/");
    await page.getByText("Right rail layout", { exact: true }).click();
    await expect(page.getByLabel("Chat message input")).toBeVisible();

    const railToggle = page.getByRole("button", { name: "Open right rail" });
    if (await railToggle.isVisible()) {
      await railToggle.click();
    }

    const rail = page.locator("[data-right-rail-surface]");
    const tabHeader = rail.getByRole("tablist");
    const activeTabBody = rail.locator('[data-slot="tabs-content"]:visible');
    await expect(activeTabBody).toBeVisible();

    await activeTabBody.evaluate((element) => {
      const overflowProbe = document.createElement("div");
      overflowProbe.dataset.testid = "right-rail-overflow-probe";
      overflowProbe.style.height = "1200px";
      overflowProbe.style.flex = "0 0 auto";
      element.append(overflowProbe);
    });

    const before = await tabHeader.boundingBox();
    expect(before).not.toBeNull();

    const metrics = await activeTabBody.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    await activeTabBody.evaluate((element) => {
      element.scrollTop = 300;
    });
    await expect
      .poll(() => activeTabBody.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);

    const after = await tabHeader.boundingBox();
    expect(after).not.toBeNull();
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(1);
  });
});
