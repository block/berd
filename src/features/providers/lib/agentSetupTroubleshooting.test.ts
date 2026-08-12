import { describe, expect, it } from "vitest";
import {
  analyzeAgentSetupFailure,
  buildAgentSetupTroubleshootingRequest,
} from "./agentSetupTroubleshooting";
import type { ProviderDisplayInfo } from "@/shared/types/providers";

const provider: ProviderDisplayInfo = {
  id: "claude-acp",
  displayName: "Claude Code",
  category: "agent",
  description: "Claude provider",
  setupMethod: "cli_auth",
  binaryName: "claude-agent-acp",
  supportsAuth: true,
  supportsAuthStatus: true,
  supportsInstall: true,
  group: "default",
  status: "not_installed",
};

describe("agent setup troubleshooting", () => {
  it("detects an existing binary path from npm EEXIST output", () => {
    const analysis = analyzeAgentSetupFailure("Command exited with code 1", [
      { text: "npm error code EEXIST" },
      { text: "npm error path /opt/homebrew/bin/claude" },
      { text: "npm error EEXIST: file already exists" },
    ]);

    expect(analysis).toMatchObject({
      kind: "existing_file",
      existingPath: "/opt/homebrew/bin/claude",
    });
  });

  it("detects platform mismatches from npm EBADPLATFORM output", () => {
    const analysis = analyzeAgentSetupFailure("Command exited with code 1", [
      { text: "npm error code EBADPLATFORM" },
      {
        text: 'wanted {"os":"win32","cpu":"x64"} (current: {"os":"darwin","cpu":"arm64"})',
      },
    ]);

    expect(analysis).toMatchObject({
      kind: "unsupported_platform",
      wantedPlatform: "win32 / x64",
      currentPlatform: "darwin / arm64",
    });
  });

  it("builds a chat request with provider context and raw output", () => {
    const analysis = analyzeAgentSetupFailure("Command exited with code 1", [
      { text: "npm error code EEXIST" },
    ]);
    const request = buildAgentSetupTroubleshootingRequest({
      provider,
      analysis,
      userMessage: "A command already exists.",
      commandError: "Command exited with code 1",
    });

    expect(request.title).toBe("Troubleshoot Claude Code setup");
    expect(request.prompt).toContain("Provider id: claude-acp");
    expect(request.prompt).toContain("Expected CLI on PATH: claude-agent-acp");
    expect(request.prompt).toContain("npm error code EEXIST");
  });
});
