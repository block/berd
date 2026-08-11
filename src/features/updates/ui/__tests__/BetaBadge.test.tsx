import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/shared/i18n";
import { useFeedbackDialogStore } from "@/features/feedback/feedbackDialogStore";
import { BetaBadge } from "../BetaBadge";

const mockPrepare = vi.hoisted(() => vi.fn());
const updater = vi.hoisted(() => ({
  state: {
    status: "idle",
    runtime: {
      enabled: true,
      channels: [
        { id: "main", label: "Main" },
        { id: "beta", label: "Beta" },
      ],
      runningBuild: {
        channelId: "main",
        version: "1.2.3",
        compatibility: {
          storeContractVersion: 1,
          writesDataEpoch: 1,
          minReadableDataEpoch: 1,
          maxReadableDataEpoch: 2,
        },
        whatToTest: undefined as string | undefined,
      },
    },
    prepareChannelSwitch: mockPrepare,
  },
}));

vi.mock("@/features/updates/hooks/useUpdater", () => ({
  useUpdaterContext: () => updater.state,
}));

function renderBadge() {
  return render(
    <I18nProvider>
      <BetaBadge />
    </I18nProvider>,
  );
}

describe("BetaBadge", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_FEEDBACK", "1");
    vi.stubEnv(
      "VITE_BETA_LINEAR_LABEL_ID",
      "12345678-1234-1234-1234-123456789abc",
    );
    mockPrepare.mockReset();
    useFeedbackDialogStore.setState({ open: false, draft: null });
    updater.state.runtime.runningBuild = {
      channelId: "main",
      version: "1.2.3",
      compatibility: {
        storeContractVersion: 1,
        writesDataEpoch: 1,
        minReadableDataEpoch: 1,
        maxReadableDataEpoch: 2,
      },
      whatToTest: undefined,
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stays hidden for Main builds", () => {
    renderBadge();
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
  });

  it("opens the quiet beta hub with report and return actions", async () => {
    const user = userEvent.setup();
    updater.state.runtime.runningBuild = {
      channelId: "beta",
      version: "2.0.0",
      compatibility: {
        storeContractVersion: 1,
        writesDataEpoch: 2,
        minReadableDataEpoch: 1,
        maxReadableDataEpoch: 2,
      },
      whatToTest: "Try the new agent builder.",
    };
    renderBadge();

    await user.click(screen.getByRole("button", { name: "Open Beta details" }));
    expect(screen.getByText("Berd 2.0.0")).toBeInTheDocument();
    expect(screen.getByText("Try the new agent builder.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Report an issue" }));
    expect(useFeedbackDialogStore.getState().draft).toMatchObject({
      titleSuffix: " [Berd 2.0.0 Beta]",
      metadata: { "Release channel": "Beta", "Running build": "2.0.0" },
    });
  });
});
