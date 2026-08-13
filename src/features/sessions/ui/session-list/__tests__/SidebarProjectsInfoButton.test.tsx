import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ASSISTIVE_UX_RULES,
  ASSISTIVE_UX_STORAGE_KEY,
} from "@/shared/assistive-ux/registry";
import {
  recordAssistiveMomentAccepted,
  recordAssistiveMomentShown,
  shouldShowAssistiveMoment,
} from "@/shared/assistive-ux/runtime";
import {
  SidebarProjectsInfoButton,
  useSidebarProjectsInfoMoment,
} from "../SidebarProjectsInfoButton";

const MOMENT_ID = ASSISTIVE_UX_RULES.sidebarProjectsInfo.id;

/** Mirrors the real call site: render the button only while visible. */
function InfoMomentHarness({
  hasProjects,
  projectsReady = true,
}: {
  hasProjects: boolean;
  projectsReady?: boolean;
}) {
  const moment = useSidebarProjectsInfoMoment({ hasProjects, projectsReady });
  if (!moment.visible) return null;
  return <SidebarProjectsInfoButton moment={moment} />;
}

/**
 * Mirrors call sites where the hook runs but the Projects header—and therefore
 * the affordance—does not render.
 */
function HookWithoutButtonHarness({ hasProjects }: { hasProjects: boolean }) {
  useSidebarProjectsInfoMoment({ hasProjects, projectsReady: true });
  return null;
}

describe("SidebarProjectsInfoButton", () => {
  beforeEach(() => {
    localStorage.removeItem(ASSISTIVE_UX_STORAGE_KEY);
  });

  it("renders the info affordance for a fresh user with no projects", () => {
    render(<InfoMomentHarness hasProjects={false} />);

    expect(
      screen.getByRole("button", { name: "About projects" }),
    ).toBeInTheDocument();
  });

  it("records a shown exposure when visible", () => {
    render(<InfoMomentHarness hasProjects={false} />);

    const stored = JSON.parse(
      localStorage.getItem(ASSISTIVE_UX_STORAGE_KEY) ?? "{}",
    );
    expect(stored.moments[MOMENT_ID].shownCount).toBe(1);
  });

  it("does not record an exposure when the hook runs without the button rendering", () => {
    render(<HookWithoutButtonHarness hasProjects={false} />);

    expect(localStorage.getItem(ASSISTIVE_UX_STORAGE_KEY)).toBeNull();
    expect(shouldShowAssistiveMoment(MOMENT_ID)).toBe(true);
  });

  it("does not record an exposure while projects have not been fetched, even when the cache is empty", () => {
    const { rerender } = render(
      <InfoMomentHarness hasProjects={false} projectsReady={false} />,
    );

    expect(
      screen.queryByRole("button", { name: "About projects" }),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem(ASSISTIVE_UX_STORAGE_KEY)).toBeNull();

    // Fetch resolves: the user actually has projects.
    rerender(<InfoMomentHarness hasProjects projectsReady />);

    expect(
      screen.queryByRole("button", { name: "About projects" }),
    ).not.toBeInTheDocument();
    const stored = JSON.parse(
      localStorage.getItem(ASSISTIVE_UX_STORAGE_KEY) ?? "{}",
    );
    expect(stored.moments[MOMENT_ID]?.shownCount ?? 0).toBe(0);
  });

  it("does not retire the moment from a stale non-empty cache before the fetch resolves", () => {
    // Stale cache says the user has projects while the fetch is pending.
    const { rerender } = render(
      <InfoMomentHarness hasProjects projectsReady={false} />,
    );

    expect(shouldShowAssistiveMoment(MOMENT_ID)).toBe(true);

    // Fetch resolves: the authoritative list is empty.
    rerender(<InfoMomentHarness hasProjects={false} projectsReady />);

    expect(
      screen.getByRole("button", { name: "About projects" }),
    ).toBeInTheDocument();
  });

  it("stays undecided when the fetch never succeeds", () => {
    render(<InfoMomentHarness hasProjects={false} projectsReady={false} />);

    expect(
      screen.queryByRole("button", { name: "About projects" }),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem(ASSISTIVE_UX_STORAGE_KEY)).toBeNull();
    expect(shouldShowAssistiveMoment(MOMENT_ID)).toBe(true);
  });

  it("opens the explanation and retires the moment as accepted", async () => {
    const user = userEvent.setup();
    render(<InfoMomentHarness hasProjects={false} />);

    await user.click(screen.getByRole("button", { name: "About projects" }));

    expect(
      screen.getByText(
        "Projects keep related chats together, and can share folders and instructions.",
      ),
    ).toBeInTheDocument();

    const stored = JSON.parse(
      localStorage.getItem(ASSISTIVE_UX_STORAGE_KEY) ?? "{}",
    );
    expect(stored.moments[MOMENT_ID].retiredReason).toBe("accepted");
    expect(shouldShowAssistiveMoment(MOMENT_ID)).toBe(false);
  });

  it("hides the affordance after the popover is dismissed", async () => {
    const user = userEvent.setup();
    render(<InfoMomentHarness hasProjects={false} />);

    await user.click(screen.getByRole("button", { name: "About projects" }));
    await user.keyboard("{Escape}");

    expect(
      screen.queryByRole("button", { name: "About projects" }),
    ).not.toBeInTheDocument();
  });

  it("does not render once the moment has been retired", () => {
    recordAssistiveMomentAccepted(MOMENT_ID);

    render(<InfoMomentHarness hasProjects={false} />);

    expect(
      screen.queryByRole("button", { name: "About projects" }),
    ).not.toBeInTheDocument();
  });

  it("does not render and retires the moment when the user has projects", () => {
    render(<InfoMomentHarness hasProjects />);

    expect(
      screen.queryByRole("button", { name: "About projects" }),
    ).not.toBeInTheDocument();

    const stored = JSON.parse(
      localStorage.getItem(ASSISTIVE_UX_STORAGE_KEY) ?? "{}",
    );
    expect(stored.moments[MOMENT_ID].retiredReason).toBe("settingsChanged");
    expect(shouldShowAssistiveMoment(MOMENT_ID)).toBe(false);
  });

  it("stops rendering after max exposures", () => {
    const maxShows = ASSISTIVE_UX_RULES.sidebarProjectsInfo.maxShows;
    for (let i = 0; i < maxShows; i += 1) {
      recordAssistiveMomentShown(MOMENT_ID);
    }

    render(<InfoMomentHarness hasProjects={false} />);

    expect(
      screen.queryByRole("button", { name: "About projects" }),
    ).not.toBeInTheDocument();
  });
});
