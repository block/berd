import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CURATED_PROVIDER_CATALOG } from "@/features/providers/curatedProviders";
import {
  clearModelSetupStatus,
  startModelSetup,
  type ModelSetupOperation,
} from "@/features/providers/api/modelSetup";
import { getModelProviders } from "@/features/providers/providerCatalog";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import { useModelSetupStore } from "@/features/providers/stores/modelSetupStore";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { ModelProviderRow } from "../ModelProviderRow";

// The native sign-in is backend-owned; the row is a pure view over the store.
// Mock the command bindings so the store's actions don't hit Tauri, and drive
// the row by pushing snapshots into the store directly.
vi.mock("@/features/providers/api/modelSetup", () => ({
  startModelSetup: vi.fn(),
  getModelSetupStatus: vi.fn(),
  listModelSetupStatus: vi.fn().mockResolvedValue([]),
  clearModelSetupStatus: vi.fn().mockResolvedValue(undefined),
  onModelSetupState: vi.fn().mockResolvedValue(() => {}),
}));

const Row = ModelProviderRow as unknown as ComponentType<
  Record<string, unknown>
>;

function modelProvider(id: string, status: "connected" | "not_configured") {
  const provider =
    getModelProviders().find((entry) => entry.id === id) ??
    CURATED_PROVIDER_CATALOG.find((entry) => entry.id === id);
  if (!provider) {
    throw new Error(`missing provider fixture: ${id}`);
  }
  return {
    ...provider,
    status,
  };
}

const providerCatalog: ProviderCatalogEntry[] = [
  {
    id: "databricks",
    displayName: "Databricks",
    category: "model",
    description: "Databricks Foundation Models",
    setupMethod: "host_with_oauth_fallback",
    fields: [
      {
        key: "DATABRICKS_HOST",
        label: "Host URL",
        secret: false,
        required: true,
        placeholder: "https://dbc-...cloud.databricks.com",
      },
      {
        key: "DATABRICKS_TOKEN",
        label: "Access Token",
        secret: true,
        required: false,
        placeholder: "Paste your access token",
      },
    ],
    group: "default",
  },
  {
    id: "ollama",
    displayName: "Ollama",
    category: "model",
    description: "Run local or self-hosted models",
    setupMethod: "config_fields",
    fields: [
      {
        key: "OLLAMA_HOST",
        label: "Host",
        secret: false,
        required: true,
        placeholder: "localhost or http://localhost:11434",
        defaultValue: "http://localhost:11434",
      },
    ],
    group: "default",
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    category: "model",
    description: "Claude models",
    setupMethod: "single_api_key",
    group: "default",
  },
  {
    id: "google",
    displayName: "Google Gemini",
    category: "model",
    description: "Gemini models",
    setupMethod: "single_api_key",
    fields: [
      {
        key: "GOOGLE_API_KEY",
        label: "API Key",
        secret: true,
        required: true,
        placeholder: "Paste your API key",
      },
    ],
    group: "default",
  },
];

describe("ModelProviderRow", () => {
  const onGetConfig = vi.fn();
  const onSaveFields = vi.fn();
  const onRemoveConfig = vi.fn();
  const onCompleteNativeSetup = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useProviderCatalogStore.getState().setEntries(providerCatalog);
    useModelSetupStore.setState({ operations: new Map() });
    onGetConfig.mockResolvedValue([]);
    onSaveFields.mockResolvedValue(undefined);
    onRemoveConfig.mockResolvedValue(undefined);
    onCompleteNativeSetup.mockResolvedValue(undefined);
  });

  it("saves all changed setup fields from one setup submit", async () => {
    const user = userEvent.setup();

    render(
      <ModelProviderRow
        provider={modelProvider("databricks", "not_configured")}
        onGetConfig={onGetConfig}
        onSaveFields={onSaveFields}
        onRemoveConfig={onRemoveConfig}
        onCompleteNativeSetup={onCompleteNativeSetup}
      />,
    );

    await user.click(screen.getByRole("button", { name: /databricks/i }));
    await user.type(
      await screen.findByPlaceholderText(/cloud\.databricks\.com/i),
      "https://dbc-test.cloud.databricks.com",
    );
    await user.type(
      screen.getByPlaceholderText(/paste your access token/i),
      "databricks-token",
    );
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(onSaveFields).toHaveBeenCalledTimes(1));
    expect(onSaveFields).toHaveBeenCalledWith([
      {
        key: "DATABRICKS_HOST",
        value: "https://dbc-test.cloud.databricks.com",
        isSecret: false,
      },
      {
        key: "DATABRICKS_TOKEN",
        value: "databricks-token",
        isSecret: true,
      },
    ]);
  });

  it("pre-fills and saves provider field defaults", async () => {
    const user = userEvent.setup();

    render(
      <ModelProviderRow
        provider={modelProvider("ollama", "not_configured")}
        onGetConfig={onGetConfig}
        onSaveFields={onSaveFields}
        onRemoveConfig={onRemoveConfig}
        onCompleteNativeSetup={onCompleteNativeSetup}
      />,
    );

    await user.click(screen.getByRole("button", { name: /ollama/i }));

    expect(
      await screen.findByDisplayValue("http://localhost:11434"),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(onSaveFields).toHaveBeenCalledTimes(1));
    expect(onSaveFields).toHaveBeenCalledWith([
      {
        key: "OLLAMA_HOST",
        value: "http://localhost:11434",
        isSecret: false,
      },
    ]);
  });

  it("shows the connected row while models are still loading", async () => {
    const user = userEvent.setup();

    render(
      <Row
        provider={modelProvider("anthropic", "connected")}
        onGetConfig={onGetConfig}
        onSaveFields={onSaveFields}
        onRemoveConfig={onRemoveConfig}
        onCompleteNativeSetup={onCompleteNativeSetup}
        modelSyncing={true}
      />,
    );

    await user.click(screen.getByRole("button", { name: /anthropic/i }));

    expect(screen.getByText(/loading models/i)).toBeInTheDocument();
  });

  it("shows the enforced Databricks AI Gateway URL when expanded", async () => {
    const user = userEvent.setup();

    render(
      <ModelProviderRow
        provider={modelProvider("databricks_v2", "connected")}
        onGetConfig={onGetConfig}
        onSaveFields={onSaveFields}
        onRemoveConfig={onRemoveConfig}
        onCompleteNativeSetup={onCompleteNativeSetup}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /databricks ai gateway/i }),
    );

    expect(screen.getByText("Configured URL")).toBeInTheDocument();
    expect(
      screen.getByText(
        "https://block-lakehouse-production.cloud.databricks.com",
      ),
    ).toBeInTheDocument();
    expect(onGetConfig).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /disconnect/i }),
    ).not.toBeInTheDocument();
  });

  it("shows a non-blocking model warning without replacing the connected state", async () => {
    const user = userEvent.setup();

    render(
      <Row
        provider={modelProvider("anthropic", "connected")}
        onGetConfig={onGetConfig}
        onSaveFields={onSaveFields}
        onRemoveConfig={onRemoveConfig}
        onCompleteNativeSetup={onCompleteNativeSetup}
        modelWarning="Model refresh failed"
      />,
    );

    await user.click(screen.getByRole("button", { name: /anthropic/i }));

    expect(screen.getByText(/model refresh failed/i)).toBeInTheDocument();
  });

  it("switches from setup save to connected controls after first configuration", async () => {
    const user = userEvent.setup();
    let saved = false;

    function SetupSaveRow() {
      const [status, setStatus] = useState<"connected" | "not_configured">(
        "not_configured",
      );

      return (
        <ModelProviderRow
          provider={modelProvider("google", status)}
          onGetConfig={async () =>
            saved
              ? [
                  {
                    key: "GOOGLE_API_KEY",
                    value: null,
                    isSet: true,
                    isSecret: true,
                    required: true,
                  },
                ]
              : []
          }
          onSaveFields={async () => {
            saved = true;
            setStatus("connected");
          }}
          onRemoveConfig={onRemoveConfig}
          onCompleteNativeSetup={onCompleteNativeSetup}
        />
      );
    }

    render(<SetupSaveRow />);

    await user.click(screen.getByRole("button", { name: /google gemini/i }));
    await user.type(
      await screen.findByPlaceholderText(/paste your api key/i),
      "google-token",
    );
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /disconnect/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /saved/i }),
    ).not.toBeInTheDocument();
  });
});

describe("ModelProviderRow native sign-in (backend-owned)", () => {
  const onGetConfig = vi.fn();
  const onSaveFields = vi.fn();
  const onRemoveConfig = vi.fn();
  const onCompleteNativeSetup = vi.fn();
  const onProviderConnected = vi.fn();

  // A native-connect provider with no config fields (the `goose configure`
  // sign-in path). `oauth_browser` gives it a non-null native-connect
  // description so the "Connect" affordance renders.
  const nativeProvider = {
    id: "native-test",
    displayName: "Native Test",
    category: "model" as const,
    description: "Native test provider",
    setupMethod: "oauth_browser" as const,
    nativeConnectQuery: "native-test",
    status: "not_configured" as const,
    group: "default" as const,
  };

  function renderNative() {
    return render(
      <Row
        provider={nativeProvider}
        onGetConfig={onGetConfig}
        onSaveFields={onSaveFields}
        onRemoveConfig={onRemoveConfig}
        onCompleteNativeSetup={onCompleteNativeSetup}
        onProviderConnected={onProviderConnected}
      />,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    useModelSetupStore.setState({ operations: new Map() });
    onGetConfig.mockResolvedValue([]);
    onCompleteNativeSetup.mockResolvedValue(undefined);
    vi.mocked(clearModelSetupStatus).mockResolvedValue(undefined);
  });

  it("kicks off the backend native sign-in when Connect is clicked", async () => {
    const user = userEvent.setup();
    vi.mocked(startModelSetup).mockResolvedValue({
      phase: "authenticating",
      status: "running",
      output: [],
      error: null,
    });

    renderNative();

    await user.click(screen.getByRole("button", { name: /native test/i }));
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    expect(startModelSetup).toHaveBeenCalledWith("native-test", {
      providerLabel: "native-test",
    });
    expect(await screen.findByText(/waiting for sign-in/i)).toBeInTheDocument();
  });

  it("runs the post-success refresh once and clears the entry on success", async () => {
    renderNative();

    const succeeded: ModelSetupOperation = {
      phase: "idle",
      status: "succeeded",
      output: [],
      error: null,
    };
    act(() => {
      useModelSetupStore.getState().setOperation("native-test", succeeded);
    });

    await waitFor(() =>
      expect(onCompleteNativeSetup).toHaveBeenCalledWith("native-test"),
    );
    expect(onCompleteNativeSetup).toHaveBeenCalledTimes(1);
    expect(onProviderConnected).toHaveBeenCalledWith("native-test");
    expect(clearModelSetupStatus).toHaveBeenCalledWith("native-test");
  });

  it("keeps the native sign-in retry surface when the post-success refresh fails", async () => {
    const user = userEvent.setup();
    onCompleteNativeSetup.mockRejectedValueOnce(
      new Error("provider refresh failed"),
    );
    renderNative();

    await user.click(screen.getByRole("button", { name: /native test/i }));

    const succeeded: ModelSetupOperation = {
      phase: "idle",
      status: "succeeded",
      output: [],
      error: null,
    };
    act(() => {
      useModelSetupStore.getState().setOperation("native-test", succeeded);
    });

    expect(
      await screen.findByText(/provider refresh failed/i),
    ).toBeInTheDocument();
    expect(onCompleteNativeSetup).toHaveBeenCalledWith("native-test");
    expect(onProviderConnected).not.toHaveBeenCalled();
    expect(clearModelSetupStatus).not.toHaveBeenCalled();
    expect(
      useModelSetupStore.getState().getStatus("native-test"),
    ).toMatchObject({
      status: "failed",
      error: "provider refresh failed",
    });
    expect(
      screen.getByRole("button", { name: /^retry$/i }),
    ).toBeInTheDocument();
  });

  it("surfaces the backend error and offers Retry when sign-in fails", async () => {
    const user = userEvent.setup();
    renderNative();

    await user.click(screen.getByRole("button", { name: /native test/i }));

    act(() => {
      useModelSetupStore.getState().setOperation("native-test", {
        phase: "idle",
        status: "failed",
        output: ["Configuring Native Test"],
        error: "Goose sign-in exited with code 1",
      });
    });

    expect(
      await screen.findByText(/goose sign-in exited with code 1/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^retry$/i }),
    ).toBeInTheDocument();
    expect(onCompleteNativeSetup).not.toHaveBeenCalled();
  });
});
