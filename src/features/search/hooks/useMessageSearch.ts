import { useCallback, useEffect, useRef, useState } from "react";
import {
  searchMessagesPage,
  MessageSearchTimeoutError,
  type MessageSearchRequest,
  type MessageSearchMatch,
} from "@/shared/api/messageSearch";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";

export type MessageSearchStatus =
  | "idle"
  | "complete"
  | "partial"
  | "timeout"
  | "error";
export interface UseMessageSearchOptions
  extends Omit<MessageSearchRequest, "cursor" | "signal"> {
  enabled?: boolean;
}
interface SearchState {
  results: MessageSearchMatch[];
  isLoading: boolean;
  error: string | null;
  status: MessageSearchStatus;
  cursor: string | null;
}
const EMPTY: SearchState = {
  results: [],
  isLoading: false,
  error: null,
  status: "idle",
  cursor: null,
};

/** Search when enabled with a nonempty query. Every query/filter change
 * cancels the previous consumer; a late transport reply cannot replace it. */
export function useMessageSearch(options: UseMessageSearchOptions) {
  const [state, setState] = useState<SearchState>(EMPTY);
  const [retryVersion, setRetryVersion] = useState(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursorRef = useRef<string | null>(null);
  const incomplete = useRef(false);
  const seenCursors = useRef(new Set<string>());
  const key = JSON.stringify([
    options.query.trim(),
    options.scope ?? "active",
    options.backendId ?? "local",
    options.workingDir ?? "",
    [...(options.types ?? [])].sort(),
    options.enabled ?? true,
    options.limit ?? 50,
  ]);
  const currentKey = useRef(key);
  currentKey.current = key;

  const cancel = useCallback(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = null;
    generation.current += 1;
    controller.current?.abort();
    busy.current = false;
    setState((previous) => ({
      ...previous,
      isLoading: false,
      status: previous.isLoading ? "partial" : previous.status,
    }));
  }, []);

  const run = useCallback(async (cursor: string | null, reset: boolean) => {
    if (busy.current && !reset) return;
    const expectedKey = currentKey.current;
    const expectedGeneration = ++generation.current;
    controller.current?.abort();
    controller.current = new AbortController();
    busy.current = true;
    setState((previous) => ({
      ...(reset ? EMPTY : previous),
      isLoading: true,
      error: null,
    }));
    try {
      const page = await searchMessagesPage({
        ...optionsRef.current,
        cursor,
        signal: controller.current.signal,
      });
      if (
        expectedGeneration !== generation.current ||
        expectedKey !== currentKey.current
      )
        return;
      if (
        page.nextCursor &&
        (page.nextCursor === cursor || seenCursors.current.has(page.nextCursor))
      )
        throw new Error("Repeated message search pagination cursor");
      if (page.nextCursor) seenCursors.current.add(page.nextCursor);
      incomplete.current ||= !page.complete;
      cursorRef.current = page.nextCursor;
      setState((previous) => {
        const results = reset ? [] : [...previous.results];
        const seen = new Set(
          results.map((match) =>
            JSON.stringify([
              match.sessionId,
              match.messageId || match.messageIndex,
            ]),
          ),
        );
        for (const match of page.matches) {
          const identity = JSON.stringify([
            match.sessionId,
            match.messageId || match.messageIndex,
          ]);
          if (!seen.has(identity)) {
            results.push(match);
            seen.add(identity);
          }
        }
        return {
          results,
          isLoading: false,
          error: null,
          cursor: page.nextCursor,
          status: incomplete.current ? "partial" : "complete",
        };
      });
    } catch (error) {
      if (
        expectedGeneration !== generation.current ||
        expectedKey !== currentKey.current
      )
        return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState((previous) => ({
        ...previous,
        isLoading: false,
        error: formatAcpErrorMessage(error, "Message search failed"),
        status:
          error instanceof MessageSearchTimeoutError ? "timeout" : "error",
      }));
    } finally {
      if (expectedGeneration === generation.current) busy.current = false;
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: query/filter identity and explicit retry restart the ref-backed consumer.
  useEffect(() => {
    generation.current += 1;
    controller.current?.abort();
    busy.current = false;
    cursorRef.current = null;
    incomplete.current = false;
    seenCursors.current.clear();
    setState(EMPTY);
    if (
      optionsRef.current.enabled !== false &&
      optionsRef.current.query.trim()
    ) {
      debounce.current = setTimeout(() => {
        debounce.current = null;
        void run(null, true);
      }, 180);
      return () => {
        if (debounce.current) clearTimeout(debounce.current);
        debounce.current = null;
        generation.current += 1;
        controller.current?.abort();
        busy.current = false;
      };
    }
    return () => {
      generation.current += 1;
      controller.current?.abort();
    };
  }, [key, retryVersion, run]);

  const loadMore = useCallback(() => {
    if (cursorRef.current && optionsRef.current.enabled !== false)
      void run(cursorRef.current, false);
  }, [run]);
  const retry = useCallback(
    () => setRetryVersion((version) => version + 1),
    [],
  );
  return { ...state, hasMore: Boolean(state.cursor), loadMore, cancel, retry };
}
