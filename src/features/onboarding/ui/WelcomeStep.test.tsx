import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { WelcomeStep } from "./WelcomeStep";

const motionMocks = vi.hoisted(() => ({ reduced: false }));
const consentMocks = vi.hoisted(() => ({
  update: vi.fn(async () => undefined),
  enforced: vi.fn(() => false),
  available: true,
}));

// The consent module is mocked at its boundary — the page's contract is which
// consent writes it makes, not the store's own persist behavior
// (consent.test.ts covers that).
vi.mock("@/shared/telemetry/consent", () => ({
  updateTelemetryEnabled: consentMocks.update,
  telemetryConsentEnforced: () => consentMocks.enforced(),
}));

vi.mock("@/shared/profile/capabilities", () => ({
  useProfileCapability: (capability: string) =>
    capability === "telemetry" ? consentMocks.available : true,
}));

vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return {
    ...actual,
    useReducedMotion: () => motionMocks.reduced,
  };
});

vi.mock("@/features/projects/artifact/ProjectArtifactPreview", () => ({
  ProjectArtifactPreview: ({
    gestureFreezeActive,
    motionImpulse,
  }: {
    gestureFreezeActive?: boolean;
    motionImpulse?: unknown;
  }) => (
    <div
      data-testid="project-cube"
      data-frozen={gestureFreezeActive ? "true" : "false"}
      data-has-motion={motionImpulse ? "true" : "false"}
    />
  ),
}));

function renderStep({
  onStart = vi.fn(),
  recordedShareUsageData = null,
  onRecordShareUsageData = vi.fn(),
}: {
  onStart?: Mock<() => void>;
  recordedShareUsageData?: boolean | null;
  onRecordShareUsageData?: Mock<(shareUsageData: boolean) => void>;
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <WelcomeStep
        onStart={onStart}
        recordedShareUsageData={recordedShareUsageData}
        onRecordShareUsageData={onRecordShareUsageData}
      />
    </QueryClientProvider>,
  );
  return { onStart, onRecordShareUsageData };
}

describe("WelcomeStep", () => {
  afterEach(() => {
    motionMocks.reduced = false;
    consentMocks.update.mockReset().mockResolvedValue(undefined);
    consentMocks.enforced.mockReset().mockReturnValue(false);
    consentMocks.available = true;
  });

  it("starts onboarding from the landing page with sharing defaulted on", async () => {
    const { onStart, onRecordShareUsageData } = renderStep();

    const heading = screen.getByRole("heading", {
      name: "Welcome to Berd. Your place for doing.",
    });
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveFocus();
    const scrollRegion = heading.closest("[class*='overflow-y-auto']");
    expect(scrollRegion).toHaveClass("max-[760px]:overflow-y-auto");
    expect(scrollRegion).toHaveClass("max-[760px]:overflow-x-hidden");
    expect(screen.getByTestId("project-cube")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: /share anonymous usage data/i }),
    ).toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: "Let’s go" }));
    expect(consentMocks.update).toHaveBeenCalledExactlyOnceWith(true);
    expect(onRecordShareUsageData).toHaveBeenCalledExactlyOnceWith(true);
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("persists an opt out before advancing", async () => {
    const { onStart, onRecordShareUsageData } = renderStep();
    await userEvent.click(
      screen.getByRole("checkbox", { name: /share anonymous usage data/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Let’s go" }));

    expect(consentMocks.update).toHaveBeenCalledExactlyOnceWith(false);
    expect(onRecordShareUsageData).toHaveBeenCalledExactlyOnceWith(false);
    expect(onStart).toHaveBeenCalledOnce();
  });

  // The regression pin for Back navigation: the checkbox shows the recorded
  // answer, not the default, so an explicit opt-out cannot silently revert.
  it("renders a recorded opt-out unchecked on a revisit", () => {
    renderStep({ recordedShareUsageData: false });

    expect(
      screen.getByRole("checkbox", { name: /share anonymous usage data/i }),
    ).not.toBeChecked();
  });

  it("writes nothing when an untouched opt-in passes through again", async () => {
    const { onStart, onRecordShareUsageData } = renderStep({
      recordedShareUsageData: true,
    });

    await userEvent.click(screen.getByRole("button", { name: "Let’s go" }));

    expect(consentMocks.update).not.toHaveBeenCalled();
    expect(onRecordShareUsageData).toHaveBeenCalledExactlyOnceWith(true);
    expect(onStart).toHaveBeenCalledOnce();
  });

  // Advancing past a visibly unchecked box always re-asserts disabled, even
  // when the recorded answer already says so — writing OFF can only ever stop
  // data from being sent, and it retries an earlier disable that failed.
  it("re-asserts disabled when advancing with the box unchecked", async () => {
    const { onStart, onRecordShareUsageData } = renderStep({
      recordedShareUsageData: false,
    });

    await userEvent.click(screen.getByRole("button", { name: "Let’s go" }));

    expect(consentMocks.update).toHaveBeenCalledExactlyOnceWith(false);
    expect(onRecordShareUsageData).toHaveBeenCalledExactlyOnceWith(false);
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("writes a deliberate change of answer on a revisit", async () => {
    const { onRecordShareUsageData } = renderStep({
      recordedShareUsageData: false,
    });

    await userEvent.click(
      screen.getByRole("checkbox", { name: /share anonymous usage data/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Let’s go" }));

    expect(consentMocks.update).toHaveBeenCalledExactlyOnceWith(true);
    expect(onRecordShareUsageData).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("advances even when the consent write fails", async () => {
    const error = new Error("read-only disk");
    consentMocks.update.mockRejectedValue(error);
    const consoleWarn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const { onStart } = renderStep();

    await userEvent.click(screen.getByRole("button", { name: "Let’s go" }));

    expect(consentMocks.update).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(consoleWarn).toHaveBeenCalledWith(
        "Failed to persist the usage-data choice:",
        error,
      );
    });
    consoleWarn.mockRestore();
  });

  // Same rules as the Settings row: consent that cannot decide anything is
  // not asked for, and advancing writes nothing.
  it.each([
    [
      "telemetry is enforced by the build",
      () => {
        consentMocks.enforced.mockReturnValue(true);
      },
    ],
    [
      "the telemetry capability is unavailable",
      () => {
        consentMocks.available = false;
      },
    ],
  ])("hides the consent choice when %s", async (_case, arrange) => {
    arrange();
    const { onStart, onRecordShareUsageData } = renderStep();

    expect(
      screen.queryByRole("checkbox", { name: /share anonymous usage data/i }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Let’s go" }));
    expect(consentMocks.update).not.toHaveBeenCalled();
    expect(onRecordShareUsageData).not.toHaveBeenCalled();
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("freezes decorative cube motion when reduced motion is requested", () => {
    motionMocks.reduced = true;
    renderStep();

    expect(screen.getByTestId("project-cube")).toHaveAttribute(
      "data-frozen",
      "true",
    );
    expect(screen.getByTestId("project-cube")).toHaveAttribute(
      "data-has-motion",
      "false",
    );
  });

  it("opens usage details in a dialog", async () => {
    renderStep();

    await userEvent.click(screen.getByRole("button", { name: "Learn more" }));

    expect(
      screen.getByRole("dialog", { name: "Sharing usage data" }),
    ).toBeInTheDocument();
    expect(screen.getByText("What we collect")).toBeInTheDocument();
    expect(screen.getByText("What we don’t collect")).toBeInTheDocument();
  });
});
