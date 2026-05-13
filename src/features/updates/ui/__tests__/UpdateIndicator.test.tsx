import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "@/features/updates/hooks/useUpdater";
import { renderWithProviders } from "@/test/render";
import { UpdateIndicator } from "../UpdateIndicator";

type MockUpdaterState = {
  status: UpdateStatus;
  relaunch: ReturnType<typeof vi.fn>;
};

const updaterMock = vi.hoisted(() => ({
  state: {} as MockUpdaterState,
}));

vi.mock("@/features/updates/hooks/useUpdater", () => ({
  useUpdaterContext: () => updaterMock.state,
}));

function setUpdaterState(status: UpdateStatus) {
  updaterMock.state = {
    status,
    relaunch: vi.fn(),
  };
  return updaterMock.state;
}

describe("UpdateIndicator", () => {
  beforeEach(() => {
    setUpdaterState("idle");
  });

  it.each([
    "idle",
    "up-to-date",
    "error",
    "unavailable",
  ] as const)("is hidden for %s", (status) => {
    setUpdaterState(status);

    renderWithProviders(<UpdateIndicator />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows a disabled in-progress indicator while downloading", () => {
    setUpdaterState("downloading");

    renderWithProviders(<UpdateIndicator />);

    expect(
      screen.getByRole("button", { name: "Update in progress" }),
    ).toBeDisabled();
  });

  it("relaunches when the ready indicator is clicked", async () => {
    const user = userEvent.setup();
    const state = setUpdaterState("ready");

    renderWithProviders(<UpdateIndicator />);

    await user.click(
      screen.getByRole("button", { name: "Restart to apply update" }),
    );

    expect(state.relaunch).toHaveBeenCalledTimes(1);
  });
});
