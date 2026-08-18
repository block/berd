import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import type { CreatePersonaRequest } from "@/shared/types/agents";
import {
  dispatchOnboarding,
  resetOnboardingStoreForTests,
} from "../model/onboardingStore";
import type { OnboardingRuntimeState } from "../model";
import { OnboardingFlow } from "./OnboardingFlow";

const mockCreatePersona = vi.hoisted(() => vi.fn());
const mockListPersonas = vi.hoisted(() => vi.fn());
const mockTrackAgentCreateCompleted = vi.hoisted(() => vi.fn());

vi.mock("@/shared/api/agents", () => ({
  createPersona: mockCreatePersona,
  listPersonas: mockListPersonas,
}));

vi.mock("@/features/agents/lib/agentTelemetry", () => ({
  trackAgentCreateCompleted: mockTrackAgentCreateCompleted,
}));

vi.mock("@/shared/api/artifacts", () => ({
  ARTIFACTS_QUERY_KEY: ["artifacts"],
  getArtifacts: vi
    .fn()
    .mockResolvedValue({ catalogVersion: "test", assets: [] }),
  selectAvatarImageUrl: vi.fn(),
}));

vi.mock("@/shared/api/avatars", () => ({
  avatarCachedRefQueryKey: (avatarRef: string) => ["avatar", avatarRef],
  getCachedAvatarForRef: vi.fn().mockResolvedValue(null),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/shared/hooks/useAvatarSrc", () => ({
  useAvatarImage: () => undefined,
  useAvatarMedia: () => ({
    src: "asset://localhost/avatar.webm",
    mediaType: "video",
    alphaMode: "stacked",
  }),
}));

vi.mock("@/shared/ui/avatar-media", () => ({
  AvatarMedia: ({ className }: { className?: string }) => (
    <canvas data-testid="avatar-media" className={className} />
  ),
}));

vi.mock("@/features/projects/artifact/ProjectArtifactPreview", () => ({
  ProjectArtifactPreview: () => <div data-testid="project-cube" />,
}));

vi.mock("@/shared/telemetry/consent", () => ({
  updateTelemetryEnabled: vi.fn(async () => undefined),
  telemetryConsentEnforced: () => false,
}));

function createdPersona(request: CreatePersonaRequest) {
  return {
    id: `/Users/x/.agents/agents/${request.displayName.toLowerCase()}.md`,
    displayName: request.displayName,
    systemPrompt: request.systemPrompt,
    provider: request.provider,
    modelProviderId: request.modelProviderId,
    model: request.model,
    isBuiltin: false,
    writable: true,
  };
}

const readyRuntime: OnboardingRuntimeState = {
  ready: true,
  failed: false,
  retry: vi.fn(),
};

function renderFlow(runtime: OnboardingRuntimeState = readyRuntime) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <OnboardingFlow runtime={runtime} />
    </QueryClientProvider>,
  );
}

async function keepRecommendedAgents(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /keep/i }));
  // Adoption finished once the flow leaves the recommendations step.
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: /keep/i }),
    ).not.toBeInTheDocument(),
  );
}

// The "engineering" work type recommends Builder, Debugger, and Reviewer, in
// catalog order — pinned here so the per-agent assertions below stay readable.
describe("OnboardingFlow agent adoption telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetOnboardingStoreForTests();
    dispatchOnboarding({ type: "start" });
    dispatchOnboarding({
      type: "set-work-types",
      workTypeIds: ["engineering"],
    });
    dispatchOnboarding({ type: "go-to", step: "recommendations" });
    useAgentStore.setState({
      personas: [],
      personasLoading: false,
      providers: [],
    });
    mockListPersonas.mockResolvedValue([]);
    mockCreatePersona.mockImplementation(
      async (request: CreatePersonaRequest) => createdPersona(request),
    );
  });

  it("emits Create Completed once per persona actually created by Keep", async () => {
    // Builder already exists, so keeping the recommendations only creates
    // Debugger and Reviewer.
    mockListPersonas.mockResolvedValue([
      {
        id: "/Users/x/.agents/agents/builder.md",
        displayName: "Builder",
        systemPrompt: "Existing.",
        isBuiltin: false,
        writable: true,
      },
    ]);
    renderFlow();

    await keepRecommendedAgents();

    expect(mockCreatePersona).toHaveBeenCalledTimes(2);
    // One event per persona actually created; with no id on the event the
    // count of two is what pins the per-persona emission.
    expect(mockTrackAgentCreateCompleted).toHaveBeenCalledTimes(2);
    expect(mockTrackAgentCreateCompleted).toHaveBeenCalledWith({
      provider: undefined,
      model: undefined,
    });
  });

  it("does not emit for a persona whose creation fails", async () => {
    // Builder succeeds, Debugger's create rejects, Reviewer succeeds.
    mockCreatePersona
      .mockImplementationOnce(async (request: CreatePersonaRequest) =>
        createdPersona(request),
      )
      .mockRejectedValueOnce(new Error("create failed"));
    renderFlow();

    await keepRecommendedAgents();

    expect(mockCreatePersona).toHaveBeenCalledTimes(3);
    // Three creates attempted, two succeeded: the failed one emits nothing,
    // which the count of two pins now that no id rides the event.
    expect(mockTrackAgentCreateCompleted).toHaveBeenCalledTimes(2);
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });
});

// AppShell renders the flow ahead of its startup gates, so the runtime-free
// steps must not depend on the chat runtime having started.
describe("OnboardingFlow runtime independence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetOnboardingStoreForTests();
    dispatchOnboarding({ type: "start" });
  });

  it.each([
    ["startup has not settled", { ready: false, failed: false }],
    ["startup failed", { ready: false, failed: true }],
  ])("renders the landing page while %s", (_case, runtime) => {
    renderFlow({ ...runtime, retry: vi.fn() });

    expect(
      screen.getByRole("heading", {
        name: "Welcome to Berd. Your place for doing.",
      }),
    ).toBeInTheDocument();
  });

  it("moves on to the work-type picker without the runtime", async () => {
    renderFlow({ ready: false, failed: false, retry: vi.fn() });

    await userEvent.click(screen.getByRole("button", { name: "Let’s go" }));

    expect(
      screen.getByRole("heading", {
        name: "What type of work will you use Berd for?",
      }),
    ).toBeInTheDocument();
  });

  it("waits for the runtime before agent adoption can call ACP", async () => {
    dispatchOnboarding({
      type: "set-work-types",
      workTypeIds: ["engineering"],
    });
    dispatchOnboarding({ type: "go-to", step: "recommendations" });
    renderFlow({ ready: false, failed: false, retry: vi.fn() });

    await userEvent.click(
      screen.getByRole("button", { name: "Getting ready…" }),
    );

    expect(mockListPersonas).not.toHaveBeenCalled();
    expect(mockCreatePersona).not.toHaveBeenCalled();
  });
});
