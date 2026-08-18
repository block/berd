export type ProjectArtifactMood =
  | "dormant"
  | "awakening"
  | "serene"
  | "active"
  | "energetic"
  | "contemplative";

export type ProjectArtifactContentMode =
  | "planes"
  | "sphere"
  | "cube"
  | "cubeStatic";

export interface ProjectArtifactInput {
  projectId?: string | null;
  name: string;
  prompt?: string | null;
  color?: string | null;
  workingDirs?: string[];
  sessionCount?: number;
  artifact?: ProjectArtifactMetadata | null;
}

export interface ProjectArtifactState {
  seed: number;
  name: string;
  accentColor: string;
  accentCssColor: string;
  mood: ProjectArtifactMood;
  moodIntensity: number;
  contentMode: ProjectArtifactContentMode;
}

export interface ProjectArtifactMetadata {
  seed: number;
  color: string;
  mood: ProjectArtifactMood;
  moodIntensity: number;
  contentMode: ProjectArtifactContentMode;
}

export interface ProjectArtifactMotionImpulse {
  sequence: number;
  deltaX: number;
  deltaY: number;
}

export interface ProjectArtifactRendererProps {
  state: ProjectArtifactState;
  imageUrls: string[];
  environmentUrl: string;
  className?: string;
  variant?: "preview" | "tile";
  motionImpulse?: ProjectArtifactMotionImpulse;
  /** Pauses continuous rendering while the home canvas drags/resizes the widget. */
  gestureFreezeActive?: boolean;
  /** Pauses continuous rendering while a mounted preview is not visible. */
  renderPaused?: boolean;
  onGlCanvasReady?: (canvas: HTMLCanvasElement) => void;
  /** Pulls the camera back to provide extra framing around oversized embeds. */
  cameraDistanceScale?: number;
}

export type ProjectArtifactPinState = { projectId: string };
