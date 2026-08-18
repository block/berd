import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOnboardingSnapshot,
  resetOnboardingStoreForTests,
} from "../model/onboardingStore";
import { OnboardingFlow } from "./OnboardingFlow";

const mockUpdateTelemetryEnabled = vi.hoisted(() =>
  vi.fn(async () => undefined),
);

vi.mock("@/features/projects/artifact/ProjectArtifactPreview", () => ({
  ProjectArtifactPreview: () => <div data-testid="project-cube" />,
}));

vi.mock("@/shared/telemetry/consent", () => ({
  updateTelemetryEnabled: mockUpdateTelemetryEnabled,
  telemetryConsentEnforced: () => false,
}));

vi.mock("@/shared/profile/capabilities", () => ({
  useProfileCapability: () => true,
}));

function renderFlow() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <OnboardingFlow />
    </QueryClientProvider>,
  );
}

describe("OnboardingFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetOnboardingStoreForTests();
  });

  it("completes first-run onboarding directly from the landing page", async () => {
    renderFlow();

    await userEvent.click(screen.getByRole("button", { name: "Let’s go" }));

    expect(getOnboardingSnapshot()).toMatchObject({
      lifecycle: "completed",
      step: "complete",
    });
    expect(
      screen.queryByRole("heading", {
        name: "What type of work will you use Berd for?",
      }),
    ).not.toBeInTheDocument();
    expect(mockUpdateTelemetryEnabled).toHaveBeenCalledWith(true);
  });

  it("records an explicit usage-data opt-out before completing", async () => {
    renderFlow();
    const user = userEvent.setup();

    await user.click(
      screen.getByRole("checkbox", { name: /share anonymous usage data/i }),
    );
    await user.click(screen.getByRole("button", { name: "Let’s go" }));

    expect(getOnboardingSnapshot()).toMatchObject({
      lifecycle: "completed",
      step: "complete",
      shareUsageData: false,
    });
    expect(mockUpdateTelemetryEnabled).toHaveBeenCalledWith(false);
  });
});
