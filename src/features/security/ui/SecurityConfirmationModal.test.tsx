import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OPEN_SETTINGS_EVENT } from "@/features/settings/lib/settingsEvents";
import {
  type InferredExplanationState,
  useSecurityConfirmationStore,
} from "@/features/security/stores/securityConfirmationStore";
import { renderWithProviders } from "@/test/render";
import { SecurityConfirmationModal } from "./SecurityConfirmationModal";

const command = 'python3 -c "import base64; exec(base64.b64decode(payload))"';

function renderModal(
  alertText: string,
  inferredExplanation: InferredExplanationState = { status: "idle" },
) {
  const resolve = vi.fn();
  useSecurityConfirmationStore.setState({
    pending: {
      request: {
        options: [
          { optionId: "allow-once", kind: "allow_once" },
          { optionId: "block", kind: "reject_once" },
        ],
      } as never,
      title: "Execute shell command",
      command,
      alertText,
      resolve,
    },
    inferredExplanation,
  });

  renderWithProviders(<SecurityConfirmationModal />);
  return { resolve };
}

describe("SecurityConfirmationModal", () => {
  beforeEach(() => {
    useSecurityConfirmationStore.setState({
      pending: null,
      inferredExplanation: { status: "idle" },
    });
  });

  it("uses a responsive wide dialog and contains long untrusted text", () => {
    renderModal(
      [
        "🔒 Security Alert",
        "Confidence: 100%",
        "Security threat detected ()",
        "",
        "Command:",
        command,
        "Finding ID: SEC-validation",
      ].join("\n"),
    );

    expect(screen.getByRole("dialog")).toHaveClass(
      "max-w-2xl",
      "min-w-0",
      "overflow-x-hidden",
    );
    expect(
      screen.queryByText(/Security threat detected/),
    ).not.toBeInTheDocument();
    expect(screen.getByText(command)).toHaveClass("max-w-full", "break-all");
    expect(screen.getByText("Finding ID: SEC-validation")).toHaveClass(
      "break-all",
    );
  });

  it("wraps an inferred explanation", () => {
    const explanation =
      "The encoded payload resembles an attempt to conceal executable instructions.";
    renderModal("🔒 Security Alert\nConfidence: 87%", {
      status: "done",
      text: explanation,
    });

    expect(screen.getByText(explanation)).toHaveClass("break-words");
    expect(
      screen.getByText("Why this may have been flagged (inferred)"),
    ).toBeInTheDocument();
  });

  it("shows an explicit fallback when inference fails", () => {
    renderModal("🔒 Security Alert\nConfidence: 87%", { status: "failed" });

    expect(
      screen.getByText(
        "An explanation could not be generated. Review the command carefully before allowing it.",
      ),
    ).toBeInTheDocument();
  });

  it("offers Goose setup and safely blocks before opening provider settings", async () => {
    const user = userEvent.setup();
    const openSettings = vi.fn();
    window.addEventListener(OPEN_SETTINGS_EVENT, openSettings);

    const { resolve } = renderModal("🔒 Security Alert\nConfidence: 87%", {
      status: "needs_setup",
    });

    expect(
      screen.getByText(
        "Connect Goose to get AI-generated explanations for future security alerts.",
      ),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "Connect Goose",
      }),
    );

    expect(resolve).toHaveBeenCalledWith({
      outcome: { outcome: "selected", optionId: "block" },
    });
    expect(openSettings).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { section: "providers" } }),
    );
    window.removeEventListener(OPEN_SETTINGS_EVENT, openSettings);
  });
});
