import type { ProviderDisplayInfo } from "@/shared/types/providers";

export type AgentSetupFailureKind =
  | "existing_file"
  | "unsupported_platform"
  | "unknown";

export interface AgentSetupFailureAnalysis {
  kind: AgentSetupFailureKind;
  rawOutput: string;
  existingPath?: string;
  wantedPlatform?: string;
  currentPlatform?: string;
}

export interface AgentSetupTroubleshootingRequest {
  title: string;
  prompt: string;
}

interface BuildPromptArgs {
  provider: ProviderDisplayInfo;
  analysis: AgentSetupFailureAnalysis;
  userMessage: string;
  commandError: string;
}

const NPM_PATH_PATTERN = /^npm error path\s+(.+)$/im;
const UNSUPPORTED_PLATFORM_PATTERN =
  /wanted\s+({[^)]*?})\s+\(current:\s+({[^)]*?})\)/i;

function normalizeLines(lines: Array<{ text: string }>): string {
  return lines
    .map((line) => line.text)
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

function formatPlatform(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as { os?: string; cpu?: string };
    return [parsed.os, parsed.cpu].filter(Boolean).join(" / ");
  } catch {
    return undefined;
  }
}

export function analyzeAgentSetupFailure(
  commandError: string,
  lines: Array<{ text: string }>,
): AgentSetupFailureAnalysis {
  const rawOutput = normalizeLines(lines);
  const searchable = `${commandError}\n${rawOutput}`;

  if (/npm error code EEXIST/i.test(searchable)) {
    const existingPath = searchable.match(NPM_PATH_PATTERN)?.[1]?.trim();
    return {
      kind: "existing_file",
      rawOutput,
      existingPath,
    };
  }

  if (/npm error code EBADPLATFORM/i.test(searchable)) {
    const platformMatch = searchable.match(UNSUPPORTED_PLATFORM_PATTERN);
    return {
      kind: "unsupported_platform",
      rawOutput,
      wantedPlatform: platformMatch?.[1]
        ? formatPlatform(platformMatch[1])
        : undefined,
      currentPlatform: platformMatch?.[2]
        ? formatPlatform(platformMatch[2])
        : undefined,
    };
  }

  return {
    kind: "unknown",
    rawOutput,
  };
}

export function buildAgentSetupTroubleshootingRequest({
  provider,
  analysis,
  userMessage,
  commandError,
}: BuildPromptArgs): AgentSetupTroubleshootingRequest {
  const rawOutput =
    analysis.rawOutput.trim().length > 0
      ? analysis.rawOutput.trim()
      : "No setup output was captured.";
  const contextLines = [
    `Provider id: ${provider.id}`,
    provider.binaryName ? `Expected CLI on PATH: ${provider.binaryName}` : null,
    `Berd summary: ${userMessage}`,
    `Command error: ${commandError}`,
    `Failure kind: ${analysis.kind}`,
  ].filter((line): line is string => Boolean(line));

  return {
    title: `Troubleshoot ${provider.displayName} setup`,
    prompt: [
      `I tried to set up ${provider.displayName} from Berd > AI providers, and setup failed.`,
      "",
      "Please help me troubleshoot this on my machine. First diagnose the likely cause, then inspect the relevant local npm, PATH, and CLI state, and only suggest or run a fix after explaining the tradeoff.",
      "",
      "Context:",
      ...contextLines,
      "",
      "Raw setup output:",
      "```text",
      rawOutput,
      "```",
    ].join("\n"),
  };
}
