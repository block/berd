import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { ThemeProvider } from "@/shared/theme/ThemeProvider";

const mocks = vi.hoisted(() => ({
  appShellRender: vi.fn(),
  buildFeatures: {
    authGate: false,
    agentTools: true,
    automations: true,
    builderbot: true,
    telemetry: true,
  },
  cancelLogin: vi.fn(),
  getAuthStatus: vi.fn(),
  securityConfirmationFallbackRender: vi.fn(),
  startLogin: vi.fn(),
  toastError: vi.fn(),
  useAvatarImage: vi.fn((avatar: unknown) =>
    typeof avatar === "string" ? `asset:///${avatar}.png` : undefined,
  ),
  useAvatarMedia: vi.fn((avatar: unknown) =>
    typeof avatar === "string"
      ? { src: `asset:///${avatar}.mp4`, mediaType: "video" as const }
      : undefined,
  ),
}));

vi.mock("@/features/auth/api/auth", () => ({
  cancelLogin: mocks.cancelLogin,
  getAuthStatus: mocks.getAuthStatus,
  startLogin: mocks.startLogin,
}));

vi.mock("@/shared/profile/buildProfile", () => ({
  getBuildFeatureState: () => mocks.buildFeatures,
}));

vi.mock("@/shared/hooks/useAvatarSrc", () => ({
  useAvatarImage: (avatar: unknown) => mocks.useAvatarImage(avatar),
  useAvatarMedia: (avatar: unknown) => mocks.useAvatarMedia(avatar),
}));

vi.mock("@/app/AppShell", () => ({
  AppShell: () => {
    mocks.appShellRender();
    return "App Shell";
  },
}));

vi.mock("@/app/ui/SelectedTextContextMenu", () => ({
  SelectedTextContextMenu: () => null,
}));

vi.mock("@/app/ui/StartupLoadingView", () => ({
  StartupLoadingView: () => "Checking sign-in status",
}));

vi.mock("@/features/security/ui/SecurityConfirmationPanel", () => ({
  SecurityConfirmationFallback: () => {
    mocks.securityConfirmationFallbackRender();
    return null;
  },
}));

vi.mock("@/shared/ui/sonner", () => ({
  Toaster: () => null,
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
  },
}));

describe("App", () => {
  let mediaPlayMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildFeatures.authGate = false;
    mediaPlayMock = vi
      .spyOn(window.HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    vi.stubGlobal("__TAURI_INTERNALS__", undefined);
    mocks.cancelLogin.mockResolvedValue(undefined);
    mocks.getAuthStatus.mockResolvedValue({
      loggedIn: false,
      requiresOrg: true,
      profile: "default",
      kgooseBaseUrl: "https://kgoose.sqprod.co",
    });
    mocks.startLogin.mockResolvedValue({
      loggedIn: true,
      requiresOrg: false,
      org: "test",
      profile: "default",
      kgooseBaseUrl: "https://test.kgoose.sqprod.co",
      email: "test@example.com",
      user: "test@example.com",
    });
  });

  afterEach(() => {
    mediaPlayMock.mockRestore();
    vi.unstubAllGlobals();
  });

  function renderApp({ authGate = true }: { authGate?: boolean } = {}) {
    mocks.buildFeatures.authGate = authGate;
    return render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );
  }

  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((promiseResolve) => {
      resolve = promiseResolve;
    });
    return { promise, resolve };
  }

  it("prevents default window navigation when files are dragged into the app", async () => {
    vi.stubGlobal(
      "DragEvent",
      window.DragEvent ?? class DragEvent extends Event {},
    );

    renderApp();
    await waitFor(() => expect(mocks.getAuthStatus).toHaveBeenCalled());

    const dragOverEvent = new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
    });
    const dropEvent = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(dragOverEvent);
    window.dispatchEvent(dropEvent);

    expect(dragOverEvent.defaultPrevented).toBe(true);
    expect(dropEvent.defaultPrevented).toBe(true);
  });

  it("mounts the app shell without checking auth when the auth gate is disabled", async () => {
    renderApp({ authGate: false });

    expect(await screen.findByText("App Shell")).toBeInTheDocument();
    expect(mocks.getAuthStatus).not.toHaveBeenCalled();
    expect(mocks.appShellRender).toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: "Goose" }),
    ).not.toBeInTheDocument();
  });

  it("shows the logged-out login page without mounting the app shell", async () => {
    const { container } = renderApp();

    expect(
      await screen.findByRole("heading", { name: "Goose" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Organization")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log In" })).toBeDisabled();
    expect(
      container.querySelector("[data-login-avatar-layer]"),
    ).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelectorAll("[data-login-avatar]")).toHaveLength(14);
    expect(
      container.querySelectorAll('[data-login-avatar-mobile="true"]'),
    ).toHaveLength(6);
    expect(mocks.useAvatarMedia).toHaveBeenCalledWith("app-avatar:pollies-22");
    expect(mocks.useAvatarMedia).toHaveBeenCalledWith("app-avatar:gloopies-14");
    expect(
      container.querySelectorAll("[data-login-avatar] video"),
    ).toHaveLength(14);
    expect(screen.queryByText("App Shell")).not.toBeInTheDocument();
    expect(mocks.appShellRender).not.toHaveBeenCalled();
  });

  it("keeps pending security confirmations reachable while logged out", async () => {
    renderApp();

    expect(
      await screen.findByRole("heading", { name: "Goose" }),
    ).toBeInTheDocument();
    expect(mocks.securityConfirmationFallbackRender).toHaveBeenCalled();
  });

  it("passes the org into the login command and mounts the app shell after login", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.type(await screen.findByLabelText("Organization"), "test");
    await user.click(screen.getByRole("button", { name: "Log In" }));

    await waitFor(() => {
      expect(mocks.startLogin).toHaveBeenCalledWith("test");
      expect(mocks.appShellRender).toHaveBeenCalled();
    });
    expect(screen.getByText("App Shell")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Goose" }),
    ).not.toBeInTheDocument();
  });

  it("pre-populates the org from auth status and allows editing it", async () => {
    const user = userEvent.setup();
    mocks.getAuthStatus.mockResolvedValueOnce({
      loggedIn: false,
      requiresOrg: false,
      org: "tes",
      profile: "default",
      kgooseBaseUrl: "https://tes.kgoose.sqprod.co",
    });
    renderApp();

    const orgInput = await screen.findByLabelText("Organization");
    expect(orgInput).toHaveValue("tes");
    await user.clear(orgInput);
    await user.type(orgInput, "test");
    await user.click(screen.getByRole("button", { name: "Log In" }));

    await waitFor(() => {
      expect(mocks.startLogin).toHaveBeenCalledWith("test");
    });
  });

  it("surfaces login command failures through the toast layer", async () => {
    const user = userEvent.setup();
    mocks.startLogin.mockRejectedValueOnce(new Error("browser failed"));
    renderApp();

    await user.type(await screen.findByLabelText("Organization"), "test");
    await user.click(screen.getByRole("button", { name: "Log In" }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith("browser failed");
    });
  });

  it("lets users cancel a pending browser login and retry", async () => {
    const user = userEvent.setup();
    const firstLogin = deferred<{
      loggedIn: boolean;
      requiresOrg: boolean;
      org: string;
      profile: string;
      kgooseBaseUrl: string;
      email: string;
      user: string;
    }>();
    mocks.startLogin.mockReturnValueOnce(firstLogin.promise);
    renderApp();

    await user.type(await screen.findByLabelText("Organization"), "test");
    await user.click(screen.getByRole("button", { name: "Log In" }));

    expect(
      screen.getByRole("button", { name: "Signing in..." }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Log In" })).toBeEnabled();
    await waitFor(() => {
      expect(mocks.cancelLogin).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      firstLogin.resolve({
        loggedIn: true,
        requiresOrg: false,
        org: "test",
        profile: "default",
        kgooseBaseUrl: "https://test.kgoose.sqprod.co",
        email: "test@example.com",
        user: "test@example.com",
      });
      await firstLogin.promise;
    });

    expect(mocks.appShellRender).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Goose" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Log In" }));

    await waitFor(() => {
      expect(mocks.startLogin).toHaveBeenCalledTimes(2);
      expect(mocks.appShellRender).toHaveBeenCalled();
    });
  });

  it("mounts the app shell immediately when auth status is logged in", async () => {
    mocks.getAuthStatus.mockResolvedValueOnce({
      loggedIn: true,
      requiresOrg: false,
      org: "test",
      profile: "default",
      kgooseBaseUrl: "https://test.kgoose.sqprod.co",
      email: "test@example.com",
      user: "test@example.com",
    });

    renderApp();

    expect(await screen.findByText("App Shell")).toBeInTheDocument();
    expect(mocks.appShellRender).toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: "Goose" }),
    ).not.toBeInTheDocument();
  });

  it("does not reach AppShell-owned startup gates while logged out", async () => {
    renderApp();

    expect(
      await screen.findByRole("heading", { name: "Goose" }),
    ).toBeInTheDocument();
    expect(mocks.appShellRender).not.toHaveBeenCalled();
  });
});
