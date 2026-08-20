import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { SystemSettings } from "../SystemSettings";

let updatesEnabled = true;
let doctorEnabled = false;
let agentToolsEnabled = false;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/shared/profile/capabilities", () => ({
  useProfileCapability: (capability: string) => {
    if (capability === "updates") return updatesEnabled;
    if (capability === "doctor") return doctorEnabled;
    if (capability === "agentTools") return agentToolsEnabled;
    return true;
  },
}));

vi.mock("@/features/updates/ui/UpdatesSettings", () => ({
  UpdatesSettings: () => <div>updates.card</div>,
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("1.2.3"),
  getTauriVersion: vi.fn().mockResolvedValue("2.0.0"),
  getIdentifier: vi.fn().mockResolvedValue("co.berd.app"),
}));

function renderSystem() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithProviders(
    <QueryClientProvider client={queryClient}>
      <SystemSettings />
    </QueryClientProvider>,
  );
}

// System (rev 5): About merged into System. The embedded Updates card
// (app version + "Check for updates") now renders at the top of the page,
// and About's former identity rows + Account render at the bottom under
// their own "About" subhead. These tests carry forward the coverage that
// used to live in the standalone AboutSettings.test.tsx, plus a check on
// the new top/bottom ordering.
describe("SystemSettings", () => {
  afterEach(() => {
    updatesEnabled = true;
    doctorEnabled = false;
    agentToolsEnabled = false;
    (
      window as unknown as { __TAURI_INTERNALS__?: boolean }
    ).__TAURI_INTERNALS__ = undefined;
  });

  it("renders the Updates card above the language row and the About subhead below it", async () => {
    updatesEnabled = true;
    (
      window as unknown as { __TAURI_INTERNALS__?: boolean }
    ).__TAURI_INTERNALS__ = true;

    renderSystem();

    await waitFor(() => {
      expect(screen.getByText("Tauri version")).toBeInTheDocument();
    });

    const updatesCard = screen.getByText("updates.card");
    const languageRow = screen.getByText("Language");
    const aboutHeading = screen.getByRole("heading", { name: "About" });

    // Updates card is first: it's the row people open System for most.
    expect(
      updatesCard.compareDocumentPosition(languageRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The About subhead, and everything under it, comes after System's own
    // rows (language row here stands in for the install-level content).
    expect(
      languageRow.compareDocumentPosition(aboutHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // Builderbot review (carried over from About): in updater-disabled builds,
  // the embedded Updates card (which normally shows the app version) doesn't
  // render at all, and System had no other version row -- restricted/custom
  // builds lost the only visible version value on the app identity page.
  it("shows the app version row when the updates card is absent", async () => {
    updatesEnabled = false;
    (
      window as unknown as { __TAURI_INTERNALS__?: boolean }
    ).__TAURI_INTERNALS__ = true;

    renderSystem();

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

    renderSystem();

    expect(screen.getByText("updates.card")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Tauri version")).toBeInTheDocument();
    });
    // The Updates card (mocked here) is the only place the version shows
    // when updates are enabled -- no second "App version" row underneath.
    expect(screen.queryByText("App version")).not.toBeInTheDocument();
  });
});
