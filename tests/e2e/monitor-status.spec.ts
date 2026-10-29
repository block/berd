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
        {
          sessionId: "session-1",
          stateKey: "watch",
          label: "Build watcher",
          instanceId: "build-instance",
          command: ["cargo", "test", "--workspace"],
          startedAt: 1793286000000,
          stopping: false,
        },
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
    "Watching:",
  );
  await page.locator("[data-monitor-status=sidebar]").hover();
  await expect(
    page.getByRole("tooltip").filter({ hasText: "Build watcher" }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Inspect 1 running monitor" }).click();
  await expect(
    page.getByRole("dialog", { name: "Running monitors" }),
  ).toBeVisible();
  await expect(page.getByText('"cargo" "test" "--workspace"')).toBeVisible();
  if (process.env.CAPTURE_MONITOR_STATUS) {
    await page
      .getByRole("dialog", { name: "Running monitors" })
      .evaluate((element) =>
        Promise.all(
          element.getAnimations().map((animation) => animation.finished),
        ),
      );
    await page.screenshot({ path: "/tmp/monitor-inspector.png" });
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
    "Watching:",
  );
  await page.getByRole("button", { name: "Monitor two", exact: true }).click();
  await expect(page.locator("[data-monitor-status=composer]")).toContainText(
    "Watching:",
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

test("inspects and stops one monitor with confirmation, failure recovery and instance isolation", async ({
  page,
}) => {
  await page.addInitScript(
    buildInitScript({
      sessions: [
        {
          sessionId: "session-inspect",
          title: "Build and review",
          workingDir: "/tmp",
          messageCount: 1,
          replayText: "Watch build checks and review feedback.",
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
    page.getByRole("button", { name: "Build and review", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page.evaluate(() => {
    const state = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (
          command: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
      stopCalls: unknown[];
      failScans: boolean;
      failedScans: number;
    };
    const original = state.__TAURI_INTERNALS__.invoke.bind(
      state.__TAURI_INTERNALS__,
    );
    let failFirst = true;
    let monitors = [
      {
        sessionId: "session-inspect",
        stateKey: "build",
        instanceId: "build-instance",
        label: "Build checks",
        command: ["cargo", "test"],
        startedAt: 1793286000000,
        stopping: false,
      },
      {
        sessionId: "session-inspect",
        stateKey: "review",
        instanceId: "review-instance",
        label: "Review feedback",
        command: ["review", "--watch"],
        startedAt: 1793286000000,
        stopping: false,
      },
    ];
    state.stopCalls = [];
    state.failScans = false;
    state.failedScans = 0;
    state.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "get_running_monitors") {
        if (state.failScans) {
          state.failedScans++;
          return Promise.reject(new Error("scan failed"));
        }
        return Promise.resolve(monitors.map((m) => ({ ...m })));
      }
      if (command === "stop_running_monitor") {
        state.stopCalls.push(args);
        if (failFirst) {
          failFirst = false;
          return Promise.reject(new Error("request failed"));
        }
        const matched = monitors.find(
          (m) =>
            m.instanceId === args?.instanceId &&
            m.sessionId === args?.sessionId &&
            m.stateKey === args?.stateKey,
        );
        if (!matched) return Promise.reject(new Error("wrong instance"));
        monitors = monitors.filter((m) => m !== matched);
        return Promise.resolve();
      }
      return original(command, args);
    };
  });
  await page
    .getByRole("button", { name: "Build and review", exact: true })
    .click();
  const trigger = page.getByRole("button", {
    name: "Inspect 2 running monitors",
  });
  await expect(trigger).toContainText("Watching: Build checks");
  await expect(trigger).toContainText("+1");
  await page.evaluate(() => {
    (window as unknown as { failScans: boolean }).failScans = true;
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { failedScans: number }).failedScans,
      ),
    )
    .toBeGreaterThan(0);
  await expect(trigger).toBeVisible();
  await expect(page.locator("[data-monitor-status=sidebar]")).toBeVisible();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Running monitors" });
  const build = dialog.getByRole("region", { name: "Build checks" });
  await expect(build.getByText('"cargo" "test"')).toBeVisible();
  await build.getByRole("button", { name: "Stop", exact: true }).click();
  await build.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { stopCalls: unknown[] }).stopCalls,
    ),
  ).toEqual([]);
  await build.getByRole("button", { name: "Stop", exact: true }).click();
  await build
    .getByRole("button", { name: "Stop monitor", exact: true })
    .click();
  await expect(build.getByRole("alert")).toContainText("Could not stop");
  await page.evaluate(() => {
    (window as unknown as { failScans: boolean }).failScans = false;
  });
  await build
    .getByRole("button", { name: "Stop monitor", exact: true })
    .click();
  await expect(
    dialog.getByRole("region", { name: "Build checks" }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("region", { name: "Review feedback" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { stopCalls: unknown[] }).stopCalls,
    ),
  ).toEqual([
    {
      sessionId: "session-inspect",
      stateKey: "build",
      instanceId: "build-instance",
    },
    {
      sessionId: "session-inspect",
      stateKey: "build",
      instanceId: "build-instance",
    },
  ]);
  await expect(
    page.getByRole("button", { name: "Inspect 1 running monitor" }),
  ).toContainText("Watching: Review feedback");
});
