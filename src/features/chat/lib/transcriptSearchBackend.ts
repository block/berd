/**
 * Contract between the find-in-transcript controller
 * (useChatTranscriptSearch) and a renderer that cannot expose its full
 * transcript as mounted DOM — the virtualized timeline. The backend owns
 * matching, painting, and match navigation; the controller keeps owning the
 * search bar UI state, shortcut, focus, and announcements.
 *
 * The classic timeline mounts everything, needs no backend, and is searched
 * directly through the DOM by the controller.
 */
export interface TranscriptSearchSnapshot {
  /** Total matches across the whole transcript (rendered-text semantics). */
  total: number;
  /** Ordinal of the active match within the total, -1 when none. */
  activeOrdinal: number;
  /** True while unharvested rows may still add to the total. */
  indexing: boolean;
}

export interface TranscriptSearchBackend {
  /** Recomputes matches for the trimmed query; reveals the first match. */
  setQuery(query: string): void;
  /** Moves the active match with wrap-around and reveals it. */
  navigate(direction: 1 | -1): void;
  /** Clears matches, paint, and pending navigation. */
  clear(): void;
  subscribe(listener: (snapshot: TranscriptSearchSnapshot) => void): () => void;
  getSnapshot(): TranscriptSearchSnapshot;
}
