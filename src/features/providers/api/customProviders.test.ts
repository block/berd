import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  syncRuntimeCustomProvider,
  syncRuntimeCustomProviders,
} from "./customProviders";
import type {
  RuntimeConfig,
  RuntimeGooseModelProvider,
} from "@/shared/runtime-config/schema";

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: () => mocks.getClient(),
}));

function runtimeProvider(
  overrides: Partial<RuntimeGooseModelProvider["customProvider"]> = {},
  providerId = "local_ollama_openai",
): RuntimeGooseModelProvider {
  return {
    id: providerId,
    displayName: "Local Ollama",
    models: [{ id: "qwen3.6:27b-mlx", name: "Qwen 3.6 27B MLX" }],
    customProvider: {
      providerId,
      engine: "openai_compatible",
      displayName: "Local Ollama",
      apiUrl: "http://127.0.0.1:11434/v1",
      models: ["qwen3.6:27b-mlx"],
      requiresAuth: false,
      supportsStreaming: true,
      preservesThinking: false,
      ...overrides,
    },
  };
}

function matchingReadResponse(provider: RuntimeGooseModelProvider) {
  const customProvider = provider.customProvider;
  if (!customProvider) {
    throw new Error("expected custom provider");
  }
  return {
    provider: {
      ...customProvider,
      catalogProviderId: customProvider.providerId,
      headers: customProvider.headers ?? {},
      apiKeySet: false,
    },
    editable: true,
    status: {},
  };
}

function mockGoose(goose: Record<string, unknown>) {
  mocks.getClient.mockResolvedValue({ goose });
}

function notFoundError(providerId = "local_ollama_openai") {
  const error = new Error("Invalid params") as Error & { data?: string };
  error.data = `Unknown provider: ${providerId}`;
  return error;
}

describe("syncRuntimeCustomProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("creates missing custom providers when the backend uses the expected provider id", async () => {
    const read = vi.fn().mockRejectedValue(notFoundError());
    const create = vi.fn().mockResolvedValue({
      providerId: "local_ollama_openai",
      status: {},
      refresh: {},
    });
    const update = vi.fn();
    mockGoose({
      GooseUnstableProvidersCustomRead: read,
      GooseUnstableProvidersCustomCreate: create,
      GooseUnstableProvidersCustomUpdate: update,
    });

    await syncRuntimeCustomProvider(runtimeProvider());

    expect(create).toHaveBeenCalledWith({
      catalogProviderId: "local_ollama_openai",
      engine: "openai_compatible",
      displayName: "Local Ollama",
      apiUrl: "http://127.0.0.1:11434/v1",
      models: ["qwen3.6:27b-mlx"],
      requiresAuth: false,
      supportsStreaming: true,
      preservesThinking: false,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("surfaces generated custom provider ids when Goose cannot create the runtime id", async () => {
    const read = vi.fn().mockRejectedValue(notFoundError());
    const create = vi.fn().mockResolvedValue({
      providerId: "custom_local_ollama",
      status: {},
      refresh: {},
    });
    mockGoose({
      GooseUnstableProvidersCustomRead: read,
      GooseUnstableProvidersCustomCreate: create,
    });

    await expect(syncRuntimeCustomProvider(runtimeProvider())).rejects.toThrow(
      "Runtime custom provider created as 'custom_local_ollama'",
    );
  });

  it("does not update when models and headers are equivalent sets", async () => {
    const update = vi.fn();
    const provider = runtimeProvider({
      models: ["qwen3.6:27b-mlx", "llama4:70b"],
      headers: { "X-First": "1", "X-Second": "2" },
    });
    mockGoose({
      GooseUnstableProvidersCustomRead: vi.fn().mockResolvedValue({
        provider: {
          ...matchingReadResponse(provider).provider,
          models: ["llama4:70b", "qwen3.6:27b-mlx"],
          headers: { "x-second": "2", "x-first": "1" },
        },
        editable: true,
        status: {},
      }),
      GooseUnstableProvidersCustomUpdate: update,
    });

    await syncRuntimeCustomProvider(provider);

    expect(update).not.toHaveBeenCalled();
  });

  it("updates when the existing catalog provider id differs from the runtime provider id", async () => {
    const update = vi.fn();
    const provider = runtimeProvider();
    mockGoose({
      GooseUnstableProvidersCustomRead: vi.fn().mockResolvedValue({
        provider: {
          ...matchingReadResponse(provider).provider,
          catalogProviderId: "custom_local_ollama",
        },
        editable: true,
        status: {},
      }),
      GooseUnstableProvidersCustomUpdate: update,
    });

    await syncRuntimeCustomProvider(provider);

    expect(update).toHaveBeenCalledWith({
      providerId: "local_ollama_openai",
      catalogProviderId: "local_ollama_openai",
      engine: "openai_compatible",
      displayName: "Local Ollama",
      apiUrl: "http://127.0.0.1:11434/v1",
      models: ["qwen3.6:27b-mlx"],
      requiresAuth: false,
      supportsStreaming: true,
      preservesThinking: false,
    });
  });

  it("does not create providers for non-not-found errors", async () => {
    const create = vi.fn();
    const error = new Error("unknown upstream error");
    mockGoose({
      GooseUnstableProvidersCustomRead: vi.fn().mockRejectedValue(error),
      GooseUnstableProvidersCustomCreate: create,
    });

    await expect(syncRuntimeCustomProvider(runtimeProvider())).rejects.toThrow(
      "unknown upstream error",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("syncs multiple runtime custom providers sequentially", async () => {
    const first = runtimeProvider({}, "first_provider");
    const second = runtimeProvider({}, "second_provider");
    let resolveFirstRead!: (
      value: ReturnType<typeof matchingReadResponse>,
    ) => void;
    let secondReadStarted = false;
    const firstRead = new Promise<ReturnType<typeof matchingReadResponse>>(
      (resolve) => {
        resolveFirstRead = resolve;
      },
    );
    const read = vi.fn(({ providerId }: { providerId: string }) => {
      if (providerId === "first_provider") {
        return firstRead;
      }
      secondReadStarted = true;
      return Promise.resolve(matchingReadResponse(second));
    });
    mockGoose({
      GooseUnstableProvidersCustomRead: read,
      GooseUnstableProvidersCustomUpdate: vi.fn(),
    });
    const config: RuntimeConfig = {
      schemaVersion: 1,
      goose: {
        defaultModelProviderId: "first_provider",
        modelProviders: [first, second],
      },
    };

    const syncPromise = syncRuntimeCustomProviders(config);
    await Promise.resolve();

    expect(read).toHaveBeenCalledWith({ providerId: "first_provider" });
    expect(secondReadStarted).toBe(false);

    resolveFirstRead(matchingReadResponse(first));
    await syncPromise;

    expect(secondReadStarted).toBe(true);
    expect(read).toHaveBeenCalledWith({ providerId: "second_provider" });
  });
});
