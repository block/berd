import { test, expect } from "./fixtures/delegated-worker-goose";

for (const scenario of ["normal", "action-limit", "busy"] as const)
  test(`${scenario}: worker completion wakes its parent exactly once over native ACP`, async ({
    page,
    realGoose,
  }) => {
    realGoose.scenario = scenario;
    test.setTimeout(120000);
    await page.goto("/");
    const input = page.getByRole("textbox", {
      name: /^(Chat message input|Start a conversation)$/,
    });
    await expect(input).toBeVisible({ timeout: 45000 });
    await input.fill(
      "Delegate the worker then finish this turn without waiting.",
    );
    await input.press("Enter");
    const prompts = () =>
      realGoose.frames.filter(
        (frame) =>
          frame.direction === "sent" &&
          frame.message.method === "session/prompt",
      );
    await expect.poll(() => prompts().length, { timeout: 45000 }).toBe(2);
    if (scenario === "action-limit") {
      const pending = realGoose.frames.filter(
        (frame) =>
          frame.direction === "received" &&
          JSON.stringify(frame.message).includes("action_limit_reached"),
      );
      expect(pending.length).toBeGreaterThan(0);
    }
    const first = prompts()[0].message;
    const second = prompts()[1].message;
    expect((second.params as { sessionId: string }).sessionId).toBe(
      (first.params as { sessionId: string }).sessionId,
    );
    const firstDone = realGoose.frames.findIndex(
      (frame) =>
        frame.direction === "received" &&
        frame.message.id === first.id &&
        "result" in frame.message,
    );
    const secondSent = realGoose.frames.findIndex(
      (frame) =>
        frame.direction === "sent" &&
        frame.message.id === second.id &&
        frame.message.method === "session/prompt",
    );
    expect(firstDone).toBeGreaterThan(-1);
    expect(firstDone).toBeLessThan(secondSent);
    await expect(
      page
        .getByRole("log", { name: "Chat messages" })
        .getByText("Parent resumed automatically", { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await expect
      .poll(
        () =>
          realGoose.frames.some(
            (frame) =>
              frame.direction === "sent" &&
              frame.message.method ===
                "_goose/unstable/session/delegated-tasks/acknowledge",
          ),
        { timeout: 10000 },
      )
      .toBe(true);
    await page.waitForTimeout(2500);
    expect(prompts()).toHaveLength(2);
    expect(realGoose.socketErrors).toEqual([]);
  });
