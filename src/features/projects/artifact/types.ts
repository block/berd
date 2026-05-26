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
}

export type ProjectArtifactPinState = { projectId: string };
