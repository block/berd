import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthStatus } from "@/features/auth/api/auth";
import { LoginView } from "./LoginView";

const mocks = vi.hoisted(() => ({
  cancelLogin: vi.fn(),
  onAuthenticated: vi.fn(),
  onRetryStatus: vi.fn(),
  startLogin: vi.fn(),
  toastError: vi.fn(),
  useAvatarImage: vi.fn(),
  useAvatarMedia: vi.fn(),
}));

vi.mock("@/features/auth/api/auth", () => ({
  cancelLogin: mocks.cancelLogin,
  startLogin: mocks.startLogin,
}));

vi.mock("@/shared/hooks/useAvatarSrc", () => ({
  useAvatarImage: (avatar: unknown) => mocks.useAvatarImage(avatar),
  useAvatarMedia: (avatar: unknown) => mocks.useAvatarMedia(avatar),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
  },
}));

function loggedOutStatus(org: string): AuthStatus {
  return {
    loggedIn: false,
    requiresOrg: false,
    org,
    profile: "default",
    kgooseBaseUrl: `https://${org}.kgoose.sqprod.co`,
  };
}

function loggedInStatus(org: string): AuthStatus {
  return {
    loggedIn: true,
    requiresOrg: false,
    org,
    profile: "default",
    kgooseBaseUrl: `https://${org}.kgoose.sqprod.co`,
  };
}

function loginView(authStatus: AuthStatus) {
  return (
    <LoginView
      authStatus={authStatus}
      onAuthenticated={mocks.onAuthenticated}
      onRetryStatus={mocks.onRetryStatus}
    />
  );
}

function EditOrgBeforePassiveEffects({ value }: { value: string }) {
  useLayoutEffect(() => {
    fireEvent.change(screen.getByLabelText("Organization"), {
      target: { value },
    });
  }, [value]);

  return null;
}

describe("LoginView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startLogin.mockResolvedValue(loggedInStatus("test"));
  });

  it("does not overwrite a user edit during the initial auth org sync", async () => {
    await act(async () => {
      render(
        <>
          {loginView(loggedOutStatus("tes"))}
          <EditOrgBeforePassiveEffects value="test" />
        </>,
      );
    });

    expect(screen.getByLabelText("Organization")).toHaveValue("test");
    await userEvent.click(screen.getByRole("button", { name: "Log In" }));

    await waitFor(() => {
      expect(mocks.startLogin).toHaveBeenCalledWith("test");
    });
  });

  it("preserves a user edit when rerendered with the same auth org", async () => {
    const user = userEvent.setup();
    const { rerender } = render(loginView(loggedOutStatus("tes")));

    const orgInput = screen.getByLabelText("Organization");
    expect(orgInput).toHaveValue("tes");
    await user.clear(orgInput);
    await user.type(orgInput, "test");
    rerender(loginView(loggedOutStatus("tes")));

    expect(screen.getByLabelText("Organization")).toHaveValue("test");
  });

  it("updates the input when auth status changes to a different org", async () => {
    const { rerender } = render(loginView(loggedOutStatus("tes")));

    rerender(loginView(loggedOutStatus("prod")));

    await waitFor(() => {
      expect(screen.getByLabelText("Organization")).toHaveValue("prod");
    });
  });
});
