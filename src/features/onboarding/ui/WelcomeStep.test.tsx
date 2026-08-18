import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WelcomeStep } from "./WelcomeStep";

const motionMocks = vi.hoisted(() => ({ reduced: false }));

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

function renderStep(onStart = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <WelcomeStep onStart={onStart} />
    </QueryClientProvider>,
  );
  return onStart;
}

describe("WelcomeStep", () => {
  afterEach(() => {
    motionMocks.reduced = false;
    localStorage.clear();
  });

  it("starts onboarding from the landing page", async () => {
    const onStart = renderStep();

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
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("persists opt out before advancing", async () => {
    const onStart = renderStep();
    await userEvent.click(
      screen.getByRole("checkbox", { name: /share anonymous usage data/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Let’s go" }));

    expect(localStorage.getItem("berd:telemetry-consent:v1")).toBe("false");
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
