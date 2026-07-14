import { create } from "zustand";

export interface OpenArtifact {
  /** Resolved absolute path used for reading/rendering. */
  resolvedPath: string;
  /** Basename shown in the viewer header. */
  filename: string;
}

interface ArtifactViewerState {
  /** The artifact currently open in the viewer per session, if any. */
  openBySession: Record<string, OpenArtifact | null>;
  /**
   * The path the user most recently closed per session. Auto-open uses this
   * to avoid re-popping the same file the user just dismissed.
   */
  lastClosedPathBySession: Record<string, string | null>;
  open: (sessionId: string, artifact: OpenArtifact) => void;
  close: (sessionId: string) => void;
}

export const useArtifactViewerStore = create<ArtifactViewerState>((set) => ({
  openBySession: {},
  lastClosedPathBySession: {},
  open: (sessionId, artifact) =>
    set((state) => ({
      openBySession: { ...state.openBySession, [sessionId]: artifact },
      // Opening clears the suppression for that path.
      lastClosedPathBySession: {
        ...state.lastClosedPathBySession,
        [sessionId]: null,
      },
    })),
  close: (sessionId) =>
    set((state) => ({
      openBySession: { ...state.openBySession, [sessionId]: null },
      lastClosedPathBySession: {
        ...state.lastClosedPathBySession,
        [sessionId]:
          state.openBySession[sessionId]?.resolvedPath ??
          state.lastClosedPathBySession[sessionId] ??
          null,
      },
    })),
}));

export function useOpenArtifact(
  sessionId: string | null | undefined,
): OpenArtifact | null {
  return useArtifactViewerStore((s) =>
    sessionId ? (s.openBySession[sessionId] ?? null) : null,
  );
}
