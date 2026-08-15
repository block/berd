import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "@/features/projects/api/projects";
import type { ChatSession } from "@/features/chat/stores/chatSessionStore";
import { setHomePinLabelsAlwaysVisible } from "@/features/home/lib/homePinLabelPreference";
import type { WidgetInstance } from "./types";
import { ProjectArtifactWidget } from "./ProjectArtifactWidget";

const state = vi.hoisted(() => ({
  projects: [] as ProjectInfo[],
  sessions: [] as ChatSession[],
}));

vi.mock("@/features/projects/stores/projectStore", () => ({
  useProjectStore: (
    selector: (store: { projects: ProjectInfo[] }) => unknown,
  ) => selector(state),
}));

vi.mock("@/features/chat/stores/chatSessionStore", () => ({
  useChatSessionStore: (
    selector: (store: { sessions: ChatSession[] }) => unknown,
  ) => selector(state),
}));

vi.mock("@/features/projects/artifact/ProjectArtifactPreview", () => ({
  ProjectArtifactPreview: ({
    input,
    motionImpulse,
    renderPaused,
    onGlCanvasReady,
  }: {
    input: { artifact?: { seed: number } | null; name: string };
    motionImpulse?: { deltaX: number; deltaY: number; sequence: number };
    renderPaused?: boolean;
    onGlCanvasReady?: (canvas: HTMLCanvasElement | null) => void;
  }) => (
    <div
      data-artifact-seed={input.artifact?.seed ?? ""}
      data-motion-delta-x={motionImpulse?.deltaX ?? ""}
      data-motion-delta-y={motionImpulse?.deltaY ?? ""}
      data-motion-sequence={motionImpulse?.sequence ?? ""}
      data-render-paused={String(renderPaused ?? false)}
      data-testid="project-artifact-preview"
    >
      <canvas ref={onGlCanvasReady} data-testid="project-artifact-canvas" />
      {input.name}
    </div>
  ),
}));

const instance: WidgetInstance = {
  id: "project-artifact-1",
  type: "projectArtifactPin",
  x: 20,
  y: 30,
  z: 1,
  state: { projectId: "project-1" },
};

function project(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "project-1",
    path: "/tmp/projects/project-1.md",
    name: "Alpha Project",
    description: "",
    prompt: "Ship Alpha",
    icon: "tabler:code",
    color: "olive",
    projectWorkspaces: [],
    workingDirs: ["/tmp/alpha"],
    useWorktrees: false,
    order: 0,
    archivedAt: null,
    ...overrides,
  };
}

function renderWidget(
  overrides: {
    onStartProjectChat?: (projectId: string) => void;
    onTagProjectInComposer?: (projectId: string) => void;
    renderPaused?: boolean;
    canvasGestureActive?: boolean;
    canvasGestureKind?: "drag" | "resize";
    widgetResizePreviewActive?: boolean;
    shouldIgnoreActivation?: () => boolean;
  } = {},
) {
  return render(
    <ProjectArtifactWidget
      instance={instance}
      onUpdateState={vi.fn()}
      {...overrides}
    />,
  );
}

describe("ProjectArtifactWidget", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:,",
    );
    state.projects = [project()];
    state.sessions = [];
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("renders the project artifact with a hover-only project name", () => {
    renderWidget();

    const preview = screen.getByTestId("project-artifact-preview");
    const label = screen.getByTestId("project-artifact-hover-label");

    expect(preview).toHaveTextContent("Alpha Project");
    expect(preview.parentElement).toHaveClass(
      "pointer-events-auto",
      "aspect-square",
      "w-[96%]",
      "max-h-full",
      "max-w-full",
      "min-h-0",
      "min-w-0",
    );
    expect(label).toHaveTextContent("Alpha Project");
    expect(label).toHaveAttribute("aria-hidden", "true");
    expect(label).toHaveClass(
      "px-2.5",
      "py-1",
      "text-xs",
      "bg-card/90",
      "text-foreground",
      "opacity-0",
      "group-hover:opacity-100",
    );
    expect(screen.queryByText("Project")).not.toBeInTheDocument();
  });

  it("keeps the project name always visible when the home pin labels preference is enabled", () => {
    setHomePinLabelsAlwaysVisible(true);

    renderWidget();

    const label = screen.getByTestId("project-artifact-hover-label");
    expect(label).toHaveTextContent("Alpha Project");
    expect(label).toHaveClass("opacity-100");
    expect(label).not.toHaveClass("opacity-0", "group-hover:opacity-100");
  });

  it("passes render pause state to the preview", () => {
    renderWidget({ renderPaused: true });

    expect(screen.getByTestId("project-artifact-preview")).toHaveAttribute(
      "data-render-paused",
      "true",
    );
  });

  it("passes the saved artifact identity to the preview", () => {
    state.projects = [
      project({
        artifact: {
          seed: 1234,
          color: "olive",
          mood: "serene",
          moodIntensity: 0.5,
          contentMode: "cubeStatic",
        },
      }),
    ];

    renderWidget();

    expect(screen.getByTestId("project-artifact-preview")).toHaveAttribute(
      "data-artifact-seed",
      "1234",
    );
  });

  it("starts a project chat when activated", () => {
    const onStartProjectChat = vi.fn();
    renderWidget({ onStartProjectChat });

    fireEvent.click(
      screen.getByRole("button", { name: "Start chat in Alpha Project" }),
    );

    expect(onStartProjectChat).toHaveBeenCalledWith("project-1");
  });

  it("tags the project in the composer when the tag handler is available", () => {
    const onStartProjectChat = vi.fn();
    const onTagProjectInComposer = vi.fn();
    renderWidget({ onStartProjectChat, onTagProjectInComposer });

    fireEvent.click(
      screen.getByRole("button", { name: "Start chat in Alpha Project" }),
    );

    expect(onTagProjectInComposer).toHaveBeenCalledWith("project-1");
    expect(onStartProjectChat).not.toHaveBeenCalled();
  });

  it("does not bubble composer-tagging clicks to the widget frame", () => {
    const onTagProjectInComposer = vi.fn();
    const onFrameClick = vi.fn();
    render(
      <fieldset
        aria-label="Project widget frame"
        onClick={onFrameClick}
        onKeyDown={() => {}}
      >
        <ProjectArtifactWidget
          instance={instance}
          onUpdateState={vi.fn()}
          onTagProjectInComposer={onTagProjectInComposer}
        />
      </fieldset>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Start chat in Alpha Project" }),
    );

    expect(onTagProjectInComposer).toHaveBeenCalledWith("project-1");
    expect(onFrameClick).not.toHaveBeenCalled();
  });

  it("suppresses activation when the drag guard is active", () => {
    const onStartProjectChat = vi.fn();
    renderWidget({
      onStartProjectChat,
      shouldIgnoreActivation: () => true,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Start chat in Alpha Project" }),
    );

    expect(onStartProjectChat).not.toHaveBeenCalled();
  });

  it("does not animate pointer impulse while a canvas gesture is active", () => {
    renderWidget({ canvasGestureActive: true });

    const button = screen.getByRole("button", {
      name: "Start chat in Alpha Project",
    });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      width: 200,
      height: 200,
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(button, { clientX: 20, clientY: 20 });
    fireEvent.pointerMove(button, { clientX: 80, clientY: 20 });

    expect(screen.getByTestId("project-artifact-preview")).toHaveAttribute(
      "data-motion-sequence",
      "",
    );
  });

  it("keeps hover motion independent from click suppression", () => {
    renderWidget({ shouldIgnoreActivation: () => true });

    const button = screen.getByRole("button", {
      name: "Start chat in Alpha Project",
    });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      width: 200,
      height: 200,
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerEnter(button, { clientX: 20, clientY: 20 });
    fireEvent.pointerMove(button, { clientX: 80, clientY: 20 });

    expect(screen.getByTestId("project-artifact-preview")).toHaveAttribute(
      "data-motion-sequence",
      "1",
    );
  });

  it("animates the starter project cube on hover", () => {
    state.projects = [];
    render(
      <ProjectArtifactWidget
        instance={{
          ...instance,
          type: "onboardingProjectArtifact",
          state: { projectId: "onboarding:starter-project" },
        }}
        onUpdateState={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Name your first project",
    });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      width: 200,
      height: 200,
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerEnter(button, { clientX: 20, clientY: 20 });
    fireEvent.pointerMove(button, { clientX: 80, clientY: 20 });

    expect(screen.getByTestId("project-artifact-preview")).toHaveAttribute(
      "data-motion-sequence",
      "1",
    );
  });

  it.each([
    "pointerUp",
    "pointerCancel",
  ] as const)("does not reuse a %s snapshot for a later resize gesture", (releaseEvent) => {
    const view = renderWidget();
    const button = screen.getByRole("button", {
      name: "Start chat in Alpha Project",
    });
    const canvas = screen.getByTestId(
      "project-artifact-canvas",
    ) as HTMLCanvasElement;
    const toDataURL = vi
      .spyOn(canvas, "toDataURL")
      .mockReturnValue("data:image/png;base64,frame-a");

    fireEvent.pointerDown(button);
    fireEvent[releaseEvent](button);
    toDataURL.mockReturnValue("data:image/png;base64,frame-b");

    view.rerender(
      <ProjectArtifactWidget
        instance={instance}
        onUpdateState={vi.fn()}
        canvasGestureActive
        canvasGestureKind="resize"
      />,
    );

    expect(document.querySelector('img[aria-hidden="true"]')).toHaveAttribute(
      "src",
      "data:image/png;base64,frame-b",
    );
  });

  it("consumes a prepared frame for its drag without leaking it to resize", () => {
    const view = renderWidget();
    const button = screen.getByRole("button", {
      name: "Start chat in Alpha Project",
    });
    const canvas = screen.getByTestId(
      "project-artifact-canvas",
    ) as HTMLCanvasElement;
    const toDataURL = vi
      .spyOn(canvas, "toDataURL")
      .mockReturnValue("data:image/png;base64,frame-a");

    fireEvent.pointerDown(button);
    view.rerender(
      <ProjectArtifactWidget
        instance={instance}
        onUpdateState={vi.fn()}
        canvasGestureActive
        canvasGestureKind="drag"
      />,
    );
    expect(document.querySelector('img[aria-hidden="true"]')).toHaveAttribute(
      "src",
      "data:image/png;base64,frame-a",
    );

    view.rerender(
      <ProjectArtifactWidget
        instance={instance}
        onUpdateState={vi.fn()}
        canvasGestureKind="drag"
      />,
    );
    toDataURL.mockReturnValue("data:image/png;base64,frame-b");
    view.rerender(
      <ProjectArtifactWidget
        instance={instance}
        onUpdateState={vi.fn()}
        canvasGestureActive
        canvasGestureKind="resize"
      />,
    );

    expect(document.querySelector('img[aria-hidden="true"]')).toHaveAttribute(
      "src",
      "data:image/png;base64,frame-b",
    );
  });

  it("starts cube pointer impulse tracking from each pointerdown", () => {
    renderWidget();

    const button = screen.getByRole("button", {
      name: "Start chat in Alpha Project",
    });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      width: 200,
      height: 200,
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(button, { clientX: 10, clientY: 20 });
    fireEvent.pointerMove(button, { clientX: 80, clientY: 20 });
    expect(screen.getByTestId("project-artifact-preview")).toHaveAttribute(
      "data-motion-sequence",
      "1",
    );

    fireEvent.pointerDown(button, { clientX: 200, clientY: 20 });
    fireEvent.pointerMove(button, { clientX: 201, clientY: 20 });

    const preview = screen.getByTestId("project-artifact-preview");
    expect(preview).toHaveAttribute("data-motion-sequence", "2");
    expect(Number(preview.dataset.motionDeltaX)).toBeLessThan(0.1);
  });

  it("renders a non-crashing unavailable state when the project is missing", () => {
    const onStartProjectChat = vi.fn();
    state.projects = [];

    renderWidget({ onStartProjectChat });

    expect(screen.getAllByText("Project unavailable").length).toBeGreaterThan(
      0,
    );
    expect(
      screen.queryByText("Unpin or restore this project"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Project unavailable" }),
    );
    expect(onStartProjectChat).not.toHaveBeenCalled();
  });
});
