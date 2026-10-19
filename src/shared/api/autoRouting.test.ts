import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  runtimeAutoRoutingConfigSchema,
  runtimeConfigSchema,
  type RuntimeAutoRoutingMode,
} from "@/shared/runtime-config/schema";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
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
    useRuntimeConfigStore.setState({
      config: {
        schemaVersion: 1,
        goose: { modelProviders: [], autoRouting: config },
      },
    });
  });
  it("sends mode ID, context and the expected config snapshot to the backend", async () => {
    vi.mocked(invokeWithStartupRetry).mockResolvedValue(
      response("gpt-6-1-sol"),
    );
    expect(
      (await routeAutoModel({ modeId: "auto", prompt: "context" })).source,
    ).toBe("router");
    expect(invokeWithStartupRetry).toHaveBeenCalledWith("route_auto_model", {
      modeId: "auto",
      prompt: "context",
      expectedAutoRouting: config,
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
  it("falls back on rejected network and timeout requests without retaining sensitive errors", async () => {
    vi.mocked(invokeWithStartupRetry).mockRejectedValue(
      new Error("secret endpoint error"),
    );
    expect(await routeAutoModel({ modeId: "auto", prompt: "context" })).toEqual(
      autoRoutingFallback(mode, "request_failed"),
    );
  });
});
