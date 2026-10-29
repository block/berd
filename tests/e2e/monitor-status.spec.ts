import { expect, test, buildInitScript } from "./fixtures/tauri-mock";

test("shows monitor status in production UI", async ({ page }) => {
  await page.addInitScript(
    buildInitScript({
      sessions: [
        {
          sessionId: "session-1",
          title: "Monitor chat",
          workingDir: "/tmp",
          messageCount: 1,
          replayText: "Watch the build and review feedback.",
          lastMessageAt: "2026-10-29T12:00:00Z",
          updatedAt: new Date().toISOString(),
        },
      ],
      runningMonitors: [
        { sessionId: "session-1", stateKey: "watch", label: "Build watcher" },
      ],
    }),
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem("goose:sidebar:group-chats-by-project", "false"),
  );
  await page.reload();
  await expect(page.locator("[data-monitor-status=sidebar]")).toBeVisible({
    timeout: 10000,
  });
  await page.getByRole("button", { name: "Monitor chat", exact: true }).click();
  await expect(page.locator("[data-monitor-status=composer]")).toContainText(
    "1 monitor running",
  );
  await page.locator("[data-monitor-status=sidebar]").hover();
  await expect(
    page.getByRole("tooltip").filter({ hasText: "Build watcher" }).first(),
  ).toBeVisible();
  if (process.env.CAPTURE_MONITOR_STATUS) {
    await page.screenshot({ path: "/tmp/monitor-status.png" });
  }
});

test("updates monitor status as mocked IPC state changes across sessions", async ({
  page,
}) => {
  await page.addInitScript(
    buildInitScript({
      sessions: [
        {
          sessionId: "session-1",
          title: "Monitor one",
          workingDir: "/tmp",
          messageCount: 1,
          replayText: "Watch the build and review feedback.",
          lastMessageAt: "2026-10-29T12:00:00Z",
          updatedAt: new Date().toISOString(),
        },
        {
          sessionId: "session-2",
          title: "Monitor two",
          workingDir: "/tmp",
          messageCount: 1,
          replayText: "Watch the build and review feedback.",
          lastMessageAt: "2026-10-29T12:00:00Z",
          updatedAt: new Date().toISOString(),
        },
      ],
      runningMonitors: [],
    }),
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem("goose:sidebar:group-chats-by-project", "false"),
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Monitor one", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page.evaluate(() => {
    const tauri = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args?: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const originalInvoke = tauri.invoke.bind(tauri);
    let monitors: Array<{
      sessionId: string;
      stateKey: string;
      label: string;
    }> = [];
    tauri.invoke = (cmd, args) =>
      cmd === "get_running_monitors"
        ? Promise.resolve(monitors.map((monitor) => ({ ...monitor })))
        : originalInvoke(cmd, args);
    (
      window as unknown as {
        __setRunningMonitors: (next: typeof monitors) => void;
      }
    ).__setRunningMonitors = (next) => {
      monitors = next;
    };
  });
  await expect(page.locator("[data-monitor-status=sidebar]")).toHaveCount(0);

  await page.evaluate(() =>
    (
      window as unknown as {
        __setRunningMonitors: (monitors: unknown[]) => void;
      }
    ).__setRunningMonitors([
      { sessionId: "session-1", stateKey: "build", label: "Build watcher" },
      { sessionId: "session-2", stateKey: "test", label: "Test watcher" },
    ]),
  );
  await expect(page.locator("[data-monitor-status=sidebar]")).toHaveCount(2, {
    timeout: 5000,
  });
  await page.getByRole("button", { name: "Monitor one", exact: true }).click();
  await expect(page.locator("[data-monitor-status=composer]")).toContainText(
    "1 monitor running",
  );
  await page.getByRole("button", { name: "Monitor two", exact: true }).click();
  await expect(page.locator("[data-monitor-status=composer]")).toContainText(
    "1 monitor running",
  );
  await page
    .getByRole("button", { name: "Monitor two", exact: true })
    .locator("[data-monitor-status=sidebar]")
    .hover();
  await expect(
    page.getByRole("tooltip").filter({ hasText: "Test watcher" }).first(),
  ).toBeVisible();

  await page.evaluate(() =>
    (
      window as unknown as {
        __setRunningMonitors: (monitors: unknown[]) => void;
      }
    ).__setRunningMonitors([]),
  );
  await expect(page.locator("[data-monitor-status=sidebar]")).toHaveCount(0, {
    timeout: 5000,
  });
  await expect(page.locator("[data-monitor-status=composer]")).toHaveCount(0);
});
