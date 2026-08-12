import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessSetupStep } from "./HarnessSetupStep";
import { CURATED_PROVIDER_CATALOG_BY_ID } from "@/features/providers/curatedProviders";

const readiness = vi.hoisted(() => ({ value: "not_installed" }));
let cardProps: Record<string, unknown> = {};

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    agentReadiness: new Map([["claude-acp", readiness.value]]),
    agentChecks: new Map(),
    loading: false,
  }),
}));

vi.mock("@/features/settings/ui/AgentProviderCard", () => ({
  AgentProviderCard: (props: Record<string, unknown>) => {
    cardProps = props;
    return <div>Provider setup</div>;
  },
}));

vi.mock("@/shared/ui/icons/ProviderIcons", () => ({
  getProviderIcon: () => <span>Provider icon</span>,
}));

describe("HarnessSetupStep", () => {
  beforeEach(() => {
    vi.stubEnv("DEV", false);
    cardProps = {};
    readiness.value = "not_installed";
  });

  it("records an already-ready provider before finishing onboarding", async () => {
    readiness.value = "ready";
    const user = userEvent.setup();
    const onSetupComplete = vi.fn();
    const onComplete = vi.fn();
    const provider = CURATED_PROVIDER_CATALOG_BY_ID.get("claude-acp");
    if (!provider) throw new Error("Missing Claude provider fixture");
    render(
      <HarnessSetupStep
        provider={provider}
        onBack={() => {}}
        initiallyComplete={false}
        onSetupComplete={onSetupComplete}
        onComplete={onComplete}
        onSkip={() => {}}
      />,
    );

    expect(screen.queryByText("Provider setup")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /finish onboarding/i }),
    );
    expect(onSetupComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onSetupComplete.mock.invocationCallOrder[0]).toBeLessThan(
      onComplete.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("completes only after an auth-required provider reports ready", () => {
    const onSetupComplete = vi.fn();
    const provider = CURATED_PROVIDER_CATALOG_BY_ID.get("claude-acp");
    if (!provider) throw new Error("Missing Claude provider fixture");
    render(
      <HarnessSetupStep
        provider={provider}
        onBack={() => {}}
        initiallyComplete={false}
        onSetupComplete={onSetupComplete}
        onComplete={() => {}}
        onSkip={() => {}}
      />,
    );

    expect(screen.getByText("Provider setup")).toBeInTheDocument();
    expect(cardProps.onInstallComplete).toBeUndefined();
    expect(
      screen.queryByRole("heading", { name: /Claude Code is ready/i }),
    ).not.toBeInTheDocument();

    act(() => (cardProps.onProviderReady as () => void)());
    expect(onSetupComplete).toHaveBeenCalledOnce();
  });
});
