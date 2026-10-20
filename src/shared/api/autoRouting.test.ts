import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  runtimeAutoRoutingConfigSchema,
  runtimeConfigSchema,
  type RuntimeAutoRoutingMode,
} from "@/shared/runtime-config/schema";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import { reconcileRuntimeConfigProviders } from "@/shared/runtime-config/newChatRuntimeConfig";
import {
  getRuntimeConfig,
  refreshRuntimeConfigForNewChat,
} from "./runtimeConfig";
import { PreCommitSendRejectedError } from "@/features/chat/lib/preCommitSendRejection";
import {
  autoRoutingFallback,
  buildAutoRoutingRequest,
  routeAutoModel,
  selectAutoRoutingResponse,
} from "./autoRouting";
vi.mock("./invokeWithStartupRetry", () => ({
  invokeWithStartupRetry: vi.fn(),
}));
vi.mock("./runtimeConfig", () => ({
  getRuntimeConfig: vi.fn(),
  refreshRuntimeConfigForNewChat: vi.fn(),
}));
vi.mock("@/shared/runtime-config/newChatRuntimeConfig", () => ({
  reconcileRuntimeConfigProviders: vi.fn(),
}));
import { invokeWithStartupRetry } from "./invokeWithStartupRetry";

const mode: RuntimeAutoRoutingMode = {
  id: "auto",
  displayName: "Auto",
  modelProviderId: "databricks_v2",
  fallback: { modelId: "served-gpt", effort: "high" },
  models: [
    {
      modelId: "served-gpt",
      routerModel: "system.ai.gpt-6.1-sol",
      minEffort: "high",
      maxEffort: "max",
    },
    {
      modelId: "served-claude",
      routerModel: "system.ai.claude-opus",
      maxEffort: "medium",
    },
  ],
};
const config = { url: "https://gateway.example.com/route", modes: [mode] };
const response = (model: string, extra = {}) => ({
  route_selection: [{ route_option: { model, harness: "codex" }, ...extra }],
  rationale: "Selected",
});
describe("auto routing selection", () => {
  it("maps normalized router IDs to concrete model IDs and supplies bounded default effort", () => {
    const raw = response("gpt-6-1-sol");
    expect(selectAutoRoutingResponse(mode, raw)).toEqual({
      modeId: "auto",
      modelProviderId: "databricks_v2",
      modelId: "served-gpt",
      effort: "high",
      source: "router",
      rationale: "Selected",
      response: raw,
    });
  });
  it("clamps returned effort and preserves the complete response", () => {
    const raw = response("claude-opus", {
      params: { reasoning_effort: "max", task_tier: "High" },
    });
    const selected = selectAutoRoutingResponse(mode, raw);
    expect(selected.effort).toBe("medium");
    expect(selected.response).toBe(raw);
  });
  it.each([
    null,
    {},
    { route_selection: [] },
    { route_selection: [{}, {}] },
    response("unknown"),
    response("gpt-6-1-sol", { params: { effort: "invented" } }),
    {
      route_selection: [
        { route_option: { model: "gpt-6-1-sol", harness: "other" } },
      ],
    },
  ])("falls back for invalid or unconfigured selections %j", (raw) => {
    expect(selectAutoRoutingResponse(mode, raw)).toMatchObject({
      modelId: "served-gpt",
      effort: "high",
      source: "fallback",
      response: raw,
    });
  });
  it("builds the documented router wire format without leaking concrete IDs", () => {
    expect(buildAutoRoutingRequest(mode, "context", config)).toEqual({
      task: { prompt: "context" },
      route_options: [
        {
          model: "system.ai.gpt-6.1-sol",
          harness: "codex",
          min_effort: "high",
          max_effort: "max",
        },
        {
          model: "system.ai.claude-opus",
          harness: "codex",
          max_effort: "medium",
        },
      ],
    });
  });
  it("fallback records stable failure reasons", () =>
    expect(autoRoutingFallback(mode, "request_failed").fallbackReason).toBe(
      "request_failed",
    ));
});
describe("auto routing runtime configuration", () => {
  it("accepts optional selectors and rejects secrets and invalid references", () => {
    expect(runtimeAutoRoutingConfigSchema.safeParse(config).success).toBe(true);
    expect(
      runtimeAutoRoutingConfigSchema.safeParse({
        ...config,
        bearerTokenEnv: "DATABRICKS_TOKEN",
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...config, url: "https://user:secret@gateway.example.com/route" },
      { ...config, url: "https://gateway.example.com/route?token=secret" },
      { ...config, timeoutMs: 0 },
      { ...config, bearerTokenEnv: "Bearer actual-value" },
      { ...config, bearerTokenEnv: "lowercase" },
      { ...config, defaultModeId: "missing" },
      { ...config, modes: [mode, mode] },
      {
        ...config,
        routeSelector: {
          router_name: "task_v3",
          config: { nested: { api_key: "secret" } },
        },
      },
      {
        ...config,
        modes: [{ ...mode, fallback: { modelId: "unknown", effort: "high" } }],
      },
      {
        ...config,
        modes: [
          {
            ...mode,
            models: [
              { ...mode.models[0], minEffort: "max", maxEffort: "high" },
            ],
          },
        ],
      },
      {
        ...config,
        modes: [
          { ...mode, fallback: { modelId: "served-gpt", effort: "low" } },
        ],
      },
    ])
      expect(runtimeAutoRoutingConfigSchema.safeParse(invalid).success).toBe(
        false,
      );
    expect(
      runtimeConfigSchema.safeParse({
        schemaVersion: 1,
        goose: { modelProviders: [], autoRouting: config },
      }).success,
    ).toBe(false);
  });
});
describe("auto routing invocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(reconcileRuntimeConfigProviders).mockImplementation(
      async () => useRuntimeConfigStore.getState().result,
    );
    vi.mocked(getRuntimeConfig).mockResolvedValue({
      status: "ready",
      source: "bundledFile",
      autoRoutingRevision: "native-revision-new",
      config: {
        schemaVersion: 1,
        goose: {
          modelProviders: [],
          autoRouting: { ...config, url: "https://changed.example.com/route" },
        },
      },
    });
    useRuntimeConfigStore.getState().setResult({
      status: "ready",
      source: "bundledFile",
      autoRoutingRevision: "native-revision-old",
      config: {
        schemaVersion: 1,
        goose: { modelProviders: [], autoRouting: config },
      },
    });
  });
  it("sends the native revision instead of roundtripping routing config to the backend", async () => {
    vi.mocked(invokeWithStartupRetry).mockResolvedValue(
      response("gpt-6-1-sol"),
    );
    expect(
      (await routeAutoModel({ modeId: "auto", prompt: "context" })).source,
    ).toBe("router");
    expect(invokeWithStartupRetry).toHaveBeenCalledWith("route_auto_model", {
      modeId: "auto",
      prompt: "context",
      expectedAutoRoutingRevision: "native-revision-old",
    });
  });
  it("sends a missing revision as null so native can request resync", async () => {
    const result = useRuntimeConfigStore.getState().result;
    if (result.status !== "ready") throw new Error("Expected ready config");
    useRuntimeConfigStore
      .getState()
      .setResult({ ...result, autoRoutingRevision: undefined });
    vi.mocked(invokeWithStartupRetry).mockRejectedValue(
      "AUTO_ROUTING_CONFIG_CHANGED",
    );
    await expect(
      routeAutoModel({ modeId: "auto", prompt: "context" }),
    ).rejects.toBeInstanceOf(PreCommitSendRejectedError);
    expect(invokeWithStartupRetry).toHaveBeenCalledWith("route_auto_model", {
      modeId: "auto",
      prompt: "context",
      expectedAutoRoutingRevision: null,
    });
  });
  it.each([
    "AUTO_ROUTING_CONFIG_CHANGED",
    new Error("AUTO_ROUTING_CONFIG_CHANGED"),
  ])("rejects a changed native snapshot without choosing the stale fallback", async (error) => {
    vi.mocked(invokeWithStartupRetry).mockRejectedValue(error);
    await expect(
      routeAutoModel({ modeId: "auto", prompt: "context" }),
    ).rejects.toBeInstanceOf(PreCommitSendRejectedError);
    expect(getRuntimeConfig).toHaveBeenCalledOnce();
    expect(refreshRuntimeConfigForNewChat).not.toHaveBeenCalled();
    expect(reconcileRuntimeConfigProviders).toHaveBeenCalledOnce();
  });
  it("waits for provider reconciliation before allowing a stale-window retry", async () => {
    vi.mocked(invokeWithStartupRetry).mockRejectedValue(
      "AUTO_ROUTING_CONFIG_CHANGED",
    );
    let finish!: () => void;
    vi.mocked(reconcileRuntimeConfigProviders).mockImplementationOnce(
      async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return useRuntimeConfigStore.getState().result;
      },
    );
    const settled = vi.fn();
    const pending = routeAutoModel({ modeId: "auto", prompt: "context" });
    void pending.then(settled, settled);
    await vi.waitFor(() =>
      expect(reconcileRuntimeConfigProviders).toHaveBeenCalledOnce(),
    );
    expect(settled).not.toHaveBeenCalled();
    const rejection = expect(pending).rejects.toBeInstanceOf(
      PreCommitSendRejectedError,
    );
    finish();
    await rejection;
  });
  it.each([
    "failed",
    "superseded",
  ])("uses an ordinary failure if stale-window provider reconciliation is %s", async (outcome) => {
    vi.mocked(invokeWithStartupRetry).mockRejectedValue(
      "AUTO_ROUTING_CONFIG_CHANGED",
    );
    if (outcome === "failed") {
      vi.mocked(reconcileRuntimeConfigProviders).mockRejectedValueOnce(
        new Error("secret provider failure"),
      );
    } else {
      vi.mocked(reconcileRuntimeConfigProviders).mockResolvedValueOnce({
        status: "unavailable",
        source: "bundledFile",
        reason: "endpointUnavailable",
        message: "unavailable",
      });
    }
    const error = await routeAutoModel({
      modeId: "auto",
      prompt: "context",
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PreCommitSendRejectedError);
    expect(String(error)).not.toContain("secret");
  });
  it("preserves cancellation while stale-window provider reconciliation is pending", async () => {
    vi.mocked(invokeWithStartupRetry).mockRejectedValue(
      "AUTO_ROUTING_CONFIG_CHANGED",
    );
    let finish!: () => void;
    vi.mocked(reconcileRuntimeConfigProviders).mockImplementationOnce(
      async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return useRuntimeConfigStore.getState().result;
      },
    );
    const controller = new AbortController();
    const pending = routeAutoModel({
      modeId: "auto",
      prompt: "context",
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(reconcileRuntimeConfigProviders).toHaveBeenCalledOnce(),
    );
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejection;
    finish();
  });
  it("resyncs a stale window so its next attempt uses the effective native config", async () => {
    vi.mocked(invokeWithStartupRetry)
      .mockRejectedValueOnce("AUTO_ROUTING_CONFIG_CHANGED")
      .mockResolvedValueOnce(response("gpt-6-1-sol"));
    await expect(
      routeAutoModel({ modeId: "auto", prompt: "context" }),
    ).rejects.toBeInstanceOf(PreCommitSendRejectedError);
    await expect(
      routeAutoModel({ modeId: "auto", prompt: "context" }),
    ).resolves.toMatchObject({ source: "router" });
    expect(invokeWithStartupRetry).toHaveBeenLastCalledWith(
      "route_auto_model",
      {
        modeId: "auto",
        prompt: "context",
        expectedAutoRoutingRevision: "native-revision-new",
      },
    );
    expect(getRuntimeConfig).toHaveBeenCalledOnce();
  });
  it.each([
    "rejected",
    "unavailable",
    "unchanged",
  ])("uses an ordinary failure when resync is %s instead of retrying forever", async (outcome) => {
    vi.mocked(invokeWithStartupRetry).mockRejectedValue(
      "AUTO_ROUTING_CONFIG_CHANGED",
    );
    if (outcome === "rejected") {
      vi.mocked(getRuntimeConfig).mockRejectedValueOnce(
        new Error("secret sync failure"),
      );
    } else if (outcome === "unavailable") {
      vi.mocked(getRuntimeConfig).mockResolvedValueOnce({
        status: "unavailable",
        source: "bundledFile",
        reason: "endpointUnavailable",
        message: "unavailable",
      });
    } else {
      vi.mocked(getRuntimeConfig).mockResolvedValueOnce({
        status: "ready",
        source: "bundledFile",
        autoRoutingRevision: "native-revision-old",
        config: {
          schemaVersion: 1,
          goose: { modelProviders: [], autoRouting: config },
        },
      });
    }
    const error = await routeAutoModel({
      modeId: "auto",
      prompt: "context",
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PreCommitSendRejectedError);
    expect(String(error)).not.toContain("secret");
    expect(invokeWithStartupRetry).toHaveBeenCalledOnce();
  });
  it("preserves cancellation while the stale-window resync is pending", async () => {
    vi.mocked(invokeWithStartupRetry).mockRejectedValue(
      "AUTO_ROUTING_CONFIG_CHANGED",
    );
    let finish!: (result: Awaited<ReturnType<typeof getRuntimeConfig>>) => void;
    vi.mocked(getRuntimeConfig).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const controller = new AbortController();
    const pending = routeAutoModel({
      modeId: "auto",
      prompt: "context",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(getRuntimeConfig).toHaveBeenCalledOnce());
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejection;
    finish({
      status: "ready",
      source: "bundledFile",
      config: {
        schemaVersion: 1,
        goose: { modelProviders: [], autoRouting: config },
      },
    });
  });
  it("rejects immediately on cancellation while native routing is pending", async () => {
    let finish!: (response: unknown) => void;
    vi.mocked(invokeWithStartupRetry).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const controller = new AbortController();
    const pending = routeAutoModel({
      modeId: "auto",
      prompt: "context",
      signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejection;
    // Settling the native request afterwards must remain harmless.
    finish(response("gpt-6-1-sol"));
    await Promise.resolve();
  });
  it("does not invoke native routing for an already cancelled turn", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      routeAutoModel({
        modeId: "auto",
        prompt: "context",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(invokeWithStartupRetry).not.toHaveBeenCalled();
  });
  it("removes the cancellation listener after a normal response", async () => {
    vi.mocked(invokeWithStartupRetry).mockResolvedValue(
      response("gpt-6-1-sol"),
    );
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    expect(
      (
        await routeAutoModel({
          modeId: "auto",
          prompt: "context",
          signal: controller.signal,
        })
      ).source,
    ).toBe("router");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
  it.each([
    { code: "timeout", elapsedMs: 5_003, timeoutMs: 5_000 },
    { code: "connection_failed", elapsedMs: 12, timeoutMs: 5_000 },
    { code: "http_error", elapsedMs: 48, timeoutMs: 5_000, httpStatus: 429 },
    { code: "http_error", elapsedMs: 100, timeoutMs: 5_000, httpStatus: 503 },
    { code: "invalid_json", elapsedMs: 52, timeoutMs: 5_000 },
    { code: "response_too_large", elapsedMs: 91, timeoutMs: 5_000 },
    { code: "response_read_failed", elapsedMs: 23, timeoutMs: 5_000 },
    { code: "client_unavailable", elapsedMs: 0, timeoutMs: 5_000 },
    { code: "credential_unavailable", elapsedMs: 0, timeoutMs: 5_000 },
    { code: "request_failed", elapsedMs: 9, timeoutMs: 5_000 },
  ])("retains safe native failure details for $code", async (failure) => {
    vi.mocked(invokeWithStartupRetry).mockRejectedValue({
      ...failure,
      message: "secret endpoint error",
      url: "https://private.example.com/?token=secret",
      body: "private response",
    });
    expect(await routeAutoModel({ modeId: "auto", prompt: "context" })).toEqual(
      {
        ...autoRoutingFallback(mode, failure.code),
        failure,
      },
    );
  });
  it.each([
    { code: "secret endpoint error", elapsedMs: 5, timeoutMs: 5_000 },
    { code: "timeout", elapsedMs: -1, timeoutMs: 5_000 },
    { code: "timeout", elapsedMs: Infinity, timeoutMs: 5_000 },
    { code: "timeout", elapsedMs: "secret", timeoutMs: 5_000 },
    { code: "timeout", elapsedMs: 5, timeoutMs: 0 },
    {
      code: "http_error",
      elapsedMs: 5,
      timeoutMs: 5_000,
      httpStatus: "secret",
    },
    { code: "http_error", elapsedMs: 5, timeoutMs: 5_000, httpStatus: 999 },
    { code: "timeout" },
    "Routing request returned HTTP 503",
    '{"code":"timeout","message":"secret"}',
  ])("keeps unknown or malformed failures generic: %j", async (error) => {
    vi.mocked(invokeWithStartupRetry).mockRejectedValue(error);
    expect(await routeAutoModel({ modeId: "auto", prompt: "context" })).toEqual(
      autoRoutingFallback(mode, "request_failed"),
    );
  });
  it("falls back on legacy errors without retaining sensitive messages", async () => {
    vi.mocked(invokeWithStartupRetry).mockRejectedValue(
      new Error("secret endpoint error"),
    );
    expect(await routeAutoModel({ modeId: "auto", prompt: "context" })).toEqual(
      autoRoutingFallback(mode, "request_failed"),
    );
  });
});
