import { test, expect, type Scenario } from "./fixtures/real-goose";

// No ACP interception: Playwright observes native WebSocket frames while the
// feature-pinned binary talks HTTP to the local Responses provider.
for (const scenario of [
  "normal",
  "http503",
  "nested",
  "flat",
  "untyped",
  "eof",
  "partial-eof",
] satisfies Scenario[]) {
  test(`${scenario}: actual provider outcome settles and the same session recovers`, async ({
    page,
    realGoose,
  }) => {
    test.setTimeout(120_000);
    realGoose.scenario = scenario;
    await page.goto("/");
    const input = page.getByRole("textbox", {
      name: /^(Chat message input|Start a conversation)$/,
    });
    await expect(input).toBeVisible({ timeout: 45_000 });
    await input.fill(`Exercise capacity case ${scenario}`);
    await input.press("Enter");

    const prompts = () =>
      realGoose.frames.filter(
        (frame) =>
          frame.direction === "sent" &&
          frame.message.method === "session/prompt",
      );
    await expect.poll(() => prompts().length, { timeout: 30_000 }).toBe(1);
    const first = prompts()[0].message;
    const terminal = () =>
      realGoose.frames.find(
        (frame) =>
          frame.direction === "received" &&
          frame.message.id === first.id &&
          ("result" in frame.message || "error" in frame.message),
      );
    await expect
      .poll(() => Boolean(terminal()), { timeout: 60_000 })
      .toBe(true);
    const visibleError =
      scenario === "eof" || scenario === "partial-eof"
        ? /stream.*(end|clos|complet)|unexpected.*(end|eof)|before.*complet|without.*(terminal|complet)/i
        : /overload|capacity|503|temporarily unavailable/i;
    const transcript = page.getByRole("log", { name: "Chat messages" });
    if (scenario === "normal") {
      expect(terminal()?.message.error).toBeUndefined();
      await expect(
        page
          .locator('[data-testid^="virtual-transcript-row-message:"]')
          .getByText("Capacity control reply", { exact: true }),
      ).toBeVisible();
    } else {
      expect(
        terminal()?.message.error,
        "The actual ACP prompt must fail, not just render a fabricated error",
      ).toBeTruthy();
      await expect(transcript.getByText(visibleError).first()).toBeVisible();
      if (scenario === "partial-eof") {
        await expect(
          page.getByText("Partial capacity reply survives", { exact: true }),
        ).toBeVisible();
      }
    }
    await expect(
      page.getByRole("button", { name: "Stop generation", exact: true }),
    ).toHaveCount(0);
    await expect(input).toBeEditable();
    const actualRequests = realGoose.requests.filter(
      (request) =>
        request.method === "POST" &&
        request.url === "/v1/responses" &&
        request.body.stream === true,
    );
    expect(actualRequests.length).toBeGreaterThan(0);
    expect(
      actualRequests.every((request) => request.body.model === "gpt-5.2"),
    ).toBe(true);

    const replies = page
      .locator('[data-testid^="virtual-transcript-row-message:"]')
      .getByText("Capacity control reply", { exact: true });
    const previousReplies = await replies.count();
    // Keep the existing page/session. Change only the provider's next outcome.
    realGoose.scenario = "normal";
    await input.fill("Recover in this same session");
    await input.press("Enter");
    await expect.poll(() => prompts().length, { timeout: 30_000 }).toBe(2);
    const second = prompts()[1].message;
    expect((second.params as { sessionId: string }).sessionId).toBe(
      (first.params as { sessionId: string }).sessionId,
    );
    await expect
      .poll(
        () =>
          realGoose.frames.some(
            (frame) =>
              frame.direction === "received" &&
              frame.message.id === second.id &&
              "result" in frame.message,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await expect(replies).toHaveCount(previousReplies + 1);
    await expect(replies.last()).toBeVisible();
    if (scenario !== "normal") {
      await expect(transcript.getByText(visibleError).first()).toBeVisible();
    }
    if (scenario === "partial-eof") {
      await expect(
        transcript.getByText("Partial capacity reply survives", {
          exact: true,
        }),
      ).toBeVisible();
    }
    await expect(
      page.getByRole("button", { name: "Stop generation", exact: true }),
    ).toHaveCount(0);
    expect(realGoose.socketErrors).toEqual([]);
    expect(
      realGoose.requests.filter(
        (request) =>
          request.url === "/v1/responses" && request.body.stream === true,
      ).length,
    ).toBeGreaterThan(actualRequests.length);
    console.log(
      `[capacity ${scenario}] native WS prompts=${prompts().length}, provider streaming requests=${realGoose.requests.filter((request) => request.body.stream === true).length}, recovered session=${(second.params as { sessionId: string }).sessionId}`,
    );
  });
}
