import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/shared/i18n";
import type { DoctorCheck } from "@/shared/api/doctor";
import { AgentVersionInfo } from "../AgentVersionInfo";

function check(overrides: Partial<DoctorCheck>): DoctorCheck {
  return {
    id: "ai-agent-codex",
    label: "Codex",
    status: "pass",
    message: "Installed",
    fixUrl: null,
    fixCommand: null,
    fixType: null,
    path: null,
    bridgePath: null,
    rawOutput: null,
    authStatus: null,
    installedVersion: null,
    latestVersion: null,
    updateAvailable: null,
    installSource: null,
    selfUpdating: null,
    main: null,
    bridge: null,
    category: "agents",
    categoryLabel: "Agents",
    ...overrides,
  };
}

function renderInfo(c: DoctorCheck) {
  return render(
    <I18nProvider>
      <AgentVersionInfo check={c} />
    </I18nProvider>,
  );
}

describe("AgentVersionInfo", () => {
  it("renders nothing when no version data is present", () => {
    const { container } = renderInfo(check({}));
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the only signal is an unknown install source", () => {
    const { container } = renderInfo(check({ installSource: "unknown" }));
    expect(container).toBeEmptyDOMElement();
  });

  it("drops the source label but keeps the version when source is unknown", () => {
    renderInfo(check({ installSource: "unknown", installedVersion: "1.2.3" }));
    expect(screen.getByText("v1.2.3")).toBeInTheDocument();
    expect(screen.queryByText(/unknown source/i)).not.toBeInTheDocument();
  });

  it("shows the install method and version from the flat fields", () => {
    renderInfo(check({ installSource: "brew", installedVersion: "1.2.3" }));
    expect(
      screen.getByText("Installed via Homebrew · v1.2.3"),
    ).toBeInTheDocument();
  });

  it("shows the update marker inline on the version row for user-managed sources", () => {
    renderInfo(
      check({
        installSource: "npm",
        installedVersion: "1.2.3",
        latestVersion: "1.3.0",
        updateAvailable: true,
        main: {
          installSource: "npm",
          installedVersion: "1.2.3",
          latestVersion: "1.3.0",
          updateAvailable: true,
          selfUpdating: null,
          updateCommand: "npm install -g @anthropic-ai/claude-code@latest",
          updateFixType: "updateMain",
        },
      }),
    );

    expect(screen.getByText("Update available → v1.3.0")).toBeInTheDocument();
    // The row no longer renders a per-readout button; the card owns the
    // single "Update" affordance.
    expect(
      screen.queryByRole("button", { name: /update/i }),
    ).not.toBeInTheDocument();
  });

  it("renders no update marker when updateCommand is absent (self-updating leak)", () => {
    renderInfo(
      check({
        installSource: "curlPipe",
        installedVersion: "1.2.3",
        latestVersion: "1.3.0",
        updateAvailable: true,
      }),
    );

    expect(screen.queryByText(/update available/i)).not.toBeInTheDocument();
  });

  it("renders no update marker for self-updating tools", () => {
    renderInfo(
      check({
        id: "ai-agent-cursor",
        label: "Cursor",
        installSource: "curlPipe",
        installedVersion: "1.2.3",
        latestVersion: "1.3.0",
        updateAvailable: true,
        selfUpdating: true,
      }),
    );

    expect(
      screen.getByText("Installed via native installer · v1.2.3"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/update available/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/auto-updates/i)).not.toBeInTheDocument();
  });

  it("renders the generic update marker on the bridge readout", () => {
    renderInfo(
      check({
        main: {
          installSource: "curlPipe",
          installedVersion: "2.1.161",
          latestVersion: null,
          updateAvailable: null,
          selfUpdating: true,
          updateCommand: null,
          updateFixType: null,
        },
        bridge: {
          installSource: "brew",
          installedVersion: "0.34.0",
          latestVersion: "0.39.0",
          updateAvailable: true,
          selfUpdating: null,
          updateCommand: "brew upgrade claude-agent-acp",
          updateFixType: "updateBridge",
        },
      }),
    );

    expect(screen.getByText("Update available → v0.39.0")).toBeInTheDocument();
  });

  it("labels bundled readouts and renders no update marker for them", () => {
    // The crate stamps a binary resolved from Berd's bundled ACP tools dir as
    // installSource "bundled", suppresses `updateAvailable`, and derives no
    // update command — the bundled copy updates with Berd itself, so no nag
    // renders even when a newer npm release exists.
    renderInfo(
      check({
        path: "/Applications/Berd.app/Contents/Resources/acp/bin/codex-acp",
        installSource: "bundled",
        installedVersion: "0.142.5",
        latestVersion: "0.143.0",
        updateAvailable: null,
        main: {
          installSource: "bundled",
          installedVersion: "0.142.5",
          latestVersion: "0.143.0",
          updateAvailable: null,
          selfUpdating: null,
          updateCommand: null,
          updateFixType: null,
          bundled: true,
        },
      }),
    );

    expect(
      screen.getByText("Installed via app bundle · v0.142.5"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/update available/i)).not.toBeInTheDocument();
  });

  it("surfaces the main CLI and ACP bridge independently when they differ", () => {
    renderInfo(
      check({
        main: {
          installSource: "brew",
          installedVersion: "1.4.0",
          latestVersion: null,
          updateAvailable: null,
          selfUpdating: null,
          updateCommand: null,
          updateFixType: null,
        },
        bridge: {
          installSource: "npm",
          installedVersion: "0.3.0",
          latestVersion: null,
          updateAvailable: null,
          selfUpdating: null,
          updateCommand: null,
          updateFixType: null,
        },
      }),
    );

    expect(screen.getByText("Codex v1.4.0 via Homebrew")).toBeInTheDocument();
    expect(screen.getByText("ACP bridge v0.3.0 via npm")).toBeInTheDocument();
  });
});
