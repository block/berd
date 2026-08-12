import { expect, test, buildInitScript } from "./fixtures/tauri-mock";

const failingAgentProvider = {
  providerId: "claude-acp",
  name: "Claude Code",
  category: "agent",
  description: "Claude Code via ACP",
  setupMethod: "cli_auth",
  binaryName: "claude-agent-acp",
  docUrl: null,
  group: "default",
  showOnlyWhenInstalled: false,
  aliases: ["claude"],
  supportsInstall: true,
  supportsAuth: false,
  supportsAuthStatus: false,
};

const missingAgentInventoryEntry = {
  providerId: "claude-acp",
  providerName: "Claude Code",
  description: "Claude Code via ACP",
  defaultModel: "",
  configured: false,
  providerType: "Claude",
  category: "agent",
  configKeys: [],
  setupSteps: [],
  supportsRefresh: true,
  refreshing: false,
  lastUpdatedAt: null,
  lastRefreshAttemptAt: null,
  lastRefreshError: null,
  stale: false,
  modelSelectionHint: null,
  models: [],
};

test.describe("Provider setup failure UX", () => {
  test("shows a readable npm failure and can start a troubleshooting chat", async ({
    page,
  }) => {
    await page.addInitScript({
      content: buildInitScript({
        providerCatalog: [failingAgentProvider],
        providerInventory: [missingAgentInventoryEntry],
        agentSetupFailure: {
          providerId: "claude-acp",
          errorMessage: "Command exited with code 1",
          lines: [
            "npm error code EEXIST",
            "npm error path /opt/homebrew/bin/claude-agent-acp",
            "npm error EEXIST: file already exists",
          ],
        },
      }),
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Providers" }).click();
    await expect(page.getByText("Agent harnesses")).toBeVisible();

    await page.getByRole("button", { name: "Install Claude Code" }).click();

    await expect(page.getByText("Setup hit a snag.")).toBeVisible();
    await expect(
      page.getByText("npm error path /opt/homebrew/bin/claude-agent-acp"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Troubleshoot in chat" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Troubleshoot in chat" }).click();

    await expect(
      page.getByRole("button", { name: "Troubleshoot Claude Code setup" }),
    ).toBeVisible();
  });
});
