import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AutomationDraft } from "@/features/automations/api/automationBuilder";
import { AutomationDraftRail } from "./AutomationDraftRail";

const baseDraft: AutomationDraft = {
  toolRequestId: "tool-1",
  toolName: "tile__render_tile",
  title: "Daily sales",
  schedule: "*/5 * * *",
  instructions: ["Send a sales digest."],
  humanReadableInstructions: ["Send a sales digest."],
  rawArguments: {},
  creationMode: "createTile",
};

function DraftRailHarness({
  onDraftOverride,
}: {
  onDraftOverride: (overrides: Partial<AutomationDraft>) => void;
}) {
  const [draft, setDraft] = useState(baseDraft);

  return (
    <AutomationDraftRail
      draftState={{
        draft,
        blockedToolRequest: null,
        createRequested: false,
        created: false,
        failed: false,
      }}
      error={null}
      isSubmitting={false}
      sessionId="session-1"
      status="idle"
      onApprove={vi.fn()}
      onDraftOverride={(overrides) => {
        onDraftOverride(overrides);
        setDraft((current) => ({ ...current, ...overrides }));
      }}
    />
  );
}

describe("AutomationDraftRail", () => {
  it("keeps an empty custom cron in edit mode while the user is typing", async () => {
    const user = userEvent.setup();
    const onDraftOverride = vi.fn();
    render(<DraftRailHarness onDraftOverride={onDraftOverride} />);

    await user.clear(screen.getByLabelText("Cron expression"));

    expect(screen.getByLabelText("Cron expression")).toHaveValue("");
    expect(onDraftOverride).toHaveBeenLastCalledWith({ schedule: "" });
  });

  it("copies the session id from the session id row", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<DraftRailHarness onDraftOverride={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /session id/i }));

    expect(writeText).toHaveBeenCalledWith("session-1");
  });
});
