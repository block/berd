import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { AboutSettings } from "../AboutSettings";

let updatesEnabled = true;

vi.mock("@/shared/profile/capabilities", () => ({
  useProfileCapability: (capability: string) =>
    capability === "updates" ? updatesEnabled : true,
}));

vi.mock("@/features/updates/ui/UpdatesSettings", () => ({
  UpdatesSettings: () => <div>updates.card</div>,
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("1.2.3"),
  getTauriVersion: vi.fn().mockResolvedValue("2.0.0"),
  getIdentifier: vi.fn().mockResolvedValue("co.berd.app"),
}));

function renderAbout() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <AboutSettings />
    </QueryClientProvider>,
  );
}

describe("AboutSettings", () => {
  afterEach(() => {
    updatesEnabled = true;
    (
      window as unknown as { __TAURI_INTERNALS__?: boolean }
    ).__TAURI_INTERNALS__ = undefined;
  });

  // Builderbot review: in updater-disabled builds, the embedded Updates
  // card (which normally shows the app version) doesn't render at all, and
  // About had no other version row -- restricted/custom builds lost the
  // only visible version value on the app identity page.
  it("shows the app version row when the updates card is absent", async () => {
    updatesEnabled = false;
    (
      window as unknown as { __TAURI_INTERNALS__?: boolean }
    ).__TAURI_INTERNALS__ = true;

    renderAbout();

    expect(screen.queryByText("updates.card")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("App version")).toBeInTheDocument();
      expect(screen.getByText("1.2.3")).toBeInTheDocument();
    });
  });

  it("omits the app version row when the updates card is present", async () => {
    updatesEnabled = true;
    (
      window as unknown as { __TAURI_INTERNALS__?: boolean }
    ).__TAURI_INTERNALS__ = true;

    renderAbout();

    expect(screen.getByText("updates.card")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Tauri version")).toBeInTheDocument();
    });
    // The Updates card (mocked here) is the only place the version shows
    // when updates are enabled -- no second "App version" row underneath.
    expect(screen.queryByText("App version")).not.toBeInTheDocument();
  });
});
